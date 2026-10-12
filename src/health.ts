// Sync health panel: what's going on, what's pending, what needs attention, and how to fix it.

import { ItemView, setIcon, WorkspaceLeaf } from "obsidian";
import type VaultSyncPlugin from "./main.ts";
import { t } from "./i18n.ts";

export const HEALTH_VIEW = "vault-sync-health";

export interface FriendlyError {
	title: string;
	hint: string;
	action: "settings" | "retry" | "none" | "encryption";
}

/** Turns raw error messages into plain language with a suggested fix. */
export function friendlyError(msg: string, host = "the repository host"): FriendlyError {
	const m = msg.toLowerCase();
	if (/no (github )?token/.test(m)) return { title: t("h.notConnected"), hint: t("h.notConnectedHint", { host }), action: "settings" };
	if (m.includes("invalid or expired") || m.includes("401"))
		return { title: t("h.badToken", { host }), hint: t("h.badTokenHint"), action: "settings" };
	if (m.includes("not found or the token cannot access") || (m.includes("not found") && m.includes("repos")))
		return { title: t("h.repoMissing"), hint: t("h.repoMissingHint"), action: "settings" };
	if (m.includes("rate limit")) return { title: t("h.rateLimit", { host }), hint: t("h.rateLimitHint", { host }), action: "none" };
	if (m.includes("outdated branch state") || m.includes("another device pushed"))
		return { title: t("h.busy", { host }), hint: t("h.busyHint"), action: "retry" };
	if (m.includes("network") || m.includes("failed to fetch") || m.includes("err_") || m.includes("offline") || m.includes("timed out"))
		return { title: t("h.offline", { host }), hint: t("h.offlineHint"), action: "retry" };
	if (m.includes("end-to-end encrypted")) return { title: t("h.encrypted"), hint: t("h.encryptedHint"), action: "encryption" };
	if (m.includes("different passphrase")) return { title: t("h.otherKey"), hint: t("h.otherKeyHint"), action: "encryption" };
	if (m.includes("pull-only")) return { title: t("h.pullOnly"), hint: t("h.pullOnlyHint"), action: "settings" };
	if (m.includes("was not found in")) return { title: t("h.branchMissing"), hint: msg, action: "settings" };
	return { title: t("h.failed"), hint: msg, action: "retry" };
}

