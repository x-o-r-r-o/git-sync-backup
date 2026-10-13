import { App, ButtonComponent, FuzzySuggestModal, Modal, Notice, Setting, TFolder } from "obsidian";
import { clickable, renderDiff, renderHunkPicker } from "./diffview.ts";
import type { CommitInfo } from "./github.ts";
import type { Decision } from "./plan.ts";
import type { ConflictChoice, ConflictInfo, DeleteGuardChoice } from "./types.ts";
import { t as tr } from "./i18n.ts";
import { localizeError } from "./errors.ts";

function list(el: HTMLElement, items: string[], max = 200) {
	const ul = el.createEl("ul", { cls: "vsg-list" });
	for (const i of items.slice(0, max)) ul.createEl("li", { text: i });
	if (items.length > max) ul.createEl("li", { text: tr("u.andMore", { n: items.length - max }) });
}

const errText = (e: unknown) => localizeError(e);

/** Destructive (red) button style. */
export function destructive(b: ButtonComponent): ButtonComponent {
	// setDestructive needs 1.13; setWarning works on every supported version (deprecated, not removed).
	return b.setWarning();
}

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
			text: tr("u.binaryDiff", { a: d.oldLabel, as: d.oldSize ?? 0, b: d.newLabel, bs: d.newSize ?? 0 }),
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
		const status = this.contentEl.createEl("p", { text: tr("u.loadingShort"), cls: "vsg-muted" });
		try {
			const d = await this.load();
			status.remove();
			renderSides(this.contentEl, d);
		} catch (e) {
			status.setText(tr("u.loadFailed", { error: errText(e) }));
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
		this.titleEl.setText(info.title ?? tr("u.conflictTitle", { path: info.path }));
		const R = info.remoteLabel ?? tr("u.repository");
		const L = info.localLabel ?? tr("u.thisDevice");
		if (!info.title) contentEl.createEl("p", { text: tr("u.conflictBody", { host: R }), cls: "vsg-muted" });
		const pick = (c: ConflictChoice) => {
			this.choice = c;
			this.close();
		};

		if (info.localText !== null && info.remoteText !== null) {
			const tabs = contentEl.createDiv({ cls: "vsg-tabs", attr: { role: "tablist" } });
			// Both panes are built up front and share one grid cell; the inactive one is only made invisible,
			// so picks survive switching and the dialog keeps the taller pane's height on either tab.
			const panes = contentEl.createDiv({ cls: "vsg-cf-panes" });
			const pickPane = panes.createDiv({ cls: "vsg-cf-pane", attr: { role: "tabpanel" } });
			pickPane.createEl("p", { cls: "vsg-muted", text: tr("u.pickHint") });
			const build = renderHunkPicker(pickPane, info.localText, info.remoteText, { a: L, b: R });
			const diffPane = panes.createDiv({ cls: "vsg-cf-pane", attr: { role: "tabpanel" } });
			renderDiff(diffPane, info.localText, info.remoteText, { oldLabel: L, newLabel: R });
			let current: "pick" | "diff" = "pick";
			const pickTab = tabs.createEl("button", { text: tr("u.chooseChanges"), attr: { role: "tab" } });
			const diffTab = tabs.createEl("button", { text: tr("u.fullDiff"), attr: { role: "tab" } });
			const show = (which: "pick" | "diff") => {
				current = which;
				pickPane.toggleClass("vsg-cf-hidden", which !== "pick");
				diffPane.toggleClass("vsg-cf-hidden", which !== "diff");
				pickPane.setAttr("aria-hidden", String(which !== "pick"));
				diffPane.setAttr("aria-hidden", String(which !== "diff"));
				for (const [tab, k] of [[pickTab, "pick"], [diffTab, "diff"]] as const) {
					tab.toggleClass("is-active", k === which);
					tab.setAttr("aria-selected", String(k === which));
				}
			};
			pickTab.onClickEvent(() => show("pick"));
			diffTab.onClickEvent(() => show("diff"));
			show("pick");
			new Setting(contentEl).addButton((b) =>
				b
					.setButtonText(tr("u.apply"))
					.setCta()
					.onClick(() => {
						if (current === "pick") pick({ custom: build() });
						else show("pick");
					}),
			);
		} else {
			contentEl.createEl("p", { text: tr("u.binaryConflict", { a: info.localSize, host: R, b: info.remoteSize }) });
		}

		const whole = new Setting(contentEl).setName(tr("u.wholeFile"));
		whole.addButton((b) => b.setButtonText(L).onClick(() => pick("local")));
		whole.addButton((b) => b.setButtonText(R).onClick(() => pick("remote")));
		whole.addButton((b) => b.setButtonText(tr("u.keepBoth")).onClick(() => pick("keep-both")));
		if (info.markers !== false && info.localText !== null && info.remoteText !== null) {
			whole.addButton((b) => b.setButtonText(tr("u.markers")).onClick(() => pick("markers")));
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
		this.titleEl.setText(tr("u.guardTitle"));
		contentEl.createEl("p", {
			text: tr("u.guardBody", { n: this.local.length + this.remote.length }),
		});
		if (this.local.length) {
			contentEl.createEl("h4", { text: tr("u.guardLocal", { n: this.local.length }) });
			list(contentEl, this.local, 50);
		}
		if (this.remote.length) {
			contentEl.createEl("h4", { text: tr("u.guardRemote", { n: this.remote.length }) });
			list(contentEl, this.remote, 50);
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(tr("u.cancelSync")).onClick(() => this.pick("cancel")))
			.addButton((b) => b.setButtonText(tr("u.skipDeletes")).setCta().onClick(() => this.pick("skip")))
			.addButton((b) => destructive(b.setButtonText(tr("u.deleteThem"))).onClick(() => this.pick("proceed")));
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

const groups = (): [string, Decision["kind"]][] => [
	[tr("u.gDownload"), "download"],
	[tr("u.gUpload"), "upload"],
	[tr("u.gMoveLocal"), "move-local"],
	[tr("u.gAdopt"), "adopt-remote-edit"],
	[tr("u.gRenameMerge"), "rename-merge"],
	[tr("u.gConflict"), "conflict"],
	[tr("u.gDeleteLocal"), "delete-local"],
	[tr("u.gDeleteRemote"), "delete-remote"],
];

/** Review before sync: every pending change with a checkbox and a diff. Unchecked files are deferred. */
export class ReviewModal extends Modal {
	private checked = new Map<string, boolean>();
	constructor(
		app: App,
		private decisions: Decision[],
		private skipped: string[],
		private loadDiff: (d: Decision) => Promise<DiffSides>,
		/** null = preview only (dry run): no checkboxes and no sync button. */
		private onSync: ((deferred: Set<string>) => void) | null,
	) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.modalEl.addClass("vsg-wide");
		const preview = !this.onSync;
		this.titleEl.setText(preview ? tr("u.previewTitle") : tr("u.reviewTitle"));
		if (!this.decisions.length) {
			contentEl.createEl("p", { text: tr("u.upToDate") });
			if (this.skipped.length) {
				contentEl.createEl("h4", { text: tr("u.skipped", { n: this.skipped.length }) });
				list(contentEl, this.skipped);
			}
			return;
		}
		contentEl.createEl("p", { cls: "vsg-muted", text: preview ? tr("u.previewHint") : tr("u.reviewHint") });
		const footer = new Setting(contentEl.createDiv());
		const syncBtnRef: { set?: (n: number) => void } = {};
		const refresh = () => syncBtnRef.set?.([...this.checked.values()].filter(Boolean).length);
		// Long lists (first sync, imports): filter by kind and search by name. Hidden rows keep their tick.
		const filterBar = this.decisions.length > 8 ? contentEl.createDiv({ cls: "vsg-review-filter" }) : null;
		const shown: { h: HTMLElement; ul: HTMLElement; kind: Decision["kind"]; rows: { el: HTMLElement; path: string }[] }[] = [];

		for (const [title, kind] of groups()) {
			const items = this.decisions.filter((d) => d.kind === kind);
			if (!items.length) continue;
			const h = contentEl.createDiv({ cls: "vsg-review-group" });
			const all = h.createEl("input", { type: "checkbox" });
			all.setAttr("aria-label", tr("u.selectGroup", { group: title }));
			all.checked = true;
			all.toggleClass("vsg-hidden", preview);
			h.createSpan({ text: ` ${title} (${items.length})`, cls: "vsg-review-title" });
			const ul = contentEl.createDiv({ cls: "vsg-review-list" });
			shown.push({ h, ul, kind, rows: [] });
			const boxes: HTMLInputElement[] = [];
			for (const d of items) {
				this.checked.set(d.path, true);
				const row = ul.createDiv({ cls: "vsg-review-row" });
				shown[shown.length - 1]?.rows.push({ el: row, path: ("from" in d ? `${d.from} ` : "") + d.path });
				const cb = row.createEl("input", { type: "checkbox" });
				cb.setAttr("aria-label", tr("u.includeFile", { path: d.path }));
				cb.checked = true;
				cb.toggleClass("vsg-hidden", preview);
				cb.onchange = () => {
					this.checked.set(d.path, cb.checked);
					refresh();
				};
				boxes.push(cb);
				const from = "from" in d ? d.from : "renamedFrom" in d && d.renamedFrom ? d.renamedFrom : null;
				row.createSpan({ text: from ? `${from} → ${d.path}` : d.path, cls: "vsg-review-path" });
				const btn = row.createEl("button", { text: tr("u.diff"), cls: "vsg-review-diff" });
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
		if (filterBar) {
			const kinds: Record<string, Decision["kind"][]> = {
				all: [],
				up: ["upload"],
				down: ["download", "move-local", "adopt-remote-edit"],
				del: ["delete-local", "delete-remote"],
				conflict: ["conflict", "rename-merge"],
			};
			let current = "all";
			const search = filterBar.createEl("input", { type: "search", cls: "vsg-review-search", placeholder: tr("u.filterSearch") });
			const chips = filterBar.createDiv({ cls: "vsg-chips" });
			const apply = () => {
				const q = search.value.toLowerCase();
				for (const g of shown) {
					const kindOk = current === "all" || kinds[current].includes(g.kind);
					let any = false;
					for (const r of g.rows) {
						const ok = kindOk && (!q || r.path.toLowerCase().includes(q));
						r.el.toggleClass("vsg-hidden", !ok);
						any ||= ok;
					}
					g.h.toggleClass("vsg-hidden", !any);
					g.ul.toggleClass("vsg-hidden", !any);
				}
			};
			const labels: [string, string][] = [["all", tr("u.filterAll")], ["up", tr("u.filterUploads")], ["down", tr("u.filterDownloads")], ["del", tr("u.filterDeletes")], ["conflict", tr("u.filterConflicts")]];
			for (const [key, label] of labels) {
				const n = key === "all" ? this.decisions.length : this.decisions.filter((d) => kinds[key].includes(d.kind)).length;
				if (key !== "all" && !n) continue;
				const chip = chips.createEl("button", { text: `${label} (${n})`, cls: key === current ? "vsg-chip is-active" : "vsg-chip" });
				chip.onClickEvent(() => {
					current = key;
					chips.querySelectorAll(".vsg-chip").forEach((c) => c.removeClass("is-active"));
					chip.addClass("is-active");
					apply();
				});
			}
			search.oninput = apply;
		}
		if (this.skipped.length) {
			contentEl.createEl("h4", { text: tr("u.skipped", { n: this.skipped.length }) });
			list(contentEl, this.skipped);
		}
		contentEl.appendChild(footer.settingEl.parentElement!);
		footer.addButton((b) => b.setButtonText(preview ? tr("u.close") : tr("u.cancel")).onClick(() => this.close()));
		if (preview) return;
		footer.addButton((b) => {
			syncBtnRef.set = (n) => {
				b.setButtonText(n === this.checked.size ? tr("u.syncAll") : tr("u.syncSelected", { n })).setDisabled(n === 0);
			};
			b.setCta().onClick(() => {
				// A rename involves two paths: defer both so neither half runs alone.
				const deferred = new Set<string>();
				for (const d of this.decisions) {
					if (this.checked.get(d.path)) continue;
					deferred.add(d.path);
					if ("from" in d) deferred.add(d.from);
					if (d.kind === "upload" && d.renamedFrom) deferred.add(d.renamedFrom);
					if (d.kind === "delete-remote" && d.renamedTo) deferred.add(d.renamedTo);
				}
				this.close();
				this.onSync?.(deferred);
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
		this.titleEl.setText(tr("u.logTitle"));
		const pre = this.contentEl.createEl("pre", { cls: "vsg-log" });
		pre.setText(this.lines.length ? [...this.lines].reverse().join("\n") : tr("u.noActivity"));
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
		const status = this.contentEl.createEl("p", { text: tr("u.loading") });
		try {
			const rows = await this.load();
			status.remove();
			if (!rows.length) this.contentEl.createEl("p", { text: tr("u.nothingFound") });
			const ul = this.contentEl.createEl("ul", { cls: "vsg-commits" });
			for (const r of rows) {
				const li = ul.createEl("li");
				li.createDiv({ text: r.label, cls: "vsg-commit-title" });
				li.createDiv({ text: r.sub, cls: "vsg-commit-sub" });
				clickable(li, () => {
					this.close();
					r.run();
				});
			}
		} catch (e) {
			status.setText(tr("u.failed", { error: errText(e) }));
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
		private onRestore: (asCopy: boolean) => void | Promise<void>,
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
		const tabs = this.contentEl.createDiv({ cls: "vsg-tabs", attr: { role: "tablist" } });
		const pane = this.contentEl.createDiv();
		const canDiff = this.text !== null && typeof this.currentText === "string";
		const show = (which: "diff" | "full") => {
			pane.empty();
			tabs.querySelectorAll("button").forEach((b) => {
				b.toggleClass("is-active", b.dataset.k === which);
				b.setAttr("aria-selected", String(b.dataset.k === which));
			});
			if (which === "diff" && canDiff) renderDiff(pane, this.currentText as string, this.text!, { oldLabel: tr("u.currentFile"), newLabel: tr("u.thisVersion") });
			else pane.createEl("pre", { cls: "vsg-version", text: this.text ?? tr("u.binaryFile", { n: this.size }) });
		};
		if (canDiff) {
			const b = tabs.createEl("button", { text: tr("u.compareCurrent"), attr: { role: "tab" } });
			b.dataset.k = "diff";
			b.onClickEvent(() => show("diff"));
		}
		const f = tabs.createEl("button", { text: tr("u.fullVersion"), attr: { role: "tab" } });
		f.dataset.k = "full";
		f.onClickEvent(() => show("full"));
		show(canDiff ? "diff" : "full");
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText(tr("u.restoreCopy")).onClick(() => {
					this.close();
					void this.onRestore(true);
				}),
			)
			.addButton((b) =>
				b
					.setButtonText(tr("u.restoreThis"))
					.setCta()
					.onClick(() => {
						this.close();
						void this.onRestore(false);
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
			.addButton((b) => b.setButtonText(tr("u.cancel")).onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.confirmText).onClick(() => {
					this.ok = true;
					this.close();
				});
				if (this.warning) destructive(b);
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
		this.setPlaceholder(tr("u.pickFolder"));
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

export interface RepoChoice {
	owner: string;
	name: string;
	private: boolean;
	defaultBranch: string;
}

/** Pick one of the repositories the token (or the signed-in app) can use. */
export class RepoSuggestModal extends FuzzySuggestModal<RepoChoice> {
	constructor(app: App, private repos: RepoChoice[], private onPick: (r: RepoChoice) => void) {
		super(app);
		this.setPlaceholder(tr("s.repoPick"));
	}
	getItems(): RepoChoice[] {
		return this.repos;
	}
	getItemText(r: RepoChoice): string {
		return `${r.owner}/${r.name}${r.private ? "" : ` (${tr("w.public")})`}`;
	}
	onChooseItem(r: RepoChoice): void {
		this.onPick(r);
	}
}

/** Pick a remote file that wasn't downloaded to this device. */
export class RemoteOnlyModal extends FuzzySuggestModal<{ path: string; size: number }> {
	private files: { path: string; size: number }[];
	private onPick: (f: { path: string; size: number }) => void;
	constructor(app: App, files: { path: string; size: number }[], onPick: (f: { path: string; size: number }) => void) {
		super(app);
		this.files = files;
		this.onPick = onPick;
		this.setPlaceholder(tr("u.pickRemoteOnly"));
	}
	getItems() {
		return this.files;
	}
	getItemText(f: { path: string; size: number }) {
		return `${f.path} (${(f.size / 1048576).toFixed(1)} MB)`;
	}
	onChooseItem(f: { path: string; size: number }) {
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
		this.titleEl.setText(tr("u.timelineTitle"));
		this.contentEl.createEl("p", {
			cls: "vsg-muted",
			text: tr("u.timelineHint"),
		});
		const status = this.contentEl.createEl("p", { text: tr("u.loading") });
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
				act(tr("u.browseFiles"), () => this.actions.browse(e));
				act(tr("u.restoreFolder"), () => this.actions.restoreFolder(e));
				act(tr("u.restoreVault"), () => this.actions.restoreVault(e));
				clickable(li, () => li.toggleClass("is-open", !li.hasClass("is-open")));
			}
		} catch (e) {
			status.setText(tr("u.failed", { error: errText(e) }));
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

export function notice(msg: string, ms = 5000) {
	new Notice(msg, ms);
}
