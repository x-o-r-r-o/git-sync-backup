// Sync health panel: what's going on, what's pending, what needs attention, and how to fix it.

import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type VaultSyncPlugin from "./main.ts";

export const HEALTH_VIEW = "vault-sync-health";

export interface FriendlyError {
	title: string;
	hint: string;
	action: "settings" | "retry" | "none";
}

/** Turns raw error messages into plain language with a suggested fix. */
export function friendlyError(msg: string): FriendlyError {
	const m = msg.toLowerCase();
	if (m.includes("no github token")) return { title: "Not connected yet", hint: "Add a GitHub token in the plugin settings.", action: "settings" };
	if (m.includes("invalid or expired") || m.includes("401"))
		return { title: "GitHub didn't accept your token", hint: "It may have expired or been revoked. Create a new token and paste it in settings.", action: "settings" };
	if (m.includes("not found or the token cannot access") || (m.includes("not found") && m.includes("repos")))
		return { title: "Repository not found", hint: "Check the owner and repository name, and that the token has access to this repo.", action: "settings" };
	if (m.includes("rate limit")) return { title: "GitHub rate limit reached", hint: "GitHub allows a fixed number of requests per hour. Sync will work again shortly.", action: "none" };
	if (m.includes("outdated branch state") || m.includes("another device pushed"))
		return { title: "GitHub was busy", hint: "Another device was syncing at the same moment. Try again.", action: "retry" };
	if (m.includes("network") || m.includes("failed to fetch") || m.includes("err_") || m.includes("offline") || m.includes("timed out"))
		return { title: "Can't reach GitHub", hint: "Check your internet connection. Sync will retry automatically.", action: "retry" };
	if (m.includes("pull-only")) return { title: "Not available in pull-only mode", hint: "Switch the mode in settings to push changes.", action: "settings" };
	return { title: "Sync failed", hint: msg, action: "retry" };
}

function ago(ts: number): string {
	if (!ts) return "never";
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}

export class HealthView extends ItemView {
	private plugin: VaultSyncPlugin;
	private remoteInfo: { ahead: boolean | null; budget: string; devices: [string, number][]; error?: string } | null = null;
	private loadingRemote = false;

	constructor(leaf: WorkspaceLeaf, plugin: VaultSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}
	getViewType() {
		return HEALTH_VIEW;
	}
	getDisplayText() {
		return "Sync status";
	}
	getIcon() {
		return "activity";
	}
	async onOpen() {
		this.render();
		void this.loadRemote();
	}

	/** Re-render local info immediately; optionally re-query GitHub. */
	refresh(withRemote = false) {
		this.render();
		if (withRemote) void this.loadRemote();
	}

	private async loadRemote() {
		const p = this.plugin;
		if (this.loadingRemote || !p.isConfigured()) return;
		this.loadingRemote = true;
		try {
			const [head, rl, commits] = await Promise.all([
				p.gh.getRef(p.settings.branch),
				p.gh.rateLimit().catch(() => null),
				p.gh.listCommits(p.settings.branch, undefined, 50).catch(() => []),
			]);
			const devices = new Map<string, number>();
			for (const c of commits) {
				const trailer = /^Device: (.+)$/m.exec(c.message)?.[1];
				const name = trailer ?? /^([^:\n]{1,40}):/.exec(c.message)?.[1];
				if (name && !devices.has(name)) devices.set(name, Date.parse(c.date));
			}
			this.remoteInfo = {
				ahead: head ? head !== p.state.head : null,
				budget: rl ? `${rl.remaining}/${rl.limit} requests left, resets ${new Date(rl.reset * 1000).toLocaleTimeString()}` : "unknown",
				devices: [...devices],
			};
		} catch (e) {
			this.remoteInfo = { ahead: null, budget: "unknown", devices: [], error: e instanceof Error ? e.message : String(e) };
		} finally {
			this.loadingRemote = false;
			this.render();
		}
	}

	private section(title: string, icon: string): HTMLElement {
		const s = this.contentEl.createDiv({ cls: "vsg-h-section" });
		const h = s.createDiv({ cls: "vsg-h-title" });
		setIcon(h.createSpan({ cls: "vsg-h-icon" }), icon);
		h.createSpan({ text: title });
		return s;
	}

	private button(parent: HTMLElement, label: string, fn: () => void, cta = false) {
		const b = parent.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
		b.onClickEvent(fn);
		return b;
	}

