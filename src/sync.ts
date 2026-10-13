// The sync engine: scan local, read remote tree, decide, apply, push one atomic commit.

import { arrayBufferToBase64 } from "obsidian";
import type { App } from "obsidian";
import { Codec, PLAIN } from "./codec.ts";
import { MARKER_PATH } from "./crypto.ts";

/** Repository file listing the vault's empty folders (git can't store empty folders). */
export const FOLDERS_PATH = ".vault-sync/folders.json";
import { NotFastForward } from "./remote.ts";
import type { BlobHint, Remote, TreeEntry, Upsert } from "./remote.ts";
import { compileGlobs } from "./glob.ts";
import { VaultIO } from "./io.ts";
import { merge3 } from "./merge.ts";
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
import { asText, conflictCopyPath, encodeText, errMsg, gitBlobSha, isHiddenPath, pool, portableNameProblem, sleep } from "./util.ts";
import { parsePointer } from "./lfs.ts";
import { configPatterns } from "./scope-config.ts";
import { t } from "./i18n.ts";
import { addSkip, localizeError, SyncError } from "./errors.ts";
import type { ErrCode, ErrParams, SkipCode, SkipNote, SkipSink } from "./errors.ts";

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
	/** True on Windows: remote names Windows can't store are skipped instead of failing. */
	windows?: boolean;
	/** On a conflict, push this device's version to a branch and open a pull request (instead of a copy). */
	conflictsAsPullRequest?(): boolean;
	/** This plugin's version, written into commit trailers. */
	pluginVersion?: string;
	/**
	 * True for a backup mirror: in push mode its copy simply follows this device, and edits made in the
	 * mirror repository are never brought into the vault as conflict copies.
	 */
	backupMirror?: boolean;
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

/** "Make the repository match this device": uploads and deletions in one forward commit. */
export interface OverwritePlan {
	upload: string[];
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
	/** Skipped paths with the reason, in English (log form). */
	skipped: string[];
	/** The same entries, translatable (see skippedLines). */
	skipNotes?: SkipNote[];
	errors: string[];
	commit: string | null;
	/** Pull/merge requests opened for conflicts (shared folders set to "pull request"). */
	pullRequests?: string[];
	/** Deletions the user chose to skip at the delete guard (the mirror must not apply them either). */
	guardKept?: string[];
}

export interface Preview {
	decisions: Decision[];
	skipped: string[];
	skipNotes?: SkipNote[];
	localShas: Map<string, string>;
	remoteShas: Map<string, string>;
	base: Record<string, string>;
}

/** The sync stopped on purpose (cancelled, or the plugin unloaded). Not shown as a failure. */
export class SyncCancelled extends SyncError {
	constructor(code: ErrCode = "cancelled", params: ErrParams = {}) {
		super(code, params);
	}
}

/**
 * A hidden path that may sync: it must start at the top of the vault (only those are listed from disk;
 * a hidden file inside a normal folder would look deleted on the next sync), and must not be .git,
 * .trash or an Obsidian settings folder (this device's, or another one such as ".obsidian-mobile").
 */
function hiddenSyncable(p: string, cfg: string, nested = false): boolean {
	if (!p.startsWith(".") && !nested) return false;
	// Never Git internals, trash, this plugin's metadata or a vault settings folder, at any depth
	// (nested vaults keep plugin settings with API keys there).
	return !p.split("/").some((seg) => seg === ".git" || seg === ".trash" || seg === ".vault-sync" || seg === cfg || /^\.obsidian/i.test(seg));
}
class StaleRemote extends Error {}
class EditedDuringSync extends SyncError {
	constructor(path: string) {
		super("editedDuringSync", { path });
	}
}

interface RemoteEntry {
	sha: string;
	mode: string;
	/** Path in the repository (differs from the vault path when a codec maps paths). */
	raw: string;
	/** Stored size from the listing (for an LFS file: the pointer's size). */
	size?: number;
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
	/** Conflicts waiting to be sent as a pull request at the end of this run. */
	private prConflicts: { path: string; local: ArrayBuffer; remote: ArrayBuffer; remoteSha: string }[] = [];
	/** Repository metadata files (not vault files) and their blob shas at the head last listed. */
	private metaShas = new Map<string, string>();
	/** The codec a running sync uses: toggling encryption mid-sync must not switch it under that sync. */
	private pinnedCodec: Codec | null = null;

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
		this.codec = this.pinnedCodec ?? this.host.codec?.() ?? PLAIN;
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

	/** Repository path and commit of each remote blob seen in the last listing (sha → hint). */
	private blobHints = new Map<string, BlobHint>();

