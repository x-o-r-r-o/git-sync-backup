// Editor change markers: lines changed since the last sync are marked in the gutter (added,
// changed, deleted), with "revert this change", next/previous change, a popover with the
// last-synced text, and "who last changed this line" (built on the device from the file's history,
// so it works with end-to-end encryption too).
//
// The base text is the file's content at the last sync: the blob whose sha the sync state keeps,
// fetched once through the same codec layers the sync uses and kept in a small in-memory cache.
// The diff and history logic is pure and lives in change-diff.ts.

import { editorInfoField, Modal, Notice, Setting, TFile } from "obsidian";
import type { App, Editor, Plugin } from "obsidian";
import { RangeSet, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, ViewPlugin } from "@codemirror/view";
import type { PluginValue, ViewUpdate } from "@codemirror/view";
import type { SyncHost } from "./sync.ts";
import type { CommitInfo } from "./remote.ts";
import { parsePointer } from "./lfs.ts";
import { asText, errMsg, gitBlobSha } from "./util.ts";
import { commitDevice, computeHunks, hunkAt, nextHunk, revertEdit, traceLine } from "./change-diff.ts";
import type { Hunk, LineTrace } from "./change-diff.ts";
import { t } from "./i18n.ts";

/** Files (and stored blobs) above this size get no markers and no line history. */
const MAX_BYTES = 1024 * 1024;
/** How many versions "who last changed this line" looks through. */
const HISTORY_LIMIT = 30;
const RECOMPUTE_MS = 400;
const RETRY_MS = 60_000;
const COMMITS_TTL_MS = 5 * 60_000;

export interface ChangeSource {
	app: App;
	enabled(): boolean;
	/** The sync host (the vault's, or a shared folder's) whose last sync covers this vault path. */
	hostFor(path: string): SyncHost | null;
	/** Whether "who last changed this line" can look through this file's history. */
	hasHistory(path: string): boolean;
	/** Commits that changed a file, newest first. */
	listCommits(path: string, limit: number): Promise<CommitInfo[]>;
	/** A file's content at a commit, decoded on this device (null = not in that commit). */
	readVersion(path: string, sha: string): Promise<ArrayBuffer | null>;
	/** Opens one version of a file in the version modal. */
	openVersion(path: string, commit: CommitInfo): void;
	/** False (after telling the user what to do) when history can't be read yet, e.g. encryption locked. */
	canBrowse(): Promise<boolean>;
	log(msg: string): void;
}

/** A small least-recently-used map. */
class Lru<V> {
	private map = new Map<string, V>();
	constructor(private max: number) {}
	has(k: string): boolean {
		return this.map.has(k);
	}
	get(k: string): V | undefined {
		if (!this.map.has(k)) return undefined;
		const v = this.map.get(k) as V;
		this.map.delete(k);
		this.map.set(k, v);
		return v;
	}
	set(k: string, v: V) {
		this.map.delete(k);
		this.map.set(k, v);
		while (this.map.size > this.max) {
			const first = this.map.keys().next();
			if (first.done) break;
			this.map.delete(first.value);
		}
	}
	clear() {
		this.map.clear();
	}
}

type MarkKind = "add" | "change" | "delete" | "delete-below";

class ChangeMark extends GutterMarker {
	constructor(readonly kind: MarkKind) {
		super();
	}
	eq(other: GutterMarker): boolean {
		return other instanceof ChangeMark && other.kind === this.kind;
	}
	toDOM(): Node {
		return createDiv({ cls: `vsg-change-mark vsg-change-${this.kind}` });
	}
}

const MARKS: Record<MarkKind, ChangeMark> = {
	add: new ChangeMark("add"),
	change: new ChangeMark("change"),
	delete: new ChangeMark("delete"),
	"delete-below": new ChangeMark("delete-below"),
};

function buildMarks(doc: Text, hunks: Hunk[]): RangeSet<GutterMarker> {
	const b = new RangeSetBuilder<GutterMarker>();
	let last = -1;
	for (const h of hunks) {
		if (h.to > h.from) {
			for (let l = Math.max(h.from, last + 1); l < h.to && l < doc.lines; l++) {
				b.add(doc.line(l + 1).from, doc.line(l + 1).from, MARKS[h.kind]);
				last = l;
			}
		} else {
			const l = Math.min(h.from, doc.lines - 1);
			if (l <= last) continue;
			const p = doc.line(l + 1).from;
			b.add(p, p, MARKS[h.from >= doc.lines ? "delete-below" : "delete"]);
			last = l;
		}
	}
	return b.finish();
}

