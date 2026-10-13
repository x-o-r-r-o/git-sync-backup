import { apiVersion, debounce, Debouncer, normalizePath, Notice, Platform, Plugin, setIcon, TAbstractFile, TFile, TFolder } from "obsidian";
import { HOSTS, makeRemote } from "./hosts.ts";
import type { Remote } from "./remote.ts";
import type { BlobCache, BlobCacheStore } from "./bitbucket.ts";
import { HEALTH_VIEW, HealthView } from "./health.ts";
import { HISTORY_VIEW, HistoryView } from "./history-view.ts";
import type { HistoryHost } from "./history-view.ts";
import { decodeCommitFiles, followRenames, HISTORY_PAGE, parentPathOf, replaceWithRepositoryVersion } from "./history.ts";
import type { PathCommit } from "./history.ts";
import { nestedHiddenIndex, VaultIO, keepSelfEnabled } from "./io.ts";
import type { Decision, SyncMode } from "./plan.ts";
import { VaultSyncSettingTab } from "./settings-tab.ts";
import { SyncCancelled, SyncEngine } from "./sync.ts";
import type { DeviceScope, SyncHost, SyncReport } from "./sync.ts";
import { SetupWizard } from "./wizard.ts";
import { readState, writeState } from "./statefile.ts";
import { SharedFolderHost, sharedFolderPattern } from "./shared.ts";
import type { HostKind } from "./hosts.ts";
import { Codec, normalizeSubdir, RepoSubdirLayer, vaultCommitsPath } from "./codec.ts";
import type { Layer } from "./codec.ts";
import { b64, EncryptionLayer, unb64 } from "./crypto.ts";
import type { EncryptionMeta } from "./crypto.ts";
import { encryptionGuard } from "./encryption.ts";
import { LfsLayer, lfsPatternsForSubdir, lfsPatternsFrom } from "./lfs.ts";
import type { EncryptionRecord } from "./encryption.ts";
import { EncryptionModal, readRemoteMarker } from "./encryption-ui.ts";
import { DEFAULT_SETTINGS, emptyState } from "./types.ts";
import type { SyncEventSummary } from "./types.ts";
import type {
	ConflictChoice,
	ConflictInfo,
	DeleteGuardChoice,
	LocalChanges,
	SharedFolder,
	SyncOptions,
	SyncState,
	VaultSyncSettings,
} from "./types.ts";
import {
	RemoteOnlyModal,
	CommitListModal,
	ConflictModal,
	confirmPlan,
	DeleteGuardModal,
	DiffModal,
	DiffSides,
	FileVersionModal,
	FolderSuggestModal,
	LogModal,
	ReviewModal,
	TimelineEntry,
	TimelineModal,
} from "./ui.ts";
import { t } from "./i18n.ts";
import { DeviceFlowError, GITHUB_APP, needsRefresh, parseTokens, pollDeviceFlow, refreshAppToken, startDeviceFlow } from "./ghapp.ts";
import type { DeviceCode } from "./ghapp.ts";
import {
	DeviceFlowError as GitLabFlowError,
	GITLAB_APP,
	needsRefresh as gitlabNeedsRefresh,
	parseTokens as parseGitLabTokens,
	pollDeviceFlow as pollGitLabDeviceFlow,
	refreshAppToken as refreshGitLabToken,
	startDeviceFlow as startGitLabDeviceFlow,
	webBaseFromApi,
} from "./gitlabapp.ts";
import type { DeviceCode as GitLabDeviceCode } from "./gitlabapp.ts";
import type { SignInFlow } from "./ghapp-ui.ts";
import type { AppConfig, AppTokens } from "./ghapp.ts";
import { webBase } from "./auth.ts";
import { normalizeConfigSync } from "./scope-config.ts";
import { compileGlobs, scopeGitignore } from "./glob.ts";
import { ExplorerBadges } from "./explorer.ts";
import { addScopeMenuItems, emitSyncEvent, frontmatterScope, installSyncExtras, SYNC_DONE_EVENT, SYNC_START_EVENT } from "./sync-extras.ts";
import { parseSetupPayload, SETUP_ACTION } from "./setuplink.ts";
import type { SetupPayload } from "./setuplink.ts";
import { ApplySetupLinkModal, CreateSetupLinkModal } from "./setuplink-ui.ts";
import { detectOtherSync } from "./othersync.ts";
import { SharedFolderModal } from "./shared-ui.ts";
import { conflictResolver } from "./conflict-editor.ts";
import { ChangeMarkers } from "./change-markers.ts";
import { MirrorHost } from "./mirror.ts";
import { dropRemovedHosts, isKnownProvider, mainSyncBlocked, removedHostNotice, syncableMirror, syncableSharedFolders } from "./removed-hosts.ts";
import { fetchRegistry, findPluginNeeds, installPlugin, obsidianFetch } from "./pluginsync.ts";
import { localizeError, skippedLines, syncProblems } from "./errors.ts";
import type { SyncOutcome } from "./errors.ts";
import { asText, conflictCopyOriginal, errMsg, portableNameProblem, redactSecrets, restoredCopyPath, sleep, stamp, tokenLooksLike, urlHost } from "./util.ts";

type Trigger = "manual" | "startup" | "change" | "interval" | "resume" | "background" | "open" | "close";
type Status = "idle" | "syncing" | "ok" | "error" | "offline" | "conflict" | "paused";

export default class VaultSyncPlugin extends Plugin implements SyncHost {
	settings!: VaultSyncSettings;
	state!: SyncState;
	private remoteCache: { kind: string; remote: Remote } | null = null;
	private refreshing: Promise<boolean> | null = null;
	private unloaded = false;
	private expiredNoticeShown = false;
	private lastOpenSync = 0;
	private badges: ExplorerBadges | null = null;
	/** Editor marks for lines changed since the last sync. */
	changeMarkers: ChangeMarkers | null = null;
	refreshBadges: () => void = () => {};
	lastReport: SyncReport | null = null;
	private encLayer: EncryptionLayer | null = null;
	private shared: { sig: string; hosts: SharedFolderHost[] } | null = null;
	/** Set by the setup wizard to show live progress. */
	onProgress: ((text: string) => void) | null = null;
	/** English message of the last failure (log and diagnostics); see lastErrorCause for display. */
	lastError: string | null = null;
	/** How the last finished sync ended as a whole (main repository, shared folders, mirror, files). */
	syncOutcome: SyncOutcome | null = null;
	private syncOutcomeSeq = 0;
	/** The error behind lastError, for translated display (status panel). */
	lastErrorCause: unknown = null;
	lastErrorAt = 0;
	private engine!: SyncEngine;
	private io!: VaultIO;
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private syncing = false;
	private changedDuringSync = false;
	private lastFailed = false;
	private queued: { mode: SyncMode; opts: SyncOptions; manual: boolean } | null = null;
	private logLines: string[] = [];
	private onChangeDebounced: Debouncer<[], void> | null = null;
	private intervalId: number | null = null;
	private nextIntervalAt = 0;
	// Edited paths since the last sync, with a sequence number so edits made during a sync survive it.
	private dirty = new Map<string, number>();
	private dirtySeq = 0;
	private fullScanNeeded = true;
	private dirtySnapshot = new Map<string, number>();
	// Paths touched while a sync runs, and paths the sync itself wrote (their vault events can arrive late).
	private touchedDuringSync = new Set<string>();
	private writtenBySync = new Map<string, number>();
	private settingTab: VaultSyncSettingTab | null = null;
	// Last status set (before the paused overlay), so the status bar can be redrawn on its own.
	private baseStatus: Status = "idle";
	private baseDetail = "";
	private pauseTimer: number | null = null;
	private pendingTimer: Debouncer<[], void> | null = null;

	get stateFilePath(): string {
		const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return normalizePath(`${dir}/sync-state.json`);
	}

	async onload() {
		await this.loadSettings();
		await this.loadState();
		this.engine = new SyncEngine(this);
		this.io = new VaultIO(this.app);
		await this.loadEncryption();

		this.registerView(HEALTH_VIEW, (leaf) => new HealthView(leaf, this));
		this.registerView(HISTORY_VIEW, (leaf) => new HistoryView(leaf, this.historyHost()));
		// Reading view: offer to download embeds whose file wasn't downloaded to this device.
		this.registerMarkdownPostProcessor((el, ctx) => {
			if (!Object.keys(this.state.remoteOnly ?? {}).length) return;
			el.querySelectorAll(".internal-embed").forEach((embed) => {
				const src = embed.getAttribute("src");
				if (!src || this.app.metadataCache.getFirstLinkpathDest(src.split("#")[0], ctx.sourcePath)) return;
				const f = this.remoteOnlyFor(src);
				if (!f || embed.nextElementSibling?.hasClass("vsg-ondemand")) return;
				const box = createDiv({ cls: "vsg-ondemand" });
				box.createSpan({ text: t("m.embedMissing", { path: f.path, mb: (f.size / 1048576).toFixed(1) }) + " " });
				const btn = box.createEl("button", { text: t("m.download") });
				btn.onClickEvent(async () => {
					btn.disabled = true;
					await this.downloadOnDemand([f.path]);
					// Obsidian shows the embed itself once the file exists; the offer goes away.
					if (this.app.vault.getAbstractFileByPath(f.path)) box.remove();
					else btn.disabled = false;
				});
				embed.after(box);
			});
		});
		this.ribbonEl = this.addRibbonIcon("refresh-cw", t("ribbon.sync"), () => this.sync("manual"));
		this.addRibbonIcon("activity", t("ribbon.status"), () => this.openHealth());
		this.addRibbonIcon("history", t("ribbon.history"), () => void this.openHistory());
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("vsg-status");
			this.statusEl.onClickEvent(() => this.openHealth());
		}
		this.setStatus("idle");
		this.settingTab = new VaultSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.register(() => this.clearPauseTimer());
		this.registerCommands();
		this.updateStatusExtras = installSyncExtras(this).updateStatus;

