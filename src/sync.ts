// The sync engine: scan local, read remote tree, decide, apply, push one atomic commit.

import { arrayBufferToBase64 } from "obsidian";
import type { App } from "obsidian";
import { Codec, PLAIN } from "./codec.ts";
import { MARKER_PATH } from "./crypto.ts";
import { NotFastForward } from "./remote.ts";
import type { Remote, Upsert } from "./remote.ts";
import { compileGlobs } from "./glob.ts";
import { VaultIO } from "./io.ts";
import { merge3 } from "./merge.ts";
import { decide, detectRenames } from "./plan.ts";
import { smartMerge } from "./smartmerge.ts";
import type { Decision, SyncMode } from "./plan.ts";
import { emptyState } from "./types.ts";
import type {
	ConflictChoice,
	ConflictInfo,
	DeleteGuardChoice,
	LocalChanges,
	SyncOptions,
	SyncState,
	VaultSyncSettings,
} from "./types.ts";
import { asText, conflictCopyPath, encodeText, errMsg, gitBlobSha, isHiddenPath, pool, sleep } from "./util.ts";

export interface SyncHost {
	app: App;
	settings: VaultSyncSettings;
	state: SyncState;
	gh: Remote;
	stateFilePath: string;
	deviceName(): string;
	log(msg: string): void;
	saveState(): Promise<void>;
	askConflict(info: ConflictInfo): Promise<ConflictChoice>;
	confirmDeletes(local: string[], remote: string[]): Promise<DeleteGuardChoice>;
	/** Live set of paths edited since the last sync (optional: without it every scan is full). */
	localChanges?(): LocalChanges;
	/** Called after a successful sync with the snapshot that sync covered. */
	markLocalChangesSynced?(covered: LocalChanges): void;
	/** Device-local scope (not synced between devices). */
	deviceScope?(): DeviceScope;
	/** Folders handled by another engine (shared folders): never touched by this one. */
	extraExcludes?(): string[];
	/** Human-readable progress for long syncs. */
	progress?(text: string): void;
	/** Path/content transforms (encryption, folder mapping, LFS). Defaults to none. */
	codec?(): Codec;
	/**
	 * Checks this device's encryption setup against the repository's marker file (blob sha or null).
	 * Throws if the repo is encrypted and this device can't read it. Returns marker JSON to publish
	 * when this device is the first to encrypt the repository, else null.
	 */
	checkEncryption?(markerSha: string | null): Promise<string | null>;
}

export interface DeviceScope {
	/** If non-empty, only these folders/patterns are synced on this device. */
	include: string[];
	/** Extra exclude patterns for this device. */
	exclude: string[];
	/** Remote files larger than this are not downloaded to this device (0 = no limit). */
	maxDownloadMB: number;
}

export interface FreeSpacePlan {
	files: string[];
	bytes: number;
}

export interface ResetPlan {
	overwrite: string[];
	download: string[];
	remove: string[];
}

export interface RestorePlan {
	changed: string[];
	added: string[];
	removed: string[];
}

export interface SyncReport {
	mode: SyncMode;
	upToDate: boolean;
	downloaded: string[];
	deletedLocal: string[];
	uploaded: string[];
	deletedRemote: string[];
	merged: string[];
	renamed: string[];
	conflictCopies: string[];
	skipped: string[];
	errors: string[];
	commit: string | null;
}

export interface Preview {
	decisions: Decision[];
	skipped: string[];
	localShas: Map<string, string>;
	remoteShas: Map<string, string>;
	base: Record<string, string>;
}

export class SyncCancelled extends Error {}
class StaleRemote extends Error {}
class EditedDuringSync extends Error {
	constructor(path: string) {
		super(`${path} was edited during sync`);
	}
}

interface RemoteEntry {
	sha: string;
	mode: string;
	/** Path in the repository (differs from the vault path when a codec maps paths). */
	raw: string;
}

interface Upload {
	path: string;
	sha: string;
	mode: string;
	// Only set for generated content (merges, conflict copies). Plain uploads are read
	// lazily at push time so a huge first sync never holds the whole vault in memory.
	data?: ArrayBuffer;
}

// The config dir is walked from disk; between full scans do it at most this often.
const CONFIG_SCAN_MS = 5 * 60_000;
// Larger text files skip line-ending normalisation.
const EOL_MAX = 2 * 1024 * 1024;

