import { debounce, Debouncer, normalizePath, Notice, Platform, Plugin, setIcon, TAbstractFile, TFile } from "obsidian";
import { HOSTS, makeRemote } from "./hosts.ts";
import type { Remote } from "./remote.ts";
import type { BlobCache, BlobCacheStore } from "./bitbucket.ts";
import { HEALTH_VIEW, HealthView } from "./health.ts";
import { VaultIO } from "./io.ts";
import type { Decision, SyncMode } from "./plan.ts";
import { VaultSyncSettingTab } from "./settings-tab.ts";
import { SyncCancelled, SyncEngine } from "./sync.ts";
import type { DeviceScope, SyncHost, SyncReport } from "./sync.ts";
import { SetupWizard } from "./wizard.ts";
import { readState, writeState } from "./statefile.ts";
import { SharedFolderHost, sharedFolderPattern } from "./shared.ts";
import type { HostKind } from "./hosts.ts";
import { Codec } from "./codec.ts";
import { b64, EncryptionLayer, unb64 } from "./crypto.ts";
import type { EncryptionMeta } from "./crypto.ts";
import { encryptionGuard } from "./encryption.ts";
import { LfsLayer } from "./lfs.ts";
import type { EncryptionRecord } from "./encryption.ts";
import { EncryptionModal, readRemoteMarker } from "./encryption-ui.ts";
import { DEFAULT_SETTINGS, emptyState } from "./types.ts";
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
import { DeviceFlowError, GITHUB_APP, needsRefresh, parseTokens, refreshAppToken } from "./ghapp.ts";
import type { AppConfig, AppTokens } from "./ghapp.ts";
import { webBase } from "./auth.ts";
import { normalizeConfigSync } from "./scope-config.ts";
import { ExplorerBadges } from "./explorer.ts";
import { parseSetupPayload, SETUP_ACTION } from "./setuplink.ts";
import type { SetupPayload } from "./setuplink.ts";
import { ApplySetupLinkModal, CreateSetupLinkModal } from "./setuplink-ui.ts";
import { detectOtherSync } from "./othersync.ts";
import { asText, conflictCopyOriginal, errMsg, restoredCopyPath, sleep, stamp } from "./util.ts";

type Trigger = "manual" | "startup" | "change" | "interval" | "resume" | "background" | "open";
type Status = "idle" | "syncing" | "ok" | "error" | "offline" | "conflict";