		// Conflict blocks written by "merge with markers" get keep-this/keep-that buttons in the editor.
		this.registerEditorExtension(conflictResolver({ ours: t("ce.ours"), theirs: t("ce.theirs"), both: t("ce.both"), hint: t("ce.hint") }));
		// Lines changed since the last sync, marked in the editor (revert, next/previous, line history).
		this.changeMarkers = this.createChangeMarkers();
		this.registerEditorExtension(this.changeMarkers.extensions);
		this.changeMarkers.addCommands(this);
		this.registerObsidianProtocolHandler(SETUP_ACTION, (params) => {
			const payload = parseSetupPayload(params.s);
			if (!payload) return void new Notice(t("link.invalid"));
			new ApplySetupLinkModal(this.app, this, payload).open();
		});
		this.badges = new ExplorerBadges(this.app, () => this.pendingLocalPaths(), () => this.settings.explorerBadges && this.isConfigured(), () => this.syncedPathTest(), () => this.explorerScopeKey());
		this.badgeTimer = debounce(() => {
			if (!this.unloaded) this.badges?.refresh();
		}, 1500, true);
		this.refreshBadges = () => this.badgeTimer?.();
		this.pendingTimer = debounce(() => {
			if (!this.unloaded) this.renderStatus();
		}, 1500, true);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshBadges()));
		this.app.workspace.onLayoutReady(() => {
			this.refreshBadges();
			void this.checkOtherSync();
			const touch = (path: string) => {
				if (this.syncing) return void this.touchedDuringSync.add(path);
				const w = this.writtenBySync.get(path);
				if (w && Date.now() - w < 5000) return;
				this.dirty.set(path, ++this.dirtySeq);
			};
			const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
				if (file instanceof TFile) touch(file.path);
				if (oldPath) touch(oldPath);
				this.refreshBadges();
				this.pendingTimer?.();
				if (!this.settings.syncOnChange) return;
				// Our own writes during a sync also land here; that only costs one cheap no-op sync later.
				if (this.syncing) this.changedDuringSync = true;
				else this.onChangeDebounced?.();
			};
			this.registerEvent(this.app.vault.on("modify", (f) => onVaultChange(f)));
			this.registerEvent(this.app.vault.on("create", (f) => onVaultChange(f)));
			this.registerEvent(this.app.vault.on("delete", (f) => onVaultChange(f)));
			this.registerEvent(this.app.vault.on("rename", (f, old) => onVaultChange(f, old)));
			// New or moved folders may hold hidden files (.gitignore): the next sync looks for them again.
			const onFolder = (f: TAbstractFile) => {
				if (f instanceof TFolder) nestedHiddenIndex(this.app).foldersChanged();
			};
			this.registerEvent(this.app.vault.on("create", onFolder));
			this.registerEvent(this.app.vault.on("rename", onFolder));
			// Files appearing, disappearing or moving can change which rows the explorer greys out.
			const shapeChanged = () => void this.vaultShapeGen++;
			this.registerEvent(this.app.vault.on("create", shapeChanged));
			this.registerEvent(this.app.vault.on("delete", shapeChanged));
			this.registerEvent(this.app.vault.on("rename", shapeChanged));
			this.rescheduleTriggers();
			if (!this.isConfigured() && !this.settings.wizardShown) {
				this.settings.wizardShown = true;
				void this.saveSettings();
				window.setTimeout(() => !this.unloaded && this.openWizard(), 1000);
			} else if (this.settings.syncOnStartup) window.setTimeout(() => void this.sync("startup"), 2500);
		});

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file || !this.settings.syncOnOpen || !this.isConfigured() || this.syncing) return;
				if (Date.now() - this.lastOpenSync < 30_000) return;
				this.lastOpenSync = Date.now();
				void this.sync("open");
			}),
		);

		// "Changes on the host": one cheap request every 5 minutes while Obsidian is visible, so a device
		// that isn't syncing on its own (paused, battery saver, no timer) still shows that something is waiting.
		this.registerInterval(window.setInterval(() => void this.checkRemoteAhead(), 5 * 60_000));

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.settings.syncOnResume) {
				if (Date.now() - this.state.lastSync > 60_000) void this.sync("resume");
			} else if (document.visibilityState === "hidden" && this.settings.syncOnBackground) {
				void this.sync("background");
			}
		});
	}

	onunload() {
		this.unloaded = true;
		this.badgeTimer?.cancel();
		this.pendingTimer?.cancel();
		this.badges?.destroy();
		this.badges = null;
		this.changeMarkers?.destroy();
		this.onChangeDebounced?.cancel();
	}
	/**
	 * Obsidian may not have rewritten community-plugins.json yet when this plugin starts (for example
	 * right after it was turned back on), so the file can say it is off while it runs. Fix the file
	 * before syncing, so that stale list is never uploaded and never turns sync off on other devices.
	 */
	private async repairSelfEnabled() {
		if (!this.settings.syncConfigDir) return;
		const path = `${this.app.vault.configDir}/community-plugins.json`;
		try {
			const a = this.app.vault.adapter;
			if (!(await a.exists(path))) return;
			const fixed = keepSelfEnabled(path, this.app.vault.configDir, new TextEncoder().encode(await a.read(path)).buffer);
			if (fixed) {
				await a.writeBinary(path, fixed);
				this.log("community-plugins.json didn't list this plugin while it runs; added it back before syncing.");
			}
		} catch (e) {
			this.log(`Couldn't check community-plugins.json: ${errMsg(e)}`);
		}
	}
	isUnloaded(): boolean {
		return this.unloaded;
	}
	get pluginVersion(): string {
		return this.manifest.version;
	}
	get windows(): boolean {
		return Platform.isWin;
	}

	/** Vault files whose names Windows (and often Android) can't store: they won't sync to such devices. */
	unportableNames(): string[] {
		const out: string[] = [];
		for (const f of this.app.vault.getFiles()) if (portableNameProblem(f.path)) out.push(f.path);
		return out;
	}

	/** True when the last check found commits on the host that this device hasn't synced yet. */
	remoteAhead = false;
	private async checkRemoteAhead() {
		if (document.visibilityState !== "visible" || this.syncing || !this.isConfigured() || !navigator.onLine) return;
		const timerSyncs = this.settings.intervalMin > 0 && this.settings.intervalMin <= 5 && !this.batterySaver() && !this.isPaused();
		if (timerSyncs) return;
		try {
			const head = await this.gh.getRef(this.settings.branch);
			const ahead = !!head && head !== this.state.head;
			if (ahead !== this.remoteAhead) {
				this.remoteAhead = ahead;
				this.ribbonEl?.toggleClass("vsg-remote-ahead", ahead);
				this.statusEl?.toggleClass("vsg-remote-ahead", ahead);
				this.refreshHealth();
			}
		} catch {
			/* offline or no access: the next sync reports it */
		}
	}

	// ---------------- pause, battery saver (this device only) ----------------

	/** Automatic syncs are paused until this time (epoch ms; Infinity = until resumed). Manual syncs still run. */
	pausedUntil(): number {
		const v = this.localGet("pausedUntil");
		if (!v) return 0;
		const n = v === "forever" ? Infinity : Number(v);
		return n > Date.now() ? n : 0;
	}
	isPaused(): boolean {
		return this.pausedUntil() > 0;
	}
	pauseSync(minutes: number | null) {
		this.localSet("pausedUntil", minutes === null ? "forever" : String(Date.now() + minutes * 60_000));
		this.setStatus("paused", t("m.pausedStatus"));
		new Notice(minutes === null ? t("m.paused") : t("m.pausedFor", { n: minutes }));
	}
	resumeSync() {
		this.localSet("pausedUntil", null);
		this.renderStatus();
		new Notice(t("m.resumed"));
		void this.sync("resume");
	}
	/** Battery saver: no timer and no sync after each edit; startup, returning to the app and manual syncs only. */
	batterySaver(): boolean {
		return this.localGet("batterySaver") === "1";
	}
	setBatterySaver(on: boolean) {
		this.localSet("batterySaver", on ? "1" : null);
		this.rescheduleTriggers();
	}
	/** Other sync tools found in this vault (checked on load and when the status panel opens). */
	otherSync: string[] = [];
	async checkOtherSync(): Promise<string[]> {
		this.otherSync = await detectOtherSync(this.app).catch(() => []);
		return this.otherSync;
	}
	private gitignoreLines: string[] = [];
	/** `filter=lfs` patterns from .gitattributes (this vault's, else the repository's). */
	private lfsPatterns: string[] = [];
	private gitattributesHead: string | null = null;
	/** Reads .gitattributes so files tracked with `git lfs track` go to LFS whatever their size. */
	async loadGitattributes() {
		try {
			const a = this.app.vault.adapter;
			let text = (await a.exists(".gitattributes")) ? await a.read(".gitattributes") : null;
			if (text === null && this.isConfigured() && !this.isEncrypted()) {
				// The repository's copy, read once per head (not on every sync).
				const head = this.state.head;
				const sub = normalizeSubdir(this.settings.repoSubdir);
				const key = head ? `${sub}#${head}` : null;
				if (key && this.gitattributesHead === key) return;
				const read = async (p: string) => {
					const data = head ? await this.gh.getFileAt(p, head) : null;
					return data ? new TextDecoder().decode(data) : "";
				};
				// A vault in a folder of the repository: the root file's anchored patterns are relative to the
				// repository root (matched here against vault paths), and the folder's own file applies too.
				const patterns = lfsPatternsForSubdir(lfsPatternsFrom(await read(".gitattributes")), sub);
				if (sub) patterns.push(...lfsPatternsFrom(await read(`${sub}/.gitattributes`)));
				this.gitattributesHead = key;
				this.lfsPatterns = patterns;
				return;
			}
			// The engine rebuilds its layers from codec() on each run; the LFS fingerprint changes with the
			// patterns, so cached hashes are recomputed once.
			this.lfsPatterns = lfsPatternsFrom(text ?? "");
		} catch {
			/* keep the previous patterns */
		}
	}
	private badgeTimer: Debouncer<[], void> | null = null;
	gitignorePatterns(): string[] {
		return this.gitignoreLines;
	}
	/** Reads the vault's .gitignore files (Obsidian doesn't index them, so they are read from disk before each sync). */
	async loadGitignore() {
		if (!this.settings.useGitignore) return void (this.gitignoreLines = []);
		const a = this.app.vault.adapter;
		try {
			// Finding .gitignore files in subfolders lists every folder on disk, so that walk is cached and
			// shared with the sync's own scan: it only runs again after folders were created or renamed, on a
			// full scan, or every 30 minutes. The .gitignore files already known are re-read on every sync.
			const st = this.state;
			const full = this.fullScanNeeded || !st.lastFullScan || Date.now() - st.lastFullScan > this.settings.fullScanMinutes * 60_000;
			const found = await this.io.listNestedHidden(() => true, new Set([".gitignore"]), { full });
			this.nestedGitignorePaths = found.map((f) => f.path).sort((x, y) => x.localeCompare(y));
			const root = (await a.exists(".gitignore")) ? (await a.read(".gitignore")).split(/\r?\n/) : [];
			const nested: string[] = [];
			for (const path of this.nestedGitignorePaths) {
				if (!(await a.exists(path))) continue;
				nested.push(...scopeGitignore(path.slice(0, -"/.gitignore".length), (await a.read(path)).split(/\r?\n/)));
			}
			this.gitignoreLines = [...root, ...nested];
		} catch (e) {
			// Keep the last rules: syncing with none could upload ignored files.
			this.log(`Could not read .gitignore files (keeping the previous rules): ${errMsg(e)}`);
		}
	}
	private nestedGitignorePaths: string[] = [];

	// Called by Obsidian when data.json changes on disk (e.g. synced from another device).
	async onExternalSettingsChange() {
		await this.loadSettings();
		this.fullScanNeeded = true;
		this.rescheduleTriggers();
		// The settings object kept its identity; open views just redraw with the new values.
		this.settingTab?.refreshIfOpen();
		this.refreshHealth();
		if (this.changeMarkers && (this.changeMarkers.extensions.length > 0) !== this.settings.changeMarkers) this.changeMarkers.setEnabled(this.settings.changeMarkers);
	}

	// ---------------- device-local secrets ----------------

	private localKey(name: string): string {
		const id = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
		return `vault-sync-git:${id}:${name}`;
	}
	/** Device-local, vault-scoped values (Obsidian's local storage API; never synced). */
	private localGet(name: string): string | null {
		const v = this.app.loadLocalStorage(`vault-sync-git:${name}`) as unknown;
		return typeof v === "string" ? v : null;
	}
	private localSet(name: string, value: string | null) {
		this.app.saveLocalStorage(`vault-sync-git:${name}`, value);
	}
	// Secrets go to Obsidian's SecretStorage (1.11.4+, encrypted by the OS keychain where available),
	// falling back to the vault-scoped local storage on older versions.
	private secretId(name: string): string {
		return this.localKey(name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
	}
	private secrets(): { getSecret(id: string): string | null; setSecret(id: string, v: string): void } | null {
		return (this.app as unknown as { secretStorage?: { getSecret(id: string): string | null; setSecret(id: string, v: string): void } }).secretStorage ?? null;
	}
	getSecret(name: string): string {
		const store = this.secrets();
		if (store) {
			try {
				const v = store.getSecret(this.secretId(name));
				if (v) return v;
				// Saved before this device's Obsidian gained SecretStorage: move it over.
				const old = this.localGet(`secret:${name}`);
				if (old) {
					store.setSecret(this.secretId(name), old);
					this.localSet(`secret:${name}`, null);
				}
				return old ?? "";
			} catch {
				/* fall through */
			}
		}
		return this.localGet(`secret:${name}`) ?? "";
	}
	setSecret(name: string, value: string) {
		const store = this.secrets();
		if (store) {
			try {
				store.setSecret(this.secretId(name), value);
				this.localSet(`secret:${name}`, null);
				return;
			} catch {
				/* fall back */
			}
		}
		this.localSet(`secret:${name}`, value || null);
	}
	getToken(): string {
		if (this.usingGitHubApp()) return this.appTokens()?.access ?? "";
		if (this.usingGitLabApp()) return this.gitlabTokens()?.access ?? "";
		const token = this.getSecret("token");
		if (!token) return "";
		// A pasted token is only ever sent to the host and API URL it was entered for: a synced data.json,
		// a setup link or a host switch can't redirect it. Tokens saved before 1.3 get bound on first use.
		const bound = this.localGet("token:for");
		if (bound === null) {
			// The binding is gone (device storage cleared): adopt the token for this host only when it looks
			// like one of this host's tokens; otherwise it stays unused until a new one is pasted.
			if (!tokenLooksLike(this.settings.provider ?? "github", token)) return "";
			this.localSet("token:for", this.tokenTarget());
		} else if (bound !== this.tokenTarget()) return "";
		return token;
	}
	private tokenTarget(): string {
		return `${this.settings.provider ?? "github"}|${this.getApiBase().replace(/\/+$/, "")}`;
	}
	/** After the user changes the API URL in settings themselves, the token follows it. */
	rebindToken() {
		// Only within the same host (e.g. fixing a typo in a self-hosted URL): a token entered for another
		// host stays hidden until a new one is pasted.
		// Same provider and same server (host name and port), e.g. a changed path or http→https. An unbound
		// token is left to getToken, which only adopts it when its format fits the host.
		const bound = this.localGet("token:for");
		const provider = this.settings.provider ?? "github";
		if (!this.getSecret("token") || bound === null || !bound.startsWith(`${provider}|`)) return;
		const oldHost = urlHost(bound.slice(provider.length + 1));
		if (oldHost !== null && oldHost === urlHost(this.getApiBase())) this.localSet("token:for", this.tokenTarget());
	}
	/** A shared folder's own token, only for the host and API URL it was entered for (empty otherwise). */
	sharedToken(def: SharedFolder): string {
		const token = this.getSecret(`token-shared-${def.id}`);
		if (!token) return "";
		const target = `${def.provider}|${this.getApiBaseFor(def.provider).replace(/\/+$/, "")}`;
		const bound = this.localGet(`token-shared-for:${def.id}`);
		if (bound === null) this.localSet(`token-shared-for:${def.id}`, target);
		else if (bound !== target) return "";
		return token;
	}
	/** The backup mirror's own token, bound to its host and API URL like the others. */
	mirrorToken(def: { id: string; provider: HostKind }): string {
		return this.sharedToken(def as SharedFolder);
	}
	setSharedToken(def: SharedFolder, token: string) {
		this.setSecret(`token-shared-${def.id}`, token);
		this.localSet(`token-shared-for:${def.id}`, token ? `${def.provider}|${this.getApiBaseFor(def.provider).replace(/\/+$/, "")}` : null);
	}
	setToken(token: string) {
		if (token) this.authGen++;
		this.setSecret("token", token);
		this.localSet("token:for", token ? this.tokenTarget() : null);
		// Pasting a token switches this device back to token sign-in.
		if (token && this.usingGitHubApp()) this.localSet("auth:github", null);
		if (token && this.usingGitLabApp()) this.localSet("auth:gitlab", null);
	}

	// ---------------- Sign in with GitHub (GitHub App device flow) ----------------

	/** Days until the pasted token expires, when the host reports it (GitHub); null = unknown. */
	tokenExpiryDays(): number | null {
		if (this.usingSignIn()) return null;
		const at = this.gh.tokenExpiresAt?.() ?? null;
		return at === null ? null : Math.floor((at - Date.now()) / 86_400_000);
	}
	/** Opens the host's token page (prefilled on GitHub). */
	openTokenPage() {
		const first = HOSTS[this.settings.provider ?? "github"].tokenSteps(this.getApiBase(), this.app.vault.getName()).find((s) => s.link);
		if (first?.link) window.open(first.link.href);
		else this.openSettings();
	}
	/** Once a day, warn when the pasted token expires within a week. */
	private warnTokenExpiry() {
		const days = this.tokenExpiryDays();
		if (days === null || days > 7) return;
		const today = new Date().toDateString();
		if (this.localGet("tokenWarned") === today) return;
		this.localSet("tokenWarned", today);
		new Notice(days <= 0 ? t("h.tokenExpiresToday") : t("h.tokenExpires", { days }), 15000);
	}

	/** The GitHub App to sign in with on this device: a custom one (Enterprise), else the built-in one on github.com. */
	githubApp(): AppConfig | null {
		const clientId = this.localGet("ghapp:clientId") ?? "";
		if (clientId) return { clientId, slug: this.localGet("ghapp:slug") ?? "" };
		const api = this.getApiBaseFor("github").replace(/\/+$/, "");
		return GITHUB_APP.clientId && /^https:\/\/api\.github\.com$/i.test(api) ? GITHUB_APP : null;
	}
	setCustomGitHubApp(clientId: string, slug: string) {
		this.localSet("ghapp:clientId", clientId || null);
		this.localSet("ghapp:slug", slug || null);
	}
	customGitHubApp(): AppConfig {
		return { clientId: this.localGet("ghapp:clientId") ?? "", slug: this.localGet("ghapp:slug") ?? "" };
	}
	githubWeb(): string {
		return webBase(this.getApiBaseFor("github"));
	}
	usingGitHubApp(): boolean {
		return (this.settings.provider ?? "github") === "github" && this.localGet("auth:github") === "app";
	}
	/** The sign-in tokens, but only for the server and app that issued them (never sent anywhere else). */
	appTokens(): AppTokens | null {
		const tokens = parseTokens(this.getSecret("ghapp"));
		if (!tokens) return null;
		const app = this.githubApp();
		// Tokens without a record of the server that issued them are never used (they could go anywhere).
		if (!tokens.web || tokens.web !== this.githubWeb() || (tokens.clientId && tokens.clientId !== app?.clientId)) return null;
		return tokens;
	}
	signedInWithApp(tokens: AppTokens) {
		this.setSecret("ghapp", JSON.stringify({ ...tokens, web: this.githubWeb(), clientId: this.githubApp()?.clientId }));
		this.localSet("auth:github", "app");
		this.expiredNoticeShown = false;
	}
	signOutApp() {
		this.authGen++;
		this.setSecret("ghapp", "");
		this.localSet("auth:github", null);
	}
	// ---------------- Sign in with GitLab (OAuth device flow) ----------------

	/** The GitLab application to sign in with: a custom one (self-managed), else the built-in one on gitlab.com. */
	gitlabApp(): { clientId: string } | null {
		const clientId = this.localGet("glapp:clientId") ?? "";
		if (clientId) return { clientId };
		const api = this.getApiBaseFor("gitlab").replace(/\/+$/, "");
		return GITLAB_APP.clientId && /^https:\/\/gitlab\.com\/api\/v4$/i.test(api) ? GITLAB_APP : null;
	}
	setCustomGitLabApp(clientId: string) {
		this.localSet("glapp:clientId", clientId || null);
	}
	gitlabWeb(): string {
		return webBaseFromApi(this.getApiBaseFor("gitlab"));
	}
	usingGitLabApp(): boolean {
		return this.settings.provider === "gitlab" && this.localGet("auth:gitlab") === "app";
	}
	/** Signed in through a host app (GitHub or GitLab) rather than a pasted token. */
	usingSignIn(): boolean {
		return this.usingGitHubApp() || this.usingGitLabApp();
	}
	/** GitLab sign-in tokens, only for the server and application that issued them. */
	gitlabTokens(): AppTokens | null {
		const tokens = parseGitLabTokens(this.getSecret("glapp"));
		if (!tokens) return null;
		const web = (tokens as { web?: string }).web;
		const clientId = (tokens as { clientId?: string }).clientId;
		// Tokens without a record of the server that issued them are never used (they could go anywhere).
		if (!web || web !== this.gitlabWeb() || (clientId && clientId !== this.gitlabApp()?.clientId)) return null;
		return tokens;
	}
	signedInWithGitLab(tokens: AppTokens, web = this.gitlabWeb(), clientId = this.gitlabApp()?.clientId) {
		this.setSecret("glapp", JSON.stringify({ ...tokens, web, clientId }));
		this.localSet("auth:gitlab", "app");
		this.expiredNoticeShown = false;
	}
	signOutGitLab() {
		this.authGen++;
		this.setSecret("glapp", "");
		this.localSet("auth:gitlab", null);
	}
	/** Bumped on sign-out and when a token is pasted: a refresh or sign-in finishing later is dropped. */
	authGen = 0;
	/** Main-host credentials for a shared folder or mirror on the same host (never sent to another host). */
	borrowedAuth(provider: string): { token: string; bearer: boolean; onUnauthorized: (failed: string) => Promise<boolean> } {
		const same = provider === this.settings.provider;
		return {
			token: same ? this.getToken() : "",
			bearer: same && provider === "gitlab" && this.usingGitLabApp(),
			onUnauthorized: (failed) => (same ? this.ensureFreshToken(true, failed) : Promise.resolve(false)),
		};
	}
	/** True when signed in through a host app and its tokens are present and valid for this server. */
	signedInNow(): boolean {
		return this.usingGitLabApp() ? !!this.gitlabTokens() : this.usingGitHubApp() ? !!this.appTokens() : false;
	}
	/** The device-flow steps for the sign-in dialog. */
	signInFlow(kind: "github" | "gitlab"): SignInFlow {
		if (kind === "gitlab") {
			let code: GitLabDeviceCode | null = null;
			return {
				title: t("app.signInGitLab"),
				host: "GitLab",
				available: () => !!this.gitlabApp(),
				start: async () => (code = await startGitLabDeviceFlow(this.gitlabWeb(), this.gitlabApp()!.clientId)),
				finish: async (isCancelled) => {
					const web = this.gitlabWeb();
					const clientId = this.gitlabApp()!.clientId;
					const tokens = await pollGitLabDeviceFlow(web, clientId, code!, { isCancelled });
					if (!isCancelled()) this.signedInWithGitLab(tokens, web, clientId);
				},
			};
		}
		let code: DeviceCode | null = null;
		return {
			title: t("app.signIn"),
			host: "GitHub",
			available: () => !!this.githubApp(),
			start: async () => (code = await startDeviceFlow(this.githubWeb(), this.githubApp()!.clientId)),
			finish: async (isCancelled) => {
				const tokens = await pollDeviceFlow(this.githubWeb(), this.githubApp()!.clientId, code!, { isCancelled });
				if (!isCancelled()) this.signedInWithApp(tokens);
			},
		};
	}

	/**
	 * Make sure the sign-in token is valid, refreshing it shortly before it expires (or right away
	 * when `force`, after a 401). Only one refresh runs at a time: GitHub and GitLab rotate refresh
	 * tokens, so two concurrent refreshes would sign the device out. Returns true when a usable token exists.
	 */
	ensureFreshToken(force = false, failedToken?: string): Promise<boolean> {
		// A pasted token can't be renewed: retrying a 401 with it would fail again.
		if (!this.usingSignIn()) return Promise.resolve(!force && !!this.getToken());
		if (this.refreshing) return this.refreshing;
		const gitlab = this.usingGitLabApp();
		const before = gitlab ? this.gitlabTokens() : this.appTokens();
		if (!before) return Promise.resolve(false);
		// Another request already renewed it: just retry with the new token.
		if (failedToken && before.access !== failedToken) return Promise.resolve(true);
		if (!force && !(gitlab ? gitlabNeedsRefresh(before) : needsRefresh(before))) return Promise.resolve(true);
		const gen = this.authGen;
		let run!: Promise<boolean>;
		run = (async () => {
			// Yield first, so `this.refreshing` is set before an early failure clears it in `finally`.
			await Promise.resolve();
			try {
				if (gitlab) {
					const app = this.gitlabApp();
					if (!app || !before.refresh) throw new DeviceFlowError("bad_refresh_token");
					const web = this.gitlabWeb();
					const fresh = await refreshGitLabToken(web, app.clientId, before.refresh);
					// Signed out, or a token pasted, while refreshing: don't sign back in.
					if (gen !== this.authGen) return false;
					this.signedInWithGitLab(fresh, web, app.clientId);
					return true;
				}
				const app = this.githubApp();
				if (!app || !before.refresh) throw new DeviceFlowError("bad_refresh_token");
				const fresh = await refreshAppToken(this.githubWeb(), app.clientId, before.refresh);
				if (gen !== this.authGen) return false;
				this.signedInWithApp(fresh);
				return true;
			} catch (e) {
				this.log(`Sign-in refresh failed: ${errMsg(e)}`);
				if ((e instanceof DeviceFlowError || e instanceof GitLabFlowError) && e.code !== "http" && !this.expiredNoticeShown) {
					this.expiredNoticeShown = true;
					new Notice(t("app.expiredSession", { host: gitlab ? "GitLab" : "GitHub" }), 10000);
				}
				return false;
			} finally {
				if (this.refreshing === run) this.refreshing = null;
			}
		})();
		this.refreshing = run;
		return run;
	}
	/** The git host client for the configured provider (rebuilt when the provider changes). */
	get gh(): Remote {
		const kind = this.settings.provider ?? "github";
		const { owner, repo } = this.settings;
		const key = `${kind}|${owner}|${repo}`;
		if (!this.remoteCache || this.remoteCache.kind !== key) {
			this.remoteCache = {
				kind: key,
				remote: makeRemote(
					kind,
					() => ({ token: this.getToken(), apiBase: this.getApiBaseFor(kind), owner, repo, onUnauthorized: (failed) => this.ensureFreshToken(true, failed), bearer: kind === "gitlab" && this.usingGitLabApp() }),
					this.blobCacheStore(`${this.settings.owner}-${this.settings.repo}`),
				),
			};
		}
		return this.remoteCache.remote;
	}
	/** Per-repository hash cache for hosts without blob hashes (Bitbucket). Never synced. */
	blobCacheStore(key: string): BlobCacheStore {
		const path = normalizePath(this.stateFilePath.replace(/sync-state\.json$/, `sync-state-cache-${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`));
		const adapter = this.app.vault.adapter;
		return {
			load: async () => (await adapter.exists(path) ? (JSON.parse(await adapter.read(path)) as BlobCache) : null),
			save: async (c) => adapter.write(path, JSON.stringify(c)),
		};
	}
	/** An error as shown to the user: translated, with this repository's host as the default host name. */
	errorText(e: unknown): string {
		return localizeError(e, this.hostLabel());
	}

	hostLabel(): string {
		return HOSTS[this.settings.provider ?? "github"].label;
	}
	// The API URL is per device and per provider (a synced data.json must never redirect the token).
	getApiBase(): string {
		return this.getApiBaseFor(this.settings.provider ?? "github");
	}
	getApiBaseFor(kind: HostKind): string {
		try {
			return this.localGet(`apiBase:${kind}`) || HOSTS[kind].defaultApi;
		} catch {
			return HOSTS[kind].defaultApi;
		}
	}
	setApiBase(url: string) {
		this.localSet(`apiBase:${this.settings.provider ?? "github"}`, url);
	}
	deviceName(): string {
		let name = "";
		try {
			name = this.localGet("device") ?? "";
		} catch {
			/* ignore */
		}
		if (name) return name;
		if (Platform.isIosApp) return "iPhone/iPad";
		if (Platform.isAndroidApp) return "Android";
		if (Platform.isMacOS) return "Mac";
		if (Platform.isWin) return "Windows";
		if (Platform.isLinux) return "Linux";
		return "Device";
	}
	setDeviceName(name: string) {
		this.localSet("device", name);
	}
	/** Device-local scope: never synced, so each device can choose its own folders and limits. */
	deviceScope(): DeviceScope {
		try {
			const raw = JSON.parse(this.localGet("scope") ?? "{}") as Partial<DeviceScope>;
			return {
				include: Array.isArray(raw.include) ? raw.include.map(String) : [],
				exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [],
				// Phones default to a 25 MB download limit (big files are memory-heavy on mobile); 0 = no limit.
				maxDownloadMB: raw.maxDownloadMB === undefined ? (Platform.isMobile ? 25 : 0) : Number(raw.maxDownloadMB) || 0,
				pinned: this.pinned(),
			};
		} catch {
			return { include: [], exclude: [], maxDownloadMB: 0 };
		}
	}
	/** Files this device downloaded on demand (kept in sync despite the size limit). */
	pinned(): string[] {
		try {
			const v = JSON.parse(this.localGet("pinned") ?? "[]") as unknown;
			return Array.isArray(v) ? v.map(String) : [];
		} catch {
			return [];
		}
	}
	private setPinned(paths: string[]) {
		this.localSet("pinned", JSON.stringify([...new Set(paths)]));
		this.settingTab?.refreshIfHidden();
	}
	/** Remote files not downloaded to this device, largest first. */
	remoteOnlyFiles(): { path: string; size: number }[] {
		return Object.entries(this.state.remoteOnly ?? {})
			.map(([path, e]) => ({ path, size: e.size }))
			.sort((a, b) => b.size - a.size);
	}
	/** Download remote-only files now and keep them synced on this device. */
	async downloadOnDemand(paths: string[]) {
		if (!paths.length) return;
		this.setPinned([...this.pinned(), ...paths]);
		new Notice(paths.length === 1 ? t("m.downloadingOne", { path: paths[0] }) : t("m.downloadingMany", { n: paths.length }));
		await this.sync("manual", this.settings.mode, { firstSyncPrefer: undefined });
	}
	clearPinned() {
		this.setPinned([]);
	}
	openRemoteOnly() {
		const files = this.remoteOnlyFiles();
		if (!files.length) return void new Notice(t("m.allLocal"));
		new RemoteOnlyModal(this.app, files, (f) => void this.downloadOnDemand([f.path])).open();
	}
	/** Finds the remote-only file an embed or link points to. */
	private remoteOnlyFor(linkpath: string): { path: string; size: number } | null {
		const clean = linkpath.split("#")[0].split("|")[0];
		const all = this.remoteOnlyFiles();
		const exact = all.find((f) => f.path === clean);
		if (exact) return exact;
		const base = clean.split("/").pop()!;
		const candidates = all.filter((f) => f.path.endsWith("/" + clean) || f.path.split("/").pop() === base);
		return candidates.sort((a, b) => a.path.length - b.path.length)[0] ?? null;
	}

	setDeviceScope(scope: DeviceScope) {
		this.localSet("scope", JSON.stringify(scope));
		this.fullScanNeeded = true;
	}
	// ---------------- encryption ----------------

	/** The encryption layer while the key is on this device (used by the mirror too). */
	encryptionLayer(): EncryptionLayer | null {
		return this.encLayer;
	}
	encryptionRecord(): EncryptionRecord | null {
		const raw = this.getSecret("encryption");
		if (!raw) return null;
		try {
			return JSON.parse(raw) as EncryptionRecord;
		} catch {
			return null;
		}
	}
	private async loadEncryption() {
		const rec = this.encryptionRecord();
		this.encLayer = rec ? await EncryptionLayer.fromMaster(unb64(rec.master)) : null;
	}
	isEncrypted(): boolean {
		return this.encLayer !== null;
	}
	async saveEncryption(r: { meta: EncryptionMeta; master: Uint8Array }) {
		this.setSecret("encryption", JSON.stringify({ meta: r.meta, master: b64(r.master) } satisfies EncryptionRecord));
		await this.loadEncryption();
		this.fullScanNeeded = true;
		this.log("End-to-end encryption unlocked on this device.");
		this.refreshHealth(true);
	}
	async lockEncryption() {
		// Never change keys under a running sync: it would mix two encodings in one run.
		if (this.syncing) return void new Notice(t("notice.busy"));
		this.setSecret("encryption", "");
		this.encLayer = null;
		this.fullScanNeeded = true;
		this.log("Encryption key removed from this device.");
		this.refreshHealth(true);
	}
	openEncryption(done?: () => void) {
		if (this.syncing) return void new Notice(t("notice.busy"));
		new EncryptionModal(this.app, this, done).open();
	}
	/** An encrypted repository viewed without the key would show scrambled names: ask to unlock first. */
	private async needsUnlock(): Promise<boolean> {
		if (this.isEncrypted()) return false;
		const marker = await readRemoteMarker(this).catch(() => null);
		if (!marker) return false;
		new Notice(t("m.unlockToBrowse"));
		this.openEncryption();
		return true;
	}
	async removeUnencryptedFiles() {
		if (!this.beginExclusive()) return;
		try {
			const removed = await this.engine.removeUnencryptedFiles((files) =>
				confirmPlan(this.app, t("m.plainTitle"), t("m.plainBody"), [{ title: t("m.deleteFrom", { host: this.hostLabel() }), items: files }], t("m.remove"), true),
			);
			new Notice(removed.length ? t("m.plainRemoved", { n: removed.length }) : t("m.plainNone"));
		} catch (e) {
			if (!(e instanceof SyncCancelled)) new Notice(t("m.removeFailed", { error: this.errorText(e) }));
		} finally {
			this.endExclusive();
		}
	}
	/** Shared folders belong to their own repositories; the main vault repo never touches them. */
	extraExcludes(): string[] {
		return (this.settings.sharedFolders ?? []).filter((f) => f.enabled && f.folder).map((f) => sharedFolderPattern(f.folder));
	}
	sharedHostsCached(): SharedFolderHost[] {
		return this.shared?.hosts ?? [];
	}
	async sharedHosts(): Promise<SharedFolderHost[]> {
		const defs = syncableSharedFolders(this.settings.sharedFolders);
		const sig = JSON.stringify(defs);
		if (!this.shared || this.shared.sig !== sig) {
			const hosts = defs.map((d) => new SharedFolderHost(this, d));
			for (const h of hosts) await h.loadState();
			this.shared = { sig, hosts };
		}
		return this.shared.hosts;
	}
	/**
	 * Settings-folder sync with "install plugins from official releases": plugins turned on (or updated)
	 * on another device are installed here from the community registry, after asking. A declined
	 * version isn't offered again.
	 */
	private offeringPlugins = false;
	private async offerPluginInstalls() {
		if (this.offeringPlugins) return;
		this.offeringPlugins = true;
		try {
			await this.offerPluginInstallsNow();
		} finally {
			this.offeringPlugins = false;
		}
	}
	private async offerPluginInstallsNow() {
		const cs = this.settings.configSync;
		if (!this.settings.syncConfigDir || !cs.installFromReleases || !cs.pluginCode || !cs.pluginList) return;
		const a = this.app.vault.adapter;
		const cfg = this.app.vault.configDir;
		const declined = new Set((this.localGet("declinedInstalls") ?? "").split("\n").filter(Boolean));
		// The community list is only downloaded when a plugin still needs installing and wasn't declined.
		const { needs } = await findPluginNeeds(
			{
				exists: (p) => a.exists(p),
				read: async (p) => {
					const text = await a.read(p);
					if (!p.endsWith("/manifest.json")) return text;
					try {
						const m = JSON.parse(text) as { id?: string; version?: string };
						if (declined.has(`${m.id}@${m.version}`)) throw new Error("declined");
					} catch (e) {
						if (e instanceof Error && e.message === "declined") return "{}";
					}
					return text;
				},
			},
			cfg,
			() => fetchRegistry(),
			new Set((this.localGet("pluginUpdatesPending") ?? "").split("\n").filter(Boolean)),
		);
		const offer = needs.filter((n) => !declined.has(`${n.id}@${n.version}`));
		if (!offer.length) return;
		const items = offer.map((n) => `${n.name} ${n.version} (${n.repo})`);
		const ok = await confirmPlan(this.app, t("pi.title"), t("pi.body"), [{ title: t("pi.list"), items }], t("pi.install"));
		if (!ok) {
			for (const n of offer) declined.add(`${n.id}@${n.version}`);
			this.localSet("declinedInstalls", [...declined].join("\n"));
			return;
		}
		const done: string[] = [];
		for (const n of offer) {
			try {
				await installPlugin(n, { transport: obsidianFetch, write: (p, d) => a.writeBinary(p, d), mkdir: async (p) => {
					if (!(await a.exists(p))) await a.mkdir(p);
				} }, cfg);
				done.push(n.name);
			} catch (e) {
				this.log(`Installing ${n.id} ${n.version} failed: ${errMsg(e)}`);
				new Notice(t("pi.failed", { name: n.name, error: this.errorText(e) }), 8000);
			}
		}
		if (done.length) new Notice(t("pi.done", { list: done.join(", ") }), 12000);
		// Installed (or declined above): no longer pending.
		const pending = (this.localGet("pluginUpdatesPending") ?? "").split("\n").filter((id) => id && !offer.some((n) => n.id === id && done.includes(n.name)));
		this.localSet("pluginUpdatesPending", pending.join("\n") || null);
	}

	private mirrorHost: { sig: string; host: MirrorHost } | null = null;
	/** The backup mirror for the current settings (rebuilt when its target changes). */
	async mirror(): Promise<MirrorHost | null> {
		const m = syncableMirror(this.settings.mirror);
		if (!m) return null;
		const sig = JSON.stringify(m);
		if (!this.mirrorHost || this.mirrorHost.sig !== sig) {
			const host = new MirrorHost(this, m);
			await host.loadState();
			this.mirrorHost = { sig, host };
		}
		return this.mirrorHost.host;
	}
	/** The mirror's last result, for the status panel (null when no mirror ran yet). */
	mirrorStatus(): { label: string; lastSync: number; lastError: string | null } | null {
		const m = this.settings.mirror;
		const h = this.mirrorHost?.host;
		if (!m?.enabled || !isKnownProvider(m.provider)) return null;
		return { label: `${HOSTS[m.provider].label} ${m.owner}/${m.repo}`, lastSync: h?.lastSync ?? 0, lastError: h?.lastError ?? null };
	}
	/** Uploads this vault to the backup mirror (push only). Returns an error message, or null. */
	private async syncMirror(guardKept: string[] = []): Promise<string | null> {
		const h = await this.mirror();
		if (!h || this.settings.mode === "pull") return null;
		try {
			// Deletions held back at the delete guard are held back on the mirror too.
			const r = await h.engine.run("push", guardKept.length ? { defer: new Set(guardKept) } : {});
			// Turning encryption on: the mirror's old plaintext files are removed once (they stay in its history).
			const fp = this.encLayer?.id ?? "";
			const key = `mirrorPlainGone:${h.target.provider}:${h.target.owner}/${h.target.repo}`;
			if (fp && this.localGet(key) !== fp) {
				await h.engine.removeUnencryptedFiles(async () => true);
				this.localSet(key, fp);
			}
			h.lastError = null;
			h.lastSync = Date.now();
			if (!r.upToDate) h.log(`Mirrored: ↑${r.uploaded.length} ✕${r.deletedRemote.length}`);
			return null;
		} catch (e) {
			if (e instanceof SyncCancelled) return null;
			h.lastError = localizeError(e);
			h.log(`Mirror failed: ${errMsg(e)}`);
			return localizeError(e);
		}
	}

	private async syncShared(mode: SyncMode): Promise<string[]> {
		const errors: string[] = [];
		for (const h of await this.sharedHosts()) {
			if (!h.activeOnThisDevice()) continue;
			try {
				const r = await h.engine.run(mode);
				h.lastError = null;
				h.lastSync = Date.now();
				if (!r.upToDate) h.log(`Synced: ↓${r.downloaded.length} ↑${r.uploaded.length} merged ${r.merged.length}`);
				for (const url of r.pullRequests ?? []) this.notify(t("m.prOpened", { folder: h.def.folder, url }), true);
			} catch (e) {
				if (e instanceof SyncCancelled) continue;
				h.lastError = localizeError(e);
				h.log(`Sync failed: ${errMsg(e)}`);
				errors.push(`${h.def.folder}: ${localizeError(e)}`);
			}
		}
		return errors;
	}

	codec(): Codec {
		// LFS is always present for reading pointers; it only uploads when a threshold is set.
		const lfs = new LfsLayer(this.gh, (this.settings.lfsThresholdMB ?? 0) * 1024 * 1024, undefined, this.lfsPatterns);
		const layers: Layer[] = this.encLayer ? [this.encLayer, lfs] : [lfs];
		// The vault in a folder of the repository: last, so encrypted names go inside that folder.
		const sub = normalizeSubdir(this.settings.repoSubdir);
		if (sub) layers.push(new RepoSubdirLayer(sub));
		return new Codec(layers);
	}
	/**
	 * Number of files already in the repository at `subdir` ("" = the whole repository), for the warning
	 * shown before changing "Folder in the repository". null when the repository can't be read.
	 */
	async repoFolderFileCount(subdir: string): Promise<number | null> {
		try {
			const head = await this.gh.getRef(this.settings.branch);
			if (!head) return 0;
			const sub = normalizeSubdir(subdir);
			const prefix = sub ? sub + "/" : "";
			let n = 0;
			for (const e of await this.gh.listTree(await this.gh.getCommitTree(head))) {
				if (e.type !== "blob" || !e.path.startsWith(prefix)) continue;
				const rel = e.path.slice(prefix.length);
				if (rel === ".gitattributes" || rel.startsWith(".vault-sync/")) continue;
				n++;
			}
			return n;
		} catch {
			return null;
		}
	}
	checkEncryption = (markerSha: string | null): Promise<string | null> =>
		encryptionGuard(
			() => this.encryptionRecord(),
			(r) => this.setSecret("encryption", JSON.stringify(r)),
			async (sha) => JSON.parse(new TextDecoder().decode(await this.gh.getBlob(sha))) as EncryptionMeta,
		)(markerSha);

	progress(text: string) {
		this.onProgress?.(text);
		this.statusEl?.setAttr("aria-label", text);
		this.ribbonEl?.setAttr("aria-label", `${t("ribbon.sync")}: ${text}`);
	}
	openWizard(start?: "vault") {
		new SetupWizard(this.app, this, start).open();
	}

	// ---------------- add a device (setup link) ----------------

	openSetupLink() {
		if (!this.isConfigured()) return void new Notice(this.configProblem() ?? t("m.needRepo"));
		new CreateSetupLinkModal(this.app, this).open();
	}

	/** Applies a confirmed setup link to this vault, then continues in the setup wizard. */
	async applySetupPayload(s: SetupPayload, token: string) {
		this.settings.provider = s.provider;
		this.setApiBase(s.api ?? HOSTS[s.provider].defaultApi);
		this.settings.owner = s.owner;
		this.settings.repo = s.repo;
		this.settings.branch = s.branch;
		if (s.syncConfigDir !== undefined) this.settings.syncConfigDir = s.syncConfigDir;
		if (s.configSync) this.settings.configSync = normalizeConfigSync(s.configSync);
		if (s.syncHidden !== undefined) this.settings.syncHidden = s.syncHidden;
		if (s.useGitignore !== undefined) this.settings.useGitignore = s.useGitignore;
		if (s.exclude !== undefined) this.settings.excludePatterns = s.exclude;
		// Always set: a vault in a repository folder must not land at the root on the new device.
		this.settings.repoSubdir = normalizeSubdir(s.subdir);
		this.settings.wizardShown = true;
		if (token) this.setToken(token);
		await this.saveSettings();
		this.log(`Setup link applied: ${s.provider} ${s.owner}/${s.repo} (${s.branch}).`);
		// With a usable token the wizard goes straight to "this vault"; otherwise connect (sign in) first.
		// A token entered for another host or server is never reused (getToken checks what it is for).
		this.openWizard(this.getToken() ? "vault" : undefined);
	}

	/** First sync from the setup wizard. Returns a one-line summary. */
	async firstSync(prefer?: "local" | "remote"): Promise<string> {
		// An automatic sync may be running: wait for it, so this one runs now (not queued) and its
		// result, with the side chosen in the wizard, is the one reported.
		for (let i = 0; this.syncing && i < 600; i++) await sleep(500);
		this.lastError = null;
		this.lastErrorCause = null;
		this.lastReport = null;
		await this.sync("manual", this.settings.mode, prefer ? { firstSyncPrefer: prefer } : { firstSyncPrefer: undefined });
		const err = this.lastError as string | null;
		if (err) return t("m.firstFailed", { error: this.errorText(this.lastErrorCause ?? err) });
		const r = this.lastReport as SyncReport | null;
		if (!r) return t("m.syncFinished");
		if (r.upToDate) return t("m.alreadyInSync");
		const parts = [
			r.downloaded.length && t("m.nDownloaded", { n: r.downloaded.length }),
			r.uploaded.length && t("m.nUploaded", { n: r.uploaded.length }),
			r.conflictCopies.length && t("m.nBoth", { n: r.conflictCopies.length }),
			r.skipped.length && t("m.nSkipped", { n: r.skipped.length }),
		].filter(Boolean);
		return t("m.firstDone", { summary: parts.join(", ") || t("m.noChanges") });
	}

	async freeUpSpace() {
		if (!this.isConfigured()) return void new Notice(this.configProblem()!);
		if (!this.beginExclusive()) return;
		try {
			await this.freeUpSpaceInner();
		} finally {
			this.endExclusive();
		}
	}
	private async freeUpSpaceInner() {
		try {
			await this.loadGitignore();
			const plan = await this.engine.freeUpSpace((p) =>
				confirmPlan(
					this.app,
					t("cmd.freeSpace"),
					t("m.freeBody", { n: p.files.length, mb: (p.bytes / 1048576).toFixed(1) }),
					[{ title: t("m.removeHere"), items: p.files }],
					t("s.freeSpace"),
				),
			);
			if (!plan.files.length) new Notice(t("m.freeNothing"));
			else new Notice(t("m.freed", { mb: (plan.bytes / 1048576).toFixed(1) }));
		} catch (e) {
			if (!(e instanceof SyncCancelled)) new Notice(t("m.freeFailed", { error: this.errorText(e) }));
		}
		this.refreshHealth();
	}

	// ---------------- persistence ----------------

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<VaultSyncSettings> | null;
		const next: VaultSyncSettings = Object.assign({}, DEFAULT_SETTINGS, saved);
		next.configSync = normalizeConfigSync(saved?.configSync);
		if (this.settings) {
			// Reloaded (data.json changed on disk): update the object in place, since the settings tab and
			// other closures hold it, and a replaced object would make their later edits not save.
			const cur = this.settings as unknown as Record<string, unknown>;
			for (const k of Object.keys(cur)) if (!(k in next)) delete cur[k];
			Object.assign(this.settings, next);
		} else this.settings = next;
		this.handleRemovedHosts();
	}
	/**
	 * Gitee and Azure DevOps were removed in 1.4.0. Settings that still use them pause instead of switching
	 * host (which could push the vault to another repository); files are never touched. One notice per device.
	 */
	private handleRemovedHosts() {
		const r = dropRemovedHosts(this.settings);
		if (r.main) this.log(`Host "${r.main.provider}" is no longer supported (${r.main.owner}/${r.main.repo}): sync paused until another host is set up.`);
		if (r.mirror) this.log(`Backup mirror host "${r.mirror.provider}" is no longer supported (${r.mirror.owner}/${r.mirror.repo}): mirror turned off.`);
		for (const f of r.shared) this.log(`Shared folder ${f}: its host is no longer supported; it is skipped.`);
		const kind = removedHostNotice(r, this.settings);
		if (!kind) return;
		try {
			if (this.localGet(`removedHostNotice:${kind}`)) return;
			this.localSet(`removedHostNotice:${kind}`, "1");
		} catch {
			// No device storage (shouldn't happen): show the notice anyway.
		}
		new Notice(t(kind === "main" ? "m.hostRemoved" : "m.hostRemovedOther"), 0);
	}
	async saveSettings() {
		// A repository entered after a removed host: sync can run again.
		if (this.settings.removedHost && this.settings.owner && this.settings.repo) delete this.settings.removedHost;
		await this.saveData(this.settings);
		// Scope settings may have changed: rescan everything next time.
		this.fullScanNeeded = true;
	}
	/** Random id for this device and vault, kept in device-local storage. */
	deviceId(): string {
		let id = this.localGet("deviceId");
		if (!id) {
			id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
			this.localSet("deviceId", id);
		}
		return id;
	}
	async loadState() {
		this.state = await readState(this.app.vault.adapter, this.stateFilePath, this.deviceId(), (m) => this.log(m));
	}
	async saveState() {
		await writeState(this.app.vault.adapter, this.stateFilePath, this.state, this.deviceId());
	}
	/** Forgets what was last synced on this device. Returns false (with a notice) while a sync runs. */
	async resetState(): Promise<boolean> {
		if (this.syncing) {
			new Notice(t("notice.busy"));
			return false;
		}
		this.state = { ...emptyState(), deviceId: this.deviceId() };
		this.fullScanNeeded = true;
		await this.saveState();
		this.log("Sync state reset by user.");
		return true;
	}

	// ---------------- change tracking (SyncHost) ----------------

	localChanges(): LocalChanges {
		this.dirtySnapshot = new Map(this.dirty);
		return { full: this.fullScanNeeded, paths: new Set(this.dirty.keys()) };
	}
	markLocalChangesSynced(covered: LocalChanges) {
		if (covered.full) this.fullScanNeeded = false;
		for (const [p, seq] of this.dirtySnapshot) {
			if (covered.paths.has(p) && this.dirty.get(p) === seq) this.dirty.delete(p);
		}
	}
	/** Files changed on this device since the last sync (stat comparison plus vault-event flags). */
	pendingLocalCount(): number {
		return this.pendingLocalPaths().size;
	}
	/** Files edited on this device since the last sync (cheap: cached stats and vault events). */
	pendingLocalPaths(): Set<string> {
		const pending = new Set(this.engine.quickLocalPending());
		for (const p of this.dirty.keys()) pending.add(p);
		return pending;
	}

	// ---------------- triggers ----------------

	rescheduleTriggers() {
		this.onChangeDebounced?.cancel();
		this.onChangeDebounced = debounce(() => this.sync("change"), this.settings.changeDebounceSec * 1000, true);
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		this.nextIntervalAt = 0;
		if (this.settings.intervalMin > 0 && !this.batterySaver()) {
			const ms = this.settings.intervalMin * 60_000;
			this.nextIntervalAt = Date.now() + ms;
			this.intervalId = window.setInterval(() => {
				this.nextIntervalAt = Date.now() + ms;
				void this.sync("interval");
			}, ms);
			this.registerInterval(this.intervalId);
		}
	}
	nextScheduledSync(): number {
		return this.nextIntervalAt;
	}

	// ---------------- commit context, frontmatter scope, explorer scope ----------------

	/** Redraws the status bar countdown and branch (desktop). */
	updateStatusExtras: () => void = () => {};
	private customCommitMessage: { text: string; at: number } | null = null;
	private syncContext: { trigger: string; message: string | null } = { trigger: "manual", message: null };
	/** The next manual sync uses this as its commit message ("Sync with a custom message…"). */
	setCustomCommitMessage(text: string) {
		this.customCommitMessage = { text, at: Date.now() };
	}
	commitContext(): { trigger: string; message: string | null } {
		return this.syncContext;
	}
	private fmCache: { at: number; value: { out: Set<string>; unknown: Set<string> } } | null = null;
	/** Notes marked `sync: false` (see sync-extras.ts); recomputed at most every 2 seconds. */
	frontmatterScope(): { out: Set<string>; unknown: Set<string> } | null {
		if (!this.settings.respectFrontmatter) return null;
		if (!this.fmCache || Date.now() - this.fmCache.at > 2000) this.fmCache = { at: Date.now(), value: frontmatterScope(this.app) };
		return this.fmCache.value;
	}
	/** Whether a vault path syncs on this device (the main repository or a shared folder). */
	syncedPathTest(): (path: string) => boolean {
		const main = this.engine.buildScope();
		const shared = (this.settings.sharedFolders ?? []).filter((f) => f.enabled && f.folder).map((f) => f.folder.replace(/^\/+|\/+$/g, "") + "/");
		if (!shared.length) return main;
		const userExcluded = compileGlobs(this.settings.excludePatterns.split("\n").map((l) => l.split("{config}").join(this.app.vault.configDir)));
		return (p: string) => main(p) || (shared.some((f) => p.startsWith(f)) && !userExcluded(p));
	}
	/** Counts files created, deleted or renamed (the explorer's greyed-out rows are cached against it). */
	private vaultShapeGen = 0;
	/** Everything the explorer's greyed-out rows depend on; they are recomputed only when this changes. */
	private explorerScopeKey(): string {
		const fm = this.frontmatterScope();
		return [
			this.vaultShapeGen,
			JSON.stringify(this.settings),
			JSON.stringify(this.deviceScope()),
			this.gitignorePatterns().join("\n"),
			fm ? `${[...fm.out].sort().join("\n")}\u0001${[...fm.unknown].sort().join("\n")}` : "",
		].join("\u0000");
	}
	isPathSynced(path: string): boolean {
		return this.syncedPathTest()(path);
	}

	// ---------------- logging / UI ----------------

	log(msg: string) {
		const line = `${stamp()}  ${msg}`;
		this.logLines.push(line);
		if (this.logLines.length > 300) this.logLines.shift();
	}

	private notify(msg: string, important = false, changedFiles = false) {
		let lvl = this.settings.noticeLevel;
		if (lvl === "auto") lvl = Platform.isMobile ? "changes" : "errors";
		const show = lvl === "all" || (important && lvl !== "silent") || (lvl === "changes" && changedFiles);
		if (show) new Notice(msg, important ? 8000 : 4000);
	}

	private setStatus(status: Status, detail = "") {
		this.refreshBadges();
		this.baseStatus = status;
		this.baseDetail = detail;
		this.renderStatus();
		this.refreshHealth();
	}

	/** Draws the status bar and ribbon from the last status, the pause state and the pending edits. */
	private renderStatus() {
		let status = this.baseStatus;
		let detail = this.baseDetail;
		// While paused (and not busy or failing) the icon says so, also after a manual sync.
		if (this.isPaused() && status !== "syncing" && status !== "error") {
			if (status !== "paused") detail = detail ? `${t("m.pausedStatus")} · ${detail}` : t("m.pausedStatus");
			status = "paused";
		} else if (status === "paused") {
			// The pause ended (or was lifted) since this was set.
			status = "idle";
			detail = "";
		}
		this.schedulePauseEnd();
		const icons: Record<Status, string> = {
			idle: "cloud",
			syncing: "refresh-cw",
			ok: "cloud",
			error: "cloud-off",
			offline: "wifi-off",
			conflict: "alert-triangle",
			paused: "pause-circle",
		};
		const last = this.state?.lastSync ? t("h.lastSync", { ago: new Date(this.state.lastSync).toLocaleTimeString() }) : t("health.notSynced");
		const title = detail || (status === "syncing" ? t("health.syncing") : last);
		if (this.statusEl) {
			this.statusEl.empty();
			const icon = this.statusEl.createSpan({ cls: `vsg-icon vsg-${status}` });
			setIcon(icon, icons[status]);
			// The same count the status panel shows.
			const pending = status === "syncing" || !this.engine ? 0 : this.pendingLocalCount();
			if (pending) this.statusEl.createSpan({ cls: "vsg-pending", text: String(pending) });
			this.statusEl.setAttr("aria-label", t("m.statusTip", { title }));
			this.statusEl.setAttr("data-tooltip-position", "top");
		}
		this.ribbonEl?.toggleClass("vsg-spinning", status === "syncing");
		this.ribbonEl?.setAttr("aria-label", `${t("ribbon.sync")}: ${title}`);
	}

	private clearPauseTimer() {
		if (this.pauseTimer !== null) window.clearTimeout(this.pauseTimer);
		this.pauseTimer = null;
	}
	/** Redraws the status when a timed pause ends, so the paused icon doesn't linger. */
	private schedulePauseEnd() {
		this.clearPauseTimer();
		const until = this.pausedUntil();
		if (!until || until === Infinity || this.unloaded) return;
		this.pauseTimer = window.setTimeout(
			() => {
				this.pauseTimer = null;
				if (!this.unloaded) this.renderStatus();
			},
			Math.min(until - Date.now() + 500, 2_000_000_000),
		);
	}

	/**
	 * Restore, reset, overwrite, free up space and similar run with sync blocked. Edits made meanwhile are
	 * parked like during a sync; endExclusive() puts them back into change tracking and syncs if needed.
	 */
	private beginExclusive(): boolean {
		if (this.syncing) {
			new Notice(t("notice.busy"));
			return false;
		}
		this.syncing = true;
		this.changedDuringSync = false;
		this.touchedDuringSync.clear();
		this.onChangeDebounced?.cancel();
		return true;
	}
	private endExclusive() {
		this.syncing = false;
		for (const p of this.touchedDuringSync) this.dirty.set(p, ++this.dirtySeq);
		this.touchedDuringSync.clear();
		const q = this.queued;
		this.queued = null;
		if (q) window.setTimeout(() => void this.sync(q.manual ? "manual" : "change", q.mode, q.opts), 500);
		else if (this.changedDuringSync) this.onChangeDebounced?.();
		this.changedDuringSync = false;
		this.refreshBadges();
		this.pendingTimer?.();
	}

	private refreshHealth(withRemote = false) {
		this.settingTab?.refreshIfHidden();
		for (const leaf of this.app.workspace.getLeavesOfType(HEALTH_VIEW)) {
			const v = leaf.view;
			if (v instanceof HealthView) v.refresh(withRemote);
		}
		// The history sidebar lists repository commits: only worth reloading when the repository may have changed.
		if (withRemote) {
			for (const leaf of this.app.workspace.getLeavesOfType(HISTORY_VIEW)) {
				const v = leaf.view;
				if (v instanceof HistoryView) v.refreshIfChanged();
			}
		}
	}

	askConflict(info: ConflictInfo): Promise<ConflictChoice> {
		return new Promise((resolve) => new ConflictModal(this.app, info, resolve).open());
	}

	confirmDeletes(local: string[], remote: string[]): Promise<DeleteGuardChoice> {
		return new Promise((resolve) => new DeleteGuardModal(this.app, local, remote, resolve).open());
	}

	isConfigured(): boolean {
		return !this.configProblem();
	}
	isSyncing(): boolean {
		return this.syncing;
	}
	openSettings() {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}
	openLog() {
		new LogModal(this.app, this.logLines).open();
	}
	async openHealth() {
		const existing = this.app.workspace.getLeavesOfType(HEALTH_VIEW)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: HEALTH_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	// ---------------- sync ----------------

	private configProblem(): string | null {
		// Settings from a removed host (Gitee, Azure DevOps): nothing syncs until a new repository is set.
		if (mainSyncBlocked(this.settings)) return t("m.hostRemoved");
		if (!this.getToken()) return t("m.needToken");
		if (!this.settings.owner || !this.settings.repo) return t("m.needRepo");
		return null;
	}

	async sync(trigger: Trigger, mode: SyncMode = this.settings.mode, opts: SyncOptions = {}): Promise<void> {
		if (this.unloaded) return;
		// "Sync and close" is asked for by the user: like a manual sync it runs while paused.
		if (trigger !== "manual" && trigger !== "close" && this.isPaused()) return void this.setStatus("paused", t("m.pausedStatus"));
		// Battery saver keeps only startup, returning to Obsidian and manual syncs.
		if (this.batterySaver() && (trigger === "change" || trigger === "interval" || trigger === "open" || trigger === "background")) return;
		if (this.usingSignIn() && navigator.onLine) await this.ensureFreshToken();
		await this.repairSelfEnabled();
		const problem = this.configProblem();
		if (problem) {
			if (trigger === "manual" || trigger === "close") new Notice(problem);
			return;
		}
		if (trigger === "manual" && this.settings.reviewBeforeManualSync && !Object.keys(opts).length && mode === this.settings.mode) {
			return this.openReview();
		}
		if (trigger !== "manual" && !navigator.onLine) {
			this.setStatus("offline", t("m.offline"));
			return;
		}
		if (this.syncing) {
			// One run is queued. A request with choices (review, current file) or a manual one is never
			// replaced by an automatic trigger; the automatic run happens anyway after it.
			const q = this.queued;
			const qHasChoices = !!q && Object.keys(q.opts).length > 0;
			// Keep a queued request with choices (review, current file); else a manual request wins over an automatic one.
			if (!q || (!qHasChoices && (trigger === "manual" || !q.manual))) this.queued = { mode, opts, manual: trigger === "manual" };
			if (trigger === "manual") new Notice(t("m.queued"));
			return;
		}
		this.syncing = true;
		await this.loadGitignore();
		await this.loadGitattributes();
		this.changedDuringSync = false;
		this.touchedDuringSync.clear();
		this.onChangeDebounced?.cancel();
		this.setStatus("syncing");
		const started = Date.now();
		let written = new Set<string>();
		// What the commit message template sees: the trigger, and a message typed for this sync.
		const typed = this.customCommitMessage;
		this.customCommitMessage = null;
		this.syncContext = { trigger, message: typed && trigger === "manual" && Date.now() - typed.at < 10 * 60_000 ? typed.text : null };
		const event: SyncEventSummary = { trigger, mode, upToDate: false, uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0 };
		emitSyncEvent(this.app, SYNC_START_EVENT, { trigger, mode });
		try {
			const r = await this.engine.run(mode, opts);
			Object.assign(event, { upToDate: r.upToDate, uploaded: r.uploaded.length, downloaded: r.downloaded.length, deleted: r.deletedLocal.length + r.deletedRemote.length, conflicts: r.conflictCopies.length });
			if (r.errors.length) event.error = redactSecrets(r.errors[0] ?? "");
			const sharedErrors = opts.defer || opts.only || opts.firstSyncPrefer ? [] : await this.syncShared(mode);
			if (sharedErrors.length) this.notify(`${t("m.sharedFailed")}\n${sharedErrors.join("\n")}`, true);
			const mirrorError = opts.defer || opts.only || opts.firstSyncPrefer ? null : await this.syncMirror(r.guardKept ?? []);
			if (mirrorError) this.notify(t("m.mirrorFailed", { error: mirrorError }), true);
			const problems = syncProblems({ errors: r.errors, sharedErrors, mirrorError });
			this.syncOutcome = { seq: ++this.syncOutcomeSeq, ok: !problems.length, problems };
			// A plugin's manifest.json arriving through sync means it was updated on another device.
			const cfgDir = this.app.vault.configDir;
			const updated = r.downloaded.map((p) => new RegExp(`^${cfgDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/plugins/([^/]+)/manifest\\.json$`).exec(p)?.[1]).filter((x): x is string => !!x);
			if (updated.length) {
				const pend = new Set((this.localGet("pluginUpdatesPending") ?? "").split("\n").filter(Boolean));
				for (const id of updated) pend.add(id);
				this.localSet("pluginUpdatesPending", [...pend].join("\n"));
			}
			if (r.downloaded.length || trigger === "startup" || trigger === "manual") void this.offerPluginInstalls().catch((e: unknown) => this.log(`Plugin check failed: ${errMsg(e)}`));
			written = new Set([...r.downloaded, ...r.merged, ...r.conflictCopies, ...r.deletedLocal]);
			const now = Date.now();
			for (const p of written) this.writtenBySync.set(p, now);
			this.lastReport = r;
			this.lastError = null;
			this.lastErrorCause = null;
			this.afterSync(r, trigger, Date.now() - started);
			this.lastFailed = false;
			await this.maybeDailySnapshot();
		} catch (e) {
			event.error = redactSecrets(errMsg(e));
			this.syncOutcome = { seq: ++this.syncOutcomeSeq, ok: false, problems: [this.errorText(e)] };
			if (e instanceof SyncCancelled) {
				this.log(e.message);
				this.setStatus("idle", this.errorText(e));
			} else {
				this.lastError = errMsg(e);
				this.lastErrorCause = e;
				this.lastErrorAt = Date.now();
				this.log(`Sync failed: ${errMsg(e)}`);
				this.setStatus("error", t("notice.failed", { error: this.errorText(e) }));
				// Automatic syncs only warn on the first failure in a row, not every interval.
				if (trigger === "manual") new Notice(t("notice.failed", { error: this.errorText(e) }), 8000);
				else if (!this.lastFailed) this.notify(t("notice.failed", { error: this.errorText(e) }), true);
				this.lastFailed = true;
			}
		} finally {
			this.syncing = false;
			this.syncContext = { trigger: "manual", message: null };
			emitSyncEvent(this.app, SYNC_DONE_EVENT, event);
			this.updateStatusExtras();
			this.changeMarkers?.refresh();
			this.settingTab?.refreshIfHidden();
			// Real edits made during the sync stay pending; the sync's own writes do not.
			for (const p of this.touchedDuringSync) if (!written.has(p)) this.dirty.set(p, ++this.dirtySeq);
			this.touchedDuringSync.clear();
			for (const [p, t] of this.writtenBySync) if (Date.now() - t > 60_000) this.writtenBySync.delete(p);
			const q = this.queued;
			this.queued = null;
			if (q) window.setTimeout(() => void this.sync(q.manual ? "manual" : "change", q.mode, q.opts), 500);
			else if (this.changedDuringSync) this.onChangeDebounced?.();
			this.changedDuringSync = false;
			this.refreshHealth(true);
		}
	}

	private afterSync(r: SyncReport, trigger: Trigger, ms: number) {
		this.warnTokenExpiry();
		this.remoteAhead = false;
		this.ribbonEl?.removeClass("vsg-remote-ahead");
		this.statusEl?.removeClass("vsg-remote-ahead");
		if (r.upToDate) {
			this.log(`Up to date (${trigger}).`);
			this.setStatus(this.conflictCopies().length ? "conflict" : "ok");
			if (trigger === "manual") this.notify(t("notice.upToDate"));
			return;
		}
		const parts: string[] = [];
		if (r.downloaded.length) parts.push(`↓${r.downloaded.length}`);
		if (r.uploaded.length) parts.push(`↑${r.uploaded.length}`);
		if (r.deletedLocal.length + r.deletedRemote.length) parts.push(`✕${r.deletedLocal.length + r.deletedRemote.length}`);
		if (r.merged.length) parts.push(t("m.mergedN", { n: r.merged.length }));
		const summary = parts.join(" ") || t("m.noChanges");
		this.log(`Sync done (${trigger}, ${r.mode}, ${ms} ms): ${summary}`);
		for (const s of r.skipped) this.log(`Skipped ${s}`);

		for (const url of r.pullRequests ?? []) this.notify(t("m.prOpened", { folder: this.app.vault.getName(), url }), true);
		if (r.errors.length) {
			this.setStatus("error", t("m.filesFailed", { n: r.errors.length }));
			this.notify(t("notice.errors", { n: r.errors.length }), true);
		} else if (r.conflictCopies.length) {
			this.setStatus("conflict", t("m.copiesCreated", { n: r.conflictCopies.length }));
			this.notify(t("notice.conflicts", { n: r.conflictCopies.length }), true);
		} else {
			this.setStatus("ok");
			this.notify(t("notice.synced", { summary }), false, parts.length > 0);
		}
	}

	private async maybeDailySnapshot() {
		if (!this.settings.dailySnapshot || this.settings.mode === "pull") return;
		if (Date.now() - this.state.lastSnapshot < 24 * 3600_000) return;
		await this.snapshot(false);
	}

	async snapshot(manual: boolean) {
		try {
			const head = this.state.head ?? (await this.gh.getRef(this.settings.branch));
			if (!head) throw new Error(t("m.nothingToSnapshot"));
			const d = new Date();
			const p = (n: number) => String(n).padStart(2, "0");
			const tag = `snapshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
			await this.gh.createRef(`refs/tags/${tag}`, head);
			this.state.lastSnapshot = Date.now();
			await this.saveState();
			this.log(`Created snapshot tag ${tag} at ${head.slice(0, 7)}.`);
			if (manual) new Notice(t("m.snapshotOk", { tag }));
		} catch (e) {
			this.log(`Snapshot failed: ${errMsg(e)}`);
			if (manual) new Notice(t("m.snapshotFailed", { error: this.errorText(e) }));
		}
	}

	// ---------------- review / diff ----------------

	private async textOf(path: string, data: ArrayBuffer | null): Promise<{ text: string | null; size: number }> {
		if (!data) return { text: "", size: 0 };
		return { text: asText(path, data), size: data.byteLength };
	}

	async openReview(previewOnly = false) {
		const problem = this.configProblem();
		if (problem) return void new Notice(problem);
		if (this.syncing) return void new Notice(t("notice.busy"));
		try {
			await this.loadGitignore();
			const pv = await this.engine.preview(this.settings.mode);
			const blobOf = (path: string, sha: string | undefined | null) => (sha ? this.engine.readBlob(path, sha) : Promise.resolve(null));
			const local = async (p: string) => ((await this.app.vault.adapter.exists(p)) ? this.engine.readLocal(p) : null);
			const loadDiff = async (d: Decision): Promise<DiffSides> => {
				const remoteSha = pv.remoteShas.get(d.path);
				let oldData: ArrayBuffer | null;
				let newData: ArrayBuffer | null;
				const H = this.hostLabel();
				let oldLabel = H;
				let newLabel = t("u.thisDevice");
				if (d.kind === "move-local") {
					oldData = await local(d.from);
					newData = await blobOf(d.path, remoteSha);
					oldLabel = `${t("u.thisDevice")} (${d.from})`;
					newLabel = `${H} (${d.path})`;
				} else if (d.kind === "adopt-remote-edit") {
					oldData = await local(d.path);
					newData = await blobOf(d.path, d.sha);
					oldLabel = `${t("u.thisDevice")} (${d.path})`;
					newLabel = `${H} (${d.from})`;
				} else if (d.kind === "download" || d.kind === "delete-local") {
					oldData = await local(d.path);
					newData = await blobOf(d.path, remoteSha);
					oldLabel = t("u.thisDevice");
					newLabel = H;
				} else {
					oldData = await blobOf(d.path, remoteSha);
					newData = await local(d.path);
				}
				const o = await this.textOf(d.path, oldData);
				const n = await this.textOf(d.path, newData);
				return { oldLabel, newLabel, oldText: o.text, newText: n.text, oldSize: o.size, newSize: n.size };
			};
			new ReviewModal(this.app, pv.decisions, skippedLines(pv.skipped, pv.skipNotes), loadDiff, previewOnly ? null : (deferred) => void this.sync("manual", this.settings.mode, { defer: deferred })).open();
		} catch (e) {
			new Notice(t("m.reviewFailed", { error: this.errorText(e) }));
		}
	}

	async compareWithGitHub(file: TFile) {
		let differs = false;
		new DiffModal(
			this.app,
			`${file.path}: ${this.hostLabel()} → ${t("u.thisDevice")}`,
			async () => {
				const head = await this.gh.getRef(this.settings.branch);
				const remote = head ? await this.engine.readRemoteFile(file.path, head) : null;
				const localData = await this.app.vault.readBinary(file);
				const [a, b] = [new Uint8Array(remote ?? new ArrayBuffer(0)), new Uint8Array(localData)];
				differs = !!remote && (a.length !== b.length || !a.every((x, i) => x === b[i]));
				const o = await this.textOf(file.path, remote);
				const n = await this.textOf(file.path, localData);
				return { oldLabel: remote ? this.hostLabel() : t("m.notThere", { host: this.hostLabel() }), newLabel: t("u.thisDevice"), oldText: o.text, newText: n.text, oldSize: o.size, newSize: n.size };
			},
			() => (differs ? [{ label: t("repo.use"), warning: true, run: () => void this.useRepositoryVersion(file.path) }] : []),
		).open();
	}

	/**
	 * Replaces one local file with the repository's latest version, after a confirmation. The local
	 * version goes to the recoverable trash first; the next sync then finds the file equal to the
	 * repository and uploads nothing. Refused while a sync (or restore, reset…) runs.
	 */
	async useRepositoryVersion(path: string) {
		const problem = this.configProblem();
		if (problem) return void new Notice(problem);
		if (this.syncing) return void new Notice(t("notice.busy"));
		// A note inside a shared folder lives in that folder's repository.
		const shared = (await this.sharedHosts()).find((h) => path.startsWith(h.def.folder.replace(/\/+$/, "") + "/"));
		if (!shared && (await this.needsUnlock())) return;
		const host = shared ? shared.gh.label : this.hostLabel();
		if (!(await confirmPlan(this.app, t("repo.use"), t("repo.useBody", { path, host }), [], t("repo.use"), true))) return;
		if (!this.beginExclusive()) return;
		try {
			const engine = shared ? shared.engine : this.engine;
			const head = shared ? await shared.gh.getRef(shared.def.branch || "main") : await this.gh.getRef(this.settings.branch);
			const remote = head ? await engine.readRemoteFile(path, head) : null;
			const r = await replaceWithRepositoryVersion(this.io, path, remote);
			if (r.kind === "replaced") this.forgetTempCopy(r.trashedAs);
			if (r.kind === "replaced") this.log(`Used the repository version of ${path}; the local version is in the trash as ${r.trashedAs}`);
			new Notice(
				r.kind === "replaced" ? t("repo.used", { path, host, copy: r.trashedAs.split("/").pop() ?? r.trashedAs })
				: r.kind === "restored" ? t("repo.restored", { path, host })
				: r.kind === "same" ? t("repo.same", { path, host })
				: t("repo.missing", { path, host }),
				8000,
			);
		} catch (e) {
			new Notice(t("repo.failed", { error: this.errorText(e) }), 8000);
		} finally {
			this.endExclusive();
			this.refreshHealth();
		}
	}

	/**
	 * The dated copy "Use repository version" writes and moves to the trash at once was never a real
	 * edit: it must not stay behind as a pending change (its create and delete events arrive meanwhile).
	 */
	private forgetTempCopy(path: string) {
		this.touchedDuringSync.delete(path);
		this.dirty.delete(path);
		this.writtenBySync.set(path, Date.now());
		this.refreshBadges();
	}

	// ---------------- history sidebar ----------------

	async openHistory() {
		const existing = this.app.workspace.getLeavesOfType(HISTORY_VIEW)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: HISTORY_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	/** Repository, branch, folder and last-synced commit: what the history sidebar's list depends on. */
	private historyVersion(): string {
		const s = this.settings;
		return `${s.provider}:${s.owner}/${s.repo}@${s.branch}/${normalizeSubdir(s.repoSubdir)}#${this.state.head ?? ""}`;
	}
	/** Whether the repository has an encryption marker for this vault, checked once per synced commit. */
	private unlockCache: { key: string; value: boolean } | null = null;
	private async remoteEncryptedCached(): Promise<boolean> {
		const key = this.historyVersion();
		if (this.unlockCache?.key === key) return this.unlockCache.value;
		try {
			const value = !!(await readRemoteMarker(this));
			this.unlockCache = { key, value };
			return value;
		} catch {
			return false; // not cached: asked again next time
		}
	}

	private historyHost(): HistoryHost {
		const entry = (c: { sha: string; title: string; date: string; author: string }): TimelineEntry => ({ sha: c.sha, message: c.title, date: c.date, author: c.author, tags: [] });
		return {
			problem: () => this.configProblem(),
			needsUnlock: async (ask) => (ask ? this.needsUnlock() : !this.isEncrypted() && (await this.remoteEncryptedCached())),
			version: () => this.historyVersion(),
			listCommits: (page) => this.gh.listCommits(this.settings.branch, vaultCommitsPath(this.settings.repoSubdir), HISTORY_PAGE, page),
			commitFiles: async (sha) => {
				const d = await this.gh.getCommitFiles(sha);
				return { parent: d.parent, files: await decodeCommitFiles(d.files, (raw) => this.engine.vaultPathOf(raw)) };
			},
			showDiff: (c, parent, f) =>
				new DiffModal(this.app, `${f.path} @ ${c.sha.slice(0, 7)}`, async () => {
					const [before, after] = await Promise.all([
						parent && f.status !== "added" ? this.engine.readRemoteFile(parentPathOf(f), parent) : Promise.resolve(null),
						f.status !== "deleted" ? this.engine.readRemoteFile(f.path, c.sha) : Promise.resolve(null),
					]);
					const o = await this.textOf(f.path, before);
					const n = await this.textOf(f.path, after);
					return {
						oldLabel: before ? t("hist.before", { sha: (parent ?? "").slice(0, 7) }) : t("hist.none"),
						newLabel: after ? t("hist.after", { sha: c.sha.slice(0, 7) }) : t("hist.none"),
						oldText: o.text,
						newText: n.text,
						oldSize: o.size,
						newSize: n.size,
					};
				}).open(),
			// A deleted file is restored as it was just before this sync deleted it.
			restoreFile: (c, parent, f) =>
				f.status === "deleted"
					? parent
						? void this.openVersion(parentPathOf(f), { sha: parent, message: t("m.beforeCommit", { sha: c.sha.slice(0, 7) }), date: c.date })
						: undefined
					: void this.openVersion(f.path, { sha: c.sha, message: c.title, date: c.date }),
			browse: (c) => void this.browseAt(entry(c)),
			restoreFolder: (c) => new FolderSuggestModal(this.app, (f) => void this.restore(entry(c), f.path)).open(),
			restoreVault: (c) => void this.restore(entry(c), ""),
			deviceName: () => this.deviceName(),
			errorText: (e) => this.errorText(e),
		};
	}

	compareFiles(a: TFile, b: TFile) {
		new DiffModal(this.app, `${a.name} ↔ ${b.name}`, async () => {
			const [x, y] = await Promise.all([this.app.vault.readBinary(a), this.app.vault.readBinary(b)]);
			return { oldLabel: a.path, newLabel: b.path, oldText: asText(a.path, x), newText: asText(b.path, y), oldSize: x.byteLength, newSize: y.byteLength };
		}).open();
	}

	conflictCopies(): { copy: TFile; original: TFile | null }[] {
		const out: { copy: TFile; original: TFile | null }[] = [];
		for (const f of this.app.vault.getFiles()) {
			const orig = conflictCopyOriginal(f.path);
			if (!orig) continue;
			const o = this.app.vault.getAbstractFileByPath(orig);
			out.push({ copy: f, original: o instanceof TFile ? o : null });
		}
		return out;
	}

	async trashFile(f: TFile) {
		await this.io.remove(f.path);
	}

	/**
	 * Resolve a conflict copy in place: pick change by change (or a whole side), write the result to
	 * the original note and move the copy to the trash. Closing the dialog changes nothing.
	 */
	async resolveConflictCopy(original: TFile, copy: TFile): Promise<boolean> {
		const [a, b] = await Promise.all([this.app.vault.readBinary(original), this.app.vault.readBinary(copy)]);
		const localText = asText(original.path, a);
		const remoteText = asText(copy.path, b);
		const choice = await new Promise<ConflictChoice>((resolve) =>
			new ConflictModal(
				this.app,
				{
					path: original.path,
					title: t("h.resolveTitle", { path: original.path }),
					localLabel: t("h.currentNote"),
					remoteLabel: t("h.conflictCopy"),
					markers: false,
					localText,
					remoteText,
					localSize: a.byteLength,
					remoteSize: b.byteLength,
				},
				resolve,
			).open(),
		);
		if (choice === "keep-both" || choice === "markers") return false;
		if (choice === "remote") await this.app.vault.modifyBinary(original, b);
		else if (typeof choice === "object") await this.app.vault.modify(original, choice.custom);
		await this.trashFile(copy);
		return true;
	}

	// ---------------- timeline / restore / reset ----------------

	private async timelineEntries(): Promise<TimelineEntry[]> {
		const [commits, tags] = await Promise.all([
			this.gh.listCommits(this.settings.branch, vaultCommitsPath(this.settings.repoSubdir), 60),
			this.gh.listTags().catch(() => []),
		]);
		const bySha = new Map<string, string[]>();
		for (const t of tags) bySha.set(t.sha, [...(bySha.get(t.sha) ?? []), t.name]);
		return commits.map((c) => ({ ...c, tags: bySha.get(c.sha) ?? [] }));
	}

	openTimeline() {
		new TimelineModal(this.app, () => this.timelineEntries(), {
			browse: (e) => void this.browseAt(e),
			restoreVault: (e) => void this.restore(e, ""),
			restoreFolder: (e) => new FolderSuggestModal(this.app, (f) => void this.restore(e, f.path)).open(),
		}).open();
	}

	private async browseAt(e: TimelineEntry) {
		if (await this.needsUnlock()) return;
		new CommitListModal(this.app, t("m.filesAt", { sha: e.sha.slice(0, 7), date: new Date(e.date).toLocaleString() }), async () => {
			const files = await this.engine.filesAt(e.sha);
			return [...files]
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([p, f]) => ({ label: p, sub: t("m.bytes", { n: f.size }), run: () => void this.openVersion(p, e) }));
		}).open();
	}

	private async restore(e: TimelineEntry, folder: string) {
		const what = folder ? t("m.whatFolder", { folder }) : t("m.whatVault");
		if (!this.beginExclusive()) return;
		this.setStatus("syncing", t("m.restoring", { what }));
		try {
			await this.loadGitignore();
			const plan = await this.engine.restoreTo(e.sha, folder, (p) =>
				confirmPlan(
					this.app,
					t("m.restoreTitle", { what }),
					t("m.restoreBody", { what, date: new Date(e.date).toLocaleString(), sha: e.sha.slice(0, 7) }),
					[
						{ title: t("m.restoredOlder"), items: p.changed },
						{ title: t("m.broughtBack"), items: p.added },
						{ title: t("m.removedSince"), items: p.removed },
					],
					t("m.restore"),
					true,
				),
			);
			const n = plan.changed.length + plan.added.length + plan.removed.length;
			new Notice(n ? t("m.restored", { what, n }) : t("m.restoreSame", { what }));
			this.lastError = null;
			this.lastErrorCause = null;
		} catch (err) {
			if (!(err instanceof SyncCancelled)) {
				this.lastError = errMsg(err);
				this.lastErrorCause = err;
				this.lastErrorAt = Date.now();
				new Notice(t("m.restoreFailed", { error: this.errorText(err) }), 8000);
			}
			this.log(errMsg(err));
		} finally {
			this.endExclusive();
			this.setStatus(this.lastError ? "error" : "ok");
			this.refreshHealth(true);
		}
	}

	/** One forward commit that makes the repository equal to this device (the opposite of reset). */
	async overwriteRemote() {
		if (!this.isConfigured()) return void new Notice(this.configProblem()!);
		if (!this.beginExclusive()) return;
		this.setStatus("syncing", t("m.comparing"));
		try {
			await this.loadGitignore();
			const plan = await this.engine.overwriteRemote((p) =>
				confirmPlan(
					this.app,
					t("ow.title"),
					t("ow.body", { host: this.hostLabel() }),
					[
						{ title: t("ow.upload"), items: p.upload },
						{ title: t("m.deleteFrom", { host: this.hostLabel() }), items: p.remove },
					],
					t("ow.confirm"),
					true,
				),
			);
			const n = plan.upload.length + plan.remove.length;
			new Notice(n ? t("ow.done", { n }) : t("m.alreadyMatches"));
			this.fullScanNeeded = true;
			this.dirty.clear();
			this.endExclusive();
			this.setStatus("ok");
		} catch (err) {
			this.endExclusive();
			if (err instanceof SyncCancelled) this.setStatus("idle");
			else {
				new Notice(t("ow.failed", { error: this.errorText(err) }), 8000);
				this.lastError = errMsg(err);
				this.lastErrorCause = err;
				this.lastErrorAt = Date.now();
				this.setStatus("error", this.errorText(err));
			}
		} finally {
			this.refreshHealth(true);
		}
	}

	async resetToGitHub() {
		if (!this.isConfigured()) return void new Notice(this.configProblem()!);
		if (!this.beginExclusive()) return;
		this.setStatus("syncing", t("m.comparing"));
		try {
			await this.loadGitignore();
			const plan = await this.engine.resetToRemote((p) =>
				confirmPlan(
					this.app,
					t("health.reset"),
					t("m.resetBody"),
					[
						{ title: t("m.replacedWith", { host: this.hostLabel() }), items: p.overwrite },
						{ title: t("m.downloaded"), items: p.download },
						{ title: t("m.removedNotInRepo"), items: p.remove },
					],
					t("m.matchRepo"),
					true,
				),
			);
			const n = plan.overwrite.length + plan.download.length + plan.remove.length;
			new Notice(n ? t("m.matched", { n }) : t("m.alreadyMatches"));
			this.fullScanNeeded = true;
			this.dirty.clear();
			this.endExclusive();
			this.setStatus("ok");
		} catch (err) {
			this.endExclusive();
			if (err instanceof SyncCancelled) this.setStatus("idle");
			else {
				new Notice(t("m.resetFailed", { error: this.errorText(err) }), 8000);
				this.lastError = errMsg(err);
				this.lastErrorCause = err;
				this.lastErrorAt = Date.now();
				this.setStatus("error", this.errorText(err));
			}
			this.log(errMsg(err));
		} finally {
			this.refreshHealth(true);
		}
	}

	// ---------------- commands ----------------

	private registerCommands() {
		this.addCommand({ id: "sync-now", name: t("cmd.sync"), callback: () => this.sync("manual") });
		this.addCommand({ id: "review", name: t("cmd.review"), callback: () => this.openReview() });
		this.addCommand({ id: "open-status", name: t("cmd.status"), callback: () => this.openHealth() });
		this.addCommand({ id: "pull-now", name: t("cmd.pull"), callback: () => this.sync("manual", "pull") });
		this.addCommand({ id: "push-now", name: t("cmd.push"), callback: () => this.sync("manual", "push") });
		this.addCommand({ id: "preview", name: t("cmd.preview"), callback: () => this.openReview(true) });
		this.addCommand({ id: "timeline", name: t("cmd.timeline"), callback: () => this.openTimeline() });
		this.addCommand({ id: "reset-to-github", name: t("cmd.reset"), callback: () => this.resetToGitHub() });
		this.addCommand({ id: "snapshot", name: t("cmd.snapshot"), callback: () => this.snapshot(true) });
		this.addCommand({ id: "setup-wizard", name: t("cmd.wizard"), callback: () => this.openWizard() });
		this.addCommand({ id: "encryption", name: t("cmd.encryption"), callback: () => this.openEncryption() });
		this.addCommand({ id: "free-up-space", name: t("cmd.freeSpace"), callback: () => this.freeUpSpace() });
		this.addCommand({ id: "download-on-demand", name: t("cmd.onDemand"), callback: () => this.openRemoteOnly() });
		this.addCommand({ id: "show-log", name: t("cmd.log"), callback: () => this.openLog() });
		this.addCommand({
			id: "file-history",
			name: t("cmd.history"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.showFileHistory(file);
				return true;
			},
		});
		this.addCommand({
			id: "compare-with-github",
			name: t("cmd.compare"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.compareWithGitHub(file);
				return true;
			},
		});
		this.addCommand({ id: "open-history", name: t("cmd.openHistory"), callback: () => void this.openHistory() });
		this.addCommand({
			id: "use-repository-version",
			name: t("cmd.useRepo"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.isConfigured()) return false;
				if (!checking) void this.useRepositoryVersion(file.path);
				return true;
			},
		});
		this.addCommand({
			id: "sync-current-file",
			name: t("cmd.syncFile"),
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) void this.sync("manual", this.settings.mode, { only: new Set([file.path]) });
				return true;
			},
		});
		this.addCommand({ id: "setup-link", name: t("cmd.setupLink"), callback: () => this.openSetupLink() });
		this.addCommand({ id: "overwrite-remote", name: t("cmd.overwrite"), callback: () => void this.overwriteRemote() });
		this.addCommand({ id: "pause", name: t("cmd.pause"), callback: () => (this.isPaused() ? this.resumeSync() : this.pauseSync(null)) });
		this.addCommand({ id: "pause-hour", name: t("cmd.pauseHour"), callback: () => this.pauseSync(60) });
		this.addCommand({ id: "copy-diagnostics", name: t("cmd.diagnostics"), callback: () => void this.copyDiagnostics() });
		const onHost = (id: string, name: string, run: (f: TFile) => void) =>
			this.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const file = this.app.workspace.getActiveFile();
					if (!file || !this.isConfigured()) return false;
					if (!checking) run(file);
					return true;
				},
			});
		onHost("open-on-host", t("cmd.openOnHost"), (f) => void this.openOnHost(f, "file"));
		onHost("history-on-host", t("cmd.historyOnHost"), (f) => void this.openOnHost(f, "history"));
		onHost("copy-host-link", t("cmd.copyHostLink"), (f) => void this.openOnHost(f, "copy"));
		this.addCommand({ id: "recover-deleted", name: t("cmd.recover"), callback: () => void this.showDeletedFiles() });
		this.addCommand({
			id: "open-repo",
			name: t("cmd.openRepo"),
			callback: async () => {
				const repo = await this.gh.getRepo().catch(() => null);
				if (repo?.html_url) window.open(repo.html_url);
				else new Notice(t("m.repoNotFound"));
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				// "Git: …" keeps our items apart from core ones such as Obsidian Sync's "Open version history"
				// (the public API has no submenus to group them under the plugin's name).
				const ours = (item: string) => t("menu.prefixed", { item });
				addScopeMenuItems(this, menu, file);
				if (file instanceof TFolder && file.path && file.path !== "/") {
					menu.addItem((i) => i.setTitle(ours(t("menu.shareFolder"))).setIcon("folder-sync").onClick(() => new SharedFolderModal(this.app, this, () => this.refreshHealth(), file.path).open()));
					menu.addItem((i) => i.setTitle(ours(t("menu.excludeFolder"))).setIcon("eye-off").onClick(() => void this.excludeFolder(file.path)));
					return;
				}
				if (!(file instanceof TFile)) return;
				menu.addItem((i) => i.setTitle(ours(t("menu.history"))).setIcon("history").onClick(() => void this.showFileHistory(file)));
				menu.addItem((i) => i.setTitle(ours(t("menu.compare"))).setIcon("file-diff").onClick(() => this.compareWithGitHub(file)));
				if (this.isConfigured()) menu.addItem((i) => i.setTitle(ours(t("menu.useRepo"))).setIcon("download").onClick(() => void this.useRepositoryVersion(file.path)));
				if (this.isConfigured()) {
					menu.addItem((i) => i.setTitle(ours(t("menu.openOnHost", { host: this.hostLabel() }))).setIcon("external-link").onClick(() => void this.openOnHost(file, "file")));
					menu.addItem((i) => i.setTitle(ours(t("menu.copyHostLink", { host: this.hostLabel() }))).setIcon("link").onClick(() => void this.openOnHost(file, "copy")));
				}
			}),
		);
	}

	/** Opens a file's page (or history) on the host, or copies a link to it at the last synced commit. */
	private async openOnHost(file: TFile, what: "file" | "history" | "copy") {
		// A note inside a shared folder lives in that folder's repository.
		const shared = (await this.sharedHosts()).find((h) => file.path.startsWith(h.def.folder.replace(/\/+$/, "") + "/"));
		if (!shared && this.isEncrypted()) return void new Notice(t("m.hostLinkEncrypted"));
		const remote = shared ? shared.gh : this.gh;
		const path = shared ? await shared.engine.remotePathOf(file.path) : await this.engine.remotePathOf(file.path);
		const branch = shared ? shared.def.branch || "main" : this.settings.branch;
		const head = shared ? shared.state.head : this.state.head;
		const ref = what === "history" ? branch : (head ?? branch);
		const url = remote.webUrl?.(what === "history" ? "history" : "file", path, ref) ?? null;
		if (!url) return void new Notice(t("m.hostLinkUnsupported", { host: shared ? remote.label : this.hostLabel() }));
		if (what === "copy") {
			try {
				await navigator.clipboard.writeText(url);
				new Notice(t("link.copied"));
			} catch (e) {
				new Notice(t("m.clipboardFailed", { error: this.errorText(e) }));
			}
		} else window.open(url);
	}

	private async excludeFolder(folder: string) {
		const line = `/${folder}/`;
		if (this.settings.excludePatterns.split("\n").some((l) => l.trim() === line)) return void new Notice(t("m.alreadyExcluded", { folder }));
		if (!(await confirmPlan(this.app, t("menu.excludeFolder"), t("m.excludeBody", { folder }), [], t("menu.excludeFolder")))) return;
		this.settings.excludePatterns = `${this.settings.excludePatterns.trimEnd()}\n${line}`;
		await this.saveSettings();
		new Notice(t("m.excluded", { folder }));
	}

	/** Copies a bug-report summary: versions, settings (no secrets), state and recent log, with tokens hidden. */
	async copyDiagnostics() {
		const s = this.settings;
		const api = this.getApiBase();
		const lines = [
			`Git Sync & Backup ${this.manifest.version} · Obsidian ${apiVersion} · ${Platform.isMobile ? "mobile" : "desktop"}${Platform.isIosApp ? " iOS" : Platform.isAndroidApp ? " Android" : Platform.isMacOS ? " macOS" : Platform.isWin ? " Windows" : Platform.isLinux ? " Linux" : ""}`,
			`Host: ${s.provider} (${/^https?:\/\/([^/]+)/.exec(api)?.[1] ?? "?"}) · sign-in: ${this.usingGitHubApp() ? "GitHub App" : this.usingGitLabApp() ? "GitLab app" : this.getToken() ? "token" : "none"}`,
			`Mode: ${s.mode} · conflicts: ${s.conflictStrategy} · settings folder: ${s.syncConfigDir} · hidden: ${s.syncHidden}${s.syncHiddenNested ? " (nested)" : ""} · .gitignore: ${s.useGitignore} · LFS: ${s.lfsThresholdMB} MB · encrypted: ${this.isEncrypted()}`,
			`Triggers: startup ${s.syncOnStartup}, edits ${s.syncOnChange} (${s.changeDebounceSec}s), every ${s.intervalMin} min, resume ${s.syncOnResume}, background ${s.syncOnBackground}, open ${s.syncOnOpen} · paused: ${this.isPaused()} · battery saver: ${this.batterySaver()}`,
			`Shared folders: ${s.sharedFolders.length} · mirror: ${s.mirror?.enabled ? s.mirror.provider : "off"}`,
			`State: head ${this.state.head?.slice(0, 7) ?? "none"} · ${Object.keys(this.state.base).length} files · last sync ${this.state.lastSync ? new Date(this.state.lastSync).toISOString() : "never"} · on demand ${Object.keys(this.state.remoteOnly ?? {}).length}`,
			`Last error: ${this.lastError ?? "none"}`,
			"",
			"Recent log:",
			...this.logLines.slice(-60),
		];
		try {
			await navigator.clipboard.writeText(redactSecrets(lines.join("\n")));
			new Notice(t("m.diagnosticsCopied"));
		} catch (e) {
			new Notice(t("m.clipboardFailed", { error: this.errorText(e) }));
		}
	}

	/** Change markers and line history. A file in a shared folder takes its base from that folder's sync. */
	private createChangeMarkers(): ChangeMarkers {
		const sharedOf = (path: string) => this.sharedHostOf(path);
		return new ChangeMarkers({
			app: this.app,
			// Without a repository there is no last-synced version, so nothing is marked.
			enabled: () => this.settings.changeMarkers,
			hostFor: (path) => sharedOf(path) ?? this,
			// Line history reads the repository the file syncs with: a shared folder's, else the vault's.
			hasHistory: (path) => !!sharedOf(path) || this.isConfigured(),
			listCommits: (path, limit) => this.fileCommits(path, limit),
			readVersion: (path, sha) => (sharedOf(path)?.engine ?? this.engine).readRemoteFile(path, sha),
			openVersion: (path, commit) => void this.openVersion(path, commit, { path: commit.path, engine: sharedOf(path)?.engine }),
			canBrowse: async (path) => !!sharedOf(path) || !(await this.needsUnlock()),
			log: (m) => this.log(m),
		});
	}

	/**
	 * A file's newest `limit` commits in the repository it syncs with (a shared folder's, else the
	 * vault's), followed back through renames; each carries the file's name at that commit.
	 */
	async fileCommits(path: string, limit: number): Promise<PathCommit[]> {
		const shared = this.sharedHostOf(path);
		const h = shared ?? { gh: this.gh, settings: this.settings, engine: this.engine };
		return followRenames(path, limit, {
			list: async (p, n) => h.gh.listCommits(h.settings.branch, await h.engine.remotePathOf(p), Math.min(n, 100)),
			files: async (sha) => decodeCommitFiles((await h.gh.getCommitFiles(sha)).files, (raw) => h.engine.vaultPathOf(raw)),
		});
	}

	/** The shared folder a vault path belongs to, if any. */
	private sharedHostOf(path: string): SharedFolderHost | null {
		return this.sharedHostsCached().find((h) => path.startsWith(h.def.folder.replace(/\/+$/, "") + "/")) ?? null;
	}

	private async showFileHistory(file: TFile) {
		// Shared folders are never encrypted: only the vault's own repository may need unlocking.
		if (!this.sharedHostOf(file.path) && (await this.needsUnlock())) return;
		new CommitListModal(this.app, t("m.history", { path: file.path }), async () => {
			const commits = await this.fileCommits(file.path, 50);
			return commits.map((c) => ({
				label: c.message.split("\n")[0],
				// Versions from before a rename say which name the file had then.
				sub: `${new Date(c.date).toLocaleString()} · ${c.author} · ${c.sha.slice(0, 7)}${c.path !== file.path ? ` · ${c.path}` : ""}`,
				run: () => void this.openVersion(file.path, c, { path: c.path, engine: this.sharedHostOf(file.path)?.engine }),
			}));
		}).open();
	}

	/**
	 * Shows a file's version at `commit`; restoring writes it to `path`. `from` reads it elsewhere: under
	 * the file's older name (history across a rename) and/or from a shared folder's repository.
	 */
	private async openVersion(path: string, commit: { sha: string; message: string; date: string }, from: { path?: string; engine?: SyncEngine } = {}) {
		try {
			const data = await (from.engine ?? this.engine).readRemoteFile(from.path ?? path, commit.sha);
			if (!data) return void new Notice(t("m.notInVersion"));
			let current: string | null | undefined;
			if (await this.app.vault.adapter.exists(path)) current = asText(path, await this.io.read(path));
			new FileVersionModal(this.app, path, commit, asText(path, data), data.byteLength, current, async (asCopy) => {
				const target = asCopy ? restoredCopyPath(path, commit.sha) : path;
				if (!asCopy && (await this.app.vault.adapter.exists(path))) {
					// Replacing different current contents: ask first (restoring as a copy keeps both).
					const now = await this.io.read(path).catch(() => null);
					const a = now ? new Uint8Array(now) : null;
					const b = new Uint8Array(data);
					const same = !!a && a.length === b.length && a.every((x, i) => x === b[i]);
					if (!same && !(await confirmPlan(this.app, t("u.restoreThis"), t("m.restoreOverBody", { path, date: new Date(commit.date).toLocaleString() }), [], t("u.restoreThis"), true))) return;
				}
				try {
					// VaultIO recreates missing folders and handles hidden (config) paths. Replacing the
					// current file moves its old contents to the recoverable trash first.
					if (asCopy) await this.io.write(target, data);
					else {
						const r = await replaceWithRepositoryVersion(this.io, target, data);
						if (r.kind === "replaced") this.forgetTempCopy(r.trashedAs);
					}
				} catch (e) {
					return void new Notice(t("m.restoreFailed", { error: this.errorText(e) }));
				}
				new Notice(t("m.restoredFile", { path: target }));
				const nf = this.app.vault.getAbstractFileByPath(target);
				if (asCopy && nf instanceof TFile) await this.app.workspace.getLeaf(true).openFile(nf);
			}).open();
		} catch (e) {
			new Notice(t("m.versionFailed", { error: this.errorText(e) }));
		}
	}

	private async showDeletedFiles() {
		if (await this.needsUnlock()) return;
		new CommitListModal(this.app, t("m.recentlyDeleted"), async () => {
			const commits = await this.gh.listCommits(this.settings.branch, vaultCommitsPath(this.settings.repoSubdir), 25);
			const rows: { label: string; sub: string; run: () => void }[] = [];
			const seen = new Set<string>();
			for (const c of commits) {
				const detail = await this.gh.getCommitFiles(c.sha);
				if (!detail.parent) continue;
				for (const f of detail.files) {
					if (f.status !== "removed") continue;
					const name = await this.engine.vaultPathOf(f.filename);
					if (!name || seen.has(name)) continue;
					if (this.app.vault.getAbstractFileByPath(name)) continue;
					seen.add(name);
					const parent = detail.parent;
					rows.push({
						label: name,
						sub: t("m.deletedOn", { date: new Date(c.date).toLocaleString(), msg: c.message.split("\n")[0] }),
						run: () => void this.openVersion(name, { sha: parent, message: t("m.beforeCommit", { sha: c.sha.slice(0, 7) }), date: c.date }),
					});
				}
			}
			return rows;
		}).open();
	}
}
