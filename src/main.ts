import { debounce, Debouncer, normalizePath, Notice, Platform, Plugin, setIcon, TAbstractFile, TFile } from "obsidian";
import { GitHub } from "./github.ts";
import { HEALTH_VIEW, HealthView } from "./health.ts";
import { VaultIO } from "./io.ts";
import type { Decision, SyncMode } from "./plan.ts";
import { VaultSyncSettingTab } from "./settings-tab.ts";
import { SyncCancelled, SyncEngine } from "./sync.ts";
import type { DeviceScope, SyncHost, SyncReport } from "./sync.ts";
import { SetupWizard } from "./wizard.ts";
import { DEFAULT_SETTINGS, emptyState } from "./types.ts";
import type {
	ConflictChoice,
	ConflictInfo,
	DeleteGuardChoice,
	LocalChanges,
	SyncOptions,
	SyncState,
	VaultSyncSettings,
} from "./types.ts";
import {
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
import { asText, conflictCopyOriginal, errMsg, restoredCopyPath, stamp } from "./util.ts";

type Trigger = "manual" | "startup" | "change" | "interval" | "resume" | "background";
type Status = "idle" | "syncing" | "ok" | "error" | "offline" | "conflict";

export default class VaultSyncPlugin extends Plugin implements SyncHost {
	settings!: VaultSyncSettings;
	state!: SyncState;
	gh!: GitHub;
	lastReport: SyncReport | null = null;
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
	private queued: { mode: SyncMode; opts: SyncOptions } | null = null;
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
		this.gh = new GitHub(() => ({
			token: this.getToken(),
			apiBase: this.getApiBase(),
			owner: this.settings.owner,
			repo: this.settings.repo,
		}));
		this.engine = new SyncEngine(this);
		this.io = new VaultIO(this.app);

		this.registerView(HEALTH_VIEW, (leaf) => new HealthView(leaf, this));
		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Sync with GitHub", () => this.sync("manual"));
		this.addRibbonIcon("activity", "GitHub sync status", () => this.openHealth());
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("vsg-status");
			this.statusEl.onClickEvent(() => this.openHealth());
		}
		this.setStatus("idle");
		this.addSettingTab(new VaultSyncSettingTab(this.app, this));
		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			const touch = (path: string) => {
				if (this.syncing) return void this.touchedDuringSync.add(path);
				const w = this.writtenBySync.get(path);
				if (w && Date.now() - w < 5000) return;
				this.dirty.set(path, ++this.dirtySeq);
			};
			const onVaultChange = (file: TAbstractFile, oldPath?: string) => {
				if (file instanceof TFile) touch(file.path);
				if (oldPath) touch(oldPath);
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
				window.setTimeout(() => this.openWizard(), 1000);
			} else if (this.settings.syncOnStartup) window.setTimeout(() => this.sync("startup"), 2500);
		});

		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.settings.syncOnResume) {
				if (Date.now() - this.state.lastSync > 60_000) this.sync("resume");
			} else if (document.visibilityState === "hidden" && this.settings.syncOnBackground) {
				this.sync("background");
			}
		});
	}

	onunload() {
		this.onChangeDebounced?.cancel();
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
		return `vault-sync-github:${id}:${name}`;
	}
	getToken(): string {
		try {
			return window.localStorage.getItem(this.localKey("token")) ?? "";
		} catch {
			return "";
		}
	}
	setToken(token: string) {
		window.localStorage.setItem(this.localKey("token"), token);
	}
	getApiBase(): string {
		try {
			return window.localStorage.getItem(this.localKey("apiBase")) || "https://api.github.com";
		} catch {
			return "https://api.github.com";
		}
	}
	setApiBase(url: string) {
		window.localStorage.setItem(this.localKey("apiBase"), url);
	}
	deviceName(): string {
		let name = "";
		try {
			name = window.localStorage.getItem(this.localKey("device")) ?? "";
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
		window.localStorage.setItem(this.localKey("device"), name);
	}
	/** Device-local scope: never synced, so each device can choose its own folders and limits. */
	deviceScope(): DeviceScope {
		try {
			const raw = JSON.parse(window.localStorage.getItem(this.localKey("scope")) ?? "{}");
			return {
				include: Array.isArray(raw.include) ? raw.include : [],
				exclude: Array.isArray(raw.exclude) ? raw.exclude : [],
				maxDownloadMB: Number(raw.maxDownloadMB) || 0,
			};
		} catch {
			return { include: [], exclude: [], maxDownloadMB: 0 };
		}
	}
	setDeviceScope(scope: DeviceScope) {
		window.localStorage.setItem(this.localKey("scope"), JSON.stringify(scope));
		this.fullScanNeeded = true;
	}
	progress(text: string) {
		this.onProgress?.(text);
		this.statusEl?.setAttr("aria-label", text);
		this.ribbonEl?.setAttr("aria-label", `Sync with GitHub: ${text}`);
	}
	openWizard() {
		new SetupWizard(this.app, this).open();
	}

	/** First sync from the setup wizard. Returns a one-line summary. */
	async firstSync(prefer?: "local" | "remote"): Promise<string> {
		await this.sync("manual", this.settings.mode, prefer ? { firstSyncPrefer: prefer } : { firstSyncPrefer: undefined });
		if (this.lastError) return `The first sync failed: ${this.lastError}. You can retry from the sync status panel.`;
		const r = this.lastReport;
		if (!r) return "Sync finished.";
		if (r.upToDate) return "Everything was already in sync.";
		const parts = [
			r.downloaded.length && `${r.downloaded.length} downloaded`,
			r.uploaded.length && `${r.uploaded.length} uploaded`,
			r.conflictCopies.length && `${r.conflictCopies.length} kept as both versions`,
			r.skipped.length && `${r.skipped.length} skipped (see status panel)`,
		].filter(Boolean);
		return `First sync complete: ${parts.join(", ") || "no changes"}.`;
	}

	async freeUpSpace() {
		if (!this.isConfigured()) return void new Notice(this.configProblem()!);
		try {
			const plan = await this.engine.freeUpSpace((p) =>
				confirmPlan(
					this.app,
					"Free up space on this device",
					`Remove ${p.files.length} local file(s) (${(p.bytes / 1048576).toFixed(1)} MB) that this device doesn't sync (outside its folders or above its download limit). Each one is identical to the copy on GitHub, which is kept. They go to the trash.`,
					[{ title: "Remove from this device", items: p.files }],
					"Free up space",
				),
			);
			if (!plan.files.length) new Notice("Nothing to remove: no local files outside this device's scope are safely on GitHub.");
			else new Notice(`Freed ${(plan.bytes / 1048576).toFixed(1)} MB.`);
		} catch (e) {
			if (!(e instanceof SyncCancelled)) new Notice(`Could not free up space: ${errMsg(e)}`);
		}
		this.refreshHealth();
	}

	// ---------------- persistence ----------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
		// Scope settings may have changed: rescan everything next time.
		this.fullScanNeeded = true;
	}
	async loadState() {
		try {
			const raw = await this.app.vault.adapter.read(this.stateFilePath);
			const parsed = JSON.parse(raw) as SyncState;
			this.state = parsed.version === 1 ? { ...emptyState(), ...parsed } : emptyState();
		} catch {
			this.state = emptyState();
		}
	}
	async saveState() {
		await this.app.vault.adapter.write(this.stateFilePath, JSON.stringify(this.state));
	}
	async resetState() {
		this.state = emptyState();
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
		const pending = new Set(this.engine.quickLocalPending());
		for (const p of this.dirty.keys()) pending.add(p);
		return pending.size;
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
				this.sync("interval");
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

	private notify(msg: string, important = false) {
		const lvl = this.settings.noticeLevel;
		if (lvl === "all" || (lvl === "errors" && important)) new Notice(msg, important ? 8000 : 4000);
	}

	private setStatus(status: Status, detail = "") {
		const icons: Record<Status, string> = {
			idle: "cloud",
			syncing: "refresh-cw",
			ok: "cloud",
			error: "cloud-off",
			offline: "wifi-off",
			conflict: "alert-triangle",
		};
		const last = this.state?.lastSync ? `Last sync ${new Date(this.state.lastSync).toLocaleTimeString()}` : "Not synced yet";
		const title = detail || (status === "syncing" ? "Syncing…" : last);
		if (this.statusEl) {
			this.statusEl.empty();
			const icon = this.statusEl.createSpan({ cls: `vsg-icon vsg-${status}` });
			setIcon(icon, icons[status]);
			const pending = this.dirty.size;
			if (pending && status !== "syncing") this.statusEl.createSpan({ cls: "vsg-pending", text: String(pending) });
			this.statusEl.setAttr("aria-label", `${title}. Click for sync status.`);
			this.statusEl.setAttr("data-tooltip-position", "top");
		}
		this.ribbonEl?.toggleClass("vsg-spinning", status === "syncing");
		this.ribbonEl?.setAttr("aria-label", `Sync with GitHub: ${title}`);
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
		this.app.workspace.revealLeaf(leaf);
	}

	// ---------------- sync ----------------

	private configProblem(): string | null {
		if (!this.getToken()) return "Add a GitHub token in Settings → Vault Sync for GitHub.";
		if (!this.settings.owner || !this.settings.repo) return "Set the repository owner and name in the plugin settings.";
		return null;
	}

	async sync(trigger: Trigger, mode: SyncMode = this.settings.mode, opts: SyncOptions = {}): Promise<void> {
		const problem = this.configProblem();
		if (problem) {
			if (trigger === "manual") new Notice(problem);
			return;
		}
		if (trigger === "manual" && this.settings.reviewBeforeManualSync && !Object.keys(opts).length && mode === this.settings.mode) {
			return this.openReview();
		}
		if (trigger !== "manual" && !navigator.onLine) {
			this.setStatus("offline", "Offline: will sync when back online");
			return;
		}
		if (this.syncing) {
			this.queued = { mode, opts };
			return;
		}
		this.syncing = true;
		this.changedDuringSync = false;
		this.touchedDuringSync.clear();
		this.onChangeDebounced?.cancel();
		this.setStatus("syncing");
		const started = Date.now();
		let written = new Set<string>();
		try {
			const r = await this.engine.run(mode, opts);
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
				this.setStatus("error", `Sync failed: ${errMsg(e)}`);
				// Automatic syncs only warn on the first failure in a row, not every interval.
				if (trigger === "manual") new Notice(`GitHub sync failed: ${errMsg(e)}`, 8000);
				else if (!this.lastFailed) this.notify(`GitHub sync failed: ${errMsg(e)}`, true);
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
			if (q) window.setTimeout(() => this.sync("change", q.mode, q.opts), 500);
			else if (this.changedDuringSync) this.onChangeDebounced?.();
			this.changedDuringSync = false;
			this.refreshHealth(true);
		}
	}

	private afterSync(r: SyncReport, trigger: Trigger, ms: number) {
		if (r.upToDate) {
			this.log(`Up to date (${trigger}).`);
			this.setStatus(this.conflictCopies().length ? "conflict" : "ok");
			if (trigger === "manual") this.notify("Vault is up to date.");
			return;
		}
		const parts: string[] = [];
		if (r.downloaded.length) parts.push(`↓${r.downloaded.length}`);
		if (r.uploaded.length) parts.push(`↑${r.uploaded.length}`);
		if (r.deletedLocal.length + r.deletedRemote.length) parts.push(`✕${r.deletedLocal.length + r.deletedRemote.length}`);
		if (r.merged.length) parts.push(`merged ${r.merged.length}`);
		const summary = parts.join(" ") || "no changes";
		this.log(`Sync done (${trigger}, ${r.mode}, ${ms} ms): ${summary}`);
		for (const s of r.skipped) this.log(`Skipped ${s}`);

		if (r.errors.length) {
			this.setStatus("error", `${r.errors.length} file(s) failed: see sync status`);
			this.notify(`GitHub sync finished with ${r.errors.length} error(s). Open the sync status panel for details.`, true);
		} else if (r.conflictCopies.length) {
			this.setStatus("conflict", `${r.conflictCopies.length} conflict copy(ies) created`);
			this.notify(`Sync: ${r.conflictCopies.length} conflict(s). Both versions kept; compare them in the sync status panel.`, true);
		} else {
			this.setStatus("ok");
			this.notify(`GitHub sync: ${summary}`);
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
			if (!head) throw new Error("Nothing to snapshot yet. Sync first.");
			const d = new Date();
			const p = (n: number) => String(n).padStart(2, "0");
			const tag = `snapshot-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
			await this.gh.createRef(`refs/tags/${tag}`, head);
			this.state.lastSnapshot = Date.now();
			await this.saveState();
			this.log(`Created snapshot tag ${tag} at ${head.slice(0, 7)}.`);
			if (manual) new Notice(`Snapshot created: ${tag}`);
		} catch (e) {
			this.log(`Snapshot failed: ${errMsg(e)}`);
			if (manual) new Notice(`Snapshot failed: ${errMsg(e)}`);
		}
	}

	// ---------------- review / diff ----------------

	private async textOf(path: string, data: ArrayBuffer | null): Promise<{ text: string | null; size: number }> {
		if (!data) return { text: "", size: 0 };
		return { text: asText(path, data), size: data.byteLength };
	}

	async openReview() {
		const problem = this.configProblem();
		if (problem) return void new Notice(problem);
		try {
			const pv = await this.engine.preview(this.settings.mode);
			const blob = (sha: string | undefined | null) => (sha ? this.gh.getBlob(sha) : Promise.resolve(null));
			const local = async (p: string) => ((await this.app.vault.adapter.exists(p)) ? this.engine.readLocal(p) : null);
			const loadDiff = async (d: Decision): Promise<DiffSides> => {
				const remoteSha = pv.remoteShas.get(d.path);
				let oldData: ArrayBuffer | null;
				let newData: ArrayBuffer | null;
				let oldLabel = "GitHub";
				let newLabel = "This device";
				if (d.kind === "move-local") {
					oldData = await local(d.from);
					newData = await blob(remoteSha);
					oldLabel = `This device (${d.from})`;
					newLabel = `GitHub (${d.path})`;
				} else if (d.kind === "adopt-remote-edit") {
					oldData = await local(d.path);
					newData = await blob(d.sha);
					oldLabel = `This device (${d.path})`;
					newLabel = `GitHub (${d.from})`;
				} else if (d.kind === "download" || d.kind === "delete-local") {
					oldData = await local(d.path);
					newData = await blob(remoteSha);
					oldLabel = "This device";
					newLabel = "GitHub";
				} else {
					oldData = await blob(remoteSha);
					newData = await local(d.path);
				}
				const o = await this.textOf(d.path, oldData);
				const n = await this.textOf(d.path, newData);
				return { oldLabel, newLabel, oldText: o.text, newText: n.text, oldSize: o.size, newSize: n.size };
			};
			new ReviewModal(this.app, pv.decisions, pv.skipped, loadDiff, (deferred) => this.sync("manual", this.settings.mode, { defer: deferred })).open();
		} catch (e) {
			new Notice(`Could not prepare review: ${errMsg(e)}`);
		}
	}

	async compareWithGitHub(file: TFile) {
		new DiffModal(this.app, `${file.path}: GitHub → this device`, async () => {
			const head = await this.gh.getRef(this.settings.branch);
			const remote = head ? await this.gh.getFileAt(file.path, head) : null;
			const localData = await this.app.vault.readBinary(file);
			const o = await this.textOf(file.path, remote);
			const n = await this.textOf(file.path, localData);
			return { oldLabel: remote ? "GitHub" : "GitHub (file not there)", newLabel: "This device", oldText: o.text, newText: n.text, oldSize: o.size, newSize: n.size };
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
			browse: (e) => this.browseAt(e),
			restoreVault: (e) => this.restore(e, ""),
			restoreFolder: (e) => new FolderSuggestModal(this.app, (f) => this.restore(e, f.path)).open(),
		}).open();
	}

	private browseAt(e: TimelineEntry) {
		new CommitListModal(this.app, `Files at ${e.sha.slice(0, 7)} (${new Date(e.date).toLocaleString()})`, async () => {
			const tree = await this.gh.listTree(await this.gh.getCommitTree(e.sha));
			const scope = this.engine.buildScope(false);
			return tree
				.filter((t) => t.type === "blob" && scope(t.path))
				.sort((a, b) => a.path.localeCompare(b.path))
				.map((t) => ({ label: t.path, sub: `${t.size ?? 0} bytes`, run: () => this.openVersion(t.path, e) }));
		}).open();
	}

	private async restore(e: TimelineEntry, folder: string) {
		if (this.syncing) return void new Notice("A sync is running. Try again in a moment.");
		const what = folder ? `folder "${folder}"` : "whole vault";
		this.syncing = true;
		this.setStatus("syncing", `Restoring ${what}…`);
		try {
			const plan = await this.engine.restoreTo(e.sha, folder, (p) =>
				confirmPlan(
					this.app,
					`Restore ${what}`,
					`Bring the ${what} back to how it was on ${new Date(e.date).toLocaleString()} (${e.sha.slice(0, 7)}). This is added as a new commit, so today's version stays in history and you can undo it the same way.`,
					[
						{ title: "Restored to the older version", items: p.changed },
						{ title: "Brought back (deleted since)", items: p.added },
						{ title: "Removed (created since)", items: p.removed },
					],
					"Restore",
					true,
				),
			);
			const n = plan.changed.length + plan.added.length + plan.removed.length;
			new Notice(n ? `Restored ${what}: ${n} file(s) changed.` : `The ${what} already matches that point in time.`);
			this.lastError = null;
		} catch (err) {
			if (!(err instanceof SyncCancelled)) {
				this.lastError = errMsg(err);
				this.lastErrorAt = Date.now();
				new Notice(`Restore failed: ${errMsg(err)}`, 8000);
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
		if (this.syncing) return void new Notice("A sync is running. Try again in a moment.");
		this.syncing = true;
		this.setStatus("syncing", "Comparing with GitHub…");
		try {
			const plan = await this.engine.resetToRemote((p) =>
				confirmPlan(
					this.app,
					"Make this device match GitHub",
					"Discard this device's unsynced changes and make it an exact copy of GitHub. Replaced and removed files are moved to the trash first, so you can still recover them.",
					[
						{ title: "Replaced with the GitHub version", items: p.overwrite },
						{ title: "Downloaded", items: p.download },
						{ title: "Removed (not on GitHub)", items: p.remove },
					],
					"Match GitHub",
					true,
				),
			);
			const n = plan.overwrite.length + plan.download.length + plan.remove.length;
			new Notice(n ? `This device now matches GitHub (${n} file(s) changed).` : "This device already matches GitHub.");
			this.fullScanNeeded = true;
			this.dirty.clear();
		} catch (err) {
			if (!(err instanceof SyncCancelled)) new Notice(`Reset failed: ${errMsg(err)}`, 8000);
			this.log(errMsg(err));
		} finally {
			this.syncing = false;
			this.setStatus("ok");
			this.refreshHealth(true);
		}
	}

	// ---------------- commands ----------------

	private registerCommands() {
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync("manual") });
		this.addCommand({ id: "review", name: "Review changes and sync", callback: () => this.openReview() });
		this.addCommand({ id: "open-status", name: "Open sync status panel", callback: () => this.openHealth() });
		this.addCommand({ id: "pull-now", name: "Pull from GitHub only", callback: () => this.sync("manual", "pull") });
		this.addCommand({ id: "push-now", name: "Back up to GitHub only (push)", callback: () => this.sync("manual", "push") });
		this.addCommand({ id: "preview", name: "Preview sync (dry run)", callback: () => this.openReview() });
		this.addCommand({ id: "timeline", name: "Timeline: restore vault or folder to an earlier point", callback: () => this.openTimeline() });
		this.addCommand({ id: "reset-to-github", name: "Make this device match GitHub (discard local changes)", callback: () => this.resetToGitHub() });
		this.addCommand({ id: "snapshot", name: "Create backup snapshot on GitHub", callback: () => this.snapshot(true) });
		this.addCommand({ id: "setup-wizard", name: "Run setup wizard", callback: () => this.openWizard() });
		this.addCommand({ id: "free-up-space", name: "Free up space on this device", callback: () => this.freeUpSpace() });
		this.addCommand({ id: "show-log", name: "Show sync log", callback: () => this.openLog() });
		this.addCommand({
			id: "file-history",
			name: "Show history of current file",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.showFileHistory(file);
				return true;
			},
		});
		this.addCommand({
			id: "compare-with-github",
			name: "Compare current file with GitHub",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) this.compareWithGitHub(file);
				return true;
			},
		});
		this.addCommand({ id: "recover-deleted", name: "Recover deleted files", callback: () => this.showDeletedFiles() });
		this.addCommand({
			id: "open-repo",
			name: "Open repository on GitHub",
			callback: async () => {
				const repo = await this.gh.getRepo().catch(() => null);
				window.open(repo?.html_url ?? `https://github.com/${this.settings.owner}/${this.settings.repo}`);
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				menu.addItem((i) => i.setTitle("Version history (GitHub)").setIcon("history").onClick(() => this.showFileHistory(file)));
				menu.addItem((i) => i.setTitle("Compare with GitHub").setIcon("file-diff").onClick(() => this.compareWithGitHub(file)));
			}),
		);
	}

	private showFileHistory(file: TFile) {
		new CommitListModal(this.app, `History: ${file.path}`, async () => {
			const commits = await this.gh.listCommits(this.settings.branch, file.path, 50);
			return commits.map((c) => ({
				label: c.message.split("\n")[0],
				sub: `${new Date(c.date).toLocaleString()} · ${c.author} · ${c.sha.slice(0, 7)}`,
				run: () => this.openVersion(file.path, c),
			}));
		}).open();
	}

	private async openVersion(path: string, commit: { sha: string; message: string; date: string }) {
		try {
			const data = await this.gh.getFileAt(path, commit.sha);
			if (!data) return void new Notice("File did not exist in that version.");
			let current: string | null | undefined;
			if (await this.app.vault.adapter.exists(path)) current = asText(path, await this.io.read(path));
			new FileVersionModal(this.app, path, commit, asText(path, data), data.byteLength, current, async (asCopy) => {
				const target = asCopy ? restoredCopyPath(path, commit.sha) : path;
				try {
					// VaultIO recreates missing folders and handles hidden (config) paths.
					await this.io.write(target, data);
				} catch (e) {
					return void new Notice(`Restore failed: ${errMsg(e)}`);
				}
				new Notice(`Restored ${target}. It will be uploaded on the next sync.`);
				const nf = this.app.vault.getAbstractFileByPath(target);
				if (asCopy && nf instanceof TFile) await this.app.workspace.getLeaf(true).openFile(nf);
			}).open();
		} catch (e) {
			new Notice(`Could not load version: ${errMsg(e)}`);
		}
	}

	private showDeletedFiles() {
		new CommitListModal(this.app, "Recently deleted files", async () => {
			const commits = await this.gh.listCommits(this.settings.branch, undefined, 25);
			const rows: { label: string; sub: string; run: () => void }[] = [];
			const seen = new Set<string>();
			for (const c of commits) {
				const detail = await this.gh.getCommitFiles(c.sha);
				if (!detail.parent) continue;
				for (const f of detail.files) {
					if (f.status !== "removed" || seen.has(f.filename)) continue;
					if (this.app.vault.getAbstractFileByPath(f.filename)) continue;
					seen.add(f.filename);
					const parent = detail.parent;
					rows.push({
						label: f.filename,
						sub: `Deleted ${new Date(c.date).toLocaleString()} · ${c.message.split("\n")[0]}`,
						run: () => this.openVersion(f.filename, { sha: parent, message: `before ${c.sha.slice(0, 7)}`, date: c.date }),
					});
				}
			}
			return rows;
		}).open();
	}
}
