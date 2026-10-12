import { App, FuzzySuggestModal, Modal, Notice, Setting, TFolder } from "obsidian";
import { renderDiff, renderHunkPicker } from "./diffview.ts";
import type { CommitInfo } from "./github.ts";
import type { Decision } from "./plan.ts";
import type { ConflictChoice, ConflictInfo, DeleteGuardChoice } from "./types.ts";

function list(el: HTMLElement, items: string[], max = 200) {
	const ul = el.createEl("ul", { cls: "vsg-list" });
	for (const i of items.slice(0, max)) ul.createEl("li", { text: i });
	if (items.length > max) ul.createEl("li", { text: `…and ${items.length - max} more` });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Content of the two sides of a diff; null text means binary. */
export interface DiffSides {
	oldLabel: string;
	newLabel: string;
	oldText: string | null;
	newText: string | null;
	oldSize?: number;
	newSize?: number;
}

function renderSides(el: HTMLElement, d: DiffSides) {
	if (d.oldText === null || d.newText === null) {
		el.createEl("p", {
			cls: "vsg-muted",
			text: `Binary file: no text diff. ${d.oldLabel}: ${d.oldSize ?? 0} bytes · ${d.newLabel}: ${d.newSize ?? 0} bytes.`,
		});
		return;
	}
	renderDiff(el, d.oldText, d.newText, { oldLabel: d.oldLabel, newLabel: d.newLabel });
}

/** Shows a diff that is loaded asynchronously. */
export class DiffModal extends Modal {
	constructor(app: App, private title: string, private load: () => Promise<DiffSides>) {
		super(app);
	}
	async onOpen() {
		this.modalEl.addClass("vsg-wide");
		this.titleEl.setText(this.title);
		const status = this.contentEl.createEl("p", { text: "Loading…", cls: "vsg-muted" });
		try {
			const d = await this.load();
			status.remove();
			renderSides(this.contentEl, d);
		} catch (e) {
			status.setText(`Could not load: ${errText(e)}`);
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Conflict resolution: pick change by change, see the full diff, or take a whole side. Closing = keep both (safe). */
export class ConflictModal extends Modal {
	private choice: ConflictChoice = "keep-both";
	constructor(app: App, private info: ConflictInfo, private done: (c: ConflictChoice) => void) {
		super(app);
	}
	onOpen() {
		const { contentEl, info } = this;
		this.modalEl.addClass("vsg-wide");
		this.titleEl.setText(`Conflict: ${info.path}`);
		contentEl.createEl("p", { text: "This file changed on this device and on GitHub since the last sync.", cls: "vsg-muted" });
		const pick = (c: ConflictChoice) => {
			this.choice = c;
			this.close();
		};

		if (info.localText !== null && info.remoteText !== null) {
			const tabs = contentEl.createDiv({ cls: "vsg-tabs" });
			const pane = contentEl.createDiv();
			let build: (() => string) | null = null;
			const show = (which: "pick" | "diff") => {
				pane.empty();
				tabs.querySelectorAll("button").forEach((b, i) => b.toggleClass("is-active", (i === 0) === (which === "pick")));
				if (which === "pick") {
					pane.createEl("p", { cls: "vsg-muted", text: "For each change, choose which version to keep. \"Both\" keeps this device's lines followed by GitHub's." });
					build = renderHunkPicker(pane, info.localText!, info.remoteText!, { a: "This device", b: "GitHub" });
				} else {
					build = null;
					renderDiff(pane, info.localText!, info.remoteText!, { oldLabel: "This device", newLabel: "GitHub" });
				}
			};
			tabs.createEl("button", { text: "Choose changes" }).onClickEvent(() => show("pick"));
			tabs.createEl("button", { text: "Full diff" }).onClickEvent(() => show("diff"));
			show("pick");
			new Setting(contentEl).addButton((b) =>
				b
					.setButtonText("Apply my choices")
					.setCta()
					.onClick(() => {
						if (build) pick({ custom: build() });
						else show("pick");
					}),
			);
		} else {
			contentEl.createEl("p", { text: `Binary file. This device: ${info.localSize} bytes · GitHub: ${info.remoteSize} bytes.` });
		}

		const whole = new Setting(contentEl).setName("Or take a whole file");
		whole.addButton((b) => b.setButtonText("This device").onClick(() => pick("local")));
		whole.addButton((b) => b.setButtonText("GitHub").onClick(() => pick("remote")));
		whole.addButton((b) => b.setButtonText("Keep both files").onClick(() => pick("keep-both")));
		if (info.localText !== null && info.remoteText !== null) {
			whole.addButton((b) => b.setButtonText("Merge with markers").onClick(() => pick("markers")));
		}
	}
	onClose() {
		this.contentEl.empty();
		this.done(this.choice);
	}
}

export class DeleteGuardModal extends Modal {
	private choice: DeleteGuardChoice = "cancel";
	constructor(app: App, private local: string[], private remote: string[], private done: (c: DeleteGuardChoice) => void) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Large deletion detected");
		contentEl.createEl("p", {
			text: `This sync would delete ${this.local.length + this.remote.length} files. Please confirm this is intended.`,
		});
		if (this.local.length) {
			contentEl.createEl("h4", { text: `Delete on this device (moved to trash): ${this.local.length}` });
			list(contentEl, this.local, 50);
		}
		if (this.remote.length) {
			contentEl.createEl("h4", { text: `Delete on GitHub (kept in history): ${this.remote.length}` });
			list(contentEl, this.remote, 50);
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel sync").onClick(() => this.pick("cancel")))
			.addButton((b) => b.setButtonText("Sync but skip deletions").setCta().onClick(() => this.pick("skip")))
			.addButton((b) => b.setButtonText("Delete them").setWarning().onClick(() => this.pick("proceed")));
	}
	private pick(c: DeleteGuardChoice) {
		this.choice = c;
		this.close();
	}
	onClose() {
		this.contentEl.empty();
		this.done(this.choice);
	}
}

const GROUPS: [string, Decision["kind"], string][] = [
	["Download from GitHub", "download", "arrow-down"],
	["Upload to GitHub", "upload", "arrow-up"],
	["Changed on both sides", "conflict", "git-merge"],
	["Delete on this device", "delete-local", "trash"],
	["Delete on GitHub", "delete-remote", "trash-2"],
];

/** Review before sync: every pending change with a checkbox and a diff. Unchecked files are deferred. */
export class ReviewModal extends Modal {
	private checked = new Map<string, boolean>();
	constructor(
		app: App,
		private decisions: Decision[],
		private skipped: string[],
		private loadDiff: (d: Decision) => Promise<DiffSides>,
		private onSync: (deferred: Set<string>) => void,
	) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("vsg-wide");
		this.titleEl.setText("Review changes");
		if (!this.decisions.length) {
			contentEl.createEl("p", { text: "Everything is up to date." });
			if (this.skipped.length) {
				contentEl.createEl("h4", { text: `Skipped: ${this.skipped.length}` });
				list(contentEl, this.skipped);
			}
			return;
		}
		contentEl.createEl("p", { cls: "vsg-muted", text: "Untick anything you don't want to sync yet. Unticked files are left alone on both sides until a later sync." });
		const footer = new Setting(contentEl.createDiv());
		const syncBtnRef: { set?: (n: number) => void } = {};
		const refresh = () => syncBtnRef.set?.([...this.checked.values()].filter(Boolean).length);

		for (const [title, kind] of GROUPS) {
			const items = this.decisions.filter((d) => d.kind === kind);
			if (!items.length) continue;
			const h = contentEl.createDiv({ cls: "vsg-review-group" });
			const all = h.createEl("input", { type: "checkbox" });
			all.checked = true;
			h.createSpan({ text: ` ${title} (${items.length})`, cls: "vsg-review-title" });
			const ul = contentEl.createDiv({ cls: "vsg-review-list" });
			const boxes: HTMLInputElement[] = [];
			for (const d of items) {
				this.checked.set(d.path, true);
				const row = ul.createDiv({ cls: "vsg-review-row" });
				const cb = row.createEl("input", { type: "checkbox" });
				cb.checked = true;
				cb.onchange = () => {
					this.checked.set(d.path, cb.checked);
					refresh();
				};
				boxes.push(cb);
				row.createSpan({ text: d.path, cls: "vsg-review-path" });
				const btn = row.createEl("button", { text: "Diff", cls: "vsg-review-diff" });
				btn.onClickEvent(() => new DiffModal(this.app, d.path, () => this.loadDiff(d)).open());
			}
			all.onchange = () => {
				boxes.forEach((b, i) => {
					b.checked = all.checked;
					this.checked.set(items[i].path, all.checked);
				});
				refresh();
			};
		}
		if (this.skipped.length) {
			contentEl.createEl("h4", { text: `Skipped: ${this.skipped.length}` });
			list(contentEl, this.skipped);
		}
		contentEl.appendChild(footer.settingEl.parentElement!);
		footer.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		footer.addButton((b) => {
			syncBtnRef.set = (n) => b.setButtonText(n === this.checked.size ? "Sync all" : `Sync ${n} selected`).setDisabled(n === 0);
			b.setCta().onClick(() => {
				const deferred = new Set([...this.checked].filter(([, v]) => !v).map(([p]) => p));
				this.close();
				this.onSync(deferred);
			});
		});
		refresh();
	}
	onClose() {
		this.contentEl.empty();
	}
}

export class LogModal extends Modal {
	constructor(app: App, private lines: string[]) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Sync log");
		const pre = this.contentEl.createEl("pre", { cls: "vsg-log" });
		pre.setText(this.lines.length ? [...this.lines].reverse().join("\n") : "No sync activity yet.");
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Generic list of rows loaded from GitHub; clicking a row runs it. */
export class CommitListModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private load: () => Promise<{ label: string; sub: string; run: () => void }[]>,
	) {
		super(app);
	}
	async onOpen() {
		this.titleEl.setText(this.title);
		const status = this.contentEl.createEl("p", { text: "Loading from GitHub…" });
		try {
			const rows = await this.load();
			status.remove();
			if (!rows.length) this.contentEl.createEl("p", { text: "Nothing found." });
			const ul = this.contentEl.createEl("ul", { cls: "vsg-commits" });
			for (const r of rows) {
				const li = ul.createEl("li");
				li.createDiv({ text: r.label, cls: "vsg-commit-title" });
				li.createDiv({ text: r.sub, cls: "vsg-commit-sub" });
				li.onClickEvent(() => {
					this.close();
					r.run();
				});
			}
		} catch (e) {
			status.setText(`Failed: ${errText(e)}`);
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** One historical version of a file: compare with the current file, view it, restore it. */
export class FileVersionModal extends Modal {
	constructor(
		app: App,
		private path: string,
		private commit: CommitInfo | { sha: string; message: string; date: string },
		private text: string | null,
		private size: number,
		private currentText: string | null | undefined,
		private onRestore: (asCopy: boolean) => void,
	) {
		super(app);
	}
	onOpen() {
		this.modalEl.addClass("vsg-wide");
		this.titleEl.setText(`${this.path} @ ${this.commit.sha.slice(0, 7)}`);
		this.contentEl.createEl("p", {
			text: `${new Date(this.commit.date).toLocaleString()} · ${this.commit.message.split("\n")[0]}`,
			cls: "vsg-commit-sub",
		});
		const tabs = this.contentEl.createDiv({ cls: "vsg-tabs" });
		const pane = this.contentEl.createDiv();
		const canDiff = this.text !== null && typeof this.currentText === "string";
		const show = (which: "diff" | "full") => {
			pane.empty();
			tabs.querySelectorAll("button").forEach((b) => b.toggleClass("is-active", b.dataset.k === which));
			if (which === "diff" && canDiff) renderDiff(pane, this.currentText as string, this.text!, { oldLabel: "Current file", newLabel: "This version" });
			else pane.createEl("pre", { cls: "vsg-version", text: this.text ?? `(binary file, ${this.size} bytes)` });
		};
		if (canDiff) {
			const b = tabs.createEl("button", { text: "Compare with current" });
			b.dataset.k = "diff";
			b.onClickEvent(() => show("diff"));
		}
		const f = tabs.createEl("button", { text: "Full version" });
		f.dataset.k = "full";
		f.onClickEvent(() => show("full"));
		show(canDiff ? "diff" : "full");
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("Restore as copy").onClick(() => {
					this.close();
					this.onRestore(true);
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Restore this version")
					.setCta()
					.onClick(() => {
						this.close();
						this.onRestore(false);
					}),
			);
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Confirmation listing exactly what an operation will change. */
export class ConfirmPlanModal extends Modal {
	private ok = false;
	constructor(
		app: App,
		private title: string,
		private intro: string,
		private sections: { title: string; items: string[] }[],
		private confirmText: string,
		private warning: boolean,
		private done: (ok: boolean) => void,
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.intro });
		for (const s of this.sections) {
			if (!s.items.length) continue;
			this.contentEl.createEl("h4", { text: `${s.title}: ${s.items.length}` });
			list(this.contentEl, s.items, 100);
		}
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.confirmText).onClick(() => {
					this.ok = true;
					this.close();
				});
				if (this.warning) b.setWarning();
				else b.setCta();
			});
	}
	onClose() {
		this.contentEl.empty();
		this.done(this.ok);
	}
}

export function confirmPlan(app: App, title: string, intro: string, sections: { title: string; items: string[] }[], confirmText: string, warning = false): Promise<boolean> {
	return new Promise((resolve) => new ConfirmPlanModal(app, title, intro, sections, confirmText, warning, resolve).open());
}

export class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private onPick: (f: TFolder) => void) {
		super(app);
		this.setPlaceholder("Choose a folder to restore");
	}
	getItems(): TFolder[] {
		return this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && !f.isRoot());
	}
	getItemText(f: TFolder): string {
		return f.path;
	}
	onChooseItem(f: TFolder): void {
		this.onPick(f);
	}
}

