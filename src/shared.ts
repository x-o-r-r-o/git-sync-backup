// Shared folders: a vault folder synced to its own repository (e.g. Work/ ↔ team/notes), so part of a
// vault can be shared with collaborators while the rest stays private. Each shared folder runs its
// own sync engine with its own state; the folder maps to the root of its repository.

import { normalizePath } from "obsidian";
import { Codec, PrefixLayer } from "./codec.ts";
import { GitHubFormatLayer } from "./ghformat.ts";
import { LfsLayer } from "./lfs.ts";
import { makeRemote } from "./hosts.ts";
import type VaultSyncPlugin from "./main.ts";
import type { Remote } from "./remote.ts";
import { SyncEngine } from "./sync.ts";
import type { DeviceScope, SyncHost } from "./sync.ts";
import { emptyState } from "./types.ts";
import { readState, writeState } from "./statefile.ts";
import type { ConflictChoice, ConflictInfo, DeleteGuardChoice, SharedFolder, SyncState, VaultSyncSettings } from "./types.ts";

// Anchored at the vault root ("/Work/"), so a nested folder with the same name (Projects/Work/) is
// never mistaken for the shared folder.
export const sharedFolderPattern = (folder: string) => "/" + folder.replace(/^\/+|\/+$/g, "") + "/";

export class SharedFolderHost implements SyncHost {
	readonly def: SharedFolder;
	state: SyncState = emptyState();
	lastError: string | null = null;
	lastSync = 0;
	readonly engine: SyncEngine;
	private plugin: VaultSyncPlugin;
	private remote: Remote;

	constructor(plugin: VaultSyncPlugin, def: SharedFolder) {
		this.plugin = plugin;
		this.def = def;
		this.remote = makeRemote(def.provider, () => {
			// Its own token (bound to its host), else the main token (and sign-in renewal), but only for the same host.
			const own = plugin.sharedToken(def);
			const auth = own ? { token: own, bearer: false, onUnauthorized: () => Promise.resolve(false) } : plugin.borrowedAuth(def.provider);
			return { ...auth, apiBase: plugin.getApiBaseFor(def.provider), owner: def.owner, repo: def.repo };
		}, plugin.blobCacheStore(`shared-${def.id}`));
		this.engine = new SyncEngine(this);
	}

	get app() {
		return this.plugin.app;
	}
	get gh(): Remote {
		return this.remote;
	}
	get settings(): VaultSyncSettings {
		const s = this.plugin.settings;
		return { ...s, provider: this.def.provider, owner: this.def.owner, repo: this.def.repo, branch: this.def.branch || "main", syncConfigDir: false, syncHidden: false, dailySnapshot: false };
	}
	/** The vault's .gitignore applies inside shared folders too (vault paths). */
	gitignorePatterns(): string[] {
		return this.plugin.gitignorePatterns();
	}
	get stateFilePath(): string {
		return normalizePath(this.plugin.stateFilePath.replace(/sync-state\.json$/, `sync-state-${this.def.id}.json`));
	}
	/** False when this device's own scope leaves the folder out. */
	activeOnThisDevice(): boolean {
		const inc = this.plugin.deviceScope().include;
		if (!inc.length) return true;
		const f = sharedFolderPattern(this.def.folder);
		return inc.some((p) => f.startsWith(p.replace(/^\/+/, "").replace(/\*+$/, "")) || p.replace(/^\/+/, "").startsWith(f));
	}

	deviceName() {
		return this.plugin.deviceName();
	}
	log(msg: string) {
		this.plugin.log(`[${this.def.folder}] ${msg}`);
	}
	progress(text: string) {
		this.plugin.progress(`${this.def.folder}: ${text}`);
	}
	async loadState() {
		this.state = await readState(this.app.vault.adapter, this.stateFilePath, this.plugin.deviceId(), (m) => this.log(m));
	}
	async saveState() {
		await writeState(this.app.vault.adapter, this.stateFilePath, this.state, this.plugin.deviceId());
	}
	askConflict(info: ConflictInfo): Promise<ConflictChoice> {
		return this.plugin.askConflict(info);
	}
	confirmDeletes(local: string[], remote: string[]): Promise<DeleteGuardChoice> {
		return this.plugin.confirmDeletes(local, remote);
	}
	deviceScope(): DeviceScope {
		const ds = this.plugin.deviceScope();
		return { include: [sharedFolderPattern(this.def.folder)], exclude: ds.exclude, maxDownloadMB: ds.maxDownloadMB, pinned: ds.pinned };
	}
	isUnloaded(): boolean {
		return this.plugin.isUnloaded();
	}
	get windows(): boolean {
		return this.plugin.windows;
	}
	commitContext() {
		return this.plugin.commitContext();
	}
	/** `sync: false` notes stay on this device inside shared folders too. */
	frontmatterScope() {
		return this.plugin.frontmatterScope();
	}
	conflictsAsPullRequest(): boolean {
		return this.def.conflicts === "pr";
	}
	get pluginVersion(): string {
		return this.plugin.pluginVersion;
	}
	codec(): Codec {
		const prefix = new PrefixLayer(this.def.folder, this.def.subdir ?? "");
		const lfs = new LfsLayer(this.remote, (this.plugin.settings.lfsThresholdMB ?? 0) * 1024 * 1024);
		return new Codec(this.def.githubFormat ? [prefix, new GitHubFormatLayer(), lfs] : [prefix, lfs]);
	}
}
