// Sync health panel: what's going on, what's pending, what needs attention, and how to fix it.

import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { confirmPlan } from "./ui.ts";
import type VaultSyncPlugin from "./main.ts";
import { t } from "./i18n.ts";
import { friendlyError, localizeError, skippedLines } from "./errors.ts";

export const HEALTH_VIEW = "vault-sync-health";

export { friendlyError } from "./errors.ts";
export type { FriendlyError } from "./errors.ts";

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
	private remoteInfo: { ahead: boolean | null; budget: string; devices: [string, number][]; versions: Map<string, string>; error?: string } | null = null;
	private loadingRemote = false;
	private remoteAgain = false;

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
		void this.plugin.checkOtherSync().then(() => this.render());
	}

	/** Re-render local info immediately; optionally re-query GitHub. */
	refresh(withRemote = false) {
		this.render();
		if (withRemote) void this.loadRemote();
	}

	private async loadRemote() {
		const p = this.plugin;
		if (!p.isConfigured()) return;
		// A refresh asked for mid-load (e.g. right after a sync) runs once more when this one ends,
		// so the panel never keeps a result fetched before that sync.
		if (this.loadingRemote) return void (this.remoteAgain = true);
		this.loadingRemote = true;
		this.remoteAgain = false;
		try {
			const [head, rl, commits] = await Promise.all([
				p.gh.getRef(p.settings.branch),
				p.gh.rateLimit().catch(() => null),
				p.gh.listCommits(p.settings.branch, undefined, 50).catch(() => []),
			]);
			const devices = new Map<string, number>();
			const versions = new Map<string, string>();
			for (const c of commits) {
				const trailer = /^Device: (.+)$/m.exec(c.message)?.[1];
				const name = trailer ?? /^([^:\n]{1,40}):/.exec(c.message)?.[1];
				if (name && !devices.has(name)) {
					devices.set(name, Date.parse(c.date));
					const v = /^Plugin: (.+)$/m.exec(c.message)?.[1];
					if (v) versions.set(name, v.trim());
				}
			}
			this.remoteInfo = {
				ahead: head ? head !== p.state.head : null,
				budget: rl ? t("h.budgetValue", { left: rl.remaining, limit: rl.limit, time: new Date(rl.reset * 1000).toLocaleTimeString() }) : t("h.unknown"),
				devices: [...devices],
				versions,
			};
		} catch (e) {
			this.remoteInfo = { ahead: null, budget: t("h.unknown"), devices: [], versions: new Map(), error: localizeError(e, p.hostLabel()) };
		} finally {
			this.loadingRemote = false;
			this.render();
			if (this.remoteAgain) {
				this.remoteAgain = false;
				void this.loadRemote();
			}
		}
	}

	/** Conflict copies with resolve / compare / open / delete. */
	private renderConflicts() {
		const p = this.plugin;
		const copies = p.conflictCopies();
		if (copies.length) {
			const s = this.section(t("health.conflicts", { n: copies.length }), "git-merge");
			s.createDiv({ cls: "vsg-muted", text: t("health.conflictsHint") });
			for (const { copy, original } of copies) {
				const row = s.createDiv({ cls: "vsg-h-row" });
				row.createDiv({ text: copy.path, cls: "vsg-h-path" });
				const b = row.createDiv({ cls: "vsg-h-row-actions" });
				if (original) {
					this.button(b, t("h.resolve"), async () => {
						if (p.isSyncing()) return void new Notice(t("notice.busy"));
						if (await p.resolveConflictCopy(original, copy)) this.refresh();
					}, true);
					this.button(b, t("health.compare"), () => p.compareFiles(original, copy));
				}
				this.button(b, t("health.open"), () => void this.app.workspace.getLeaf(true).openFile(copy));
				this.button(b, t("health.deleteCopy"), async () => {
					if (!(await confirmPlan(this.app, t("health.deleteCopy"), t("h.deleteCopyBody"), [{ title: t("h.conflictCopy"), items: [copy.path] }], t("health.deleteCopy"), true))) return;
					await p.trashFile(copy);
					this.refresh();
				});
			}
		}

	}

	private section(title: string, icon: string): HTMLElement {
		const s = this.contentEl.createDiv({ cls: "vsg-h-section" });
		const h = s.createDiv({ cls: "vsg-h-title" });
		setIcon(h.createSpan({ cls: "vsg-h-icon" }), icon);
		h.createSpan({ text: title });
		return s;
	}

	/** A button whose action can't run twice at once, and whose errors are shown instead of lost. */
	private button(parent: HTMLElement, label: string, fn: () => unknown, cta = false) {
		const b = parent.createEl("button", { text: label, cls: cta ? "mod-cta" : "" });
		let busy = false;
		b.onClickEvent(async () => {
			if (busy) return;
			busy = true;
			b.disabled = true;
			try {
				await fn();
			} catch (e) {
				new Notice(localizeError(e, this.plugin.hostLabel()), 8000);
			} finally {
				busy = false;
				b.disabled = false;
			}
		});
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
		else if (p.isPaused()) [headline, ico, cls] = [t("m.pausedStatus"), "pause-circle", "warn"];
		else if (p.lastError) [headline, ico, cls] = [t("health.failed"), "alert-octagon", "err"];
		else if (p.conflictCopies().length) [headline, ico, cls] = [t("health.attention"), "alert-triangle", "warn"];
		else if (!p.state.lastSync) [headline, ico, cls] = [t("health.notSynced"), "cloud", "warn"];
		setIcon(icon, ico);
		st.addClass(`vsg-h-${cls}`);
		text.createDiv({ cls: "vsg-h-headline", text: headline });
		if (p.isConfigured()) text.createDiv({
			cls: "vsg-muted",
			text: `${t("h.lastSync", { ago: ago(p.state.lastSync) })} · ${p.settings.owner || "?"}/${p.settings.repo || "?"} (${p.settings.branch}) · ${p.settings.mode === "sync" ? t("s.modeSync") : p.settings.mode === "push" ? t("s.modePush") : t("s.modePull")}${p.isEncrypted() ? ` · 🔒 ${t("health.encrypted")}` : ""}`,
		});
		const acts = el.createDiv({ cls: "vsg-h-actions" });
		if (!p.isConfigured()) this.button(acts, t("health.wizard"), () => p.openWizard(), true);
		else this.button(acts, t("health.syncNow"), () => p.sync("manual"), true);
		if (p.isConfigured()) {
			if (p.isPaused()) this.button(acts, t("h.resume"), () => {
				p.resumeSync();
				this.refresh();
			});
			else this.button(acts, t("h.pause"), () => {
				p.pauseSync(60);
				this.refresh();
			});
		}
		this.button(acts, t("health.review"), () => p.openReview());
		this.button(acts, "↻", () => this.refresh(true)).setAttr("aria-label", t("h.refresh"));
		if (!p.isConfigured()) {
			// Nothing to show until a host and repository are set up.
			el.createDiv({ cls: "vsg-muted", text: t("h.setupHint") });
			// Conflict copies are local files: they can be resolved without a repository.
			this.renderConflicts();
			return;
		}

		if (p.lastError) {
			const cause = p.lastErrorCause ?? p.lastError;
			const f = friendlyError(cause, p.hostLabel());
			const s = this.section(f.title, "alert-octagon");
			s.addClass("vsg-h-error");
			s.createDiv({ text: f.hint });
			const detail = localizeError(cause, p.hostLabel());
			s.createDiv({ cls: "vsg-muted", text: detail === f.hint ? ago(p.lastErrorAt) : `${ago(p.lastErrorAt)} · ${detail}` });
			if (f.action === "settings") this.button(s, t("health.openSettings"), () => p.openSettings(), true);
			if (f.action === "retry") this.button(s, t("health.tryAgain"), () => p.sync("manual"), true);
			if (f.action === "encryption") this.button(s, t("health.enterPassphrase"), () => p.openEncryption(() => void p.sync("manual")), true);
		}

		// ---- other sync tools ----
		if (p.otherSync.length) {
			const s = this.section(t("os.title"), "alert-triangle");
			s.addClass("vsg-h-error");
			s.createDiv({ text: t("os.found", { list: p.otherSync.map((x) => (x === ".git" ? t("os.gitFolder") : x)).join(", ") }) });
			s.createDiv({ cls: "vsg-muted", text: t("os.hint") });
		}

		// ---- pending ----
		const pend = this.section(t("health.pending"), "clock");
		const edited = p.pendingLocalCount();
		pend.createDiv({ text: edited ? t("health.editedN", { n: edited }) : t("health.noEdits") });
		if (this.remoteInfo?.ahead || p.remoteAhead) pend.createDiv({ text: t("health.remoteAhead"), cls: "vsg-h-accent" });
		else if (this.remoteInfo?.ahead === false) pend.createDiv({ text: t("health.remoteSame"), cls: "vsg-muted" });
		else if (this.loadingRemote) pend.createDiv({ text: t("health.checking"), cls: "vsg-muted" });
		const ds = p.deviceScope();
		if (ds.include.length || ds.exclude.length || ds.maxDownloadMB) {
			const bits = [ds.include.length && t("h.only", { list: ds.include.join(", ") }), ds.exclude.length && t("h.excluding", { list: ds.exclude.join(", ") }), ds.maxDownloadMB && t("h.noDownloadsOver", { mb: ds.maxDownloadMB })].filter(Boolean);
			pend.createDiv({ cls: "vsg-muted", text: t("h.deviceScope", { what: bits.join("; ") }) });
		}
		if (p.isPaused()) {
			const until = p.pausedUntil();
			pend.createDiv({ cls: "vsg-h-accent", text: until === Infinity ? t("h.pausedUntilResumed") : t("h.pausedUntil", { time: new Date(until).toLocaleTimeString() }) });
		}
		if (p.batterySaver()) pend.createDiv({ cls: "vsg-muted", text: t("h.batterySaverOn") });
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

		this.renderConflicts();

		// ---- on demand ----
		const onDemand = p.remoteOnlyFiles();
		if (onDemand.length) {
			const s = this.section(t("h.onDemand", { n: onDemand.length }), "cloud-download");
			const mb = onDemand.reduce((n, f) => n + f.size, 0) / 1048576;
			s.createDiv({ cls: "vsg-muted", text: t("h.onDemandHint", { mb: mb.toFixed(1) }) });
			const row = s.createDiv({ cls: "vsg-h-actions" });
			this.button(row, t("s.onDemandBrowse"), () => p.openRemoteOnly());
		}

		// ---- names other devices can't store ----
		const badNames = p.unportableNames();
		if (badNames.length) {
			const s = this.section(t("h.badNames", { n: badNames.length }), "file-warning");
			s.createDiv({ cls: "vsg-muted", text: t("h.badNamesHint") });
			const ul = s.createEl("ul", { cls: "vsg-list" });
			for (const x of badNames.slice(0, 30)) ul.createEl("li", { text: x });
		}

		// ---- skipped ----
		const skipped = p.lastReport ? skippedLines(p.lastReport.skipped, p.lastReport.skipNotes) : [];
		if (skipped.length) {
			const s = this.section(t("health.skipped", { n: skipped.length }), "eye-off");
			const ul = s.createEl("ul", { cls: "vsg-list" });
			for (const x of skipped.slice(0, 50)) ul.createEl("li", { text: x });
		}

		// ---- devices ----
		if (this.remoteInfo?.devices.length) {
			const s = this.section(t("health.devices"), "monitor-smartphone");
			const mine = p.pluginVersion;
			const other = [...this.remoteInfo.versions].filter(([name, v]) => name !== p.deviceName() && v !== mine);
			if (other.length) s.createDiv({ cls: "vsg-h-accent", text: t("h.versionMismatch", { mine, list: other.map(([n, v]) => `${n} (${v})`).join(", ") }) });
			for (const [name, ts] of this.remoteInfo.devices) {
				const row = s.createDiv({ cls: "vsg-h-row" });
				const v = this.remoteInfo.versions.get(name);
				row.createDiv({ text: name + (name === p.deviceName() ? ` ${t("health.thisDevice")}` : "") + (v ? ` · ${v}` : "") });
				row.createDiv({ cls: "vsg-muted", text: t("health.lastSynced", { ago: ago(ts) }) });
			}
		}

		// ---- GitHub ----
		const gh = this.section(p.hostLabel(), "server");
		if (p.settings.provider === "github") gh.createDiv({ cls: "vsg-muted", text: t("h.budget", { budget: this.remoteInfo?.budget ?? "…" }) });
		const expires = p.tokenExpiryDays();
		if (expires !== null && expires <= 14) {
			gh.createDiv({ cls: "vsg-h-accent", text: expires <= 0 ? t("h.tokenExpiresToday") : t("h.tokenExpires", { days: expires }) });
			this.button(gh, t("h.newToken"), () => p.openTokenPage(), true);
		}
		if (this.remoteInfo?.error) gh.createDiv({ cls: "vsg-muted", text: t("h.checkFailed", { host: p.hostLabel(), error: this.remoteInfo.error }) });
		const mirror = p.mirrorStatus();
		if (mirror) {
			gh.createDiv({
				cls: mirror.lastError ? "vsg-h-accent" : "vsg-muted",
				text: mirror.lastError ? t("h.mirrorFailed", { target: mirror.label, error: mirror.lastError }) : t("h.mirror", { target: mirror.label, ago: ago(mirror.lastSync) }),
			});
		}

		// ---- tools ----
		const tools = this.section(t("health.tools"), "wrench");
		const tl = tools.createDiv({ cls: "vsg-h-actions" });
		this.button(tl, t("health.timeline"), () => p.openTimeline());
		this.button(tl, t("health.snapshot"), () => p.snapshot(true));
		this.button(tl, t("health.reset"), () => p.resetToGitHub());
		this.button(tl, t("cmd.overwrite"), () => p.overwriteRemote());
		this.button(tl, t("health.freeSpace"), () => p.freeUpSpace());
		this.button(tl, t("link.addDevice"), () => p.openSetupLink());
		this.button(tl, t("health.wizard"), () => p.openWizard());
		this.button(tl, t("health.log"), () => p.openLog());
		this.button(tl, t("cmd.diagnostics"), () => p.copyDiagnostics());
		this.button(tl, p.batterySaver() ? t("h.batterySaverOff") : t("h.batterySaverTurnOn"), () => {
			p.setBatterySaver(!p.batterySaver());
			this.refresh();
		});
		this.button(tl, t("health.settings"), () => p.openSettings());
	}
}
