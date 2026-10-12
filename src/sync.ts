// The sync engine: scan local, read remote tree, decide, apply, push one atomic commit.

import { arrayBufferToBase64 } from "obsidian";
import type { App } from "obsidian";
import { Codec, PLAIN } from "./codec.ts";
import { MARKER_PATH } from "./crypto.ts";
import { NotFastForward } from "./remote.ts";
import type { Remote, Upsert } from "./remote.ts";
import { compileGlobs } from "./glob.ts";
import { VaultIO } from "./io.ts";
import { lcsMatch, merge3, splitLines } from "./merge.ts";
import { decide, detectRenames, detectSimilarRenames } from "./plan.ts";
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
import { parsePointer } from "./lfs.ts";
import { configPatterns } from "./scope-config.ts";
import { t } from "./i18n.ts";

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
	/** True once Obsidian unloaded the plugin (disable, update, reload): a running sync stops at the next safe point. */
	isUnloaded?(): boolean;
	/** Lines of the vault's .gitignore (read by the host before each sync). */
	gitignorePatterns?(): string[];
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
	/** Files downloaded on demand: always synced on this device despite the size limit. */
	pinned?: string[];
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

/**
 * A hidden path that may sync: it must start at the top of the vault (only those are listed from disk;
 * a hidden file inside a normal folder would look deleted on the next sync), and must not be .git,
 * .trash or an Obsidian settings folder (this device's, or another one such as ".obsidian-mobile").
 */