/** Reject paths that could escape the vault or that git itself forbids. */
function safePath(p: string): boolean {
	if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
	return !p.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

export class SyncEngine {
	private io: VaultIO;
	private host: SyncHost;
	private opts: SyncOptions = {};
	private codec: Codec = PLAIN;
	private markerToAdd: string | null = null;
	private assertUnchanged: (path: string) => Promise<void> = async () => {};

	constructor(host: SyncHost) {
		this.host = host;
		this.io = new VaultIO(host.app);
	}

	// Settings are snapshotted for the duration of a sync, so edits in the settings tab can't switch
	// repository or branch halfway through.
	private snap: VaultSyncSettings | null = null;
	private get s(): VaultSyncSettings {
		return this.snap ?? this.host.settings;
	}

	private get repoKey() {
		// The codec is part of the identity: enabling encryption or a folder mapping starts a fresh,
		// non-deleting baseline instead of comparing against the wrong representation.
		return `${this.s.owner}/${this.s.repo}@${this.s.branch}${this.codec.id ? "#" + this.codec.id : ""}`;
	}

	private loadCodec() {
		this.codec = this.host.codec?.() ?? PLAIN;
	}

	/** Repository path of a vault path (for history lookups). */
	remotePathOf(path: string): Promise<string> {
		this.loadCodec();
		return this.codec.encodePath(path);
	}

	/** Vault path of a repository path, or null if it isn't a file this vault manages. */
	vaultPathOf(raw: string): Promise<string | null> {
		this.loadCodec();
		if (raw === MARKER_PATH) return Promise.resolve(null);
		return this.codec.transformsPaths ? this.codec.decodePath(raw) : Promise.resolve(raw);
	}

	/** File content as stored at `ref`, decoded (decrypted) for display or restore. */
	async readRemoteFile(path: string, ref: string): Promise<ArrayBuffer | null> {
		this.loadCodec();
		const data = await this.host.gh.getFileAt(await this.codec.encodePath(path), ref);
		return data ? this.codec.decode(path, data) : null;
	}

	/** Decoded file list of a commit: vault path → stored entry. */
	async filesAt(commit: string, scope = this.buildScope(false)): Promise<Map<string, RemoteEntry & { size: number }>> {
		this.loadCodec();
		const out = new Map<string, RemoteEntry & { size: number }>();
		for (const e of await this.host.gh.listTree(await this.host.gh.getCommitTree(commit))) {
			if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) continue;
			const p = await this.vaultPathOf(e.path);
			if (p === null || !safePath(p) || !scope(p)) continue;
			out.set(p, { sha: e.sha, mode: e.mode, raw: e.path, size: e.size ?? 0 });
		}
		return out;
	}

	private async blob(path: string, sha: string): Promise<ArrayBuffer> {
		return this.codec.decode(path, await this.host.gh.getBlob(sha));
	}

	/** Which paths this plugin manages. With `device` (default) the device-local scope applies too. */
	buildScope(device = true): (path: string) => boolean {
		this.loadCodec();
		const cfg = this.host.app.vault.configDir;
		const sub = (l: string) => l.split("{config}").join(cfg);
		const patterns = this.s.excludePatterns.split("\n").map(sub);
		const ds = device ? this.host.deviceScope?.() : undefined;
		const excluded = compileGlobs([
			...patterns,
			...(ds?.exclude ?? []).map(sub),
			...(this.host.extraExcludes?.() ?? []),
			".git/",
			this.host.stateFilePath,
			// Every engine's state files live in the plugin folder.
			this.host.stateFilePath.replace(/[^/]+$/, "sync-state*"),
		]);
		const includes = (ds?.include ?? []).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
		// A codec that maps a folder (shared folders) only ever handles paths inside that folder.
		const prefix = this.codec.layers.find((l) => l.id.startsWith("folder:"))?.id.slice("folder:".length);
		const included = includes.length ? compileGlobs(includes.map(sub)) : null;
		return (p: string) => {
			if (excluded(p)) return false;
			if (prefix && !p.startsWith(prefix)) return false;
			if (included && !included(p) && !p.startsWith(cfg + "/")) return false;
			if (!isHiddenPath(p)) return true;
			if (!this.s.syncConfigDir || !p.startsWith(cfg + "/")) return false;
			return !isHiddenPath(p.slice(cfg.length + 1));
		};
	}

	/** Dry run: what would happen, without touching anything. */
	async preview(mode: SyncMode): Promise<Preview> {
		this.loadCodec();
		const ctx = await this.gather(false, {}, true);
		const plan = decide(ctx.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope);
		const decisions = detectRenames(plan.decisions, ctx.base, ctx.localShas, ctx.remoteShas);
		return { decisions, skipped: ctx.skipped, localShas: ctx.localShas, remoteShas: ctx.remoteShas, base: ctx.base };
	}

	/**
	 * Vault files that look changed since the last sync: new, deleted, or with a different mtime/size
	 * than when last hashed. In-memory only (no reads, no network), so it is cheap enough for the UI.
	 */
	quickLocalPending(): string[] {
		const state = this.host.state;
		const scope = this.buildScope();
		const cfgPrefix = this.host.app.vault.configDir + "/";
		const seen = new Set<string>();
		const out: string[] = [];
		for (const f of this.io.listVault(scope)) {
			seen.add(f.path);
			const c = state.cache[f.path];
			if (!c || c.m !== f.mtime || c.s !== f.size || state.base[f.path] !== c.h) out.push(f.path);
		}
		for (const p of Object.keys(state.base)) {
			if (!seen.has(p) && !p.startsWith(cfgPrefix) && scope(p)) out.push(p);
		}
		return out;
	}

	/** Content of a local file (for diffs). */
	readLocal(path: string): Promise<ArrayBuffer> {
		return this.io.read(path);
	}

	/** Decoded content of a remote blob of `path` (for diffs). */
	readBlob(path: string, sha: string): Promise<ArrayBuffer> {
		this.loadCodec();
		return this.blob(path, sha);
	}

	async run(mode: SyncMode, opts: SyncOptions = {}): Promise<SyncReport> {
		const outer = this.snap === null;
		if (outer) this.snap = { ...this.host.settings };
		try {
			return await this.runWithRetries(mode, opts);
		} finally {
			if (outer) this.snap = null;
		}
	}

	private async runWithRetries(mode: SyncMode, opts: SyncOptions): Promise<SyncReport> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.runOnce(mode, opts);
			} catch (e) {
				if (e instanceof NotFastForward && attempt < 3) {
					this.host.log("Remote moved during sync (another device pushed). Retrying.");
					continue;
				}
				if (e instanceof StaleRemote) {
					if (attempt < 3) {
						this.host.log("GitHub returned an outdated branch state. Waiting and retrying.");
						await sleep(2000 * (attempt + 1));
						continue;
					}
					throw new Error("GitHub keeps returning an outdated branch state. Nothing was changed; try again in a minute.");
				}
				throw e;
			}
		}
	}

	private async normHash(path: string, data: ArrayBuffer, sha: string): Promise<string | undefined> {
		if (data.byteLength > EOL_MAX) return undefined;
		const text = asText(path, data);
		if (text === null) return undefined;
		if (!text.includes("\r\n")) return sha;
		return this.codec.storedSha(path, encodeText(text.replace(/\r\n/g, "\n")));
	}

	private async gather(initIfEmpty: boolean, opts: SyncOptions = {}, readOnly = false) {
		const state = this.host.state;
		if (state.repoKey !== this.repoKey) {
			this.host.log(`Repository changed to ${this.repoKey}. Starting from a fresh baseline (no deletions).`);
			Object.assign(state, emptyState(this.repoKey));
		}
		const baseScope = this.buildScope();
		const maxBytes = this.s.maxFileSizeMB * 1024 * 1024;
		const skipped: string[] = [];
		const skipPaths = new Set<string>();
		const skip = (path: string, why: string) => {
			skipped.push(`${path} (${why})`);
			skipPaths.add(path);
		};
		const scope = (p: string) => baseScope(p) && !skipPaths.has(p);
		for (const p of opts.defer ?? []) skip(p, "deferred in review");

		// ---- local ----
		// Vault file stats come from Obsidian's in-memory index, so listing is cheap; only files whose
		// mtime/size changed (or that vault events flagged) are re-hashed. The config dir is walked from
		// disk only on full scans or every few minutes. We yield to the UI regularly so it never freezes.
		const now = Date.now();
		const changes: LocalChanges = this.host.localChanges?.() ?? { full: true, paths: new Set() };
		const covered: LocalChanges = { full: changes.full, paths: new Set(changes.paths) };
		const full = covered.full || !state.lastFullScan || now - state.lastFullScan > this.s.fullScanMinutes * 60_000;
		const configDue = this.s.syncConfigDir && (full || now - state.lastConfigScan > CONFIG_SCAN_MS);
		const cfgPrefix = this.host.app.vault.configDir + "/";

		this.host.progress?.("Scanning files…");
		// Stored forms changed (e.g. LFS turned on): cached hashes are stale, recompute them once.
		const cacheValid = (state.codecFingerprint ?? "") === this.codec.fingerprint;
		const files = this.io.listVault(baseScope);
		const walkConfig = this.s.syncConfigDir && (configDue || !cacheValid);
		if (walkConfig) files.push(...(await this.io.listConfig(baseScope)));
		const localShas = new Map<string, string>();
		const cacheNext: SyncState["cache"] = {};
		let hashed = 0;
		for (const f of files) {
			if (f.size > maxBytes) {
				skip(f.path, `local file larger than ${this.s.maxFileSizeMB} MB`);
				continue;
			}
			const c = cacheValid ? state.cache[f.path] : undefined;
			if (c && c.m === f.mtime && c.s === f.size && !covered.paths.has(f.path)) {
				cacheNext[f.path] = c;
				localShas.set(f.path, c.h);
				continue;
			}
			const data = await this.io.read(f.path);
			const h = await this.codec.storedSha(f.path, data);
			const n = await this.normHash(f.path, data, h);
			cacheNext[f.path] = n ? { m: f.mtime, s: f.size, h, n } : { m: f.mtime, s: f.size, h };
			localShas.set(f.path, h);
			if (++hashed % 25 === 0) await sleep(0);
		}
		if (this.s.syncConfigDir && !walkConfig) {
			for (const [p, c] of Object.entries(state.cache)) {
				if (!p.startsWith(cfgPrefix) || !baseScope(p) || localShas.has(p)) continue;
				if (c.s > maxBytes) skip(p, `local file larger than ${this.s.maxFileSizeMB} MB`);
				else {
					cacheNext[p] = c;
					localShas.set(p, c.h);
				}
			}
		}
		if (!readOnly) {
			if (full) state.lastFullScan = now;
			if (configDue) state.lastConfigScan = now;
		}

		// ---- remote ----
		this.host.progress?.("Checking GitHub…");
		let head = await this.host.gh.getRef(this.s.branch);
		// A branch we synced before has vanished (deleted, renamed, or the token lost access). Never treat
		// that as "the remote is empty": it would delete everything locally.
		if (!head && (state.head || Object.keys(state.base).length)) {
			throw new Error(`The branch "${this.s.branch}" was not found in ${this.s.owner}/${this.s.repo}. It may have been deleted or renamed, or the token lost access. Nothing was changed.`);
		}
		if (!head && initIfEmpty) head = await this.initRemote();

		// Safety: never act on a remote state older than the one we already synced, and never
		// infer deletions across a rewritten history.
		let base = state.base;
		// A file whose only change is CRLF <-> LF counts as unchanged.
		const eolSame = new Set<string>();
		if (this.s.ignoreLineEndingChanges) {
			for (const [p, l] of localShas) {
				const b = base[p];
				const n = cacheNext[p]?.n;
				if (b && l !== b && n && state.baseNorm?.[p] === n) {
					localShas.set(p, b);
					eolSame.add(p);
				}
			}
		}
		if (head && state.head && head !== state.head) {
			const rel = await this.host.gh.compare(state.head, head);
			if (rel === "behind") throw new StaleRemote();
			if (rel === "diverged" || rel === "missing") {
				this.host.log("Remote history was rewritten (force-push?). Comparing from scratch; nothing will be deleted.");
				base = {};
			}
		}

		// Fast path: nothing changed anywhere since last sync.
		const baseInScope = Object.keys(state.base).filter(scope);
		const unchangedLocal = localShas.size === baseInScope.length && [...localShas].every(([p, h]) => state.base[p] === h);
		if (head && head === state.head && unchangedLocal && !state.dirty) {
			return { scope, skipPaths, skipped, localShas, cacheNext, head, treeSha: null, remote: null, remoteShas: localShas, upToDate: true, base, eolSame, covered };
		}

		const remote = new Map<string, RemoteEntry>();
		const remoteShas = new Map<string, string>();
		let treeSha: string | null = null;
		let markerSha: string | null = null;
		if (head) {
			treeSha = await this.host.gh.getCommitTree(head);
			const deviceMax = (this.host.deviceScope?.().maxDownloadMB ?? 0) * 1024 * 1024;
			const fold = (p: string) => p.normalize("NFC").toLowerCase();
			const lowerLocal = new Map([...localShas.keys()].map((p) => [fold(p), p]));
			const seenLower = new Set<string>();
			for (const raw of await this.host.gh.listTree(treeSha)) {
				if (raw.path === MARKER_PATH) markerSha = raw.sha;
				if (raw.type !== "blob" || (raw.mode !== "100644" && raw.mode !== "100755")) continue;
				// Map the repository path back to a vault path (decrypt names, strip folder prefix).
				const vp = this.codec.transformsPaths ? await this.codec.decodePath(raw.path) : raw.path;
				if (vp === null) continue;
				const e = { ...raw, path: vp };
				if (!baseScope(e.path)) continue;
				if (!safePath(e.path)) {
					skipped.push(`${e.path} (unsafe path)`);
					continue;
				}
				if ((e.size ?? 0) > maxBytes) {
					skip(e.path, `remote file larger than ${this.s.maxFileSizeMB} MB`);
					continue;
				}
				if (deviceMax && (e.size ?? 0) > deviceMax && !localShas.has(e.path)) {
					skip(e.path, "larger than this device's download limit");
					continue;
				}
				const lower = fold(e.path);
				const localTwin = lowerLocal.get(lower);
				if (seenLower.has(lower) || (localTwin && localTwin !== e.path && !state.base[e.path])) {
					skip(e.path, "differs only by letter case from another file");
					continue;
				}
				seenLower.add(lower);
				remote.set(e.path, { sha: e.sha, mode: e.mode, raw: raw.path });
				remoteShas.set(e.path, e.sha);
			}
		}
		// Encryption: refuse to read an encrypted repo without the key, or to mix keys.
		if (this.host.checkEncryption && !readOnly) this.markerToAdd = await this.host.checkEncryption(head ? markerSha : null);
		else if (this.host.checkEncryption) await this.host.checkEncryption(head ? markerSha : null);
		for (const p of skipPaths) {
			localShas.delete(p);
			remoteShas.delete(p);
			remote.delete(p);
		}
		return { scope, skipPaths, skipped, localShas, cacheNext, head, treeSha, remote, remoteShas, upToDate: false, base, eolSame, covered };
	}

	private async initRemote(): Promise<string> {
		const repo = await this.host.gh.getRepo();
		if (!repo) throw new Error(`Repository ${this.s.owner}/${this.s.repo} not found or the token cannot access it.`);
		const otherHead = repo.default_branch !== this.s.branch ? await this.host.gh.getRef(repo.default_branch) : null;
		if (otherHead) {
			await this.host.gh.createRef(`refs/heads/${this.s.branch}`, otherHead);
			this.host.log(`Created branch ${this.s.branch} from ${repo.default_branch}.`);
		} else {
			const content = "# Managed by Vault Sync for Git. Keeps git clients from rewriting line endings.\n* -text\n";
			await this.host.gh.putFile(".gitattributes", "Initialise vault repository", arrayBufferToBase64(encodeText(content)), this.s.branch);
			this.host.log("Initialised empty repository.");
		}
		const head = await this.host.gh.getRef(this.s.branch);
		if (!head) throw new Error("Could not initialise the repository branch.");
		return head;
	}

	private async runOnce(mode: SyncMode, opts: SyncOptions): Promise<SyncReport> {
		const host = this.host;
		const state = host.state;
		this.opts = opts;
		this.loadCodec();
		this.markerToAdd = null;
		const report: SyncReport = {
			mode,
			upToDate: false,
			downloaded: [],
			deletedLocal: [],
			uploaded: [],
			deletedRemote: [],
			merged: [],
			renamed: [],
			conflictCopies: [],
			skipped: [],
			errors: [],
			commit: null,
		};

		const ctx = await this.gather(mode !== "pull", opts);
		report.skipped = ctx.skipped;
		const cacheNext = ctx.cacheNext;

		if (ctx.upToDate) {
			report.upToDate = true;
			state.cache = cacheNext;
			state.codecFingerprint = this.codec.fingerprint;
			state.lastSync = Date.now();
			await host.saveState();
			host.markLocalChangesSynced?.(ctx.covered);
			return report;
		}

		const remote = ctx.remote ?? new Map<string, RemoteEntry>();
		state.dirty = false;
		const plan = decide(ctx.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope);
		let decisions = detectRenames(plan.decisions, ctx.base, ctx.localShas, ctx.remoteShas);

		// Paths skipped for size/case keep their old base so they are not seen as deleted later.
		const next: Record<string, string> = { ...plan.settled };
		for (const p of ctx.skipPaths) if (state.base[p]) next[p] = state.base[p];

		// ---- delete guard ----
		const delLocal = decisions.filter((d) => d.kind === "delete-local").map((d) => d.path);
		// Renames are not deletions.
		const delRemote = decisions.filter((d) => d.kind === "delete-remote" && !d.renamedTo).map((d) => d.path);
		const total = delLocal.length + delRemote.length;
		const baseCount = Object.keys(state.base).length;
		const limit = Math.max(this.s.deleteGuardMin, Math.ceil((baseCount * this.s.deleteGuardPercent) / 100));
		if (this.s.deleteGuardEnabled && total > limit) {
			const choice = await host.confirmDeletes(delLocal, delRemote);
			if (choice === "cancel") throw new SyncCancelled("Sync cancelled by delete guard.");
			if (choice === "skip") {
				for (const d of decisions) {
					if ((d.kind === "delete-local" || d.kind === "delete-remote") && state.base[d.path]) next[d.path] = state.base[d.path];
				}
				decisions = decisions.filter((d) => d.kind !== "delete-local" && d.kind !== "delete-remote");
			}
		}

		// The user may keep editing while a sync runs. Before replacing or deleting a local file, check it
		// is still exactly what was scanned; otherwise leave it for the next sync (where it becomes a
		// normal conflict) instead of overwriting the new edit.
		const scanned: SyncState["cache"] = { ...cacheNext };
		let editedDuringSync = false;
		this.assertUnchanged = async (path: string) => {
			const st = await this.io.stat(path);
			const c = scanned[path];
			const changed = c ? !st || st.mtime !== c.m || st.size !== c.s : st !== null;
			if (changed) throw new EditedDuringSync(path);
		};

		const uploads: Upload[] = [];
		const remoteDeletes: string[] = [];
		const renames: string[] = [];
		const device = host.deviceName();

		const recordWrite = async (path: string, sha: string, data?: ArrayBuffer) => {
			const st = await this.io.stat(path);
			if (!st) return;
			const n = data ? await this.normHash(path, data, sha) : undefined;
			cacheNext[path] = n ? { m: st.mtime, s: st.size, h: sha, n } : { m: st.mtime, s: st.size, h: sha };
		};
		const queueUpload = async (path: string, data?: ArrayBuffer, sha?: string) => {
			const hash = sha ?? (await this.codec.storedSha(path, data ?? (await this.io.read(path))));
			uploads.push({ path, data, sha: hash, mode: remote.get(path)?.mode ?? "100644" });
		};
		const fail = (path: string, e: unknown) => {
			if (e instanceof EditedDuringSync) {
				editedDuringSync = true;
				report.skipped.push(`${path} (edited during sync, will sync next time)`);
				if (state.base[path]) next[path] = state.base[path];
				else delete next[path];
				return;
			}
			report.errors.push(`${path}: ${errMsg(e)}`);
			host.log(`Error on ${path}: ${errMsg(e)}`);
			if (state.base[path]) next[path] = state.base[path];
			else delete next[path];
		};

		// ---- apply simple decisions (parallel) ----
		const simple = decisions.filter((d) => d.kind !== "conflict");
		let done = 0;
		const downloads = simple.filter((d) => d.kind === "download" || d.kind === "adopt-remote-edit").length;
		await pool(simple, 4, async (d) => {
			try {
				switch (d.kind) {
					case "move-local": {
						await this.assertUnchanged(d.path);
						if (!(await this.io.stat(d.from))) {
							// The old file vanished meanwhile: fall back to a plain download.
							const data = await this.blob(d.path, d.sha);
							await this.io.write(d.path, data);
							await recordWrite(d.path, d.sha, data);
						} else {
							await this.assertUnchanged(d.from);
							await this.io.rename(d.from, d.path);
							const old = cacheNext[d.from];
							const st = await this.io.stat(d.path);
							if (st) cacheNext[d.path] = { m: st.mtime, s: st.size, h: d.upload ?? d.sha, ...(old?.n ? { n: old.n } : {}) };
						}
						delete cacheNext[d.from];
						delete next[d.from];
						next[d.path] = d.sha;
						if (d.upload) await queueUpload(d.path, undefined, d.upload);
						report.renamed.push(`${d.from} → ${d.path}`);
						break;
					}
					case "adopt-remote-edit": {
						const data = await this.blob(d.path, d.sha);
						await this.assertUnchanged(d.path);
						await this.io.write(d.path, data);
						await recordWrite(d.path, d.sha, data);
						await queueUpload(d.path, data, d.sha);
						remoteDeletes.push(d.from);
						renames.push(`${d.from} → ${d.path}`);
						report.renamed.push(`${d.from} → ${d.path} (with edits from ${this.host.gh.label})`);
						host.progress?.(`Downloading ${++done}/${downloads}`);
						break;
					}
					case "download": {
						const data = await this.blob(d.path, d.sha);
						await this.assertUnchanged(d.path);
						await this.io.write(d.path, data);
						await recordWrite(d.path, d.sha, data);
						next[d.path] = d.sha;
						report.downloaded.push(d.path);
						host.progress?.(`Downloading ${++done}/${downloads}`);
						break;
					}
					case "delete-local":
						await this.assertUnchanged(d.path);
						await this.io.remove(d.path);
						delete next[d.path];
						delete cacheNext[d.path];
						report.deletedLocal.push(d.path);
						break;
					case "upload":
						await queueUpload(d.path, undefined, d.sha);
						if (d.renamedFrom) {
							renames.push(`${d.renamedFrom} → ${d.path}`);
							report.renamed.push(`${d.renamedFrom} → ${d.path}`);
						}
						break;
					case "delete-remote":
						remoteDeletes.push(d.path);
						break;
				}
			} catch (e) {
				fail(d.path, e);
			}
		});

		// ---- conflicts (sequential, may prompt) ----
		for (const d of decisions) {
			if (d.kind !== "conflict") continue;
			try {
				await this.resolveConflict(d, mode, device, next, report, queueUpload, recordWrite);
			} catch (e) {
				fail(d.path, e);
			}
		}

		// ---- push one atomic commit ----
		// Content identical to GitHub (e.g. a merge that equals the remote) needs no upload.
		for (let i = uploads.length - 1; i >= 0; i--) {
			const u = uploads[i];
			if (remote.get(u.path)?.sha === u.sha) {
				next[u.path] = u.sha;
				uploads.splice(i, 1);
			}
		}
		let newHead = ctx.head;
		if (mode !== "pull" && (uploads.length || remoteDeletes.length) && ctx.head && ctx.treeSha) {
			const pushed = await this.push(ctx.head, ctx.treeSha, uploads, remoteDeletes, remote, device, renames);
			newHead = pushed.sha;
			// If the host merged us onto a newer head, our baseline is incomplete: compare fully next time.
			if (!pushed.fastForward) state.dirty = true;
			report.commit = newHead;
			const renamedTargets = new Set(renames.map((r) => r.split(" → ")[1]));
			const renamedSources = new Set(renames.map((r) => r.split(" → ")[0]));
			for (const u of uploads) {
				next[u.path] = u.sha;
				if (!report.merged.includes(u.path) && !report.conflictCopies.includes(u.path) && !renamedTargets.has(u.path)) report.uploaded.push(u.path);
			}
			for (const p of remoteDeletes) {
				delete next[p];
				if (!renamedSources.has(p)) report.deletedRemote.push(p);
			}
		}

		const baseNorm: Record<string, string> = {};
		for (const [p, sha] of Object.entries(next)) {
			const c = cacheNext[p];
			if (c?.n && (c.h === sha || ctx.eolSame.has(p))) baseNorm[p] = c.n;
			else if (state.baseNorm?.[p] && state.base[p] === sha) baseNorm[p] = state.baseNorm[p];
		}

		state.head = newHead;
		state.base = next;
		state.codecFingerprint = this.codec.fingerprint;
		state.baseNorm = baseNorm;
		state.cache = cacheNext;
		state.lastSync = Date.now();
		state.dirty = state.dirty || editedDuringSync || report.errors.length > 0;
		await host.saveState();
		host.markLocalChangesSynced?.(ctx.covered);
		return report;
	}

	private async resolveConflict(
		d: Extract<Decision, { kind: "conflict" }>,
		mode: SyncMode,
		device: string,
		next: Record<string, string>,
		report: SyncReport,
		queueUpload: (path: string, data?: ArrayBuffer, sha?: string) => Promise<void>,
		recordWrite: (path: string, sha: string, data?: ArrayBuffer) => Promise<void>,
	): Promise<void> {
		const host = this.host;
		await this.assertUnchanged(d.path);
		const localData = await this.io.read(d.path);
		const remoteData = await this.blob(d.path, d.remote);
		const localText = asText(d.path, localData);
		const remoteText = asText(d.path, remoteData);

		const writeRemote = async () => {
			await this.io.write(d.path, remoteData);
			await recordWrite(d.path, d.remote, remoteData);
			next[d.path] = d.remote;
		};
		const keepBoth = async (uploadCopy: boolean) => {
			const copy = conflictCopyPath(d.path, device);
			await this.io.write(copy, localData);
			await writeRemote();
			if (uploadCopy) await queueUpload(copy, localData);
			report.conflictCopies.push(copy);
			host.log(`Conflict on ${d.path}: kept both, your version saved as "${copy}".`);
		};

		if (mode === "pull") return keepBoth(false);

		// First sync with an existing vault on both sides: the setup wizard may say which side wins.
		// "The repository wins": the local version was never uploaded, so move it to the trash first.
		const replaceWithRemote = async () => {
			await this.assertUnchanged(d.path);
			await this.io.remove(d.path);
			await writeRemote();
		};
		if (!d.base && this.opts.firstSyncPrefer === "remote") return void (await replaceWithRemote());
		if (!d.base && this.opts.firstSyncPrefer === "local") return void (await queueUpload(d.path, localData));

		// Structure-aware merge first (canvas/JSON by key and id, Markdown frontmatter by key).
		if (d.base && localText !== null && remoteText !== null && this.s.conflictStrategy !== "local" && this.s.conflictStrategy !== "remote") {
			const b = asText(d.path, await this.blob(d.path, d.base));
			const smart = b === null ? null : smartMerge(d.path, b, localText, remoteText, { local: `this device (${device})`, remote: this.host.gh.label });
			if (smart?.clean) {
				const merged = encodeText(smart.text);
				const sha = await this.codec.storedSha(d.path, merged);
				await this.io.write(d.path, merged);
				await recordWrite(d.path, sha, merged);
				await queueUpload(d.path, merged, sha);
				report.merged.push(d.path);
				host.log(`Merged ${d.path} (${smart.kind}-aware merge).`);
				return;
			}
		}

		let strategy: string = this.s.conflictStrategy;
		if (strategy === "ask") {
			const choice = await host.askConflict({
				path: d.path,
				remoteLabel: host.gh.label,
				localText,
				remoteText,
				localSize: localData.byteLength,
				remoteSize: remoteData.byteLength,
			});
			if (typeof choice === "object") {
				// Hand-picked result from the per-change conflict view.
				const merged = encodeText(choice.custom);
				const sha = await this.codec.storedSha(d.path, merged);
				await this.io.write(d.path, merged);
				await recordWrite(d.path, sha, merged);
				await queueUpload(d.path, merged, sha);
				report.merged.push(d.path);
				host.log(`Conflict on ${d.path}: resolved change by change.`);
				return;
			}
			strategy = choice;
		}

		switch (strategy) {
			case "local":
				await queueUpload(d.path, localData);
				host.log(`Conflict on ${d.path}: kept this device's version.`);
				return;
			case "remote":
				await replaceWithRemote();
				host.log(`Conflict on ${d.path}: took the ${this.host.gh.label} version.`);
				return;
			case "keep-both":
				return keepBoth(true);
			case "auto":
			case "markers": {
				if (localText === null || remoteText === null) return keepBoth(true);
				if (!d.base && strategy === "auto") return keepBoth(true);
				let baseText = "";
				if (d.base) {
					const b = asText(d.path, await this.blob(d.path, d.base));
					if (b === null) return keepBoth(true);
					baseText = b;
				}
				const res = merge3(baseText, localText, remoteText, { local: `this device (${device})`, remote: this.host.gh.label });
				if (!res || (!res.clean && strategy === "auto")) return keepBoth(true);
				const merged = encodeText(res.text);
				await this.io.write(d.path, merged);
				await recordWrite(d.path, await this.codec.storedSha(d.path, merged), merged);
				await queueUpload(d.path, merged);
				report.merged.push(d.path);
				host.log(
					res.clean
						? `Merged changes from both sides in ${d.path}.`
						: `Merged ${d.path} with ${res.conflicts} conflict marker block(s). Search for "<<<<<<<".`,
				);
				return;
			}
		}
	}

	private async push(
		head: string,
		baseTree: string,
		uploads: Upload[],
		deletes: string[],
		remote: Map<string, RemoteEntry>,
		device: string,
		renames: string[] = [],
	): Promise<{ sha: string; fastForward: boolean }> {
		const codec = this.codec;
		const upserts: Upsert[] = [];
		for (const u of uploads) {
			upserts.push({
				path: remote.get(u.path)?.raw ?? (await codec.encodePath(u.path)),
				mode: u.mode,
				load: async () => {
					// Read late (bounded memory) and record the sha of exactly what was sent.
					const plain = u.data ?? (await this.io.read(u.path));
					u.data = undefined;
					const stored = await codec.encode(u.path, plain);
					u.sha = await gitBlobSha(stored);
					return stored;
				},
				// Inline text is byte-exact whenever the stored bytes are valid UTF-8 (asText checks).
				text: (b) => asText(u.path, b),
			});
		}
		if (this.markerToAdd) {
			const content = this.markerToAdd;
			upserts.push({ path: MARKER_PATH, mode: "100644", load: async () => encodeText(content), text: () => content });
		}
		const rawDeletes: string[] = [];
		for (const p of deletes) rawDeletes.push(remote.get(p)?.raw ?? (await codec.encodePath(p)));

		const res = await this.host.gh.commit({
			branch: this.s.branch,
			parent: head,
			parentTree: baseTree,
			message: this.commitMessage(uploads, deletes, device, renames),
			upserts,
			deletes: rawDeletes,
			existing: new Map([...remote.values()].map((e) => [e.raw, e.sha])),
			progress: (done, total) => this.host.progress?.(`Uploading ${done}/${total}`),
		});
		this.host.log(`Pushed commit ${res.sha.slice(0, 7)} (${uploads.length} changed, ${deletes.length} deleted).`);
		return res;
	}

	/**
	 * After switching an existing repository to encryption, the old unencrypted files are still there
	 * (sync ignores them). This deletes them in one commit. Their history keeps old copies.
	 */
	async removeUnencryptedFiles(confirm: (files: string[]) => Promise<boolean>): Promise<string[]> {
		this.loadCodec();
		if (!this.codec.has("enc:")) throw new Error("Encryption is not enabled on this device.");
		const gh = this.host.gh;
		const head = await gh.getRef(this.s.branch);
		if (!head) return [];
		const tree = await gh.getCommitTree(head);
		const foreign: string[] = [];
		for (const e of await gh.listTree(tree)) {
			if (e.type !== "blob" || e.path === MARKER_PATH || e.path === ".gitattributes") continue;
			if ((await this.codec.decodePath(e.path)) === null) foreign.push(e.path);
		}
		if (!foreign.length) return [];
		if (!(await confirm(foreign))) throw new SyncCancelled("Cancelled.");
		const device = this.host.deviceName();
		await gh.commit({
			branch: this.s.branch,
			parent: head,
			parentTree: tree,
			message: `${device}: remove ${foreign.length} unencrypted file(s)\n\nDevice: ${device}`,
			upserts: [],
			deletes: foreign,
		});
		this.host.log(`Removed ${foreign.length} unencrypted files from the repository.`);
		return foreign;
	}

	/**
	 * Remove local copies of files this device doesn't need (outside its device scope, or above its
	 * download limit) — only when the exact same content is safely on GitHub.
	 */
	async freeUpSpace(confirm: (plan: FreeSpacePlan) => Promise<boolean>): Promise<FreeSpacePlan> {
		const state = this.host.state;
		const shared = this.buildScope(false);
		const mine = this.buildScope(true);
		const max = (this.host.deviceScope?.().maxDownloadMB ?? 0) * 1024 * 1024;
		this.loadCodec();
		const head = await this.host.gh.getRef(this.s.branch);
		if (!head) throw new Error("The branch in the repository is empty.");
		const remote = new Map<string, string>();
		for (const [p, e] of await this.filesAt(head, shared)) remote.set(p, e.sha);

		const plan: FreeSpacePlan = { files: [], bytes: 0 };
		for (const f of this.io.listVault(shared)) {
			if (mine(f.path) && !(max && f.size > max)) continue;
			const r = remote.get(f.path);
			if (!r) continue;
			const c = state.cache[f.path];
			const h = c && c.m === f.mtime && c.s === f.size ? c.h : await this.codec.storedSha(f.path, await this.io.read(f.path));
			if (h !== r) continue; // not safely on GitHub: keep it
			plan.files.push(f.path);
			plan.bytes += f.size;
		}
		if (!plan.files.length) return plan;
		if (!(await confirm(plan))) throw new SyncCancelled("Cancelled.");
		for (const p of plan.files) {
			await this.io.remove(p);
			delete state.cache[p];
			// Forget the baseline too: a missing local file must never later read as "deleted here".
			delete state.base[p];
			delete state.baseNorm[p];
		}
		await this.host.saveState();
		this.host.log(`Freed ${(plan.bytes / 1048576).toFixed(1)} MB: removed ${plan.files.length} local copies that are safe in the repository.`);
		return plan;
	}

	/**
	 * Make this device match GitHub exactly. Files that would be overwritten or removed are moved
	 * to the trash first, so local-only work stays recoverable.
	 */
	async resetToRemote(confirm: (plan: ResetPlan) => Promise<boolean>): Promise<ResetPlan> {
		const state = this.host.state;
		this.loadCodec();
		const ctx = await this.gather(false, {}, true);
		const head = ctx.upToDate ? state.head : ctx.head;
		if (!head) throw new Error("The branch in the repository is empty. Nothing to reset to.");
		const remoteShas = ctx.upToDate ? new Map(ctx.localShas) : ctx.remoteShas;
		const plan: ResetPlan = { overwrite: [], download: [], remove: [] };
		for (const p of new Set([...ctx.localShas.keys(), ...remoteShas.keys()])) {
			const l = ctx.localShas.get(p);
			const r = remoteShas.get(p);
			if (r && l && l !== r) plan.overwrite.push(p);
			else if (r && !l) plan.download.push(p);
			else if (!r && l) plan.remove.push(p);
		}
		if (!plan.overwrite.length && !plan.download.length && !plan.remove.length) return plan;
		if (!(await confirm(plan))) throw new SyncCancelled("Reset cancelled.");

		const cacheNext = ctx.cacheNext;
		const write = async (p: string) => {
			const sha = remoteShas.get(p)!;
			const data = await this.blob(p, sha);
			await this.io.write(p, data);
			const st = await this.io.stat(p);
			const n = await this.normHash(p, data, sha);
			if (st) cacheNext[p] = n ? { m: st.mtime, s: st.size, h: sha, n } : { m: st.mtime, s: st.size, h: sha };
		};
		await pool(plan.overwrite, 4, async (p) => {
			await this.io.remove(p);
			await write(p);
		});
		await pool(plan.download, 4, write);
		for (const p of plan.remove) {
			await this.io.remove(p);
			delete cacheNext[p];
		}

		const base: Record<string, string> = {};
		for (const [p, sha] of remoteShas) base[p] = sha;
		for (const p of ctx.skipPaths) if (state.base[p]) base[p] = state.base[p];
		state.head = head;
		state.base = base;
		state.baseNorm = {};
		for (const [p, sha] of Object.entries(base)) if (cacheNext[p]?.h === sha && cacheNext[p].n) state.baseNorm[p] = cacheNext[p].n!;
		state.cache = cacheNext;
		state.lastSync = Date.now();
		state.dirty = false;
		await this.host.saveState();
		this.host.log(
			`Reset to ${this.host.gh.label}: ${plan.overwrite.length} replaced, ${plan.download.length} downloaded, ${plan.remove.length} removed (old versions in trash).`,
		);
		return plan;
	}

	/**
	 * Restore the whole vault, or one folder, to how it was at `commit`. Local changes are synced
	 * first, then the restore is pushed as a new commit on top (history is never rewritten), then
	 * pulled down to this device.
	 */
	async restoreTo(commit: string, folder: string, confirm: (plan: RestorePlan) => Promise<boolean>): Promise<RestorePlan> {
		this.loadCodec();
		if (this.s.mode === "pull") throw new Error("Restore needs to push to the repository, which pull-only mode does not allow.");
		await this.run(this.s.mode);
		const gh = this.host.gh;
		const head = await gh.getRef(this.s.branch);
		if (!head) throw new Error("The branch in the repository is empty.");
		// Restores act on GitHub for every device, so they use the shared scope, not this device's.
		const scope = this.buildScope(false);
		const prefix = folder.replace(/^\/+|\/+$/g, "");
		const inScope = (p: string) => scope(p) && (!prefix || p === prefix || p.startsWith(prefix + "/"));
		const headTree = await gh.getCommitTree(head);
		const cur = await this.filesAt(head, inScope);
		const tgt = await this.filesAt(commit, inScope);

		const plan: RestorePlan = { changed: [], added: [], removed: [] };
		const upserts: Upsert[] = [];
		const deletes: string[] = [];
		for (const [p, e] of tgt) {
			const c = cur.get(p);
			if (!c) plan.added.push(p);
			else if (c.sha !== e.sha) plan.changed.push(p);
			else continue;
			// Reuse the old blob as stored (still encrypted if the repo is): no decrypt/re-encrypt.
			upserts.push({ path: c?.raw ?? e.raw, mode: e.mode, sha: e.sha, load: () => gh.getBlob(e.sha) });
		}
		for (const [p, c] of cur) {
			if (tgt.has(p)) continue;
			plan.removed.push(p);
			deletes.push(c.raw);
		}
		if (!upserts.length && !deletes.length) return plan;
		if (!(await confirm(plan))) throw new SyncCancelled("Restore cancelled.");

		const what = prefix ? `"${prefix}"` : "vault";
		const message = `${this.host.deviceName()}: restore ${what} to ${commit.slice(0, 7)}\n\n${plan.changed.length} restored, ${plan.added.length} brought back, ${plan.removed.length} removed\n\nDevice: ${this.host.deviceName()}`;
		let newCommit: string;
		try {
			newCommit = (await gh.commit({ branch: this.s.branch, parent: head, parentTree: headTree, message, upserts, deletes })).sha;
		} catch (e) {
			if (e instanceof NotFastForward) throw new Error("Another device pushed during the restore. Nothing was changed; please try again.");
			throw e;
		}
		this.host.log(`Restored ${what} to ${commit.slice(0, 7)} as commit ${newCommit.slice(0, 7)}.`);
		await this.run("sync");
		return plan;
	}

	private commitMessage(uploads: Upload[], deletes: string[], device: string, renames: string[] = []): string {
		const parts: string[] = [];
		const targets = new Set(renames.map((r) => r.split(" → ")[1]));
		const sources = new Set(renames.map((r) => r.split(" → ")[0]));
		const added = uploads.filter((u) => !this.host.state.base[u.path] && !targets.has(u.path)).length;
		const changed = uploads.filter((u) => this.host.state.base[u.path]).length;
		const deleted = deletes.filter((p) => !sources.has(p)).length;
		if (added) parts.push(`${added} added`);
		if (changed) parts.push(`${changed} updated`);
		if (renames.length) parts.push(`${renames.length} renamed`);
		if (deleted) parts.push(`${deleted} deleted`);
		const files = [
			...renames,
			...uploads.map((u) => u.path).filter((p) => !targets.has(p)),
			...deletes.filter((p) => !sources.has(p)),
		].slice(0, 10);
		const summary = parts.join(", ") || "sync";
		const subject = this.s.commitTemplate
			.split("{{device}}").join(device)
			.split("{{summary}}").join(summary)
			.split("{{date}}").join(new Date().toISOString())
			.split("{{count}}").join(String(uploads.length + deletes.length));
		const total = renames.length + uploads.filter((u) => !targets.has(u.path)).length + deleted;
		const more = total - files.length;
		const list = `${files.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- …and ${more} more` : ""}`;
		return `${subject}\n\n${list}\n\nDevice: ${device}`;
	}
}