const setHunks = StateEffect.define<Hunk[]>();

const hunksField = StateField.define<RangeSet<GutterMarker>>({
	create: () => RangeSet.empty,
	update(marks, tr) {
		for (const e of tr.effects) if (e.is(setHunks)) return buildMarks(tr.state.doc, e.value);
		// Until the debounced recompute, existing marks move along with the edits.
		return tr.docChanged ? marks.map(tr.changes) : marks;
	},
});

/** The CodeMirror editor behind an Obsidian editor. */
function cmOf(editor: Editor): EditorView | null {
	const cm = (editor as unknown as { cm?: unknown }).cm;
	return cm instanceof EditorView ? cm : null;
}

export class ChangeMarkers {
	/** Registered with registerEditorExtension; emptied while the setting is off. */
	readonly extensions: Extension[] = [];
	private bases = new Lru<string | null>(16);
	private failed = new Map<string, number>();
	private inflight = new Map<string, Promise<string | null>>();
	private versions = new Lru<string | null>(40);
	private commits = new Map<string, { at: number; list: CommitInfo[] }>();
	readonly views = new Set<MarkerView>();
	private popover: { el: HTMLElement; close: () => void } | null = null;
	private readonly plugin: ViewPlugin<MarkerView>;
	private readonly ext: Extension;

	constructor(readonly src: ChangeSource) {
		this.plugin = ViewPlugin.define((view) => new MarkerView(view, this));
		this.ext = [
			hunksField,
			this.plugin,
			gutter({
				class: "vsg-change-gutter",
				markers: (v) => v.state.field(hunksField),
				initialSpacer: () => MARKS.change,
				domEventHandlers: {
					click: (view, block) => this.openPopover(view, view.state.doc.lineAt(block.from).number - 1),
				},
			}),
		];
		if (src.enabled()) this.extensions.push(this.ext);
	}

	/** Applies the setting: adds or removes the gutter in every open editor. */
	setEnabled(on: boolean) {
		this.closePopover();
		this.extensions.length = 0;
		if (on) this.extensions.push(this.ext);
		this.src.app.workspace.updateOptions();
	}

	/** After a sync (new base versions): reload the base of every open editor. */
	refresh() {
		this.commits.clear();
		for (const v of this.views) v.reload();
	}

	destroy() {
		this.closePopover();
	}