function hiddenSyncable(p: string, cfg: string): boolean {
	if (!p.startsWith(".")) return false;
	const top = p.split("/")[0];
	if (top === ".git" || top === ".trash" || top === cfg || /^\.obsidian/i.test(top)) return false;
	return !p.split("/").includes(".git");
}
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
	/** Set after repeated "behind" answers: the branch really was moved back, so treat it like a rewrite. */
	private acceptRewind = false;
	private pinnedRemote: Remote | null = null;

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
		const data = await this.gh.getFileAt(await this.codec.encodePath(path), ref);
		return data ? this.codec.decode(path, data) : null;
	}

	/** Decoded file list of a commit: vault path → stored entry. */
	async filesAt(commit: string, scope = this.buildScope(false)): Promise<Map<string, RemoteEntry & { size: number }>> {
		this.loadCodec();
		const out = new Map<string, RemoteEntry & { size: number }>();
		for (const e of await this.gh.listTree(await this.gh.getCommitTree(commit))) {
			if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) continue;
			const p = await this.vaultPathOf(e.path);
			if (p === null || !safePath(p) || !scope(p)) continue;
			out.set(p, { sha: e.sha, mode: e.mode, raw: e.path, size: e.size ?? 0 });
		}
		return out;
	}

	private async blob(path: string, sha: string): Promise<ArrayBuffer> {
		return this.codec.decode(path, await this.verifiedBlob(sha, path));
	}

	/**
	 * Downloads a stored blob and checks it against its git object id, so a truncated or empty
	 * response (e.g. Gitea's blob size limit, a proxy cutting the body) is never written to the vault.
	 */
	/** A conflict-copy name that isn't taken yet (two conflicts in the same minute get "-2", "-3", …). */
	private async freeCopyPath(path: string, device: string): Promise<string> {
		const now = new Date();
		for (let n = 1; ; n++) {
			const p = conflictCopyPath(path, device, now, n);
			if (!(await this.io.stat(p))) return p;
		}
	}

	private async verifiedBlob(sha: string, path: string): Promise<ArrayBuffer> {
		const data = await this.gh.getBlob(sha);
		if (/^[0-9a-f]{40}$/i.test(sha) && (await gitBlobSha(data)) !== sha.toLowerCase()) {
			throw new Error(`${path} couldn't be downloaded completely from ${this.gh.label} (got ${data.byteLength} bytes). The server may limit the size of files it sends through its API.`);
		}
		return data;
	}

	/** Which paths this plugin manages. With `device` (default) the device-local scope applies too. */
	buildScope(device = true): (path: string) => boolean {
		this.loadCodec();
		const cfg = this.host.app.vault.configDir;
		const sub = (l: string) => l.split("{config}").join(cfg);
		const patterns = this.s.excludePatterns.split("\n").map(sub);
		const ds = device ? this.host.deviceScope?.() : undefined;
		const excluded = compileGlobs([
			// Settings-folder parts that stay on each device, then the vault's .gitignore, then the
			// user's own patterns: later patterns win, so the user always has the last word.
			...(this.s.syncConfigDir ? configPatterns(this.s.configSync).map(sub) : []),
			...(this.s.useGitignore ? (this.host.gitignorePatterns?.() ?? []) : []),
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
			if (p.startsWith(cfg + "/")) return this.s.syncConfigDir && !isHiddenPath(p.slice(cfg.length + 1));
			if (p === ".gitignore" && this.s.useGitignore) return true;
			return this.s.syncHidden && hiddenSyncable(p, cfg);
		};
	}

	/** Dry run: what would happen, without touching anything. */
	async preview(mode: SyncMode): Promise<Preview> {
		this.loadCodec();
		const ctx = await this.gather(false, {}, true);
		const plan = decide(ctx.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope);
		const decisions = await this.similarRenames(detectRenames(plan.decisions, ctx.base, ctx.localShas, ctx.remoteShas), ctx.base, ctx.localShas, ctx.remoteShas);
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
			if (!seen.has(p) && !p.startsWith(cfgPrefix) && !isHiddenPath(p) && scope(p)) out.push(p);
		}
		return out;
	}

	private scopeSignature(): string {
		const ds = this.host.deviceScope?.();
		return JSON.stringify([
			this.s.excludePatterns,
			this.s.syncConfigDir,
			this.s.syncConfigDir ? configPatterns(this.s.configSync) : [],
			this.s.syncHidden,
			this.s.useGitignore ? (this.host.gitignorePatterns?.() ?? []) : false,
			this.s.maxFileSizeMB,
			ds?.include ?? [],
			ds?.exclude ?? [],
			ds?.maxDownloadMB ?? 0,
			[...(ds?.pinned ?? [])].sort(),
			this.host.extraExcludes?.() ?? [],
		]);
	}

	/** Renamed-and-edited files: pair leftover delete + add decisions by content similarity. */
	private async similarRenames(decisions: Decision[], base: Record<string, string>, local: Map<string, string>, remote: Map<string, string>): Promise<Decision[]> {
		const texts = new Map<string, string | null>();
		const MAX = 512 * 1024;
		return detectSimilarRenames(decisions, base, local, remote, {
			text: async (side, path, sha) => {
				const key = `${side}:${path}:${sha}`;
				if (texts.has(key)) return texts.get(key)!;
				let data: ArrayBuffer | null = null;
				try {
					data = side === "local" ? await this.io.read(path) : await this.blob(path, sha);
				} catch {
					data = null;
				}
				const t = data && data.byteLength <= MAX ? asText(path, data) : null;
				texts.set(key, t);
				return t;
			},
			similarity: (a, b) => {
				const A = splitLines(a);
				const B = splitLines(b);
				if (!A.length && !B.length) return 1;
				const m = lcsMatch(A, B);
				if (!m) return 0;
				const matches = m.reduce((n, x) => n + (x >= 0 ? 1 : 0), 0);
				return (2 * matches) / (A.length + B.length);
			},
		});
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
		if (outer) {
			this.snap = { ...this.host.settings };
			// One client for the whole sync: a settings change mid-sync can't redirect it to another repository.
			this.pinnedRemote = this.host.gh;
		}
		try {
			return await this.runWithRetries(mode, opts);
		} finally {
			if (outer) {
				this.snap = null;
				this.pinnedRemote = null;
			}
		}
	}

	/** This device's download limit for `path` in bytes (0 = none; pinned files have none). */
	private downloadLimit(path: string): number {
		const ds = this.host.deviceScope?.();
		if (!ds?.maxDownloadMB || ds.pinned?.includes(path)) return 0;
		return ds.maxDownloadMB * 1024 * 1024;
	}

	private get gh(): Remote {
		return this.pinnedRemote ?? this.host.gh;
	}

	/** Stop at a safe point when the plugin was unloaded, so a reloaded copy never syncs alongside this one. */
	private checkAlive() {
		if (this.host.isUnloaded?.()) throw new SyncCancelled("The plugin was unloaded; sync stopped. It continues next time.");
	}

	private async runWithRetries(mode: SyncMode, opts: SyncOptions): Promise<SyncReport> {
		this.acceptRewind = false;
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
						this.host.log(`${this.gh.label} returned an older branch state. Waiting and retrying.`);
						await sleep(2000 * (attempt + 1));
						continue;
					}
					if (!this.acceptRewind) {
						// Still older after waiting: the branch was really moved back (e.g. "undo last commit"
						// with a force-push). Compare from scratch, like after a rewritten history; nothing is deleted.
						this.host.log(`The ${this.gh.label} branch was moved back to an earlier commit. Comparing from scratch; nothing will be deleted.`);
						this.acceptRewind = true;
						continue;
					}
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
		// Files Obsidian doesn't index (settings folder, hidden files) are found by walking the disk.
		const walksDisk = this.s.syncConfigDir || this.s.syncHidden || this.s.useGitignore;
		const configDue = walksDisk && (full || now - state.lastConfigScan > CONFIG_SCAN_MS);
		const cfgPrefix = this.host.app.vault.configDir + "/";
		const onDisk = (p: string) => p.startsWith(cfgPrefix) || isHiddenPath(p);

		this.host.progress?.(t("p.scanning"));
		// Stored forms changed (e.g. LFS turned on): cached hashes are stale, recompute them once.
		const cacheValid = (state.codecFingerprint ?? "") === this.codec.fingerprint;
		const files = this.io.listVault(baseScope);
		const walkConfig = walksDisk && (configDue || !cacheValid);
		if (walkConfig) {
			if (this.s.syncConfigDir) files.push(...(await this.io.listConfig(baseScope)));
			if (this.s.syncHidden || this.s.useGitignore) files.push(...(await this.io.listHidden(baseScope)));
		}
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
		if (walksDisk && !walkConfig) {
			for (const [p, c] of Object.entries(state.cache)) {
				if (!onDisk(p) || !baseScope(p) || localShas.has(p)) continue;
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
		this.host.progress?.(t("p.checking", { host: this.gh.label }));
		let head = await this.gh.getRef(this.s.branch);
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
			const rel = await this.gh.compare(state.head, head);
			if (rel === "behind" && !this.acceptRewind) throw new StaleRemote();
			if (rel === "behind" || rel === "diverged" || rel === "missing") {
				this.host.log("Remote history was rewritten (force-push?). Comparing from scratch; nothing will be deleted.");
				base = {};
			}
		}

		// Fast path: nothing changed anywhere since last sync.
		const baseInScope = Object.keys(state.base).filter(scope);
		const unchangedLocal = localShas.size === baseInScope.length && [...localShas].every(([p, h]) => state.base[p] === h);
		// Anything that changes what this device syncs (patterns, folders, limits, on-demand downloads)
		// must trigger a full comparison, even when nothing changed on either side.
		const scopeSig = this.scopeSignature();
		if (head && head === state.head && unchangedLocal && !state.dirty && state.scopeSig === scopeSig) {
			return { scope, skipPaths, skipped, localShas, cacheNext, head, treeSha: null, remote: null, remoteShas: localShas, upToDate: true, base, eolSame, covered, remoteOnly: state.remoteOnly ?? {}, scopeSig };
		}

		const remote = new Map<string, RemoteEntry>();
		const remoteShas = new Map<string, string>();
		const remoteOnly: SyncState["remoteOnly"] = {};
		let treeSha: string | null = null;
		let markerSha: string | null = null;
		if (head) {
			treeSha = await this.gh.getCommitTree(head);
			const dsc = this.host.deviceScope?.();
			const deviceMax = (dsc?.maxDownloadMB ?? 0) * 1024 * 1024;
			const pinned = new Set(dsc?.pinned ?? []);
			const fold = (p: string) => p.normalize("NFC").toLowerCase();
			const lowerLocal = new Map([...localShas.keys()].map((p) => [fold(p), p]));
			const seenLower = new Set<string>();
			for (const raw of await this.gh.listTree(treeSha)) {
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
				// Big and not on this device: leave it in the repository, unless this device had it at the
				// last sync (then it was deleted or renamed here, and that must reach the repository).
				const wasHere = !!state.base[e.path] && !state.remoteOnly?.[e.path];
				if (deviceMax && (e.size ?? 0) > deviceMax && !localShas.has(e.path) && !pinned.has(e.path) && !wasHere) {
					skip(e.path, "larger than this device's download limit; available on demand");
					remoteOnly[e.path] = { sha: e.sha, size: e.size ?? 0 };
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
		if (opts.only) {
			// "Sync current file": every other path keeps its baseline and is left for a later sync.
			for (const p of new Set([...localShas.keys(), ...remoteShas.keys(), ...Object.keys(base)])) if (!opts.only.has(p)) skipPaths.add(p);
		}
		for (const p of skipPaths) {
			localShas.delete(p);
			remoteShas.delete(p);
			remote.delete(p);
		}
		return { scope, skipPaths, skipped, localShas, cacheNext, head, treeSha, remote, remoteShas, upToDate: false, base, eolSame, covered, remoteOnly, scopeSig };
	}

	private async initRemote(): Promise<string> {
		const repo = await this.gh.getRepo();
		if (!repo) throw new Error(`Repository ${this.s.owner}/${this.s.repo} not found or the token cannot access it.`);
		const otherHead = repo.default_branch !== this.s.branch ? await this.gh.getRef(repo.default_branch) : null;
		if (otherHead) {
			await this.gh.createRef(`refs/heads/${this.s.branch}`, otherHead);
			this.host.log(`Created branch ${this.s.branch} from ${repo.default_branch}.`);
		} else {
			const content = "# Managed by Vault Sync for Git. Keeps git clients from rewriting line endings.\n* -text\n";
			await this.gh.putFile(".gitattributes", "Initialise vault repository", arrayBufferToBase64(encodeText(content)), this.s.branch);
			this.host.log("Initialised empty repository.");
		}
		const head = await this.gh.getRef(this.s.branch);
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
		this.checkAlive();
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
		let decisions = await this.similarRenames(detectRenames(plan.decisions, ctx.base, ctx.localShas, ctx.remoteShas), ctx.base, ctx.localShas, ctx.remoteShas);

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
		const simple = decisions.filter((d) => d.kind !== "conflict" && d.kind !== "rename-merge");
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
							if (d.replace) {
								// Renamed and edited remotely: after the rename, take the new content.
								const data = await this.blob(d.path, d.sha);
								await this.io.write(d.path, data);
								await recordWrite(d.path, d.sha, data);
							} else {
								const old = cacheNext[d.from];
								const st = await this.io.stat(d.path);
								if (st) cacheNext[d.path] = { m: st.mtime, s: st.size, h: d.upload ?? d.sha, ...(old?.n ? { n: old.n } : {}) };
							}
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
						report.renamed.push(`${d.from} → ${d.path} (with edits from ${this.gh.label})`);
						host.progress?.(t("p.downloading", { done: ++done, total: downloads }));
						break;
					}
					case "download": {
						const raw = await this.verifiedBlob(d.sha, d.path);
						// A large-file (LFS) pointer looks tiny in the listing; its real size decides.
						const ptr = parsePointer(raw);
						const limit = this.downloadLimit(d.path);
						if (ptr && limit && ptr.size > limit) {
							report.skipped.push(`${d.path} (larger than this device's download limit; available on demand)`);
							if (!(await this.io.stat(d.path))) ctx.remoteOnly[d.path] = { sha: d.sha, size: ptr.size };
							if (state.base[d.path]) next[d.path] = state.base[d.path];
							else delete next[d.path];
							break;
						}
						const data = await this.codec.decode(d.path, raw);
						await this.assertUnchanged(d.path);
						await this.io.write(d.path, data);
						await recordWrite(d.path, d.sha, data);
						next[d.path] = d.sha;
						report.downloaded.push(d.path);
						host.progress?.(t("p.downloading", { done: ++done, total: downloads }));
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
			if (d.kind !== "conflict" && d.kind !== "rename-merge") continue;
			try {
				if (d.kind === "conflict") await this.resolveConflict(d, mode, device, next, report, queueUpload, recordWrite);
				else await this.renameMerge(d, device, next, cacheNext, report, remoteDeletes, renames, queueUpload, recordWrite);
			} catch (e) {
				fail(d.path, e);
				if (d.kind === "rename-merge" && state.base[d.from]) next[d.from] = state.base[d.from];
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
			this.checkAlive();
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
		state.remoteOnly = ctx.remoteOnly;
		state.scopeSig = ctx.scopeSig;
		state.codecFingerprint = this.codec.fingerprint;
		state.baseNorm = baseNorm;
		state.cache = cacheNext;
		state.lastSync = Date.now();
		state.dirty = state.dirty || editedDuringSync || report.errors.length > 0;
		await host.saveState();
		host.markLocalChangesSynced?.(ctx.covered);
		return report;
	}

	/** One side renamed (and edited) a file that the other side edited: merge both under the new name. */
	private async renameMerge(
		d: Extract<Decision, { kind: "rename-merge" }>,
		device: string,
		next: Record<string, string>,
		cacheNext: SyncState["cache"],
		report: SyncReport,
		remoteDeletes: string[],
		renames: string[],
		queueUpload: (path: string, data?: ArrayBuffer, sha?: string) => Promise<void>,
		recordWrite: (path: string, sha: string, data?: ArrayBuffer) => Promise<void>,
	): Promise<void> {
		const localPath = d.side === "remote" ? d.from : d.path;
		await this.assertUnchanged(localPath);
		if (d.side === "remote") await this.assertUnchanged(d.path);
		const baseText = asText(d.from, await this.blob(d.from, d.base));
		const localData = await this.io.read(localPath);
		const remoteData = await this.blob(d.side === "remote" ? d.path : d.from, d.remote);
		const localText = asText(localPath, localData);
		const remoteText = asText(d.path, remoteData);
		const res = baseText !== null && localText !== null && remoteText !== null ? merge3(baseText, localText, remoteText, { local: `this device (${device})`, remote: this.gh.label }) : null;

		if (res?.clean) {
			const merged = encodeText(res.text);
			const sha = await this.codec.storedSha(d.path, merged);
			if (d.side === "remote") {
				await this.io.remove(d.from);
				delete cacheNext[d.from];
			}
			await this.assertUnchanged(d.path);
			await this.io.write(d.path, merged);
			await recordWrite(d.path, sha, merged);
			await queueUpload(d.path, merged, sha);
			report.merged.push(d.path);
		} else {
			// Overlapping edits: keep this device's version under the new name and the other side's as a copy.
			const copy = await this.freeCopyPath(d.path, d.side === "remote" ? device : this.gh.label);
			const keep = d.side === "remote" ? remoteData : localData;
			const other = d.side === "remote" ? localData : remoteData;
			if (d.side === "remote") {
				await this.io.remove(d.from);
				delete cacheNext[d.from];
			}
			await this.io.write(d.path, keep);
			await recordWrite(d.path, await this.codec.storedSha(d.path, keep), keep);
			await queueUpload(d.path, keep);
			await this.io.write(copy, other);
			await queueUpload(copy, other);
			report.conflictCopies.push(copy);
		}
		delete next[d.from];
		if (d.side === "local") remoteDeletes.push(d.from);
		renames.push(`${d.from} → ${d.path}`);
		report.renamed.push(`${d.from} → ${d.path} (renamed and edited on both sides, merged)`);
		this.host.log(`${d.from} was renamed to ${d.path} while also edited elsewhere: ${res?.clean ? "merged both edits" : "kept both versions"}.`);
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
			await this.assertUnchanged(d.path);
			const copy = await this.freeCopyPath(d.path, device);
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
			const smart = b === null ? null : smartMerge(d.path, b, localText, remoteText, { local: `this device (${device})`, remote: this.gh.label });
			if (smart?.clean) {
				const merged = encodeText(smart.text);
				const sha = await this.codec.storedSha(d.path, merged);
				await this.assertUnchanged(d.path);
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
				remoteLabel: this.gh.label,
				localText,
				remoteText,
				localSize: localData.byteLength,
				remoteSize: remoteData.byteLength,
			});
			if (typeof choice === "object") {
				// Hand-picked result from the per-change conflict view.
				const merged = encodeText(choice.custom);
				const sha = await this.codec.storedSha(d.path, merged);
				await this.assertUnchanged(d.path);
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
				host.log(`Conflict on ${d.path}: took the ${this.gh.label} version.`);
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
				const res = merge3(baseText, localText, remoteText, { local: `this device (${device})`, remote: this.gh.label });
				if (!res || (!res.clean && strategy === "auto")) return keepBoth(true);
				const merged = encodeText(res.text);
				await this.assertUnchanged(d.path);
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

		const res = await this.gh.commit({
			branch: this.s.branch,
			parent: head,
			parentTree: baseTree,
			message: this.commitMessage(uploads, deletes, device, renames),
			upserts,
			deletes: rawDeletes,
			existing: new Map([...remote.values()].map((e) => [e.raw, e.sha])),
			progress: (done, total) => this.host.progress?.(t("p.uploading", { done, total })),
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
		const gh = this.gh;
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
		const pinned = new Set(this.host.deviceScope?.().pinned ?? []);
		this.loadCodec();
		const head = await this.gh.getRef(this.s.branch);
		if (!head) throw new Error("The branch in the repository is empty.");
		const remote = new Map<string, string>();
		for (const [p, e] of await this.filesAt(head, shared)) remote.set(p, e.sha);

		const plan: FreeSpacePlan = { files: [], bytes: 0 };
		for (const f of this.io.listVault(shared)) {
			if (mine(f.path) && !(max && f.size > max && !pinned.has(f.path))) continue;
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
			`Reset to ${this.gh.label}: ${plan.overwrite.length} replaced, ${plan.download.length} downloaded, ${plan.remove.length} removed (old versions in trash).`,
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
		const gh = this.gh;
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
			upserts.push({ path: c?.raw ?? e.raw, mode: e.mode, sha: e.sha, load: () => this.verifiedBlob(e.sha, p) });
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
