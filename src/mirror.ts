// Backup mirror: after each sync, the vault is also uploaded to a second repository (any supported
// host), push only. It runs its own engine with its own state, uses the same scope as the main
// repository, and the same encryption when the vault is encrypted (so a mirror never leaks plaintext).

import { normalizePath } from "obsidian";
import { Codec } from "./codec.ts";
import { encryptionGuard } from "./encryption.ts";
import type { EncryptionMeta } from "./crypto.ts";
import { makeRemote } from "./hosts.ts";
import { LfsLayer } from "./lfs.ts";
import type VaultSyncPlugin from "./main.ts";
import type { Remote } from "./remote.ts";
import { SyncEngine } from "./sync.ts";
import type { DeviceScope, SyncHost } from "./sync.ts";
import { emptyState } from "./types.ts";
import type { ConflictChoice, ConflictInfo, DeleteGuardChoice, MirrorTarget, SyncState, VaultSyncSettings } from "./types.ts";
import { readState, writeState } from "./statefile.ts";

export class MirrorHost implements SyncHost {
	readonly target: MirrorTarget;
	state: SyncState = emptyState();
	lastError: string | null = null;
	lastSync = 0;
	readonly engine: SyncEngine;
	private plugin: VaultSyncPlugin;
	private remote: Remote;

	constructor(plugin: VaultSyncPlugin, target: MirrorTarget) {
		this.plugin = plugin;
		this.target = target;
		const def = { id: "mirror", provider: target.provider };
		this.remote = makeRemote(
			target.provider,
			// Its own token, else the main one, but only for the same host.
			() => ({ token: plugin.mirrorToken(def) || (target.provider === plugin.settings.provider ? plugin.getToken() : ""), apiBase: plugin.getApiBaseFor(target.provider), owner: target.owner, repo: target.repo }),
			plugin.blobCacheStore(`mirror-${target.owner}-${target.repo}`),
		);
		this.engine = new SyncEngine(this);
	}

	get app() {
		return this.plugin.app;
	}
	get gh(): Remote {
		return this.remote;
	}
	get settings(): VaultSyncSettings {
		const t = this.target;
		// Push only; the mirror follows the main repository's scope, minus things only the main repo needs.
		return { ...this.plugin.settings, provider: t.provider, owner: t.owner, repo: t.repo, branch: t.branch || "main", mode: "push", dailySnapshot: false, keepEmptyFolders: false, deleteGuardEnabled: false };
	}
	get stateFilePath(): string {
		return normalizePath(this.plugin.stateFilePath.replace(/sync-state\.json$/, "sync-state-mirror.json"));
	}
	get pluginVersion(): string {
		return this.plugin.pluginVersion;
	}
	deviceName() {
		return this.plugin.deviceName();
	}
	log(msg: string) {
		this.plugin.log(`[mirror] ${msg}`);
	}
	progress(text: string) {
		this.plugin.progress(`${this.target.repo}: ${text}`);
	}
	async loadState() {
		this.state = await readState(this.app.vault.adapter, this.stateFilePath, this.plugin.deviceId(), (m) => this.log(m));
	}
	async saveState() {
		await writeState(this.app.vault.adapter, this.stateFilePath, this.state, this.plugin.deviceId());
	}
	askConflict(_info: ConflictInfo): Promise<ConflictChoice> {
		// Push only: this device's version is what the mirror keeps.
		return Promise.resolve("local");
	}
	confirmDeletes(): Promise<DeleteGuardChoice> {
		// The main sync already passed the delete guard; the mirror only follows it.
		return Promise.resolve("proceed");
	}
	deviceScope(): DeviceScope {
		return this.plugin.deviceScope();
	}
	extraExcludes(): string[] {
		return this.plugin.extraExcludes();
	}
	gitignorePatterns(): string[] {
		return this.plugin.gitignorePatterns();
	}
	isUnloaded(): boolean {
		return this.plugin.isUnloaded();
	}
	codec(): Codec {
		const enc = this.plugin.encryptionLayer();
		const lfs = new LfsLayer(this.remote, (this.plugin.settings.lfsThresholdMB ?? 0) * 1024 * 1024);
		return new Codec(enc ? [enc, lfs] : [lfs]);
	}
	checkEncryption = (markerSha: string | null): Promise<string | null> =>
		encryptionGuard(
			() => this.plugin.encryptionRecord(),
			() => undefined, // the mirror never changes this device's key
			async (sha) => JSON.parse(new TextDecoder().decode(await this.remote.getBlob(sha))) as EncryptionMeta,
		)(markerSha);
}