function ago(ts: number): string {
	if (!ts) return t("time.never");
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return t("time.now");
	if (s < 3600) return t("time.min", { n: Math.round(s / 60) });
	if (s < 86400) return t("time.hour", { n: Math.round(s / 3600) });
	return t("time.day", { n: Math.round(s / 86400) });
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
		return t("health.title");
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
				budget: rl ? t("h.budgetValue", { left: rl.remaining, limit: rl.limit, time: new Date(rl.reset * 1000).toLocaleTimeString() }) : t("h.unknown"),
				devices: [...devices],
			};
		} catch (e) {
			this.remoteInfo = { ahead: null, budget: t("h.unknown"), devices: [], error: e instanceof Error ? e.message : String(e) };
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

	private button(parent: HTMLElement, label: string, fn: () => unknown, cta = false) {
		const b = parent.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
		b.onClickEvent(() => void fn());
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
		let headline = t("health.upToDate");
		let ico = "check-circle";
		let cls = "ok";
		if (!p.isConfigured()) [headline, ico, cls] = [t("health.notSetUp"), "settings", "warn"];
		else if (p.isSyncing()) [headline, ico, cls] = [t("health.syncing"), "refresh-cw", "busy"];
		else if (p.lastError) [headline, ico, cls] = [t("health.failed"), "alert-octagon", "err"];
		else if (p.conflictCopies().length) [headline, ico, cls] = [t("health.attention"), "alert-triangle", "warn"];
		else if (!p.state.lastSync) [headline, ico, cls] = [t("health.notSynced"), "cloud", "warn"];
		setIcon(icon, ico);
		st.addClass(`vsg-h-${cls}`);
		text.createDiv({ cls: "vsg-h-headline", text: headline });
		text.createDiv({
			cls: "vsg-muted",
			text: `${t("h.lastSync", { ago: ago(p.state.lastSync) })} · ${p.settings.owner || "?"}/${p.settings.repo || "?"} (${p.settings.branch}) · ${p.settings.mode === "sync" ? t("s.modeSync") : p.settings.mode === "push" ? t("s.modePush") : t("s.modePull")}${p.isEncrypted() ? ` · 🔒 ${t("health.encrypted")}` : ""}`,
		});
		const acts = el.createDiv({ cls: "vsg-h-actions" });
		if (!p.isConfigured()) this.button(acts, t("health.wizard"), () => p.openWizard(), true);
		else this.button(acts, t("health.syncNow"), () => p.sync("manual"), true);
		this.button(acts, t("health.review"), () => p.openReview());
		this.button(acts, "↻", () => this.refresh(true)).setAttr("aria-label", "Refresh");

		if (p.lastError) {
			const f = friendlyError(p.lastError, p.hostLabel());
			const s = this.section(f.title, "alert-octagon");
			s.addClass("vsg-h-error");
			s.createDiv({ text: f.hint });
			s.createDiv({ cls: "vsg-muted", text: `${ago(p.lastErrorAt)} · ${p.lastError}` });
			if (f.action === "settings") this.button(s, t("health.openSettings"), () => p.openSettings(), true);
			if (f.action === "retry") this.button(s, t("health.tryAgain"), () => p.sync("manual"), true);
			if (f.action === "encryption") this.button(s, t("health.enterPassphrase"), () => p.openEncryption(() => void p.sync("manual")), true);
		}

		// ---- pending ----
		const pend = this.section(t("health.pending"), "clock");
		const edited = p.pendingLocalCount();
		pend.createDiv({ text: edited ? t("health.editedN", { n: edited }) : t("health.noEdits") });
		if (this.remoteInfo?.ahead) pend.createDiv({ text: t("health.remoteAhead"), cls: "vsg-h-accent" });
		else if (this.remoteInfo?.ahead === false) pend.createDiv({ text: t("health.remoteSame"), cls: "vsg-muted" });
		else if (this.loadingRemote) pend.createDiv({ text: t("health.checking"), cls: "vsg-muted" });
		const ds = p.deviceScope();
		if (ds.include.length || ds.exclude.length || ds.maxDownloadMB) {
			const bits = [ds.include.length && t("h.only", { list: ds.include.join(", ") }), ds.exclude.length && t("h.excluding", { list: ds.exclude.join(", ") }), ds.maxDownloadMB && t("h.noDownloadsOver", { mb: ds.maxDownloadMB })].filter(Boolean);
			pend.createDiv({ cls: "vsg-muted", text: t("h.deviceScope", { what: bits.join("; ") }) });
		}
		const next = p.nextScheduledSync();
		pend.createDiv({ cls: "vsg-muted", text: next ? t("health.nextSync", { time: new Date(next).toLocaleTimeString() }) : t("health.noSchedule") });

		// ---- shared folders ----
		const shared = p.sharedHostsCached();
		if (shared.length) {
			const s = this.section(t("health.shared"), "folder-sync");
			for (const h of shared) {
				const row = s.createDiv({ cls: "vsg-h-row" });
				row.createDiv({ text: `${h.def.folder} → ${h.def.owner}/${h.def.repo}`, cls: "vsg-h-path" });
				const status = !h.activeOnThisDevice() ? t("h.notOnDevice") : h.lastError ? `⚠ ${h.lastError}` : t("health.lastSynced", { ago: ago(h.lastSync || h.state.lastSync) });
				row.createDiv({ cls: h.lastError ? "vsg-h-accent" : "vsg-muted", text: status });
			}
		}

		// ---- conflict copies ----
		const copies = p.conflictCopies();
		if (copies.length) {
			const s = this.section(t("health.conflicts", { n: copies.length }), "git-merge");
			s.createDiv({ cls: "vsg-muted", text: t("health.conflictsHint") });
			for (const { copy, original } of copies) {
				const row = s.createDiv({ cls: "vsg-h-row" });
				row.createDiv({ text: copy.path, cls: "vsg-h-path" });
				const b = row.createDiv({ cls: "vsg-h-row-actions" });
				if (original) this.button(b, t("health.compare"), () => p.compareFiles(original, copy));
				this.button(b, t("health.open"), () => void this.app.workspace.getLeaf(true).openFile(copy));
				this.button(b, t("health.deleteCopy"), async () => {
					await p.trashFile(copy);
					this.refresh();
				});
			}
		}

		// ---- on demand ----
		const onDemand = p.remoteOnlyFiles();
		if (onDemand.length) {
			const s = this.section(t("h.onDemand", { n: onDemand.length }), "cloud-download");
			const mb = onDemand.reduce((n, f) => n + f.size, 0) / 1048576;
			s.createDiv({ cls: "vsg-muted", text: t("h.onDemandHint", { mb: mb.toFixed(1) }) });
			const row = s.createDiv({ cls: "vsg-h-actions" });
			this.button(row, t("s.onDemandBrowse"), () => p.openRemoteOnly());
		}

		// ---- skipped ----
		const skipped = p.lastReport?.skipped ?? [];
		if (skipped.length) {
			const s = this.section(t("health.skipped", { n: skipped.length }), "eye-off");
			const ul = s.createEl("ul", { cls: "vsg-list" });
			for (const x of skipped.slice(0, 50)) ul.createEl("li", { text: x });
		}

		// ---- devices ----
		if (this.remoteInfo?.devices.length) {
			const s = this.section(t("health.devices"), "monitor-smartphone");
			for (const [name, ts] of this.remoteInfo.devices) {
				const row = s.createDiv({ cls: "vsg-h-row" });
				row.createDiv({ text: name + (name === p.deviceName() ? ` ${t("health.thisDevice")}` : "") });
				row.createDiv({ cls: "vsg-muted", text: t("health.lastSynced", { ago: ago(ts) }) });
			}
		}

		// ---- GitHub ----
		const gh = this.section(p.hostLabel(), "server");
		gh.createDiv({ cls: "vsg-muted", text: t("h.budget", { budget: this.remoteInfo?.budget ?? "…" }) });
		if (this.remoteInfo?.error) gh.createDiv({ cls: "vsg-muted", text: t("h.checkFailed", { host: p.hostLabel(), error: this.remoteInfo.error }) });

		// ---- tools ----
		const tools = this.section(t("health.tools"), "wrench");
		const tl = tools.createDiv({ cls: "vsg-h-actions" });
		this.button(tl, t("health.timeline"), () => p.openTimeline());
		this.button(tl, t("health.snapshot"), () => p.snapshot(true));
		this.button(tl, t("health.reset"), () => p.resetToGitHub());
		this.button(tl, t("health.freeSpace"), () => p.freeUpSpace());
		this.button(tl, t("health.wizard"), () => p.openWizard());
		this.button(tl, t("health.log"), () => p.openLog());
		this.button(tl, t("health.settings"), () => p.openSettings());
	}
}
