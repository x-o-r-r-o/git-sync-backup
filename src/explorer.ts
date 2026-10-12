// Sync status in the file explorer: a dot on files edited since the last sync and a mark on conflict
// copies. The explorer only renders visible rows, so rows are marked as they appear (MutationObserver).
// Uses the explorer's `data-path` attribute; styling is in styles.css.

import type { App } from "obsidian";
import { conflictCopyOriginal } from "./util.ts";
import { t } from "./i18n.ts";

const PENDING = "vsg-x-pending";
const CONFLICT = "vsg-x-conflict";

export class ExplorerBadges {
	private app: App;
	private pending: () => Set<string>;
	private enabled: () => boolean;
	private observers = new Map<HTMLElement, MutationObserver>();
	private status = new Map<string, string>();

	constructor(app: App, pending: () => Set<string>, enabled: () => boolean) {
		this.app = app;
		this.pending = pending;
		this.enabled = enabled;
	}

	/** Recompute statuses and re-mark every rendered row. Cheap: runs after syncs and edits (debounced). */
	refresh() {
		this.status.clear();
		if (this.enabled()) {
			for (const p of this.pending()) this.status.set(p, PENDING);
			for (const f of this.app.vault.getFiles()) if (conflictCopyOriginal(f.path)) this.status.set(f.path, CONFLICT);
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
		const rows = root.matches?.(".nav-file-title[data-path]") ? [root] : Array.from(root.querySelectorAll<HTMLElement>(".nav-file-title[data-path]"));
		for (const el of rows) {
			const cls = this.status.get(el.dataset.path ?? "");
			el.toggleClass(PENDING, cls === PENDING);
			el.toggleClass(CONFLICT, cls === CONFLICT);
			if (cls) el.setAttr("aria-description", cls === PENDING ? t("x.pending") : t("x.conflict"));
			else el.removeAttribute("aria-description");
		}
	}

	private clear(root: HTMLElement) {
		for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${PENDING}, .${CONFLICT}`))) {
			el.removeClasses([PENDING, CONFLICT]);
			el.removeAttribute("aria-description");
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