	private async verifiedBlob(sha: string, path: string): Promise<ArrayBuffer> {
		const data = await this.gh.getBlob(sha, this.blobHints.get(sha));
		if (/^[0-9a-f]{40}$/i.test(sha) && (await gitBlobSha(data)) !== sha.toLowerCase()) {
			throw new SyncError("incompleteDownload", { path, host: this.gh.label, bytes: data.byteLength });
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
			// Side files of an open SQLite database: syncing them mid-write corrupts the database elsewhere.
			"*-wal",
			"*-shm",
			"*-journal",
			this.host.stateFilePath,
			// Every engine's state files live in the plugin folder.
			this.host.stateFilePath.replace(/[^/]+$/, "sync-state*"),
		]);
		const includes = (ds?.include ?? []).map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
		// A codec that maps a folder (shared folders) only ever handles paths inside that folder.
		const prefix = (this.codec.layers.find((l) => "folderPrefix" in l) as { folderPrefix?: string } | undefined)?.folderPrefix;
		const included = includes.length ? compileGlobs(includes.map(sub)) : null;
		return (p: string) => {
			if (excluded(p)) return false;
			if (prefix && !p.startsWith(prefix)) return false;
			if (included && !included(p) && !p.startsWith(cfg + "/")) return false;
			if (!isHiddenPath(p)) return true;
			if (p.startsWith(cfg + "/")) return this.s.syncConfigDir && !isHiddenPath(p.slice(cfg.length + 1));
			// .gitignore files (the vault's and its subfolders') sync when .gitignore support is on.
			if ((p === ".gitignore" || p.endsWith("/.gitignore")) && this.s.useGitignore && hiddenSyncable(p, cfg, true)) return true;
			return this.s.syncHidden && hiddenSyncable(p, cfg, this.s.syncHiddenNested);
		};
	}

	/** Dry run: what would happen, without touching anything. */
	async preview(mode: SyncMode): Promise<Preview> {
		this.loadCodec();
		const ctx = await this.gather(false, {}, true, { mode });
		for (const [from, to] of ctx.caseRenames) this.rekey(ctx, from, to);
		const plan = decide(ctx.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope, { pushKeepsRemote: !this.host.backupMirror });
		let decisions = await this.similarRenames(detectRenames(plan.decisions, ctx.base, ctx.localShas, ctx.remoteShas), ctx.base, ctx.localShas, ctx.remoteShas, { cache: ctx.cacheNext, remote: ctx.remote });
		decisions = await this.keepMovedOutOfScope(decisions, ctx.base, ctx, () => {});
		return { decisions, skipped: ctx.skipped, skipNotes: ctx.skipNotes, localShas: ctx.localShas, remoteShas: ctx.remoteShas, base: ctx.base };
	}

	/** A local file now known under another name (case-only rename): move its baseline and local hash along. */
	private rekey(ctx: { base: Record<string, string>; localShas: Map<string, string>; eolSame: Set<string> }, from: string, to: string) {
		const base = { ...ctx.base };
		if (base[from]) {
			base[to] = base[from];
			delete base[from];
		}
		ctx.base = base;
		const l = ctx.localShas.get(from);
		if (l) {
			ctx.localShas.delete(from);
			ctx.localShas.set(to, l);
		}
		if (ctx.eolSame.delete(from)) ctx.eolSame.add(to);
	}

	/**
	 * A file moved out of this device's scope (device include/exclude patterns) looks deleted here, but it
	 * still exists: keep it in the repository instead of deleting it for every device. Only runs when
	 * there are deletions to check; candidates are found by size first, then confirmed by content.
	 */
	private async keepMovedOutOfScope(decisions: Decision[], base: Record<string, string>, skipped: SkipSink, keep: (path: string) => void): Promise<Decision[]> {
		const cands = decisions.filter((d) => d.kind === "delete-remote" && !d.renamedTo && base[d.path]);
		const ds = this.host.deviceScope?.();
		const narrowed = !!ds && (ds.include.some((x) => x.trim() && !x.trim().startsWith("#")) || ds.exclude.length > 0);
		if (!cands.length || !narrowed) return decisions;
		const kept = new Set<string>();
		// Already found on an earlier sync (same content as then): keep it without rescanning.
		const known = this.host.state.keptMoved ?? {};
		for (const d of cands) {
			if (known[d.path] && known[d.path] === base[d.path]) {
				kept.add(d.path);
				keep(d.path);
			}
		}
		const rest = cands.filter((d) => !kept.has(d.path));
		const shared = this.buildScope(false);
		const mine = this.buildScope(true);
		const bySize = new Map<number, string[]>();
		if (rest.length) for (const f of this.io.listVault((p) => shared(p) && !mine(p))) if (f.size > 0) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f.path]);
		for (const d of rest) {
			// The size from the last sync that saw the file (empty files never count as a match).
			const size = this.host.state.cache[d.path]?.s;
			if (!size) continue;
			for (const p of bySize.get(size) ?? []) {
				let same = false;
				try {
					same = (await this.codec.storedSha(d.path, await this.io.read(p))) === base[d.path];
				} catch {
					same = false;
				}
				if (!same) continue;
				kept.add(d.path);
				keep(d.path);
				addSkip(skipped, d.path, "movedOutOfScope", { to: p });
				break;
			}
		}
		return kept.size ? decisions.filter((d) => !(d.kind === "delete-remote" && kept.has(d.path))) : decisions;
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
			// A file whose only change is CRLF <-> LF syncs as unchanged, so it isn't pending either.
			const eolOnly = this.s.ignoreLineEndingChanges && !!c?.n && state.baseNorm?.[f.path] === c.n;
			if (!c || c.m !== f.mtime || c.s !== f.size || (state.base[f.path] !== c.h && !eolOnly)) out.push(f.path);
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
			this.s.syncHiddenNested,
			this.s.useGitignore ? (this.host.gitignorePatterns?.() ?? []) : false,
			this.s.maxFileSizeMB,
			ds?.include ?? [],
			ds?.exclude ?? [],
			ds?.maxDownloadMB ?? 0,
			[...(ds?.pinned ?? [])].sort(),
			this.host.extraExcludes?.() ?? [],
		]);
	}

	/**
	 * Renamed-and-edited files: pair leftover delete + add decisions by content similarity. Only text
	 * files are read, and only when their known size (local scan, remote listing) is small: a deleted
	 * video next to a new note must never download the video.
	 */
	private async similarRenames(
		decisions: Decision[],
		base: Record<string, string>,
		local: Map<string, string>,
		remote: Map<string, string>,
		sizes: { cache: SyncState["cache"]; remote: Map<string, RemoteEntry> | null },
	): Promise<Decision[]> {
		const texts = new Map<string, string | null>();
		const MAX = 2 * 1024 * 1024;
		// asText answers null for an empty buffer only when the extension isn't a text type.
		const textType = (p: string) => asText(p, new ArrayBuffer(0)) !== null;
		const known = (path: string) => {
			const all = [sizes.cache[path]?.s, sizes.remote?.get(path)?.size, this.host.state.cache[path]?.s].filter((x): x is number => typeof x === "number");
			return all.length ? Math.max(...all) : undefined;
		};
		return detectSimilarRenames(decisions, base, local, remote, {
			// A few other notes in the same folder on this device (small text files only), to tell template
			// lines from real content. Only read when a delete + add pair already looks similar.
			siblings: async (path, exclude) => {
				const slash = path.lastIndexOf("/");
				const dir = slash < 0 ? "" : path.slice(0, slash + 1);
				const dot = path.lastIndexOf(".");
				const ext = dot > slash ? path.slice(dot).toLowerCase() : "";
				const near = [...local.keys()]
					.filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes("/") && !exclude.has(p) && (p.lastIndexOf(".") > p.lastIndexOf("/") ? p.slice(p.lastIndexOf(".")).toLowerCase() : "") === ext)
					.filter((p) => (known(p) ?? Infinity) <= 256 * 1024)
					.sort()
					.slice(-6);
				const out: string[] = [];
				for (const p of near) {
					try {
						const t = asText(p, await this.io.read(p));
						if (t !== null) out.push(t);
					} catch {
						/* unreadable: just one sibling fewer */
					}
				}
				return out;
			},
			text: async (side, path, sha) => {
				const key = `${side}:${path}:${sha}`;
				if (texts.has(key)) return texts.get(key)!;
				let t: string | null = null;
				const size = known(path);
				if (textType(path) && !(size !== undefined && size > MAX)) {
					try {
						let data: ArrayBuffer | null;
						if (side === "local") data = await this.io.read(path);
						else {
							const raw = await this.verifiedBlob(sha, path);
							// A large-file (LFS) pointer is tiny; the file behind it may not be.
							const ptr = parsePointer(raw);
							data = ptr && ptr.size > MAX ? null : await this.codec.decode(path, raw);
						}
						t = data && data.byteLength <= MAX ? asText(path, data) : null;
					} catch {
						t = null;
					}
				}
				texts.set(key, t);
				return t;
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
			this.pinnedCodec = this.host.codec?.() ?? PLAIN;
		}
		try {
			return await this.runWithRetries(mode, opts);
		} finally {
			if (outer) {
				this.snap = null;
				this.pinnedRemote = null;
				this.pinnedCodec = null;
			}
		}
	}

	/** This device's download limit for `path` in bytes (0 = none; pinned files have none). */
	private downloadLimit(path: string): number {
		const ds = this.host.deviceScope?.();
		if (!ds?.maxDownloadMB || ds.pinned?.includes(path)) return 0;
		return ds.maxDownloadMB * 1024 * 1024;
	}

	/**
	 * Keeps empty folders across devices with a three-way comparison of folder lists (last sync, this
	 * device, the repository). Off with encryption or a folder mapping (names would leak / not map).
	 * Returns the new list to upload, if it changed, and records the new baseline.
	 */
	private async syncEmptyFolders(mode: SyncMode, foldersSha: string | null | undefined, scope: (p: string) => boolean): Promise<{ upload: string | null; base: string[] } | null> {
		if (!this.s.keepEmptyFolders || this.codec.transformsPaths || this.opts.only || this.opts.defer?.size) return null;
		const state = this.host.state;
		let remote: string[] = [];
		if (foldersSha) {
			try {
				const parsed = JSON.parse(new TextDecoder().decode(await this.verifiedBlob(foldersSha, FOLDERS_PATH))) as unknown;
				if (Array.isArray(parsed)) remote = parsed.filter((x): x is string => typeof x === "string" && safePath(x));
			} catch {
				remote = [];
			}
		}
		// Entries outside this device's scope (another device's folders) are kept as they are.
		const base = new Set((state.baseFolders ?? []).filter(scope));
		const local = new Set(this.io.listEmptyFolders(scope));
		const R = new Set(remote.filter(scope));
		const next = new Set(remote);
		if (mode !== "pull") {
			for (const f of local) if (!base.has(f)) next.add(f); // made empty here
			for (const f of base) {
				// Deleted here, or no longer empty here (its files sync on their own): drop it from the list.
				if (!local.has(f) && R.has(f)) next.delete(f);
			}
		}
		if (mode !== "push") {
			for (const f of R) {
				if (base.has(f) || local.has(f)) continue;
				// A name this device can't create (Windows) is skipped; it stays in the list for the others.
				if (this.host.windows && portableNameProblem(f)) continue;
				try {
					await this.io.makeFolder(f);
				} catch (e) {
					this.host.log(`Couldn't create empty folder ${f}: ${errMsg(e)}`);
				}
			}
			for (const f of base) {
				if (R.has(f) || !local.has(f)) continue;
				try {
					await this.io.removeEmptyFolder(f);
				} catch (e) {
					this.host.log(`Couldn't remove empty folder ${f}: ${errMsg(e)}`);
				}
			}
		}
		const sorted = (x: Iterable<string>) => [...x].sort();
		const nextList = sorted(next);
		const changed = JSON.stringify(nextList) !== JSON.stringify(sorted(remote));
		// The new baseline is only stored together with the rest of the state, after the push succeeded.
		// The baseline is what this device actually has in common with the list. In push mode, folders that
		// exist only in the repository were never created here, so they stay out (else they'd look deleted).
		const newBase = mode === "pull" ? sorted(R) : mode === "push" ? nextList.filter((f) => local.has(f) || base.has(f)) : nextList;
		// Names this device skips (Windows) never exist here, so they stay out of its baseline too.
		const here = (f: string) => scope(f) && !(this.host.windows && portableNameProblem(f));
		return { upload: mode !== "pull" && changed ? JSON.stringify(nextList, null, 1) + "\n" : null, base: newBase.filter(here) };
	}

	/**
	 * Pushes this device's side of each conflict to a new branch and opens a pull request; only then is
	 * the note replaced by the repository's version (the edits live on the branch). If anything fails,
	 * falls back to a conflict copy, so nothing is ever lost.
	 */
	private async sendConflictsAsPullRequest(
		head: string,
		remote: Map<string, RemoteEntry>,
		device: string,
		next: Record<string, string>,
		report: SyncReport,
		recordWrite: (path: string, sha: string, data?: ArrayBuffer) => Promise<void>,
	): Promise<void> {
		const items = this.prConflicts;
		this.prConflicts = [];
		const gh = this.gh;
		const d = new Date();
		const p2 = (n: number) => String(n).padStart(2, "0");
		const slug = device.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "device";
		const branch = `vault-sync/conflict-${slug}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
		let prUrl: string | null = null;
		try {
			await gh.createRef(`refs/heads/${branch}`, head);
			const tree = await gh.getCommitTree(head);
			const upserts: Upsert[] = [];
			for (const c of items) {
				const raw = remote.get(c.path)?.raw ?? (await this.codec.encodePath(c.path));
				upserts.push({ path: raw, mode: remote.get(c.path)?.mode ?? "100644", load: () => this.codec.encode(c.path, c.local) });
			}
			const list = items.map((c) => `- ${c.path}`).join("\n");
			await gh.commit({ author: this.author(), branch, parent: head, parentTree: tree, message: `${device}: conflicting edits (${items.length})\n\n${list}\n\n${this.trailer(device)}`, upserts, deletes: [] });
			prUrl = (await gh.createPullRequest!(branch, this.s.branch, `Conflicting edits from ${device}`, `${device} and another device changed the same lines. This branch holds ${device}'s version; review and merge what you need.\n\n${list}`)).url;
		} catch (e) {
			this.host.log(`Pull request for conflicts failed (${errMsg(e)}); keeping both versions as copies instead.`);
		}
		for (const c of items) {
			try {
				await this.assertUnchanged(c.path);
				if (!prUrl) {
					// Fallback: the classic conflict copy (uploaded on the next sync).
					const copy = await this.freeCopyPath(c.path, device);
					await this.io.write(copy, c.local);
					report.conflictCopies.push(copy);
				}
				await this.io.write(c.path, c.remote);
				await recordWrite(c.path, c.remoteSha, c.remote);
				next[c.path] = c.remoteSha;
			} catch (e) {
				addSkip(report, c.path, "conflictKept", { error: localizeError(e, this.gh.label) }, { error: errMsg(e) });
			}
		}
		if (prUrl) {
			(report.pullRequests ??= []).push(prUrl);
			this.host.log(`Conflicts sent as a pull request: ${prUrl}`);
		}
	}

	/** Commit trailer: the device, and this plugin's version (the status panel warns about mixed versions). */
	private trailer(device: string): string {
		return `Device: ${device}` + (this.host.pluginVersion ? `\nPlugin: ${this.host.pluginVersion}` : "");
	}
	/** Commit author from settings, when both name and email are set. */
	private author(): { name: string; email: string } | undefined {
		const name = (this.s.authorName ?? "").trim();
		const email = (this.s.authorEmail ?? "").trim();
		return name && email ? { name, email } : undefined;
	}

	private get gh(): Remote {
		return this.pinnedRemote ?? this.host.gh;
	}

	/** Stop at a safe point when the plugin was unloaded, so a reloaded copy never syncs alongside this one. */
	private checkAlive() {
		if (this.host.isUnloaded?.()) throw new SyncCancelled("unloaded");
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

	private async gather(initIfEmpty: boolean, opts: SyncOptions = {}, readOnly = false, how: { mode?: SyncMode; noFastPath?: boolean } = {}) {
		const state = this.host.state;
		if (state.repoKey !== this.repoKey) {
			this.host.log(`Repository changed to ${this.repoKey}. Starting from a fresh baseline (no deletions).`);
			Object.assign(state, emptyState(this.repoKey));
		}
		const baseScope = this.buildScope();
		const maxBytes = this.s.maxFileSizeMB * 1024 * 1024;
		const skipped: string[] = [];
		const skipNotes: SkipNote[] = [];
		const sink: SkipSink = { skipped, skipNotes };
		const skipPaths = new Set<string>();
		const skip = (path: string, why: SkipCode, params: ErrParams = {}) => {
			addSkip(sink, path, why, params);
			skipPaths.add(path);
		};
		const scope = (p: string) => baseScope(p) && !skipPaths.has(p);
		for (const p of opts.defer ?? []) skip(p, "deferred");

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
			// Inside normal folders: everything hidden (opt-in), or just .gitignore files. The folder walk
			// behind it is shared with the .gitignore loader and only repeated when folders changed, on a
			// full scan, or every 30 minutes.
			if (this.s.syncHidden && this.s.syncHiddenNested) files.push(...(await this.io.listNestedHidden(baseScope, undefined, { full })));
			else if (this.s.useGitignore) files.push(...(await this.io.listNestedHidden(baseScope, new Set([".gitignore"]), { full })));
		}
		const localShas = new Map<string, string>();
		const cacheNext: SyncState["cache"] = {};
		let unknownLocal = false;
		let hashed = 0;
		for (const f of files) {
			if (f.size > maxBytes) {
				skip(f.path, "localTooLarge", { mb: this.s.maxFileSizeMB });
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
				if (c.s > maxBytes) skip(p, "localTooLarge", { mb: this.s.maxFileSizeMB });
				else {
					cacheNext[p] = c;
					localShas.set(p, c.h);
				}
			}
			// A synced settings-folder/hidden file the reused cache doesn't know (e.g. a conflict copy written
			// by an older version) is unknown until the next disk walk, not deleted: keep its baseline.
			for (const p of Object.keys(state.base)) {
				if (onDisk(p) && baseScope(p) && !localShas.has(p) && !skipPaths.has(p) && !state.cache[p]) {
					skipPaths.add(p);
					unknownLocal = true;
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
			throw new SyncError("branchMissing", { branch: this.s.branch, repo: `${this.s.owner}/${this.s.repo}` });
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
		const baseInScope = Object.keys(state.base).filter((p) => scope(p) && !state.keptMoved?.[p]);
		const unchangedLocal = localShas.size === baseInScope.length && [...localShas].every(([p, h]) => state.base[p] === h);
		// Anything that changes what this device syncs (patterns, folders, limits, on-demand downloads)
		// must trigger a full comparison, even when nothing changed on either side.
		const scopeSig = this.scopeSignature();
		// A folder emptied or created here is a change too (its list lives in the repository).
		const foldersSame =
			!this.s.keepEmptyFolders || this.codec.transformsPaths || how.mode === "pull" || this.s.mode === "pull" ||
			JSON.stringify(this.io.listEmptyFolders(scope).sort()) === JSON.stringify([...(state.baseFolders ?? [])].filter(scope).sort());
		if (!how.noFastPath && head && head === state.head && unchangedLocal && foldersSame && !state.dirty && state.scopeSig === scopeSig) {
			return { scope, skipPaths, skipped, skipNotes, localShas, cacheNext, head, treeSha: null, remote: null, remoteShas: localShas, upToDate: true, base, eolSame, covered, remoteOnly: state.remoteOnly ?? {}, scopeSig, unknownLocal, caseRenames: [] as [string, string][] };
		}

		const remote = new Map<string, RemoteEntry>();
		const remoteShas = new Map<string, string>();
		const remoteOnly: SyncState["remoteOnly"] = {};
		let treeSha: string | null = null;
		let markerSha: string | null = null;
		let foldersSha: string | null = null;
		const winSkipped = new Set<string>();
		// Folder + extension of each skipped name: a note renamed (and edited) into it shares both.
		const winSkippedSpots = new Set<string>();
		const winBad: string[] = [];
		const spot = (p: string) => `${p.slice(0, Math.max(0, p.lastIndexOf("/")))}|${/\.[^./]*$/.exec(p)?.[0] ?? ""}`;
		this.metaShas = new Map();
		this.blobHints = new Map();
		// Local files renamed on another device by letter case only: [local path, new remote path].
		const caseRenames: [string, string][] = [];
		if (head) {
			treeSha = await this.gh.getCommitTree(head);
			const dsc = this.host.deviceScope?.();
			const deviceMax = (dsc?.maxDownloadMB ?? 0) * 1024 * 1024;
			const pinned = new Set(dsc?.pinned ?? []);
			const fold = (p: string) => p.normalize("NFC").toLowerCase();
			const lowerLocal = new Map([...localShas.keys()].map((p) => [fold(p), p]));
			const seenLower = new Map<string, string>();
			const listed: { raw: TreeEntry; vp: string }[] = [];
			for (const raw of await this.gh.listTree(treeSha)) {
				if (raw.path === MARKER_PATH) markerSha = raw.sha;
				if (raw.path === FOLDERS_PATH) foldersSha = raw.sha;
				if (raw.path === MARKER_PATH || raw.path === FOLDERS_PATH) this.metaShas.set(raw.path, raw.sha);
				if (raw.type !== "blob" || (raw.mode !== "100644" && raw.mode !== "100755")) continue;
				// Map the repository path back to a vault path (decrypt names, strip folder prefix).
				const vp = this.codec.transformsPaths ? await this.codec.decodePath(raw.path) : raw.path;
				if (vp !== null) listed.push({ raw, vp });
			}
			const remotePaths = new Set(listed.map((x) => x.vp));
			for (const { raw, vp } of listed) {
				const e = { ...raw, path: vp };
				if (!baseScope(e.path)) continue;
				if (!safePath(e.path)) {
					addSkip(sink, e.path, "unsafePath");
					continue;
				}
				if (this.host.windows && portableNameProblem(e.path)) {
					// Windows can't create this name; writing it would fail on every sync.
					skip(e.path, "windowsName");
					winSkipped.add(e.sha);
					winSkippedSpots.add(spot(e.path));
					winBad.push(e.path);
					continue;
				}
				if ((e.size ?? 0) > maxBytes) {
					skip(e.path, "remoteTooLarge", { mb: this.s.maxFileSizeMB });
					continue;
				}
				const lower = fold(e.path);
				const localTwin = lowerLocal.get(lower);
				// Same name in another Unicode form (macOS/iOS store NFD, other systems NFC): the same file.
				// Local IO and the baseline use the local spelling, remote operations the repository path.
				if (localTwin && localTwin !== e.path && localTwin.normalize("NFC") === e.path.normalize("NFC") && !remotePaths.has(localTwin) && !seenLower.has(lower)) {
					e.path = localTwin;
				}
				// Big and not on this device: leave it in the repository, unless this device had it at the
				// last sync (then it was deleted or renamed here, and that must reach the repository).
				const wasHere = !!state.base[e.path] && !state.remoteOnly?.[e.path];
				if (deviceMax && (e.size ?? 0) > deviceMax && !localShas.has(e.path) && !pinned.has(e.path) && !wasHere) {
					skip(e.path, "onDemand");
					remoteOnly[e.path] = { sha: e.sha, size: e.size ?? 0 };
					continue;
				}
				const other = seenLower.get(lower) ?? (localTwin && localTwin !== e.path ? localTwin : undefined);
				// (Not when the exact spelling also exists here: then it is a separate local file, not a rename.)
				if (other && !seenLower.has(lower) && !state.base[e.path] && state.base[other] && !remotePaths.has(other) && !localShas.has(e.path)) {
					// The local file is gone from the repository and a new path differing only by letter case
					// appeared: renamed by case on another device. Rename here too instead of deleting it.
					if (how.mode === "push") {
						skip(e.path, "caseRenamedFrom", { other });
						skip(other, "caseRenamedTo", { other: e.path });
						continue;
					}
					caseRenames.push([other, e.path]);
				} else if (other && (seenLower.has(lower) || !state.base[e.path])) {
					skip(e.path, other.normalize("NFC") === e.path.normalize("NFC") ? "unicodeClash" : "caseClash", { other });
					continue;
				}
				seenLower.set(lower, e.path);
				remote.set(e.path, { sha: e.sha, mode: e.mode, raw: raw.path, size: e.size });
				// Where the blob lives, for hosts that can't send big files through their blob API (Gitea).
				if (head) this.blobHints.set(e.sha, { path: raw.path, ref: head });
				remoteShas.set(e.path, e.sha);
			}
		}
		// Encryption: refuse to read an encrypted repo without the key, or to mix keys.
		if (this.host.checkEncryption && !readOnly) this.markerToAdd = await this.host.checkEncryption(head ? markerSha : null);
		else if (this.host.checkEncryption) await this.host.checkEncryption(head ? markerSha : null);
		// Renamed elsewhere to a name Windows can't store: the old name looks deleted remotely. Keep the
		// note here (skip its old path too) instead of trashing it.
		// Renamed and edited at once: same folder and type as a name that is NEW in this sync (a name
		// seen before can't explain a later deletion). Such notes stay kept while that name exists.
		const seen = new Set(state.winSeen ?? []);
		const newSpots = new Set(winBad.filter((p) => !seen.has(p)).map(spot));
		const winKept: Record<string, string> = {};
		if (winSkipped.size) {
			for (const [p, sha] of Object.entries(base)) {
				if (remoteShas.has(p) || skipPaths.has(p)) continue;
				if (winSkipped.has(sha)) skip(p, "winRenamed");
				else if (newSpots.has(spot(p)) || (state.winKept?.[p] && winSkippedSpots.has(spot(p)))) {
					skip(p, "winMaybeRenamed");
					winKept[p] = spot(p);
				}
			}
		}
		const win = head ? { seen: winBad, kept: winKept } : undefined;
		if (opts.only) {
			// "Sync current file": every other path keeps its baseline and is left for a later sync.
			for (const p of new Set([...localShas.keys(), ...remoteShas.keys(), ...Object.keys(base)])) if (!opts.only.has(p)) skipPaths.add(p);
		}
		for (const p of skipPaths) {
			localShas.delete(p);
			remoteShas.delete(p);
			remote.delete(p);
		}
		return { scope, skipPaths, skipped, skipNotes, localShas, cacheNext, head, treeSha, remote, remoteShas, upToDate: false, base, eolSame, covered, remoteOnly, scopeSig, unknownLocal, caseRenames, foldersSha, win };
	}

	private async initRemote(): Promise<string> {
		const repo = await this.gh.getRepo();
		if (!repo) throw new SyncError("repoNotFound", { repo: `${this.s.owner}/${this.s.repo}` });
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
		if (!head) throw new SyncError("initFailed");
		return head;
	}

	private async runOnce(mode: SyncMode, opts: SyncOptions): Promise<SyncReport> {
		const host = this.host;
		const state = host.state;
		this.prConflicts = [];
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

		const ctx = await this.gather(mode !== "pull", opts, false, { mode });
		this.checkAlive();
		report.skipped = ctx.skipped;
		report.skipNotes = ctx.skipNotes;
		const cacheNext = ctx.cacheNext;
		const maxBytes = this.s.maxFileSizeMB * 1024 * 1024;

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
		// The next value of state.dirty; only stored with the rest of the state once this sync succeeded.
		let dirtyNext = false;
		// Some remote changes are deliberately left for later (push mode, "sync current file", deferred
		// in review, delete guard): the next sync must compare fully instead of taking the fast path.
		let behind = ctx.unknownLocal || !!opts.only || !!opts.defer?.size;

		// Renamed by letter case only on another device: rename the local file first (nothing is deleted),
		// then compare it under its new name like any other file.
		for (const [from, to] of ctx.caseRenames) {
			try {
				const c = cacheNext[from];
				const st = await this.io.stat(from);
				if (!c || !st || st.mtime !== c.m || st.size !== c.s) throw new EditedDuringSync(from);
				await this.io.rename(from, to);
				const moved = await this.io.stat(to);
				if (moved) cacheNext[to] = { ...c, m: moved.mtime, s: moved.size };
				delete cacheNext[from];
				this.rekey(ctx, from, to);
				report.renamed.push(`${from} → ${to}`);
			} catch (e) {
				// Leave both names as they are and try again next time.
				for (const p of [from, to]) {
					ctx.skipPaths.add(p);
					ctx.localShas.delete(p);
					ctx.remoteShas.delete(p);
					remote.delete(p);
				}
				addSkip(report, to, "caseRenameFailed", { from, error: localizeError(e, this.gh.label) }, { from, error: errMsg(e) });
				behind = true;
			}
		}

		const plan = decide(ctx.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope, { pushKeepsRemote: !this.host.backupMirror });
		let decisions = await this.similarRenames(detectRenames(plan.decisions, ctx.base, ctx.localShas, ctx.remoteShas), ctx.base, ctx.localShas, ctx.remoteShas, { cache: cacheNext, remote });

		// Paths skipped for size/case keep their old base so they are not seen as deleted later. The base
		// of THIS comparison: after a rewritten history it is empty, and an old entry kept here would make
		// the file look deleted remotely on the next sync.
		const next: Record<string, string> = { ...plan.settled };
		const keepBase = (p: string) => {
			if (ctx.base[p]) next[p] = ctx.base[p];
			else delete next[p];
		};
		for (const p of ctx.skipPaths) if (ctx.base[p]) next[p] = ctx.base[p];
		decisions = await this.keepMovedOutOfScope(decisions, ctx.base, report, (p) => {
			next[p] = ctx.base[p];
			(state.keptMoved ??= {})[p] = ctx.base[p];
		});
		if ("win" in ctx && ctx.win) {
			state.winSeen = ctx.win.seen.length ? ctx.win.seen : undefined;
			state.winKept = Object.keys(ctx.win.kept).length ? ctx.win.kept : undefined;
		}
		// Forget kept files that came back into scope, changed, or left the repository.
		for (const p of Object.keys(state.keptMoved ?? {})) {
			if (ctx.localShas.has(p) || !ctx.base[p] || ctx.remoteShas.get(p) !== state.keptMoved![p]) delete state.keptMoved![p];
		}

		// ---- delete guard ----
		const delLocal = decisions.filter((d) => d.kind === "delete-local").map((d) => d.path);
		// Renames are not deletions.
		const delRemote = decisions.filter((d) => d.kind === "delete-remote" && !d.renamedTo).map((d) => d.path);
		const total = delLocal.length + delRemote.length;
		const baseCount = Object.keys(state.base).length;
		const limit = Math.max(this.s.deleteGuardMin, Math.ceil((baseCount * this.s.deleteGuardPercent) / 100));
		if (this.s.deleteGuardEnabled && total > limit) {
			const choice = await host.confirmDeletes(delLocal, delRemote);
			if (choice === "cancel") throw new SyncCancelled("guardCancelled");
			if (choice === "skip") {
				report.guardKept = [...delLocal, ...delRemote];
				for (const d of decisions) {
					if (d.kind === "delete-local" || d.kind === "delete-remote") keepBase(d.path);
				}
				decisions = decisions.filter((d) => d.kind !== "delete-local" && d.kind !== "delete-remote");
				behind = true;
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
				addSkip(report, path, "editedDuringSync");
				keepBase(path);
				return;
			}
			report.errors.push(`${path}: ${errMsg(e)}`);
			host.log(`Error on ${path}: ${errMsg(e)}`);
			keepBase(path);
		};

		// ---- apply simple decisions (parallel) ----
		const simple = decisions.filter((d) => d.kind !== "conflict" && d.kind !== "rename-merge");
		let done = 0;
		const downloads = simple.filter((d) => d.kind === "download" || d.kind === "adopt-remote-edit").length;
		// Empty folders are pruned once all parallel writes are done: pruning inside the pool could trash a
		// folder another download is writing into at that moment.
		await this.io.deferPruning(() => pool(simple, 4, async (d) => {
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
							// Renamed and edited remotely: fetch the new content first, so a failed download
							// leaves the file untouched under its old name instead of renamed with old content.
							const data = d.replace ? await this.blob(d.path, d.sha) : null;
							await this.assertUnchanged(d.from);
							await this.io.rename(d.from, d.path);
							if (data) {
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
						if (ptr && maxBytes > 0 && ptr.size > maxBytes) {
							// Same as a too-large file in the listing: skipped, its baseline left as it was.
							addSkip(report, d.path, "remoteTooLarge", { mb: this.s.maxFileSizeMB });
							ctx.skipPaths.add(d.path);
							keepBase(d.path);
							break;
						}
						const limit = this.downloadLimit(d.path);
						if (ptr && limit && ptr.size > limit) {
							addSkip(report, d.path, "onDemand");
							if (!(await this.io.stat(d.path))) ctx.remoteOnly[d.path] = { sha: d.sha, size: ptr.size };
							keepBase(d.path);
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
						// Push mode, changed on both sides: the repository's version is saved as a copy first.
						// If that fails, nothing is uploaded either (the repository keeps its version for now).
						if (d.keepRemote) await this.keepRemoteCopy(d.path, d.keepRemote, device, remote, report, queueUpload, recordWrite);
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
				// A rename that didn't happen leaves the old path as it was: keep its baseline too, or the
				// untouched old file would read as new here next time and be uploaded again.
				if ((d.kind === "move-local" || d.kind === "adopt-remote-edit") && ctx.base[d.from]) next[d.from] = ctx.base[d.from];
			}
		}));

		// ---- conflicts (sequential, may prompt) ----
		for (const d of decisions) {
			if (d.kind !== "conflict" && d.kind !== "rename-merge") continue;
			try {
				if (d.kind === "conflict") await this.resolveConflict(d, mode, device, next, report, queueUpload, recordWrite);
				else await this.renameMerge(d, device, next, cacheNext, report, remoteDeletes, renames, queueUpload, recordWrite);
			} catch (e) {
				fail(d.path, e);
				if (d.kind === "rename-merge" && ctx.base[d.from]) next[d.from] = ctx.base[d.from];
			}
		}

		// ---- empty folders (.vault-sync/folders.json) ----
		const foldersUpdate = await this.syncEmptyFolders(mode, ctx.foldersSha, ctx.scope).catch((e: unknown) => {
			host.log(`Empty folders not synced: ${errMsg(e)}`);
			return null;
		});

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
		const folderUpsert = foldersUpdate?.upload ?? null;
		if (mode !== "pull" && (uploads.length || remoteDeletes.length || folderUpsert !== null) && ctx.head && ctx.treeSha) {
			this.checkAlive();
			const pushed = await this.push(ctx.head, ctx.treeSha, uploads, remoteDeletes, remote, device, renames, folderUpsert);
			newHead = pushed.sha;
			// If the host merged us onto a newer head, our baseline is incomplete: compare fully next time.
			if (!pushed.fastForward) dirtyNext = true;
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

		// ---- conflicts sent as a pull request (team shared folders) ----
		if (this.prConflicts.length && newHead) await this.sendConflictsAsPullRequest(newHead, remote, device, next, report, recordWrite);

		// Anything whose new baseline isn't what the repository holds (e.g. remote edits kept out in push
		// mode) still has to be synced: never let the "nothing changed" fast path hide it.
		const pushed = new Set(report.commit ? [...uploads.map((u) => u.path), ...remoteDeletes] : []);
		for (const p of new Set([...ctx.remoteShas.keys(), ...Object.keys(next)])) {
			if (behind) break;
			if (ctx.skipPaths.has(p) || ctx.remoteOnly[p] || pushed.has(p)) continue;
			if (next[p] !== ctx.remoteShas.get(p)) behind = true;
		}

		const baseNorm: Record<string, string> = {};
		for (const [p, sha] of Object.entries(next)) {
			const c = cacheNext[p];
			if (c?.n && (c.h === sha || ctx.eolSame.has(p))) baseNorm[p] = c.n;
			else if (state.baseNorm?.[p] && state.base[p] === sha) baseNorm[p] = state.baseNorm[p];
		}

		state.head = newHead;
		state.base = next;
		if (foldersUpdate) state.baseFolders = foldersUpdate.base;
		state.remoteOnly = ctx.remoteOnly;
		state.scopeSig = ctx.scopeSig;
		state.codecFingerprint = this.codec.fingerprint;
		state.baseNorm = baseNorm;
		state.cache = cacheNext;
		state.lastSync = Date.now();
		state.dirty = dirtyNext || behind || editedDuringSync || report.errors.length > 0;
		await host.saveState();
		host.markLocalChangesSynced?.(ctx.covered);
		return report;
	}

	/**
	 * Push mode, both sides changed `path`: saves the repository's version as a conflict copy next to it
	 * (uploaded too, so every device sees both), before this device's version replaces it in the
	 * repository. The local file itself is left alone. A version too large for this device stays in the
	 * repository's history instead.
	 */
	private async keepRemoteCopy(
		path: string,
		sha: string,
		device: string,
		remote: Map<string, RemoteEntry>,
		report: SyncReport,
		queueUpload: (path: string, data?: ArrayBuffer, sha?: string) => Promise<void>,
		recordWrite: (path: string, sha: string, data?: ArrayBuffer) => Promise<void>,
	): Promise<void> {
		const maxBytes = this.s.maxFileSizeMB * 1024 * 1024;
		const limit = this.downloadLimit(path);
		const listed = remote.get(path)?.size ?? 0;
		const raw = limit && listed > limit ? null : await this.verifiedBlob(sha, path);
		const ptr = raw ? parsePointer(raw) : null;
		const size = ptr ? ptr.size : listed;
		if (!raw || (maxBytes > 0 && size > maxBytes) || (limit && size > limit)) {
			addSkip(report, path, "pushCopyTooLarge", { host: this.gh.label });
			this.host.log(`Push only: ${path} changed in ${this.gh.label} too; its version is too large to copy here and stays in the repository's history.`);
			return;
		}
		const data = await this.codec.decode(path, raw);
		const copy = await this.freeCopyPath(path, this.gh.label);
		await this.io.write(copy, data);
		// Recorded like any scanned file (see renameMerge), so the copy never reads as deleted later.
		const copySha = await this.codec.storedSha(copy, data);
		await recordWrite(copy, copySha, data);
		await queueUpload(copy, data, copySha);
		report.conflictCopies.push(copy);
		this.host.log(`Push only: ${path} changed here and in ${this.gh.label}; uploaded this device's version (${device}) and kept the ${this.gh.label} version as "${copy}".`);
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
			// Write the merged file first; the old one is only removed once its content is safe elsewhere.
			await this.assertUnchanged(d.path);
			await this.io.write(d.path, merged);
			await recordWrite(d.path, sha, merged);
			if (d.side === "remote") {
				await this.assertUnchanged(d.from);
				await this.io.remove(d.from);
				delete cacheNext[d.from];
			}
			await queueUpload(d.path, merged, sha);
			report.merged.push(d.path);
		} else {
			// Overlapping edits: keep this device's version under the new name and the other side's as a copy.
			const copy = await this.freeCopyPath(d.path, d.side === "remote" ? device : this.gh.label);
			const keep = d.side === "remote" ? remoteData : localData;
			const other = d.side === "remote" ? localData : remoteData;
			await this.assertUnchanged(d.path);
			await this.io.write(d.path, keep);
			const keepSha = await this.codec.storedSha(d.path, keep);
			await recordWrite(d.path, keepSha, keep);
			await this.io.write(copy, other);
			// Recorded like any scanned file: settings-folder/hidden copies are only listed from the cache
			// between disk walks, and an unrecorded copy would look deleted there.
			const copySha = await this.codec.storedSha(copy, other);
			await recordWrite(copy, copySha, other);
			// Both versions are written: only now may the old file go.
			if (d.side === "remote") {
				await this.assertUnchanged(d.from);
				await this.io.remove(d.from);
				delete cacheNext[d.from];
			}
			await queueUpload(d.path, keep, keepSha);
			await queueUpload(copy, other, copySha);
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
			// Team flow: this device's version goes to a branch with a pull request after the main push;
			// the note is only replaced once that branch holds it (see sendConflictsAsPullRequest).
			if (uploadCopy && this.gh.createPullRequest && this.host.conflictsAsPullRequest?.()) {
				this.prConflicts.push({ path: d.path, local: localData, remote: remoteData, remoteSha: d.remote });
				// The base of this comparison (empty after a rewritten history: then no baseline is kept).
				if (d.base) next[d.path] = d.base;
				return;
			}
			const copy = await this.freeCopyPath(d.path, device);
			await this.io.write(copy, localData);
			// Recorded like any scanned file (see renameMerge), so the copy never reads as deleted later.
			const copySha = await this.codec.storedSha(copy, localData);
			await recordWrite(copy, copySha, localData);
			await writeRemote();
			if (uploadCopy) await queueUpload(copy, localData, copySha);
			report.conflictCopies.push(copy);
			host.log(`Conflict on ${d.path}: kept both, your version saved as "${copy}".`);
		};

		if (mode === "pull") return keepBoth(false);

		// First sync with an existing vault on both sides: the setup wizard may say which side wins.
		// "The repository wins": the local version was never uploaded, so move it to the trash first,
		// always somewhere recoverable (never a permanent delete, whatever the deletion preference says).
		const replaceWithRemote = async () => {
			await this.assertUnchanged(d.path);
			await this.io.removeRecoverable(d.path);
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
		foldersJson: string | null = null,
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
		if (foldersJson !== null) upserts.push({ path: FOLDERS_PATH, mode: "100644", load: async () => encodeText(foldersJson), text: () => foldersJson });
		const rawDeletes: string[] = [];
		for (const p of deletes) rawDeletes.push(remote.get(p)?.raw ?? (await codec.encodePath(p)));

		const res = await this.gh.commit({
			author: this.author(),
			branch: this.s.branch,
			parent: head,
			parentTree: baseTree,
			message: this.commitMessage(uploads, deletes, device, renames),
			upserts,
			deletes: rawDeletes,
			// Metadata files too: hosts that create-or-update per file (GitLab, Gitea) must update them.
			existing: new Map([...[...remote.values()].map((e): [string, string] => [e.raw, e.sha]), ...this.metaShas]),
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
		if (!this.codec.has("enc:")) throw new SyncError("encryptionOff");
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
		if (!(await confirm(foreign))) throw new SyncCancelled();
		const device = this.host.deviceName();
		await gh.commit({
			author: this.author(),
			branch: this.s.branch,
			parent: head,
			parentTree: tree,
			message: `${device}: remove ${foreign.length} unencrypted file(s)\n\n${this.trailer(device)}`,
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
		if (!head) throw new SyncError("branchEmpty");
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
		if (!(await confirm(plan))) throw new SyncCancelled();
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
		// Always the real remote listing: the "nothing changed" shortcut would compare against local hashes.
		const ctx = await this.gather(false, {}, true, { noFastPath: true });
		const head = ctx.head;
		if (!head) throw new SyncError("resetEmpty");
		for (const [from, to] of ctx.caseRenames) {
			this.rekey(ctx, from, to);
			if (ctx.cacheNext[from]) ctx.cacheNext[to] = ctx.cacheNext[from];
		}
		const remoteShas = ctx.remoteShas;
		const plan: ResetPlan = { overwrite: [], download: [], remove: [] };
		for (const p of new Set([...ctx.localShas.keys(), ...remoteShas.keys()])) {
			// Exact bytes on disk (a line-ending-only difference still counts here).
			const l = ctx.localShas.has(p) ? (ctx.cacheNext[p]?.h ?? ctx.localShas.get(p)) : undefined;
			const r = remoteShas.get(p);
			if (r && l && l !== r) plan.overwrite.push(p);
			else if (r && !l) plan.download.push(p);
			else if (!r && l) plan.remove.push(p);
		}
		if (!plan.overwrite.length && !plan.download.length && !plan.remove.length) return plan;
		if (!(await confirm(plan))) throw new SyncCancelled("resetCancelled");

		const cacheNext = ctx.cacheNext;
		// Renamed by letter case only in the repository: take the new name first (content is handled below).
		for (const [from, to] of ctx.caseRenames) {
			await this.io.rename(from, to);
			delete cacheNext[from];
			delete cacheNext[to];
		}
		const write = async (p: string) => {
			const sha = remoteShas.get(p)!;
			const data = await this.blob(p, sha);
			await this.io.write(p, data);
			const st = await this.io.stat(p);
			const n = await this.normHash(p, data, sha);
			if (st) cacheNext[p] = n ? { m: st.mtime, s: st.size, h: sha, n } : { m: st.mtime, s: st.size, h: sha };
		};
		// Overwritten and removed files hold local work that isn't in the repository: they always go to a
		// recoverable trash, never a permanent delete. Empty folders are pruned after all writes finished.
		await this.io.deferPruning(async () => {
			await pool(plan.overwrite, 4, async (p) => {
				await this.io.removeRecoverable(p);
				await write(p);
			});
			await pool(plan.download, 4, write);
			for (const p of plan.remove) {
				await this.io.removeRecoverable(p);
				delete cacheNext[p];
			}
		});

		const base: Record<string, string> = {};
		for (const [p, sha] of remoteShas) base[p] = sha;
		for (const p of ctx.skipPaths) if (ctx.base[p]) base[p] = ctx.base[p];
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
	 * The opposite of resetToRemote: one new commit that makes the repository equal to this device
	 * (within scope). History is kept, nothing is force-pushed. Files only in the repository that this
	 * device chose not to download (on demand) or kept after moving them out of scope are left alone.
	 */
	async overwriteRemote(confirm: (plan: OverwritePlan) => Promise<boolean>): Promise<OverwritePlan> {
		const state = this.host.state;
		this.loadCodec();
		if (this.s.mode === "pull") throw new SyncError("overwritePullOnly");
		// Not read-only: like a normal sync, this run must publish the encryption marker if it is the first
		// encrypted push (checkEncryption sets markerToAdd).
		this.markerToAdd = null;
		const ctx = await this.gather(true, {}, false, { noFastPath: true });
		const remote = ctx.remote ?? new Map<string, RemoteEntry>();
		const plan: OverwritePlan = { upload: [], remove: [] };
		for (const [p, l] of ctx.localShas) if (ctx.remoteShas.get(p) !== (ctx.cacheNext[p]?.h ?? l)) plan.upload.push(p);
		for (const p of ctx.remoteShas.keys()) if (!ctx.localShas.has(p) && !state.keptMoved?.[p]) plan.remove.push(p);
		if (!plan.upload.length && !plan.remove.length) return plan;
		if (!(await confirm(plan))) throw new SyncCancelled();
		const uploads: Upload[] = [];
		for (const p of plan.upload) uploads.push({ path: p, sha: ctx.cacheNext[p]?.h ?? ctx.localShas.get(p)!, mode: remote.get(p)?.mode ?? "100644" });
		const device = this.host.deviceName();
		const head = ctx.head;
		let newHead = head;
		if (head && ctx.treeSha) newHead = (await this.push(head, ctx.treeSha, uploads, plan.remove, remote, device)).sha;
		else throw new SyncError("overwriteEmpty");
		// The repository now equals this device: that is the new baseline.
		const base: Record<string, string> = {};
		const removed = new Set(plan.remove);
		for (const [p, sha] of ctx.remoteShas) if (!removed.has(p)) base[p] = sha;
		for (const u of uploads) base[u.path] = u.sha;
		for (const p of ctx.skipPaths) if (ctx.base[p]) base[p] = ctx.base[p];
		state.head = newHead;
		state.base = base;
		state.cache = ctx.cacheNext;
		state.lastSync = Date.now();
		state.dirty = true; // compare fully once more, to settle line-ending and encoding details
		await this.host.saveState();
		this.host.log(`Repository set to this device: ${plan.upload.length} uploaded, ${plan.remove.length} removed (still in history).`);
		return plan;
	}

	/**
	 * Restore the whole vault, or one folder, to how it was at `commit`. Local changes are synced
	 * first, then the restore is pushed as a new commit on top (history is never rewritten), then
	 * pulled down to this device.
	 */
	async restoreTo(commit: string, folder: string, confirm: (plan: RestorePlan) => Promise<boolean>): Promise<RestorePlan> {
		this.loadCodec();
		if (this.s.mode === "pull") throw new SyncError("restorePullOnly");
		await this.run(this.s.mode);
		const gh = this.gh;
		const head = await gh.getRef(this.s.branch);
		if (!head) throw new SyncError("branchEmpty");
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
		if (!(await confirm(plan))) throw new SyncCancelled("restoreCancelled");

		const what = prefix ? `"${prefix}"` : "vault";
		const message = `${this.host.deviceName()}: restore ${what} to ${commit.slice(0, 7)}\n\n${plan.changed.length} restored, ${plan.added.length} brought back, ${plan.removed.length} removed\n\n${this.trailer(this.host.deviceName())}`;
		let newCommit: string;
		try {
			newCommit = (await gh.commit({ author: this.author(), branch: this.s.branch, parent: head, parentTree: headTree, message, upserts, deletes })).sha;
		} catch (e) {
			if (e instanceof NotFastForward) throw new SyncError("restoreRaced");
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
		return `${subject}\n\n${list}\n\n${this.trailer(device)}`;
	}
}