	/**
	 * The file's text as of the last sync. null = no markers (new file, binary, too big, or
	 * unavailable offline). Fetched once per base version; failures are retried after a minute.
	 */
	async baseFor(path: string): Promise<string | null> {
		const host = this.src.hostFor(path);
		const sha = host?.state.base[path];
		if (!host || !sha || host.state.remoteOnly?.[path]) return null;
		if (asText(path, new ArrayBuffer(0)) === null) return null;
		const f = this.src.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile && f.stat.size > MAX_BYTES) return null;
		const key = `${path}\0${sha}`;
		if (this.bases.has(key)) return this.bases.get(key) ?? null;
		const failedAt = this.failed.get(key);
		if (failedAt && Date.now() - failedAt < RETRY_MS) return null;
		const running = this.inflight.get(key);
		if (running) return running;
		const p = this.localBase(host, path, sha, f instanceof TFile ? f : null)
			.catch(() => null)
			.then((local) => (local !== null ? local : this.fetchBase(host, path, sha)))
			.then((text) => {
				this.bases.set(key, text);
				this.failed.delete(key);
				return text;
			})
			.catch((e: unknown) => {
				this.failed.set(key, Date.now());
				this.src.log(`Change markers: couldn't read the last-synced version of ${path}: ${errMsg(e)}`);
				return null;
			})
			.finally(() => this.inflight.delete(key));
		this.inflight.set(key, p);
		return p;
	}

	/**
	 * Right after a sync the file on disk usually is the last-synced version: when its stored sha (the
	 * sync's cached hash for this exact size and time, or computed for plain files) equals the base sha,
	 * the local text is the base and nothing is downloaded. null = not provably the same: fetch it.
	 */
	private async localBase(host: SyncHost, path: string, sha: string, f: TFile | null): Promise<string | null> {
		if (!f) return null;
		const c = host.state.cache[path];
		const cachedSame = !!c && c.m === f.stat.mtime && c.s === f.stat.size && c.h === sha;
		const codec = host.codec?.();
		if (!cachedSame && codec?.transformsContent) return null;
		const data = await this.src.app.vault.adapter.readBinary(path);
		if (!cachedSame && (await gitBlobSha(data)) !== sha.toLowerCase()) return null;
		if (data.byteLength > MAX_BYTES) return null;
		return asText(path, data)?.replace(/\r\n/g, "\n") ?? null;
	}

	private async fetchBase(host: SyncHost, path: string, sha: string): Promise<string | null> {
		const codec = host.codec?.();
		const head = host.state.head;
		const hint = head ? { path: codec ? await codec.encodePath(path) : path, ref: head } : undefined;
		const raw = await host.gh.getBlob(sha, hint);
		// Same check as the sync: a truncated download must never become the base.
		if (/^[0-9a-f]{40}$/i.test(sha) && (await gitBlobSha(raw)) !== sha.toLowerCase()) throw new Error("incomplete download");
		// Encryption adds a little; anything far bigger isn't worth marking.
		if (raw.byteLength > 2 * MAX_BYTES) return null;
		// A large-file (LFS) pointer is tiny; the file behind it may not be.
		const ptr = parsePointer(raw);
		if (ptr && ptr.size > MAX_BYTES) return null;
		const data = codec ? await codec.decode(path, raw) : raw;
		if (data.byteLength > MAX_BYTES) return null;
		return asText(path, data)?.replace(/\r\n/g, "\n") ?? null;
	}

	private viewState(view: EditorView): { mv: MarkerView; base: string; hunks: Hunk[] } | null {
		const mv = view.plugin(this.plugin);
		if (!mv || mv.base === null || !this.src.enabled()) return null;
		return { mv, base: mv.base, hunks: computeHunks(mv.base, view.state.doc.toString()) };
	}

	private cursorLine(view: EditorView): number {
		return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
	}

	/** Puts the change at `line` (0-based) back to its last-synced text. */
	revertAt(view: EditorView, line: number, checking = false): boolean {
		const s = this.viewState(view);
		const h = s && hunkAt(s.hunks, line, view.state.doc.lines);
		if (!h) return false;
		if (checking) return true;
		const e = revertEdit(view.state.doc.toString(), h);
		view.dispatch({ changes: e, selection: { anchor: e.from }, userEvent: "input" });
		view.focus();
		return true;
	}

	/** Moves the cursor to the next (or previous) change. */
	goTo(view: EditorView, dir: 1 | -1, checking = false): boolean {
		const s = this.viewState(view);
		const h = s && nextHunk(s.hunks, this.cursorLine(view), dir);
		if (!h) return false;
		if (checking) return true;
		const pos = view.state.doc.line(Math.min(h.from, view.state.doc.lines - 1) + 1).from;
		view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
		view.focus();
		return true;
	}

	addCommands(plugin: Plugin) {
		const onEditor = (id: string, name: string, run: (view: EditorView, checking: boolean) => boolean) =>
			plugin.addCommand({
				id,
				name,
				editorCheckCallback: (checking, editor) => {
					const view = cmOf(editor);
					return !!view && run(view, checking);
				},
			});
		onEditor("revert-change", t("cmd.revertChange"), (v, c) => this.revertAt(v, this.cursorLine(v), c));
		onEditor("next-change", t("cmd.nextChange"), (v, c) => this.goTo(v, 1, c));
		onEditor("previous-change", t("cmd.prevChange"), (v, c) => this.goTo(v, -1, c));
		plugin.addCommand({
			id: "who-changed-line",
			name: t("cmd.whoChanged"),
			editorCheckCallback: (checking, editor, ctx) => {
				const path = ctx.file?.path;
				if (!path || asText(path, new ArrayBuffer(0)) === null || !this.src.hasHistory(path)) return false;
				if (!checking) void this.whoChanged(path, editor.getValue(), editor.getCursor().line);
				return true;
			},
		});
	}

	// ---- popover ----

	closePopover() {
		this.popover?.close();
		this.popover = null;
	}

	/** Shows the last-synced text of the change at `line`, with Revert (tap or click on a marker). */
	openPopover(view: EditorView, line: number): boolean {
		const s = this.viewState(view);
		const h = s && hunkAt(s.hunks, line, view.state.doc.lines);
		if (!s || !h) return false;
		this.closePopover();
		const path = view.state.field(editorInfoField, false)?.file?.path ?? null;
		const doc = view.dom.ownerDocument;
		const el = doc.body.createDiv({ cls: "vsg-change-popover", attr: { role: "dialog" } });
		el.createDiv({ cls: "vsg-change-popover-title", text: t(h.kind === "add" ? "cm.added" : h.kind === "delete" ? "cm.deleted" : "cm.changed") });
		if (h.oldLines.length) {
			el.createDiv({ cls: "vsg-change-popover-label", text: t("cm.lastSynced") });
			el.createEl("pre", { cls: "vsg-change-old", text: h.oldLines.join("\n") });
		} else el.createEl("p", { cls: "vsg-change-popover-label", text: t("cm.newLines") });
		const row = el.createDiv({ cls: "vsg-change-popover-buttons" });
		const revert = row.createEl("button", { text: t("cm.revert"), cls: "mod-warning" });
		revert.addEventListener("click", () => {
			this.closePopover();
			this.revertAt(view, line);
		});
		if (path && h.oldLines.length && this.src.hasHistory(path)) {
			const who = row.createEl("button", { text: t("cm.who") });
			// The line as it was at the last sync: who wrote the text this change replaces.
			who.addEventListener("click", () => {
				this.closePopover();
				void this.whoChanged(path, s.base, h.oldFrom, this.src.hostFor(path)?.state.head ?? null);
			});
		}
		// Below the first line of the change, kept inside the window (phones included).
		const at = view.coordsAtPos(view.state.doc.line(Math.min(h.from, view.state.doc.lines - 1) + 1).from);
		const box = view.dom.getBoundingClientRect();
		const win = doc.defaultView ?? activeWindow;
		const w = el.getBoundingClientRect().width;
		const left = Math.max(8, Math.min(box.left + 8, win.innerWidth - w - 8));
		const below = (at?.bottom ?? box.top) + 4;
		const hgt = el.getBoundingClientRect().height;
		const top = below + hgt > win.innerHeight - 8 ? Math.max(8, (at?.top ?? below) - hgt - 4) : below;
		el.setCssProps({ "--vsg-pop-left": `${left}px`, "--vsg-pop-top": `${top}px` });
		const onDown = (e: Event) => {
			if (!el.contains(e.target as Node)) this.closePopover();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closePopover();
		};
		const onScroll = () => this.closePopover();
		doc.addEventListener("pointerdown", onDown, true);
		doc.addEventListener("keydown", onKey, true);
		view.scrollDOM.addEventListener("scroll", onScroll);
		this.popover = {
			el,
			close: () => {
				doc.removeEventListener("pointerdown", onDown, true);
				doc.removeEventListener("keydown", onKey, true);
				view.scrollDOM.removeEventListener("scroll", onScroll);
				el.remove();
			},
		};
		return true;
	}

	// ---- line authoring ----

	private async commitsFor(path: string): Promise<CommitInfo[]> {
		const c = this.commits.get(path);
		if (c && Date.now() - c.at < COMMITS_TTL_MS) return c.list;
		const list = await this.src.listCommits(path, HISTORY_LIMIT);
		this.commits.set(path, { at: Date.now(), list });
		return list;
	}

	private async versionText(path: string, sha: string): Promise<string | null> {
		const key = `${path}\0${sha}`;
		if (this.versions.has(key)) return this.versions.get(key) ?? null;
		const data = await this.src.readVersion(path, sha);
		const text = data && data.byteLength <= MAX_BYTES ? asText(path, data) : null;
		this.versions.set(key, text);
		return text;
	}

	/**
	 * The commits to trace `base` (the text at the last sync, commit `head`) through: from that commit on,
	 * not from newer remote commits made since. When `head` didn't change this file, from the newest
	 * version whose text is `base`. Unchanged when neither is found.
	 */
	private async fromLastSync(path: string, commits: CommitInfo[], head: string, base: string): Promise<CommitInfo[]> {
		const at = commits.findIndex((c) => c.sha === head);
		if (at >= 0) return commits.slice(at);
		const want = base.replace(/\r\n/g, "\n");
		for (let k = 0; k < Math.min(commits.length, 10); k++) {
			const v = await this.versionText(path, commits[k].sha);
			if (v !== null && v.replace(/\r\n/g, "\n") === want) return commits.slice(k);
		}
		return commits;
	}

	/**
	 * Finds and shows the most recent commit that changed line `line` (0-based) of `text`. `fromHead`:
	 * `text` is the version of the last sync (that commit), so newer remote commits are skipped.
	 */
	async whoChanged(path: string, text: string, line: number, fromHead: string | null = null) {
		if (text.length > MAX_BYTES) return void new Notice(t("la.tooBig"));
		if (!(await this.src.canBrowse())) return;
		const busy = new Notice(t("la.looking"), 0);
		try {
			let commits = (await this.commitsFor(path)).slice(0, HISTORY_LIMIT);
			// Whether the listed history reaches the file's first version (before skipping newer commits).
			const complete = commits.length < HISTORY_LIMIT;
			if (fromHead) commits = await this.fromLastSync(path, commits, fromHead, text);
			const r = await traceLine(text, line, commits.length, (k) => this.versionText(path, commits[k].sha), complete);
			busy.hide();
			new LineAuthorModal(this.src.app, path, r, commits, (c) => this.src.openVersion(path, c)).open();
		} catch (e) {
			busy.hide();
			new Notice(t("la.failed", { error: errMsg(e) }));
		}
	}
}

