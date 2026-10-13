// Inline conflict resolution for git-style conflict markers written by the
// "merge with markers" strategy (src/merge.ts) or by command-line git users.
//
// The pure functions (findConflictBlocks / resolveBlock) have no editor
// dependency and are unit-tested; conflictResolver() wraps them in a
// CodeMirror 6 extension that shows a small button bar above each block.

import { Prec, StateField } from "@codemirror/state";
import type { EditorState, Extension, Range, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

export interface ConflictBlock {
	/** Offset of the first character of the `<<<<<<<` line. */
	from: number;
	/** Offset just past the `>>>>>>>` line, including its line break if present. */
	to: number;
	oursLabel: string;
	theirsLabel: string;
	/** Lines between `<<<<<<<` and `|||||||`/`=======`, each with its original line ending. */
	ours: string;
	/** Lines between `=======` and `>>>>>>>`, each with its original line ending. */
	theirs: string;
	/** diff3 style only: lines between `|||||||` and `=======`. */
	base?: string;
}

export type ConflictChoice = "ours" | "theirs" | "both";

const OPEN = "<<<<<<<";

interface Line {
	start: number;
	/** Offset past the line break (or end of text). */
	end: number;
	/** Line content without "\n" / "\r\n". */
	text: string;
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	while (start < text.length) {
		const nl = text.indexOf("\n", start);
		const end = nl < 0 ? text.length : nl + 1;
		let content = text.slice(start, nl < 0 ? text.length : nl);
		if (content.endsWith("\r")) content = content.slice(0, -1);
		lines.push({ start, end, text: content });
		start = end;
	}
	return lines;
}

/** Returns the label if `line` is `marker` optionally followed by a space and a label, else null. */
function markerLabel(line: string, marker: string): string | null {
	if (!line.startsWith(marker)) return null;
	const rest = line.slice(marker.length);
	if (rest === "") return "";
	if (rest[0] !== " " && rest[0] !== "\t") return null;
	return rest.trim();
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Finds well-formed conflict blocks. Markers inside fenced code blocks are
 * ignored, as are unbalanced or malformed blocks (missing `=======` or
 * `>>>>>>>`, nested `<<<<<<<`, markers out of order).
 */
export function findConflictBlocks(text: string): ConflictBlock[] {
	if (!text.includes(OPEN)) return [];
	const lines = splitLines(text);
	const blocks: ConflictBlock[] = [];
	let fence: string | null = null;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i].text;
		const fm = FENCE_RE.exec(line);
		if (fence !== null) {
			if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && line.trim() === fm[1]) fence = null;
			i++;
			continue;
		}
		if (fm) {
			// A backtick fence's info string may not contain backticks.
			if (fm[1][0] !== "`" || !line.slice(line.indexOf(fm[1]) + fm[1].length).includes("`")) fence = fm[1];
			i++;
			continue;
		}
		const oursLabel = markerLabel(line, OPEN);
		if (oursLabel === null) {
			i++;
			continue;
		}
		const parsed = parseBlock(text, lines, i, oursLabel);
		if (parsed.block) {
			blocks.push(parsed.block);
		}
		i = parsed.next;
	}
	return blocks;
}

function parseBlock(
	text: string,
	lines: Line[],
	openIdx: number,
	oursLabel: string,
): { block: ConflictBlock | null; next: number } {
	let baseIdx = -1;
	let sepIdx = -1;
	// A second bare separator means one side itself contains a "=======" line: which one splits the
	// block can't be known, so the block is ambiguous and gets no buttons (resolving it could drop lines).
	let ambiguous = false;
	for (let j = openIdx + 1; j < lines.length; j++) {
		const l = lines[j].text;
		if (markerLabel(l, OPEN) !== null) return { block: null, next: j }; // nested/unbalanced: retry from here
		if (sepIdx < 0 && baseIdx < 0 && markerLabel(l, "|||||||") !== null) {
			baseIdx = j;
			continue;
		}
		if (l === "=======") {
			if (sepIdx < 0) sepIdx = j;
			else ambiguous = true;
			continue;
		}
		const theirsLabel = markerLabel(l, ">>>>>>>");
		if (theirsLabel !== null) {
			if (sepIdx < 0 || ambiguous) return { block: null, next: j + 1 }; // no separator, or more than one
			const slice = (a: number, b: number): string => (a >= b ? "" : text.slice(lines[a].start, lines[b - 1].end));
			const oursEnd = baseIdx >= 0 ? baseIdx : sepIdx;
			const block: ConflictBlock = {
				from: lines[openIdx].start,
				to: lines[j].end,
				oursLabel,
				theirsLabel,
				ours: slice(openIdx + 1, oursEnd),
				theirs: slice(sepIdx + 1, j),
			};
			if (baseIdx >= 0) block.base = slice(baseIdx + 1, sepIdx);
			return { block, next: j + 1 };
		}
	}
	return { block: null, next: lines.length }; // never closed
}