export interface TimelineEntry {
	sha: string;
	message: string;
	date: string;
	author: string;
	tags: string[];
}

/** Timeline of commits and snapshots, with restore actions per point in time. */
export class TimelineModal extends Modal {
	constructor(
		app: App,
		private load: () => Promise<TimelineEntry[]>,
		private actions: {
			restoreVault: (e: TimelineEntry) => void;
			restoreFolder: (e: TimelineEntry) => void;
			browse: (e: TimelineEntry) => void;
		},
	) {
		super(app);
	}
	async onOpen() {
		this.modalEl.addClass("vsg-wide");
		this.titleEl.setText("Timeline");
		this.contentEl.createEl("p", {
			cls: "vsg-muted",
			text: "Every sync is a point you can go back to. Restoring adds a new commit on top, so the current state stays in history too.",
		});
		const status = this.contentEl.createEl("p", { text: "Loading from GitHub…" });
		try {
			const entries = await this.load();
			status.remove();
			const ul = this.contentEl.createEl("ul", { cls: "vsg-commits vsg-timeline" });
			for (const e of entries) {
				const li = ul.createEl("li");
				const title = li.createDiv({ cls: "vsg-commit-title" });
				for (const t of e.tags) title.createSpan({ cls: "vsg-tag", text: t });
				title.appendText(e.message.split("\n")[0]);
				li.createDiv({ text: `${new Date(e.date).toLocaleString()} · ${e.author} · ${e.sha.slice(0, 7)}`, cls: "vsg-commit-sub" });
				const acts = li.createDiv({ cls: "vsg-timeline-actions" });
				const act = (label: string, fn: () => void) =>
					acts.createEl("button", { text: label }).onClickEvent((ev) => {
						ev.stopPropagation();
						this.close();
						fn();
					});
				act("Browse files", () => this.actions.browse(e));
				act("Restore a folder…", () => this.actions.restoreFolder(e));
				act("Restore whole vault", () => this.actions.restoreVault(e));
				li.onClickEvent(() => li.toggleClass("is-open", !li.hasClass("is-open")));
			}
		} catch (e) {
			status.setText(`Failed: ${errText(e)}`);
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

export function notice(msg: string, ms = 5000) {
	new Notice(msg, ms);
}
