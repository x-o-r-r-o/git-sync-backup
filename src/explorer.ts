// Sync status in the file explorer: a dot on files edited since the last sync, a mark on conflict
// copies, and files and folders that don't sync (excluded, outside this device's scope) greyed out. The explorer only renders visible rows, so rows are marked as they appear (MutationObserver).
// Uses the explorer's `data-path` attribute; styling is in styles.css.

import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { conflictCopyOriginal } from "./util.ts";
import { t } from "./i18n.ts";

const PENDING = "vsg-x-pending";
const CONFLICT = "vsg-x-conflict";
const EXCLUDED = "vsg-x-excluded";
const ROWS = ".nav-file-title[data-path], .nav-folder-title[data-path]";

export class ExplorerBadges {
	private app: App;
	private pending: () => Set<string>;
	private enabled: () => boolean;
	private observers = new Map<HTMLElement, MutationObserver>();
	private status = new Map<string, string>();
	private synced: (() => (path: string) => boolean) | null;
	private excluded = new Set<string>();
	/** What the scope depends on (settings, device scope, `sync: false` notes, files created/deleted/renamed). */
	private scopeKey: (() => string) | null;
	private excludedKey: string | null = null;

	constructor(app: App, pending: () => Set<string>, enabled: () => boolean, synced?: () => (path: string) => boolean, scopeKey?: () => string) {
		this.app = app;
		this.pending = pending;
		this.enabled = enabled;
		this.synced = synced ?? null;
		this.scopeKey = scopeKey ?? null;
	}

	/** Files that don't sync, and folders with nothing inside that syncs. Recomputed only when the scope key changes. */
	private computeExcluded() {
		let key: string | null = null;
		try {
			key = this.scopeKey?.() ?? null;
		} catch {
			key = null;
		}
		if (key !== null && key === this.excludedKey) return;
		this.excludedKey = key;
		this.excluded.clear();
		if (!this.synced) return;
		let inScope: (path: string) => boolean;
		try {
			inScope = this.synced();
		} catch {
			return;
		}
		const syncedFolders = new Set<string>();
		const folders: string[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f instanceof TFolder) {
				if (f.path && f.path !== "/") folders.push(f.path);
			} else if (f instanceof TFile) {
				if (!inScope(f.path)) {
					this.excluded.add(f.path);
					continue;
				}
				for (let i = f.path.lastIndexOf("/"); i > 0; i = f.path.lastIndexOf("/", i - 1)) {
					const dir = f.path.slice(0, i);
					if (syncedFolders.has(dir)) break;
					syncedFolders.add(dir);
				}
			}
		}
		for (const d of folders) if (!syncedFolders.has(d) && !inScope(d)) this.excluded.add(d);
	}

	/** Recompute statuses and re-mark every rendered row. Cheap: runs after syncs and edits (debounced). */
	refresh() {
		this.status.clear();
		if (this.enabled()) {
			for (const p of this.pending()) this.status.set(p, PENDING);
			for (const f of this.app.vault.getFiles()) if (conflictCopyOriginal(f.path)) this.status.set(f.path, CONFLICT);
			this.computeExcluded();
		} else {
			this.excluded.clear();
			this.excludedKey = null;
		}
		this.attach();
		for (const root of this.observers.keys()) this.markAll(root);
	}

	/** Watch every open file explorer (they come and go with the layout). */
	attach() {
		const roots = new Set(this.app.workspace.getLeavesOfType("file-explorer").map((l) => l.view.containerEl));
		for (const [root, obs] of this.observers) {
			if (!roots.has(root) || !this.enabled()) {
				obs.disconnect();
				this.observers.delete(root);
				this.clear(root);
			}
		}
		if (!this.enabled()) return;
		for (const root of roots) {
			if (this.observers.has(root)) continue;
			const obs = new MutationObserver((records) => {
				for (const r of records) for (const n of Array.from(r.addedNodes)) if (n.instanceOf(HTMLElement)) this.markAll(n);
			});
			obs.observe(root, { childList: true, subtree: true });
			this.observers.set(root, obs);
		}
	}

	private markAll(root: HTMLElement) {
		const rows = root.matches?.(ROWS) ? [root] : Array.from(root.querySelectorAll<HTMLElement>(ROWS));
		for (const el of rows) {
			const path = el.dataset.path ?? "";
			const cls = this.status.get(path);
			const out = this.excluded.has(path);
			el.toggleClass(PENDING, cls === PENDING && !out);
			el.toggleClass(CONFLICT, cls === CONFLICT);
			el.toggleClass(EXCLUDED, out);
			if (out) {
				el.setAttr("aria-description", t("x.excluded"));
				el.setAttr("title", t("x.excluded"));
				el.dataset.vsgTip = "1";
			} else {
				if (cls) el.setAttr("aria-description", cls === PENDING ? t("x.pending") : t("x.conflict"));
				else el.removeAttribute("aria-description");
				if (el.dataset.vsgTip) {
					el.removeAttribute("title");
					delete el.dataset.vsgTip;
				}
			}
		}
	}

	private clear(root: HTMLElement) {
		for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${PENDING}, .${CONFLICT}, .${EXCLUDED}`))) {
			el.removeClasses([PENDING, CONFLICT, EXCLUDED]);
			el.removeAttribute("aria-description");
			if (el.dataset.vsgTip) {
				el.removeAttribute("title");
				delete el.dataset.vsgTip;
			}
		}
	}

	destroy() {
		for (const [root, obs] of this.observers) {
			obs.disconnect();
			this.clear(root);
		}
		this.observers.clear();
	}
}
