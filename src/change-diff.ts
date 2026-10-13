// Line hunks between the last-synced text of a file and its current text (editor change markers),
// reverting one hunk, and tracing a line back through a file's history (line authoring).
// Pure module: no Obsidian or CodeMirror imports, unit-tested.

import { lcsMatch } from "./merge.ts";

/**
 * One changed region. Lines are 0-based, in the editor's model (the text split on "\n").
 * `from`/`to` index the current text (`to` exclusive; `from === to` for a deletion, which sits
 * before current line `from`); `oldFrom`/`oldLines` describe the last-synced side.
 */
export interface Hunk {
	kind: "add" | "change" | "delete";
	from: number;
	to: number;
	oldFrom: number;
	oldLines: string[];
}

/** The editor's line model: CodeMirror documents are "\n"-separated, so CRLF is normalised first. */
export function editorLines(text: string): string[] {
	return text.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Index in `b` of each line of `a` matched by a longest common subsequence (-1 = not matched).
 * Huge rewrites (too big to diff cheaply) match nothing.
 */
function match(a: string[], b: string[]): Int32Array {
	return lcsMatch(a, b) ?? new Int32Array(a.length).fill(-1);
}

/** Changed regions from `base` (last-synced text) to `current`. */
export function computeHunks(base: string, current: string): Hunk[] {
	if (base === current) return [];
	const A = editorLines(base);
	const B = editorLines(current);
	const m = match(A, B);
	const hunks: Hunk[] = [];
	let i = 0;
	let j = 0;
	const flush = (i0: number, i1: number, j0: number, j1: number) => {
		if (i1 === i0 && j1 === j0) return;
		const oldLines = A.slice(i0, i1);
		const kind = i1 === i0 ? "add" : j1 === j0 ? "delete" : "change";
		hunks.push({ kind, from: j0, to: j1, oldFrom: i0, oldLines });
	};
	while (i < A.length || j < B.length) {
		const i0 = i;
		const j0 = j;
		// Unmatched old lines, then new lines up to the next match, form one hunk.
		while (i < A.length && m[i] < 0) i++;
		const nextJ = i < A.length ? m[i] : B.length;
		j = Math.max(j, nextJ);
		flush(i0, i, j0, j);
		if (i < A.length) {
			i++;
			j++;
		}
	}
	return hunks;
}

/** The hunk that covers 0-based line `line` (a deletion counts for the line it sits above, or the last line). */
export function hunkAt(hunks: Hunk[], line: number, lineCount: number): Hunk | null {
	for (const h of hunks) {
		if (h.to > h.from ? line >= h.from && line < h.to : line === Math.min(h.from, lineCount - 1)) return h;
	}
	return null;
}

/** The first hunk starting after `line` (wrapping around), or before it with `dir` -1. */
export function nextHunk(hunks: Hunk[], line: number, dir: 1 | -1): Hunk | null {
	if (!hunks.length) return null;
	if (dir === 1) return hunks.find((h) => h.from > line) ?? hunks[0];
	for (let k = hunks.length - 1; k >= 0; k--) if (hunks[k].from < line) return hunks[k];
	return hunks[hunks.length - 1];
}

/**
 * The text edit that puts a hunk back to its last-synced lines: replace `text.slice(from, to)`
 * with `insert`. `text` is the current text in the editor's model ("\n" line breaks).
 */
export function revertEdit(text: string, h: Hunk): { from: number; to: number; insert: string } {
	const starts = [0];
	for (let k = 0; k < text.length; k++) if (text.charCodeAt(k) === 10) starts.push(k + 1);
	const n = starts.length;
	const lineEnd = (l: number) => (l + 1 < n ? starts[l + 1] - 1 : text.length);
	const old = h.oldLines.join("\n");
	if (h.to > h.from) {
		if (h.oldLines.length) return { from: starts[h.from], to: lineEnd(h.to - 1), insert: old };
		// Added lines: remove them together with one line break.
		if (h.to < n) return { from: starts[h.from], to: starts[h.to], insert: "" };
		if (h.from > 0) return { from: lineEnd(h.from - 1), to: text.length, insert: "" };
		return { from: 0, to: text.length, insert: "" };
	}
	// Deleted lines: put them back above line `from` (or after the last line).
	if (h.from < n) return { from: starts[h.from], to: starts[h.from], insert: old + "\n" };
	return { from: text.length, to: text.length, insert: "\n" + old };
}

/** Applies revertEdit (for tests and callers working on plain strings). */
export function revertHunk(text: string, h: Hunk): string {
	const e = revertEdit(text, h);
	return text.slice(0, e.from) + e.insert + text.slice(e.to);
}

export type LineTrace =
	/** The line was changed on this device since the last sync (not in any commit yet). */
	| { kind: "local" }
	/** versions[index] is the commit that last changed the line. `atLeast`: history ran out, it may be older. */
	| { kind: "commit"; index: number; atLeast: boolean }
	/** No history to look at. */
	| { kind: "none" };

/**
 * Finds the most recent version that changed line `line` (0-based) of `current`.
 * `load(k)` gives the file's text in history version k (0 = newest, as listed by the host; null =
 * missing there, or not text). `count` versions exist in the walk; `complete` says whether they
 * reach the file's first version (else a line older than all of them is reported with atLeast).
 * Versions are loaded lazily: the walk stops at the first version where the line changed.
 */
export async function traceLine(
	current: string,
	line: number,
	count: number,
	load: (k: number) => Promise<string | null>,
	complete: boolean,
): Promise<LineTrace> {
	if (count === 0) return { kind: "none" };
	let text = editorLines(current);
	let pos = line;
	const newest = await load(0);
	if (newest === null) return { kind: "local" };
	let prev = editorLines(newest);
	// The current text against the newest version: lines that don't match were edited here.
	const back = match(prev, text);
	pos = indexOf(back, pos);
	if (pos < 0) return { kind: "local" };
	text = prev;
	for (let k = 0; k + 1 < count; k++) {
		const older = await load(k + 1);
		if (older === null) return { kind: "commit", index: k, atLeast: false };
		prev = editorLines(older);
		const p = indexOf(match(prev, text), pos);
		if (p < 0) return { kind: "commit", index: k, atLeast: false };
		pos = p;
		text = prev;
	}
	return { kind: "commit", index: count - 1, atLeast: !complete };
}

/** Position in the older text of line `pos` of the newer one, given older→newer matches; -1 if unmatched. */
function indexOf(olderToNewer: Int32Array, pos: number): number {
	for (let k = 0; k < olderToNewer.length; k++) if (olderToNewer[k] === pos) return k;
	return -1;
}

/** The device that made a commit, from its "Device:" trailer. */
export function commitDevice(message: string): string | null {
	return /^Device: (.+)$/m.exec(message)?.[1]?.trim() || null;
}
