// History sidebar: recent syncs (commits) of the main repository with device, author and changed files.
// Expanding a sync lists its files (decoded: encrypted names show decrypted); a file opens its diff
// against the previous version. Restore actions reuse the timeline's code. Works with keyboard and touch.

import { debounce, ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type { CommitInfo } from "./remote.ts";
import { appendPage, filterFiles, HISTORY_PAGE } from "./history.ts";
import type { FileStatus, HistoryCommit, HistoryFile } from "./history.ts";
import { clickable } from "./diffview.ts";
import { t } from "./i18n.ts";
import type { Key } from "./i18n.ts";

export const HISTORY_VIEW = "vault-sync-history";

export interface CommitFiles {
	parent: string | null;
	files: HistoryFile[];
}

/** What the sidebar needs from the plugin (kept narrow so main.ts stays the only owner of sync state). */
export interface HistoryHost {
	/** Why history can't be shown (not set up), or null. */
	problem(): string | null;
	/** Encrypted repository without the key on this device (names would be scrambled). `ask` opens the unlock dialog. */
	needsUnlock(ask: boolean): Promise<boolean>;
	/** Changes when the listed history may have changed (repository, branch, folder or last-synced commit). */
	version(): string;
	listCommits(page: number): Promise<CommitInfo[]>;
	commitFiles(sha: string): Promise<CommitFiles>;
	showDiff(c: HistoryCommit, parent: string | null, f: HistoryFile): void;
	restoreFile(c: HistoryCommit, parent: string | null, f: HistoryFile): void;
	browse(c: HistoryCommit): void;
	restoreFolder(c: HistoryCommit): void;
	restoreVault(c: HistoryCommit): void;
	deviceName(): string;
	errorText(e: unknown): string;
}

const STATUS: Record<FileStatus, { letter: string; key: Key }> = {
	added: { letter: "A", key: "hist.added" },
	modified: { letter: "M", key: "hist.modified" },
	deleted: { letter: "D", key: "hist.deleted" },
	renamed: { letter: "R", key: "hist.renamed" },
};

export class HistoryView extends ItemView {
	private commits: HistoryCommit[] = [];
	private page = 0;
	private hasMore = false;
	private loading = false;
	private error: string | null = null;
	private again = false;
	private askedUnlock = false;
	private gen = 0;
	private filter = "";
	/** host.version() of the list on screen, and whether a refresh was skipped while hidden. */
	private shownVersion: string | null = null;
	private stale = false;
	/** Changed files per commit (commits never change, so this survives refreshes). */
	private files = new Map<string, Promise<CommitFiles>>();
	private loaded = new Map<string, CommitFiles | { error: string }>();
	private expanded = new Set<string>();
	private listEl!: HTMLElement;
	private filterTimer = debounce(() => this.applyFilter(), 350, true);

	constructor(leaf: WorkspaceLeaf, private host: HistoryHost) {
		super(leaf);
	}
	getViewType() {
		return HISTORY_VIEW;
	}
	getDisplayText() {
		return t("hist.title");
	}
	getIcon() {
		return "history";
	}

	async onOpen() {
		const el = this.contentEl;
		el.empty();
		el.addClass("vsg-history");
		const bar = el.createDiv({ cls: "vsg-hist-bar" });
		const input = bar.createEl("input", { type: "search", cls: "vsg-hist-filter", attr: { placeholder: t("hist.filter"), "aria-label": t("hist.filter") } });
		input.addEventListener("input", () => {
			this.filter = input.value;
			this.filterTimer();
		});
		const refresh = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": t("h.refresh") } });
		setIcon(refresh, "refresh-cw");
		refresh.onClickEvent(() => this.refresh());
		this.listEl = el.createDiv({ cls: "vsg-hist-list" });
		// A refresh skipped while the sidebar was hidden happens when it is shown again.
		const wake = () => {
			if (this.stale && this.containerEl.isShown()) {
				this.stale = false;
				this.refresh();
			}
		};
		this.registerEvent(this.app.workspace.on("layout-change", wake));
		this.registerEvent(this.app.workspace.on("active-leaf-change", wake));
		this.wake = wake;
		this.refresh();
	}

	private wake: (() => void) | null = null;
	onResize() {
		this.wake?.();
	}

	/**
	 * After a sync: reload only when the repository moved on since the list on screen was loaded, and
	 * only while the sidebar is visible (a hidden one reloads when shown). Saves its API calls otherwise.
	 */
	refreshIfChanged() {
		if (!this.listEl) return;
		if (!this.error && this.shownVersion !== null && this.host.version() === this.shownVersion) return;
		if (!this.containerEl.isShown()) return void (this.stale = true);
		this.refresh();
	}

	async onClose() {
		this.askedUnlock = false;
		this.filterTimer.cancel();
		this.gen++;
	}

	/** Reloads the newest syncs (after a sync, or from the refresh button). */
	refresh() {
		if (!this.listEl) return;
		if (this.loading) return void (this.again = true);
		void this.fetchPage(true);
	}

	private async fetchPage(reset: boolean) {
		const problem = this.host.problem();
		if (problem) {
			this.commits = [];
			this.error = problem;
			return this.render();
		}
		// Ask to unlock once per opening; later refreshes (after each sync) only check, without dialogs.
		const ask = !this.askedUnlock;
		this.askedUnlock = true;
		if (reset && (await this.host.needsUnlock(ask))) {
			this.error = t("m.unlockToBrowse");
			return this.render();
		}
		const gen = ++this.gen;
		this.loading = true;
		this.error = null;
		this.render();
		const version = this.host.version();
		try {
			const page = reset ? 1 : this.page + 1;
			const list = await this.host.listCommits(page);
			if (gen !== this.gen) return;
			if (reset) this.shownVersion = version;
			this.commits = appendPage(reset ? [] : this.commits, list);
			this.page = page;
			this.hasMore = list.length >= HISTORY_PAGE;
		} catch (e) {
			if (gen === this.gen) this.error = t("u.failed", { error: this.host.errorText(e) });
		} finally {
			if (gen === this.gen) {
				this.loading = false;
				if (this.again) {
					this.again = false;
					void this.fetchPage(true);
				} else if (this.filter.trim()) this.applyFilter();
				else this.render();
			}
		}
	}

	private filesOf(sha: string): Promise<CommitFiles> {
		let p = this.files.get(sha);
		if (!p) {
			p = this.host.commitFiles(sha);
			this.files.set(sha, p);
			p.then(
				(r) => this.loaded.set(sha, r),
				(e) => {
					// A failed request can be tried again by collapsing and expanding.
					this.files.delete(sha);
					this.loaded.set(sha, { error: this.host.errorText(e) });
				},
			);
		}
		return p;
	}

	/** With a filter, the file lists of all loaded syncs are needed (fetched a few at a time, then cached). */
	private applyFilter() {
		if (!this.filter.trim()) return this.render();
		const todo = this.commits.filter((c) => !this.loaded.has(c.sha));
		this.render();
		let next = 0;
		const gen = this.gen;
		const worker = async () => {
			while (next < todo.length && gen === this.gen) {
				const c = todo[next++];
				await this.filesOf(c.sha).catch(() => null);
				this.render();
			}
		};
		void Promise.all([worker(), worker(), worker(), worker()]);
	}

	private toggle(c: HistoryCommit) {
		if (this.expanded.has(c.sha)) this.expanded.delete(c.sha);
		else {
			this.expanded.add(c.sha);
			if (!this.loaded.has(c.sha) || "error" in this.loaded.get(c.sha)!) {
				this.loaded.delete(c.sha);
				void this.filesOf(c.sha).catch(() => null).then(() => this.render());
			}
		}
		this.render();
	}

	private render() {
		const el = this.listEl;
		if (!el) return;
		// Keep keyboard focus on the same row across re-renders.
		const focused = (document.activeElement as HTMLElement | null)?.closest?.("[data-focus]")?.getAttribute("data-focus") ?? null;
		el.empty();
		if (this.error) el.createDiv({ cls: "vsg-muted vsg-hist-msg", text: this.error });
		const q = this.filter.trim();
		let shown = 0;
		let pending = 0;
		const ul = el.createEl("ul", { cls: "vsg-hist-commits" });
		for (const c of this.commits) {
			const info = this.loaded.get(c.sha);
			let files: HistoryFile[] | null = info && !("error" in info) ? info.files : null;
			if (q) {
				if (!info) {
					pending++;
					continue;
				}
				files = files ? filterFiles(files, q) : [];
				if (!files.length) continue;
			}
			shown++;
			this.renderCommit(ul, c, q ? files : null, info);
		}
		if (!this.commits.length && !this.loading && !this.error) el.createDiv({ cls: "vsg-muted vsg-hist-msg", text: t("hist.empty") });
		if (q && !shown && !pending && this.commits.length) el.createDiv({ cls: "vsg-muted vsg-hist-msg", text: t("hist.noMatch") });
		if (this.loading || pending) el.createDiv({ cls: "vsg-muted vsg-hist-msg", text: t("u.loadingShort") });
		else if (this.hasMore) {
			const more = el.createEl("button", { text: t("hist.loadMore"), cls: "vsg-hist-more", attr: { "data-focus": "more" } });
			more.onClickEvent(() => void this.fetchPage(false));
		}
		if (focused) el.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
	}

	private renderCommit(ul: HTMLElement, c: HistoryCommit, matching: HistoryFile[] | null, info: CommitFiles | { error: string } | undefined) {
		const open = matching !== null || this.expanded.has(c.sha);
		const li = ul.createEl("li", { cls: "vsg-hist-commit" });
		li.toggleClass("is-open", open);
		const head = li.createDiv({ cls: "vsg-hist-head", attr: { "data-focus": c.sha } });
		const chevron = head.createSpan({ cls: "vsg-hist-chevron" });
		setIcon(chevron, open ? "chevron-down" : "chevron-right");
		const text = head.createDiv({ cls: "vsg-hist-text" });
		text.createDiv({ cls: "vsg-commit-title", text: c.title });
		const mine = c.device && c.device === this.host.deviceName() ? ` ${t("health.thisDevice")}` : "";
		const sub = [new Date(c.date).toLocaleString(), c.device ? c.device + mine : null, c.author && c.author !== c.device ? c.author : null, c.sha.slice(0, 7)].filter(Boolean).join(" · ");
		text.createDiv({ cls: "vsg-commit-sub", text: sub });
		head.setAttr("aria-expanded", String(open));
		if (matching === null) clickable(head, () => this.toggle(c), `${c.title} · ${sub}`);
		if (!open) return;

		const body = li.createDiv({ cls: "vsg-hist-body" });
		if (!info) body.createDiv({ cls: "vsg-muted", text: t("u.loadingShort") });
		else if ("error" in info) body.createDiv({ cls: "vsg-muted", text: t("u.failed", { error: info.error }) });
		else {
			const files = matching ?? info.files;
			if (!files.length) body.createDiv({ cls: "vsg-muted", text: t("hist.noFiles") });
			const list = body.createEl("ul", { cls: "vsg-hist-files" });
			for (const f of files) {
				const row = list.createEl("li", { cls: "vsg-hist-file" });
				const s = STATUS[f.status];
				const label = t(s.key);
				const name = row.createDiv({ cls: "vsg-hist-name", attr: { "data-focus": `${c.sha}:${f.path}` } });
				name.createSpan({ cls: `vsg-hist-status is-${f.status}`, text: s.letter, attr: { title: label, "aria-hidden": "true" } });
				const p = name.createSpan({ cls: "vsg-hist-path", text: f.path });
				if (f.previous) p.createSpan({ cls: "vsg-muted", text: ` ${t("hist.renamedFrom", { path: f.previous })}` });
				clickable(name, () => this.host.showDiff(c, info.parent, f), `${label}: ${f.path}`);
				const restore = row.createEl("button", { text: t("hist.restoreFile"), cls: "vsg-hist-restore" });
				restore.setAttr("aria-label", `${t("hist.restoreFile")}: ${f.path}`);
				restore.onClickEvent(() => this.host.restoreFile(c, info.parent, f));
			}
		}
		const acts = body.createDiv({ cls: "vsg-hist-actions" });
		acts.createEl("button", { text: t("u.browseFiles") }).onClickEvent(() => this.host.browse(c));
		acts.createEl("button", { text: t("u.restoreFolder") }).onClickEvent(() => this.host.restoreFolder(c));
		acts.createEl("button", { text: t("u.restoreVault") }).onClickEvent(() => this.host.restoreVault(c));
	}
}