/** Text that replaces the whole block for the given choice ("both" = ours then theirs). */
export function resolveBlock(block: ConflictBlock, choice: ConflictChoice): string {
	if (choice === "ours") return block.ours;
	if (choice === "theirs") return block.theirs;
	if (block.ours === "" || block.theirs === "") return block.ours + block.theirs;
	// Both sides normally end with a line break; guard against a side that doesn't.
	const eol = block.ours.endsWith("\n") ? "" : block.theirs.includes("\r\n") ? "\r\n" : "\n";
	return block.ours + eol + block.theirs;
}

// ---------------------------------------------------------------------------
// CodeMirror 6 extension
// ---------------------------------------------------------------------------

export interface ConflictResolverLabels {
	ours: string;
	theirs: string;
	both: string;
	hint?: string;
}

/** Resolves the conflict block starting at (or containing) `pos` in the current document. */
function resolveAt(view: EditorView, pos: number, choice: ConflictChoice): boolean {
	const blocks = findConflictBlocks(view.state.doc.toString());
	const block = blocks.find((b) => b.from === pos) ?? blocks.find((b) => b.from <= pos && pos < b.to);
	if (!block) return false;
	view.dispatch({
		changes: { from: block.from, to: block.to, insert: resolveBlock(block, choice) },
		userEvent: "input.conflict-resolve",
		scrollIntoView: true,
	});
	view.focus();
	return true;
}

class ConflictBarWidget extends WidgetType {
	labels: ConflictResolverLabels;
	oursLabel: string;
	theirsLabel: string;

	constructor(labels: ConflictResolverLabels, oursLabel: string, theirsLabel: string) {
		super();
		this.labels = labels;
		this.oursLabel = oursLabel;
		this.theirsLabel = theirsLabel;
	}

	eq(other: ConflictBarWidget): boolean {
		return other.labels === this.labels && other.oursLabel === this.oursLabel && other.theirsLabel === this.theirsLabel;
	}

	toDOM(view: EditorView): HTMLElement {
		const bar = createDiv({ cls: "vsg-conflict-bar" });
		bar.setAttribute("role", "toolbar");
		if (this.labels.hint) {
			bar.setAttribute("aria-label", this.labels.hint);
			bar.createSpan({ cls: "vsg-conflict-hint", text: this.labels.hint });
		}
		const make = (choice: ConflictChoice, text: string, detail: string): void => {
			const btn = bar.createEl("button", { cls: `vsg-conflict-btn vsg-conflict-btn-${choice}`, text });
			btn.type = "button";
			btn.setAttribute("aria-label", detail ? `${text} (${detail})` : text);
			btn.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor selection
			btn.addEventListener("click", (e) => {
				e.preventDefault();
				e.stopPropagation();
				resolveAt(view, view.posAtDOM(bar), choice);
			});
		};
		make("ours", this.labels.ours, this.oursLabel);
		make("theirs", this.labels.theirs, this.theirsLabel);
		make("both", this.labels.both, "");
		return bar;
	}

	ignoreEvent(): boolean {
		return true; // the buttons handle their own events
	}
}