export default class VaultSyncPlugin extends Plugin implements SyncHost {
	settings!: VaultSyncSettings;
	state!: SyncState;
	private remoteCache: { kind: string; remote: Remote } | null = null;
	private refreshing: Promise<boolean> | null = null;
	private unloaded = false;
	private expiredNoticeShown = false;
	private lastOpenSync = 0;
	private badges: ExplorerBadges | null = null;
	refreshBadges: () => void = () => {};
	lastReport: SyncReport | null = null;
	private encLayer: EncryptionLayer | null = null;
	private shared: { sig: string; hosts: SharedFolderHost[] } | null = null;
	/** Set by the setup wizard to show live progress. */
	onProgress: ((text: string) => void) | null = null;
	lastError: string | null = null;
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
				box.createEl("button", { text: t("m.download") }).onClickEvent(() => void this.downloadOnDemand([f.path]));
				embed.after(box);
			});
		});
		this.ribbonEl = this.addRibbonIcon("refresh-cw", t("ribbon.sync"), () => this.sync("manual"));
		this.addRibbonIcon("activity", t("ribbon.status"), () => this.openHealth());
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("vsg-status");
			this.statusEl.onClickEvent(() => this.openHealth());
		}
		this.setStatus("idle");
		this.addSettingTab(new VaultSyncSettingTab(this.app, this));
		this.registerCommands();

		this.registerObsidianProtocolHandler(SETUP_ACTION, (params) => {
			const payload = parseSetupPayload(params.s);
			if (!payload) return void new Notice(t("link.invalid"));
			new ApplySetupLinkModal(this.app, this, payload).open();
		});
		this.badges = new ExplorerBadges(this.app, () => this.pendingLocalPaths(), () => this.settings.explorerBadges && this.isConfigured());
		this.badgeTimer = debounce(() => {
			if (!this.unloaded) this.badges?.refresh();
		}, 1500, true);
		this.refreshBadges = () => this.badgeTimer?.();
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
				if (!this.settings.syncOnChange) return;
				// Our own writes during a sync also land here; that only costs one cheap no-op sync later.
				if (this.syncing) this.changedDuringSync = true;
				else this.onChangeDebounced?.();
			};
			this.registerEvent(this.app.vault.on("modify", (f) => onVaultChange(f)));
			this.registerEvent(this.app.vault.on("create", (f) => onVaultChange(f)));
			this.registerEvent(this.app.vault.on("delete", (f) => onVaultChange(f)));
			this.registerEvent(this.app.vault.on("rename", (f, old) => onVaultChange(f, old)));
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
		this.badges?.destroy();
		this.badges = null;
		this.onChangeDebounced?.cancel();
	}
	isUnloaded(): boolean {
		return this.unloaded;
	}
	/** Other sync tools found in this vault (checked on load and when the status panel opens). */
	otherSync: string[] = [];
	async checkOtherSync(): Promise<string[]> {
		this.otherSync = await detectOtherSync(this.app).catch(() => []);
		return this.otherSync;
	}
	private gitignoreLines: string[] = [];
	private badgeTimer: Debouncer<[], void> | null = null;
	gitignorePatterns(): string[] {
		return this.gitignoreLines;
	}
	/** Reads the vault's .gitignore (it isn't indexed by Obsidian, so read it from disk before each sync). */
	async loadGitignore() {
		if (!this.settings.useGitignore) return void (this.gitignoreLines = []);
		try {
			const a = this.app.vault.adapter;
			this.gitignoreLines = (await a.exists(".gitignore")) ? (await a.read(".gitignore")).split(/\r?\n/) : [];
		} catch {
			this.gitignoreLines = [];
		}
	}

	// Called by Obsidian when data.json changes on disk (e.g. synced from another device).
	async onExternalSettingsChange() {
		await this.loadSettings();
		this.fullScanNeeded = true;
		this.rescheduleTriggers();
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
		const token = this.getSecret("token");
		if (!token) return "";
		// A pasted token is only ever sent to the host and API URL it was entered for: a synced data.json,
		// a setup link or a host switch can't redirect it. Tokens saved before 1.3 get bound on first use.
		const bound = this.localGet("token:for");
		if (bound === null) this.localSet("token:for", this.tokenTarget());
		else if (bound !== this.tokenTarget()) return "";
		return token;
	}
	private tokenTarget(): string {
		return `${this.settings.provider ?? "github"}|${this.getApiBase().replace(/\/+$/, "")}`;
	}
	/** After the user changes the API URL in settings themselves, the token follows it. */
	rebindToken() {
		// Only within the same host (e.g. fixing a typo in a self-hosted URL): a token entered for another
		// host stays hidden until a new one is pasted.
		const bound = this.localGet("token:for");
		const provider = this.settings.provider ?? "github";
		if (this.getSecret("token") && (bound === null || bound.startsWith(`${provider}|`))) this.localSet("token:for", this.tokenTarget());
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
	setSharedToken(def: SharedFolder, token: string) {
		this.setSecret(`token-shared-${def.id}`, token);
		this.localSet(`token-shared-for:${def.id}`, token ? `${def.provider}|${this.getApiBaseFor(def.provider).replace(/\/+$/, "")}` : null);
	}
	setToken(token: string) {
		this.setSecret("token", token);
		this.localSet("token:for", token ? this.tokenTarget() : null);
		// Pasting a token switches this device back to token sign-in.
		if (token && this.usingGitHubApp()) this.localSet("auth:github", null);
	}

	// ---------------- Sign in with GitHub (GitHub App device flow) ----------------

	/** Days until the pasted token expires, when the host reports it (GitHub); null = unknown. */
	tokenExpiryDays(): number | null {
		if (this.usingGitHubApp()) return null;
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
		if ((tokens.web && tokens.web !== this.githubWeb()) || (tokens.clientId && tokens.clientId !== app?.clientId)) return null;
		return tokens;
	}
	signedInWithApp(tokens: AppTokens) {
		this.setSecret("ghapp", JSON.stringify({ ...tokens, web: this.githubWeb(), clientId: this.githubApp()?.clientId }));
		this.localSet("auth:github", "app");
		this.expiredNoticeShown = false;
	}
	signOutApp() {
		this.setSecret("ghapp", "");
		this.localSet("auth:github", null);
	}
	/**
	 * Make sure the sign-in token is valid, refreshing it shortly before it expires (or right away
	 * when `force`, after a 401). Only one refresh runs at a time: GitHub rotates the refresh token,
	 * so two concurrent refreshes would sign the device out. Returns true when a usable token exists.
	 */
	ensureFreshToken(force = false, failedToken?: string): Promise<boolean> {
		// A pasted token can't be renewed: retrying a 401 with it would fail again.
		if (!this.usingGitHubApp()) return Promise.resolve(!force && !!this.getToken());
		if (this.refreshing) return this.refreshing;
		const before = this.appTokens();
		if (!before) return Promise.resolve(false);
		// Another request already renewed it: just retry with the new token.
		if (failedToken && before.access !== failedToken) return Promise.resolve(true);
		if (!force && !needsRefresh(before)) return Promise.resolve(true);
		this.refreshing = (async () => {
			try {
				const app = this.githubApp();
				if (!app || !before.refresh) throw new DeviceFlowError("bad_refresh_token");
				this.signedInWithApp(await refreshAppToken(this.githubWeb(), app.clientId, before.refresh));
				return true;
			} catch (e) {
				this.log(`Sign-in refresh failed: ${errMsg(e)}`);
				if (e instanceof DeviceFlowError && e.code !== "http" && !this.expiredNoticeShown) {
					this.expiredNoticeShown = true;
					new Notice(t("app.expiredSession"), 10000);
				}
				return false;
			} finally {
				this.refreshing = null;
			}
		})();
		return this.refreshing;
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
					() => ({ token: this.getToken(), apiBase: this.getApiBaseFor(kind), owner, repo, onUnauthorized: (failed) => this.ensureFreshToken(true, failed) }),
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

	private encryptionRecord(): EncryptionRecord | null {
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
		if (this.syncing) return void new Notice(t("notice.busy"));
		this.syncing = true;
		try {
			const removed = await this.engine.removeUnencryptedFiles((files) =>
				confirmPlan(this.app, t("m.plainTitle"), t("m.plainBody"), [{ title: t("m.deleteFrom", { host: this.hostLabel() }), items: files }], t("m.remove"), true),
			);
			new Notice(removed.length ? t("m.plainRemoved", { n: removed.length }) : t("m.plainNone"));
		} catch (e) {
			if (!(e instanceof SyncCancelled)) new Notice(t("m.removeFailed", { error: errMsg(e) }));
		} finally {
			this.syncing = false;
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
		const defs = (this.settings.sharedFolders ?? []).filter((f) => f.enabled && f.folder && f.owner && f.repo);
		const sig = JSON.stringify(defs);
		if (!this.shared || this.shared.sig !== sig) {
			const hosts = defs.map((d) => new SharedFolderHost(this, d));
			for (const h of hosts) await h.loadState();
			this.shared = { sig, hosts };
		}
		return this.shared.hosts;
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
			} catch (e) {
				if (e instanceof SyncCancelled) continue;
				h.lastError = errMsg(e);
				h.log(`Sync failed: ${errMsg(e)}`);
				errors.push(`${h.def.folder}: ${errMsg(e)}`);
			}
		}
		return errors;
	}

	codec(): Codec {
		// LFS is always present for reading pointers; it only uploads when a threshold is set.
		const lfs = new LfsLayer(this.gh, (this.settings.lfsThresholdMB ?? 0) * 1024 * 1024);
		return new Codec(this.encLayer ? [this.encLayer, lfs] : [lfs]);
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
		this.lastReport = null;
		await this.sync("manual", this.settings.mode, prefer ? { firstSyncPrefer: prefer } : { firstSyncPrefer: undefined });
		const err = this.lastError as string | null;
		if (err) return t("m.firstFailed", { error: err });
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
		if (this.syncing) return void new Notice(t("notice.busy"));
		this.syncing = true;
		try {
			await this.freeUpSpaceInner();
		} finally {
			this.syncing = false;
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
			if (!(e instanceof SyncCancelled)) new Notice(t("m.freeFailed", { error: errMsg(e) }));
		}
		this.refreshHealth();
	}

	// ---------------- persistence ----------------

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<VaultSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.settings.configSync = normalizeConfigSync(saved?.configSync);
	}
	async saveSettings() {
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
	async resetState() {
		this.state = { ...emptyState(), deviceId: this.deviceId() };
		this.fullScanNeeded = true;
		await this.saveState();
		this.log("Sync state reset by user.");
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
		if (this.settings.intervalMin > 0) {
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

	// ---------------- logging / UI ----------------

	log(msg: string) {
		const line = `${stamp()}  ${msg}`;
		this.logLines.push(line);
		if (this.logLines.length > 300) this.logLines.shift();
		console.debug(`[vault-sync] ${msg}`);
	}

	private notify(msg: string, important = false, changedFiles = false) {
		let lvl = this.settings.noticeLevel;
		if (lvl === "auto") lvl = Platform.isMobile ? "changes" : "errors";
		const show = lvl === "all" || (important && lvl !== "silent") || (lvl === "changes" && changedFiles);
		if (show) new Notice(msg, important ? 8000 : 4000);
	}

	private setStatus(status: Status, detail = "") {
		this.refreshBadges();
		const icons: Record<Status, string> = {
			idle: "cloud",
			syncing: "refresh-cw",
			ok: "cloud",
			error: "cloud-off",
			offline: "wifi-off",
			conflict: "alert-triangle",
		};
		const last = this.state?.lastSync ? t("h.lastSync", { ago: new Date(this.state.lastSync).toLocaleTimeString() }) : t("health.notSynced");
		const title = detail || (status === "syncing" ? t("health.syncing") : last);
		if (this.statusEl) {
			this.statusEl.empty();
			const icon = this.statusEl.createSpan({ cls: `vsg-icon vsg-${status}` });
			setIcon(icon, icons[status]);
			const pending = this.dirty.size;
			if (pending && status !== "syncing") this.statusEl.createSpan({ cls: "vsg-pending", text: String(pending) });
			this.statusEl.setAttr("aria-label", t("m.statusTip", { title }));
			this.statusEl.setAttr("data-tooltip-position", "top");
		}
		this.ribbonEl?.toggleClass("vsg-spinning", status === "syncing");
		this.ribbonEl?.setAttr("aria-label", `${t("ribbon.sync")}: ${title}`);
		this.refreshHealth();
	}

	private refreshHealth(withRemote = false) {
		for (const leaf of this.app.workspace.getLeavesOfType(HEALTH_VIEW)) {
			const v = leaf.view;
			if (v instanceof HealthView) v.refresh(withRemote);
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
		if (!this.getToken()) return t("m.needToken");
		if (!this.settings.owner || !this.settings.repo) return t("m.needRepo");
		return null;
	}

	async sync(trigger: Trigger, mode: SyncMode = this.settings.mode, opts: SyncOptions = {}): Promise<void> {
		if (this.unloaded) return;
		if (this.usingGitHubApp() && navigator.onLine) await this.ensureFreshToken();
		const problem = this.configProblem();
		if (problem) {
			if (trigger === "manual") new Notice(problem);
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
		this.changedDuringSync = false;
		this.touchedDuringSync.clear();
		this.onChangeDebounced?.cancel();
		this.setStatus("syncing");
		const started = Date.now();
		let written = new Set<string>();
		try {
			const r = await this.engine.run(mode, opts);
			const sharedErrors = opts.defer || opts.only || opts.firstSyncPrefer ? [] : await this.syncShared(mode);
			if (sharedErrors.length) this.notify(`${t("m.sharedFailed")}\n${sharedErrors.join("\n")}`, true);
			written = new Set([...r.downloaded, ...r.merged, ...r.conflictCopies, ...r.deletedLocal]);
			const now = Date.now();
			for (const p of written) this.writtenBySync.set(p, now);
			this.lastReport = r;
			this.lastError = null;
			this.afterSync(r, trigger, Date.now() - started);
			this.lastFailed = false;
			await this.maybeDailySnapshot();
		} catch (e) {
			if (e instanceof SyncCancelled) {
				this.log(e.message);
				this.setStatus("idle", e.message);
			} else {
				this.lastError = errMsg(e);
				this.lastErrorAt = Date.now();
				this.log(`Sync failed: ${errMsg(e)}`);
				this.setStatus("error", t("notice.failed", { error: errMsg(e) }));
				// Automatic syncs only warn on the first failure in a row, not every interval.
				if (trigger === "manual") new Notice(t("notice.failed", { error: errMsg(e) }), 8000);
				else if (!this.lastFailed) this.notify(t("notice.failed", { error: errMsg(e) }), true);
				this.lastFailed = true;
			}
		} finally {
			this.syncing = false;
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
			if (manual) new Notice(t("m.snapshotFailed", { error: errMsg(e) }));
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
			new ReviewModal(this.app, pv.decisions, pv.skipped, loadDiff, previewOnly ? null : (deferred) => void this.sync("manual", this.settings.mode, { defer: deferred })).open();
		} catch (e) {
			new Notice(t("m.reviewFailed", { error: errMsg(e) }));
		}
	}

	async compareWithGitHub(file: TFile) {
		new DiffModal(this.app, `${file.path}: ${this.hostLabel()} → ${t("u.thisDevice")}`, async () => {
			const head = await this.gh.getRef(this.settings.branch);
			const remote = head ? await this.engine.readRemoteFile(file.path, head) : null;
			const localData = await this.app.vault.readBinary(file);
			const o = await this.textOf(file.path, remote);
			const n = await this.textOf(file.path, localData);
			return { oldLabel: remote ? this.hostLabel() : t("m.notThere", { host: this.hostLabel() }), newLabel: t("u.thisDevice"), oldText: o.text, newText: n.text, oldSize: o.size, newSize: n.size };
		}).open();
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
			this.gh.listCommits(this.settings.branch, undefined, 60),
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
		if (this.syncing) return void new Notice(t("notice.busy"));
		const what = folder ? t("m.whatFolder", { folder }) : t("m.whatVault");
		this.syncing = true;
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
		} catch (err) {
			if (!(err instanceof SyncCancelled)) {
				this.lastError = errMsg(err);
				this.lastErrorAt = Date.now();
				new Notice(t("m.restoreFailed", { error: errMsg(err) }), 8000);
			}
			this.log(errMsg(err));
		} finally {
			this.syncing = false;
			this.setStatus(this.lastError ? "error" : "ok");
			this.refreshHealth(true);
		}
	}

	async resetToGitHub() {
		if (!this.isConfigured()) return void new Notice(this.configProblem()!);
		if (this.syncing) return void new Notice(t("notice.busy"));
		this.syncing = true;
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
			this.syncing = false;
			this.setStatus("ok");
		} catch (err) {
			this.syncing = false;
			if (err instanceof SyncCancelled) this.setStatus("idle");
			else {
				new Notice(t("m.resetFailed", { error: errMsg(err) }), 8000);
				this.lastError = errMsg(err);
				this.lastErrorAt = Date.now();
				this.setStatus("error", errMsg(err));
			}
			this.log(errMsg(err));
		} finally {
			this.syncing = false;
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
				if (!checking) this.showFileHistory(file);
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
				if (!(file instanceof TFile)) return;
				menu.addItem((i) => i.setTitle(t("menu.history")).setIcon("history").onClick(() => this.showFileHistory(file)));
				menu.addItem((i) => i.setTitle(t("menu.compare")).setIcon("file-diff").onClick(() => this.compareWithGitHub(file)));
			}),
		);
	}

	private showFileHistory(file: TFile) {
		new CommitListModal(this.app, t("m.history", { path: file.path }), async () => {
			const commits = await this.gh.listCommits(this.settings.branch, await this.engine.remotePathOf(file.path), 50);
			return commits.map((c) => ({
				label: c.message.split("\n")[0],
				sub: `${new Date(c.date).toLocaleString()} · ${c.author} · ${c.sha.slice(0, 7)}`,
				run: () => void this.openVersion(file.path, c),
			}));
		}).open();
	}

	private async openVersion(path: string, commit: { sha: string; message: string; date: string }) {
		try {
			const data = await this.engine.readRemoteFile(path, commit.sha);
			if (!data) return void new Notice(t("m.notInVersion"));
			let current: string | null | undefined;
			if (await this.app.vault.adapter.exists(path)) current = asText(path, await this.io.read(path));
			new FileVersionModal(this.app, path, commit, asText(path, data), data.byteLength, current, async (asCopy) => {
				const target = asCopy ? restoredCopyPath(path, commit.sha) : path;
				try {
					// VaultIO recreates missing folders and handles hidden (config) paths.
					await this.io.write(target, data);
				} catch (e) {
					return void new Notice(t("m.restoreFailed", { error: errMsg(e) }));
				}
				new Notice(t("m.restoredFile", { path: target }));
				const nf = this.app.vault.getAbstractFileByPath(target);
				if (asCopy && nf instanceof TFile) await this.app.workspace.getLeaf(true).openFile(nf);
			}).open();
		} catch (e) {
			new Notice(t("m.versionFailed", { error: errMsg(e) }));
		}
	}

	private async showDeletedFiles() {
		if (await this.needsUnlock()) return;
		new CommitListModal(this.app, t("m.recentlyDeleted"), async () => {
			const commits = await this.gh.listCommits(this.settings.branch, undefined, 25);
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