	private render() {
		const p = this.plugin;
		const el = this.contentEl;
		el.empty();
		el.addClass("vsg-health");

		// ---- status ----
		const st = el.createDiv({ cls: "vsg-h-status" });
		const icon = st.createSpan({ cls: "vsg-h-big" });
		const text = st.createDiv();
		let headline = "Up to date";
		let ico = "check-circle";
		let cls = "ok";
		if (!p.isConfigured()) [headline, ico, cls] = ["Not set up", "settings", "warn"];
		else if (p.isSyncing()) [headline, ico, cls] = ["Syncing…", "refresh-cw", "busy"];
		else if (p.lastError) [headline, ico, cls] = ["Last sync failed", "alert-octagon", "err"];
		else if (p.conflictCopies().length) [headline, ico, cls] = ["Needs attention", "alert-triangle", "warn"];
		else if (!p.state.lastSync) [headline, ico, cls] = ["Not synced yet", "cloud", "warn"];
		setIcon(icon, ico);
		st.addClass(`vsg-h-${cls}`);
		text.createDiv({ cls: "vsg-h-headline", text: headline });
		text.createDiv({
			cls: "vsg-muted",
			text: `Last sync ${ago(p.state.lastSync)} · ${p.settings.owner || "?"}/${p.settings.repo || "?"} (${p.settings.branch}) · ${p.settings.mode === "sync" ? "two-way" : p.settings.mode === "push" ? "backup only" : "pull only"}`,
		});
		const acts = el.createDiv({ cls: "vsg-h-actions" });
		if (!p.isConfigured()) this.button(acts, "Run setup wizard", () => p.openWizard(), true);
		else this.button(acts, "Sync now", () => p.sync("manual"), true);
		this.button(acts, "Review…", () => p.openReview());
		this.button(acts, "↻", () => this.refresh(true)).setAttr("aria-label", "Refresh");

		if (p.lastError) {
			const f = friendlyError(p.lastError);
			const s = this.section(f.title, "alert-octagon");
			s.addClass("vsg-h-error");
			s.createDiv({ text: f.hint });
			s.createDiv({ cls: "vsg-muted", text: `${ago(p.lastErrorAt)} · ${p.lastError}` });
			if (f.action === "settings") this.button(s, "Open settings", () => p.openSettings(), true);
			if (f.action === "retry") this.button(s, "Try again", () => p.sync("manual"), true);
		}

		// ---- pending ----
		const pend = this.section("Pending", "clock");
		const edited = p.pendingLocalCount();
		pend.createDiv({ text: edited ? `${edited} file${edited === 1 ? "" : "s"} edited on this device since the last sync` : "No local edits waiting" });
		if (this.remoteInfo?.ahead) pend.createDiv({ text: "GitHub has newer changes from another device", cls: "vsg-h-accent" });
		else if (this.remoteInfo?.ahead === false) pend.createDiv({ text: "Nothing new on GitHub", cls: "vsg-muted" });
		else if (this.loadingRemote) pend.createDiv({ text: "Checking GitHub…", cls: "vsg-muted" });
		const ds = p.deviceScope();
		if (ds.include.length || ds.exclude.length || ds.maxDownloadMB) {
			const bits = [ds.include.length && `only ${ds.include.join(", ")}`, ds.exclude.length && `excluding ${ds.exclude.join(", ")}`, ds.maxDownloadMB && `no downloads over ${ds.maxDownloadMB} MB`].filter(Boolean);
			pend.createDiv({ cls: "vsg-muted", text: `This device syncs ${bits.join("; ")}.` });
		}
		const next = p.nextScheduledSync();
		pend.createDiv({ cls: "vsg-muted", text: next ? `Next scheduled sync ${new Date(next).toLocaleTimeString()}` : "No periodic sync scheduled" });

		// ---- conflict copies ----
		const copies = p.conflictCopies();
		if (copies.length) {
			const s = this.section(`Conflict copies (${copies.length})`, "git-merge");
			s.createDiv({ cls: "vsg-muted", text: "Both versions were kept. Compare them, keep what you need, then delete the copy." });
			for (const { copy, original } of copies) {
				const row = s.createDiv({ cls: "vsg-h-row" });
				row.createDiv({ text: copy.path, cls: "vsg-h-path" });
				const b = row.createDiv({ cls: "vsg-h-row-actions" });
				if (original) this.button(b, "Compare", () => p.compareFiles(original, copy));
				this.button(b, "Open", () => void this.app.workspace.getLeaf(true).openFile(copy));
				this.button(b, "Delete copy", async () => {
					await p.trashFile(copy);
					this.refresh();
				});
			}
		}

		// ---- skipped ----
		const skipped = p.lastReport?.skipped ?? [];
		if (skipped.length) {
			const s = this.section(`Skipped in last sync (${skipped.length})`, "eye-off");
			const ul = s.createEl("ul", { cls: "vsg-list" });
			for (const x of skipped.slice(0, 50)) ul.createEl("li", { text: x });
		}

		// ---- devices ----
		if (this.remoteInfo?.devices.length) {
			const s = this.section("Devices", "monitor-smartphone");
			for (const [name, ts] of this.remoteInfo.devices) {
				const row = s.createDiv({ cls: "vsg-h-row" });
				row.createDiv({ text: name + (name === p.deviceName() ? " (this device)" : "") });
				row.createDiv({ cls: "vsg-muted", text: `last synced ${ago(ts)}` });
			}
		}

		// ---- GitHub ----
		const gh = this.section("GitHub", "github");
		gh.createDiv({ cls: "vsg-muted", text: `API budget: ${this.remoteInfo?.budget ?? "…"}` });
		if (this.remoteInfo?.error) gh.createDiv({ cls: "vsg-muted", text: `Could not check GitHub: ${this.remoteInfo.error}` });

		// ---- tools ----
		const tools = this.section("Tools", "wrench");
		const t = tools.createDiv({ cls: "vsg-h-actions" });
		this.button(t, "Timeline & restore", () => p.openTimeline());
		this.button(t, "Snapshot now", () => p.snapshot(true));
		this.button(t, "Make this device match GitHub", () => p.resetToGitHub());
		this.button(t, "Free up space", () => p.freeUpSpace());
		this.button(t, "Setup wizard", () => p.openWizard());
		this.button(t, "Sync log", () => p.openLog());
		this.button(t, "Settings", () => p.openSettings());
	}
}
