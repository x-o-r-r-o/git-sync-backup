import { debounce, Debouncer, normalizePath, Notice, Platform, Plugin, setIcon, TFile } from "obsidian";
import { GitHub } from "./github.ts";
import type { SyncMode } from "./plan.ts";
import { VaultSyncSettingTab } from "./settings-tab.ts";
import { SyncCancelled, SyncEngine, SyncHost, SyncReport } from "./sync.ts";
import {
	ConflictChoice,
	ConflictInfo,
	DEFAULT_SETTINGS,
	DeleteGuardChoice,
	emptyState,
	SyncState,
	VaultSyncSettings,
} from "./types.ts";
import { CommitListModal, ConflictModal, DeleteGuardModal, FileVersionModal, LogModal, PreviewModal } from "./ui.ts";
import { VaultIO } from "./io.ts";
import { asText, conflictCopyPath, errMsg, stamp } from "./util.ts";

type Trigger = "manual" | "startup" | "change" | "interval" | "resume" | "background";
type Status = "idle" | "syncing" | "ok" | "error" | "offline" | "conflict";

export default class VaultSyncPlugin extends Plugin implements SyncHost {
	settings!: VaultSyncSettings;
	state!: SyncState;
	gh!: GitHub;
	private engine!: SyncEngine;
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private syncing = false;
	private changedDuringSync = false;
	private lastFailed = false;
	private queued: SyncMode | null = null;
	private logLines: string[] = [];
	private onChangeDebounced: Debouncer<[], void> | null = null;
	private intervalId: number | null = null;

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

		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Sync with GitHub", () => this.sync("manual"));
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("vsg-status");
			this.statusEl.onClickEvent(() => this.sync("manual"));
		}
		this.setStatus("idle");
		this.addSettingTab(new VaultSyncSettingTab(this.app, this));
		this.registerCommands();

		this.app.workspace.onLayoutReady(() => {
			const onVaultChange = () => {
				if (!this.settings.syncOnChange) return;
				// Our own writes during a sync also land here; that only costs one cheap no-op sync later.
				if (this.syncing) this.changedDuringSync = true;
				else this.onChangeDebounced?.();
			};
			this.registerEvent(this.app.vault.on("modify", onVaultChange));
			this.registerEvent(this.app.vault.on("create", onVaultChange));
			this.registerEvent(this.app.vault.on("delete", onVaultChange));
			this.registerEvent(this.app.vault.on("rename", onVaultChange));
			this.rescheduleTriggers();
			if (this.settings.syncOnStartup) window.setTimeout(() => this.sync("startup"), 2500);
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

	// ---------------- persistence ----------------

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}
	async saveSettings() {
		await this.saveData(this.settings);
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
		await this.saveState();
		this.log("Sync state reset by user.");
	}

	// ---------------- triggers ----------------

	rescheduleTriggers() {
		this.onChangeDebounced?.cancel();
		this.onChangeDebounced = debounce(() => this.sync("change"), this.settings.changeDebounceSec * 1000, true);
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		if (this.settings.intervalMin > 0) {
			this.intervalId = window.setInterval(() => this.sync("interval"), this.settings.intervalMin * 60_000);
			this.registerInterval(this.intervalId);
		}
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
			this.statusEl.setAttr("aria-label", title);
			this.statusEl.setAttr("data-tooltip-position", "top");
		}
		this.ribbonEl?.toggleClass("vsg-spinning", status === "syncing");
		this.ribbonEl?.setAttr("aria-label", `Sync with GitHub: ${title}`);
	}

	askConflict(info: ConflictInfo): Promise<ConflictChoice> {
		return new Promise((resolve) => new ConflictModal(this.app, info, resolve).open());
	}

	confirmDeletes(local: string[], remote: string[]): Promise<DeleteGuardChoice> {
		return new Promise((resolve) => new DeleteGuardModal(this.app, local, remote, resolve).open());
	}

	// ---------------- sync ----------------

	private configured(): string | null {
		if (!this.getToken()) return "Add a GitHub token in Settings → Vault Sync for GitHub.";
		if (!this.settings.owner || !this.settings.repo) return "Set the repository owner and name in the plugin settings.";
		return null;
	}

	async sync(trigger: Trigger, mode: SyncMode = this.settings.mode): Promise<void> {
		const problem = this.configured();
		if (problem) {
			if (trigger === "manual") new Notice(problem);
			return;
		}
		if (trigger !== "manual" && !navigator.onLine) {
			this.setStatus("offline", "Offline: will sync when back online");
			return;
		}
		if (this.syncing) {
			this.queued = mode;
			return;
		}
		this.syncing = true;
		this.changedDuringSync = false;
		this.onChangeDebounced?.cancel();
		this.setStatus("syncing");
		const started = Date.now();
		try {
			const r = await this.engine.run(mode);
			this.afterSync(r, trigger, Date.now() - started);
			this.lastFailed = false;
			await this.maybeDailySnapshot();
		} catch (e) {
			if (e instanceof SyncCancelled) {
				this.log(e.message);
				this.setStatus("idle", e.message);
			} else {
				this.log(`Sync failed: ${errMsg(e)}`);
				this.setStatus("error", `Sync failed: ${errMsg(e)}`);
				// Automatic syncs only warn on the first failure in a row, not every interval.
				if (trigger === "manual") new Notice(`GitHub sync failed: ${errMsg(e)}`, 8000);
				else if (!this.lastFailed) this.notify(`GitHub sync failed: ${errMsg(e)}`, true);
				this.lastFailed = true;
			}
		} finally {
			this.syncing = false;
			const q = this.queued;
			this.queued = null;
			if (q) window.setTimeout(() => this.sync("change", q), 500);
			else if (this.changedDuringSync) this.onChangeDebounced?.();
			this.changedDuringSync = false;
		}
	}

	private afterSync(r: SyncReport, trigger: Trigger, ms: number) {
		if (r.upToDate) {
			this.log(`Up to date (${trigger}).`);
			this.setStatus("ok");
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
			this.setStatus("error", `${r.errors.length} file(s) failed: see sync log`);
			this.notify(`GitHub sync finished with ${r.errors.length} error(s). Open "Show sync log" for details.`, true);
		} else if (r.conflictCopies.length) {
			this.setStatus("conflict", `${r.conflictCopies.length} conflict copy(ies) created`);
			this.notify(`Sync: ${r.conflictCopies.length} conflict(s). Both versions kept:\n${r.conflictCopies.join("\n")}`, true);
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

	// ---------------- commands ----------------

	private registerCommands() {
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync("manual") });
		this.addCommand({ id: "pull-now", name: "Pull from GitHub only", callback: () => this.sync("manual", "pull") });
		this.addCommand({ id: "push-now", name: "Back up to GitHub only (push)", callback: () => this.sync("manual", "push") });
		this.addCommand({
			id: "preview",
			name: "Preview sync (dry run)",
			callback: async () => {
				const problem = this.configured();
				if (problem) return new Notice(problem);
				try {
					const pv = await this.engine.preview(this.settings.mode);
					new PreviewModal(this.app, pv.decisions, pv.skipped, () => this.sync("manual")).open();
				} catch (e) {
					new Notice(`Preview failed: ${errMsg(e)}`);
				}
			},
		});
		this.addCommand({ id: "snapshot", name: "Create backup snapshot on GitHub", callback: () => this.snapshot(true) });
		this.addCommand({ id: "show-log", name: "Show sync log", callback: () => new LogModal(this.app, this.logLines).open() });
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
			if (!data) return new Notice("File did not exist in that version.");
			new FileVersionModal(this.app, path, commit, asText(path, data), data.byteLength, async (asCopy) => {
				const target = asCopy ? conflictCopyPath(path, `restored ${commit.sha.slice(0, 7)}`) : path;
				try {
					// VaultIO recreates missing folders and handles hidden (config) paths.
					await new VaultIO(this.app).write(target, data);
				} catch (e) {
					return new Notice(`Restore failed: ${errMsg(e)}`);
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