class MarkerView implements PluginValue {
	path: string | null = null;
	/** Text at the last sync; null = none known (no markers). */
	base: string | null = null;
	private token = 0;
	private timer: number | null = null;
	private dead = false;

	constructor(
		private view: EditorView,
		private ctl: ChangeMarkers,
	) {
		ctl.views.add(this);
		// Dispatching isn't allowed while the view is being built or updated.
		window.setTimeout(() => this.reload(), 0);
	}

	private filePath(): string | null {
		return this.view.state.field(editorInfoField, false)?.file?.path ?? null;
	}

	update(u: ViewUpdate) {
		if (this.filePath() !== this.path) window.setTimeout(() => this.reload(), 0);
		else if (u.docChanged) this.schedule();
	}

	reload() {
		if (this.dead) return;
		const token = ++this.token;
		this.path = this.filePath();
		this.base = null;
		const path = this.path;
		if (!path || !this.ctl.src.enabled()) return this.push([]);
		void this.ctl.baseFor(path).then((base) => {
			if (token !== this.token || this.dead) return;
			this.base = base;
			this.recompute();
		});
	}

	private schedule() {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.recompute();
		}, RECOMPUTE_MS);
	}

	private recompute() {
		if (this.dead) return;
		const doc = this.view.state.doc;
		this.push(this.base === null || doc.length > MAX_BYTES ? [] : computeHunks(this.base, doc.toString()));
	}

	private push(hunks: Hunk[]) {
		if (this.dead) return;
		this.view.dispatch({ effects: setHunks.of(hunks) });
	}

	destroy() {
		this.dead = true;
		this.ctl.views.delete(this);
		if (this.timer !== null) window.clearTimeout(this.timer);
	}
}

/** "Last changed on … by … (sha)", with a button to open that version. */
class LineAuthorModal extends Modal {
	constructor(
		app: App,
		private path: string,
		private r: LineTrace,
		private commits: CommitInfo[],
		private open_: (c: CommitInfo) => void,
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(t("la.title"));
		this.contentEl.createEl("p", { text: this.path, cls: "vsg-commit-sub" });
		const r = this.r;
		if (r.kind !== "commit") {
			this.contentEl.createEl("p", { text: t(r.kind === "local" ? "la.local" : "la.none") });
			return;
		}
		const c = this.commits[r.index];
		const vars = { date: new Date(c.date).toLocaleString(), device: commitDevice(c.message) ?? c.author, sha: c.sha.slice(0, 7), n: this.commits.length };
		this.contentEl.createEl("p", { text: t(r.atLeast ? "la.resultOlder" : "la.result", vars) });
		this.contentEl.createEl("p", { text: c.message.split("\n")[0], cls: "vsg-commit-sub" });
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText(t("la.open"))
				.setCta()
				.onClick(() => {
					this.close();
					this.open_(c);
				}),
		);
	}
	onClose() {
		this.contentEl.empty();
	}
}