/** Shown in place of a marker line, so Markdown doesn't style it (a quote, or a heading underline). */
class MarkerWidget extends WidgetType {
	kind: "open" | "base" | "sep" | "close";
	label: string;
	constructor(kind: "open" | "base" | "sep" | "close", label: string) {
		super();
		this.kind = kind;
		this.label = label;
	}
	eq(other: MarkerWidget): boolean {
		return other.kind === this.kind && other.label === this.label;
	}
	toDOM(): HTMLElement {
		return createSpan({ cls: `vsg-cm-marker-label vsg-cm-marker-${this.kind}`, text: this.label });
	}
}

function buildDecorations(state: EditorState, labels: ConflictResolverLabels): DecorationSet {
	const blocks = findConflictBlocks(state.doc.toString());
	if (blocks.length === 0) return Decoration.none;
	const ranges: Range<Decoration>[] = [];
	const doc = state.doc;
	for (const b of blocks) {
		ranges.push(Decoration.widget({ widget: new ConflictBarWidget(labels, b.oursLabel, b.theirsLabel), block: true, side: -1 }).range(b.from));
		// Tint each side and neutralise Markdown styling inside the block: the line above "=======" would
		// otherwise render as a heading, and ">>>>>>>" as nested quotes.
		let section: "ours" | "base" | "theirs" = "ours";
		const last = doc.lineAt(Math.max(b.from, b.to - 1)).number;
		for (let n = doc.lineAt(b.from).number; n <= last; n++) {
			const line = doc.line(n);
			let kind: "open" | "base" | "sep" | "close" | null = null;
			let label = "";
			if (line.from === b.from) [kind, label] = ["open", b.oursLabel];
			else if (n === last) [kind, label] = ["close", b.theirsLabel];
			else if (section === "ours" && b.base !== undefined && markerLabel(line.text, "|||||||") !== null) [kind, label, section] = ["base", markerLabel(line.text, "|||||||") ?? "", "base"];
			else if (section !== "theirs" && line.text === "=======") [kind, section] = ["sep", "theirs"];
			if (kind) {
				ranges.push(Decoration.line({ class: `vsg-cm-marker vsg-cm-marker-line-${kind}` }).range(line.from));
				if (line.length > 0) ranges.push(Decoration.replace({ widget: new MarkerWidget(kind, label) }).range(line.from, line.to));
			} else ranges.push(Decoration.line({ class: `vsg-cm-side vsg-cm-${section}` }).range(line.from));
		}
	}
	return Decoration.set(ranges, true);
}

/**
 * Editor extension that shows "keep this device / keep repository / keep both"
 * buttons above every conflict block. Labels must already be translated.
 *
 * Block widgets must come from a state field (CodeMirror disallows block
 * decorations from view plugins), so decorations live in a StateField that
 * rescans only when the document changes.
 */
function touchesMarker(tr: Transaction): boolean {
	let hit = false;
	const marker = (t: string) => t.includes("<<<<<<<") || t.includes("=======") || t.includes(">>>>>>>");
	tr.changes.iterChangedRanges((fromA, toA, from, to) => {
		if (hit) return;
		const doc = tr.state.doc;
		// Removed text matters too: deleting a code fence can reveal blocks that were inside "code".
		const removed = tr.startState.doc.sliceString(fromA, toA);
		hit = marker(doc.sliceString(doc.lineAt(from).from, doc.lineAt(to).to)) || marker(removed) || removed.includes("```") || removed.includes("~~~");
	});
	return hit;
}

export function conflictResolver(labels: ConflictResolverLabels): Extension {
	const field = StateField.define<DecorationSet>({
		create: (state) => buildDecorations(state, labels),
		update: (deco, tr) => {
			if (!tr.docChanged) return deco;
			// Typing in a note without conflicts: only rescan when a changed line could hold a marker,
			// so big notes aren't copied on every keystroke.
			if (deco.size === 0 && !touchesMarker(tr)) return deco;
			return buildDecorations(tr.state, labels);
		},
		// Highest precedence: the marker labels must win over Markdown's own decorations on those lines.
		provide: (f) => Prec.highest(EditorView.decorations.from(f)),
	});
	return field;
}
