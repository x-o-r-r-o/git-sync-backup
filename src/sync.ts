// The sync engine: scan local, read remote tree, decide, apply, push one atomic commit.

import { arrayBufferToBase64 } from "obsidian";
import type { App } from "obsidian";
import type { GitHub, NewTreeEntry } from "./github.ts";
import { compileGlobs } from "./glob.ts";
import { VaultIO } from "./io.ts";
import { merge3 } from "./merge.ts";
import { decide } from "./plan.ts";
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
	gh: GitHub;
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
class NotFastForward extends Error {}
class StaleRemote extends Error {}

interface RemoteEntry {
	sha: string;
	mode: string;
}

interface Upload {
	path: string;
	sha: string;
	mode: string;
	// Only set for generated content (merges, conflict copies). Plain uploads are read
	// lazily at push time so a huge first sync never holds the whole vault in memory.
	data?: ArrayBuffer;
}

// Inline text up to this size in tree requests (saves one API call per file).
const INLINE_MAX = 400 * 1024;
const TREE_CHUNK_BYTES = 3 * 1024 * 1024;
const TREE_CHUNK_ENTRIES = 400;
const UPLOAD_BATCH = 8;
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

	constructor(host: SyncHost) {
		this.host = host;
		this.io = new VaultIO(host.app);
	}

	private get s() {
		return this.host.settings;
	}

	private get repoKey() {
		return `${this.s.owner}/${this.s.repo}@${this.s.branch}`;
	}

	buildScope(): (path: string) => boolean {
		const cfg = this.host.app.vault.configDir;
		const patterns = this.s.excludePatterns.split("\n").map((l) => l.split("{config}").join(cfg));
		const excluded = compileGlobs([...patterns, ".git/", this.host.stateFilePath]);
		return (p: string) => {
			if (excluded(p)) return false;
			if (!isHiddenPath(p)) return true;
			if (!this.s.syncConfigDir || !p.startsWith(cfg + "/")) return false;
			return !isHiddenPath(p.slice(cfg.length + 1));
		};
	}

	/** Dry run: what would happen, without touching anything. */
	async preview(mode: SyncMode): Promise<Preview> {
		const ctx = await this.gather(false, {}, true);
		const plan = decide(ctx.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope);
		return { decisions: plan.decisions, skipped: ctx.skipped, localShas: ctx.localShas, remoteShas: ctx.remoteShas, base: ctx.base };
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

	async run(mode: SyncMode, opts: SyncOptions = {}): Promise<SyncReport> {
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
		return gitBlobSha(encodeText(text.replace(/\r\n/g, "\n")));
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

		const files = this.io.listVault(baseScope);
		if (configDue) files.push(...(await this.io.listConfig(baseScope)));
		const localShas = new Map<string, string>();
		const cacheNext: SyncState["cache"] = {};
		let hashed = 0;
		for (const f of files) {
			if (f.size > maxBytes) {
				skip(f.path, `local file larger than ${this.s.maxFileSizeMB} MB`);
				continue;
			}
			const c = state.cache[f.path];
			if (c && c.m === f.mtime && c.s === f.size && !covered.paths.has(f.path)) {
				cacheNext[f.path] = c;
				localShas.set(f.path, c.h);
				continue;
			}
			const data = await this.io.read(f.path);
			const h = await gitBlobSha(data);
			const n = await this.normHash(f.path, data, h);
			cacheNext[f.path] = n ? { m: f.mtime, s: f.size, h, n } : { m: f.mtime, s: f.size, h };
			localShas.set(f.path, h);
			if (++hashed % 25 === 0) await sleep(0);
		}
		if (this.s.syncConfigDir && !configDue) {
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
		let head = await this.host.gh.getRef(this.s.branch);
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
		if (head) {
			treeSha = await this.host.gh.getCommitTree(head);
			const lowerLocal = new Map([...localShas.keys()].map((p) => [p.toLowerCase(), p]));
			const seenLower = new Set<string>();
			for (const e of await this.host.gh.listTree(treeSha)) {
				if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) continue;
				if (!baseScope(e.path)) continue;
				if (!safePath(e.path)) {
					skipped.push(`${e.path} (unsafe path)`);
					continue;
				}
				if ((e.size ?? 0) > maxBytes) {
					skip(e.path, `remote file larger than ${this.s.maxFileSizeMB} MB`);
					continue;
				}
				const lower = e.path.toLowerCase();
				const localTwin = lowerLocal.get(lower);
				if (seenLower.has(lower) || (localTwin && localTwin !== e.path && !state.base[e.path])) {
					skip(e.path, "differs only by letter case from another file");
					continue;
				}
				seenLower.add(lower);
				remote.set(e.path, { sha: e.sha, mode: e.mode });
				remoteShas.set(e.path, e.sha);
			}
		}
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
			const content = "# Managed by Vault Sync for GitHub. Keeps git clients from rewriting line endings.\n* -text\n";
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
		const report: SyncReport = {
			mode,
			upToDate: false,
			downloaded: [],
			deletedLocal: [],
			uploaded: [],
			deletedRemote: [],
			merged: [],
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
			state.lastSync = Date.now();
			await host.saveState();
			host.markLocalChangesSynced?.(ctx.covered);
			return report;
		}

		const remote = ctx.remote ?? new Map<string, RemoteEntry>();
		const plan = decide(ctx.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope);
		let decisions = plan.decisions;

		// Paths skipped for size/case keep their old base so they are not seen as deleted later.
		const next: Record<string, string> = { ...plan.settled };
		for (const p of ctx.skipPaths) if (state.base[p]) next[p] = state.base[p];

		// ---- delete guard ----
		const delLocal = decisions.filter((d) => d.kind === "delete-local").map((d) => d.path);
		const delRemote = decisions.filter((d) => d.kind === "delete-remote").map((d) => d.path);
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

		const uploads: Upload[] = [];
		const remoteDeletes: string[] = [];
		const device = host.deviceName();

		const recordWrite = async (path: string, sha: string, data?: ArrayBuffer) => {
			const st = await this.io.stat(path);
			if (!st) return;
			const n = data ? await this.normHash(path, data, sha) : undefined;
			cacheNext[path] = n ? { m: st.mtime, s: st.size, h: sha, n } : { m: st.mtime, s: st.size, h: sha };
		};
		const queueUpload = async (path: string, data?: ArrayBuffer, sha?: string) => {
			const hash = sha ?? (data ? await gitBlobSha(data) : await gitBlobSha(await this.io.read(path)));
			uploads.push({ path, data, sha: hash, mode: remote.get(path)?.mode ?? "100644" });
		};
		const fail = (path: string, e: unknown) => {
			report.errors.push(`${path}: ${errMsg(e)}`);
			host.log(`Error on ${path}: ${errMsg(e)}`);
			if (state.base[path]) next[path] = state.base[path];
			else delete next[path];
		};

		// ---- apply simple decisions (parallel) ----
		const simple = decisions.filter((d) => d.kind !== "conflict");
		await pool(simple, 4, async (d) => {
			try {
				switch (d.kind) {
					case "download": {
						const data = await host.gh.getBlob(d.sha);
						await this.io.write(d.path, data);
						await recordWrite(d.path, d.sha, data);
						next[d.path] = d.sha;
						report.downloaded.push(d.path);
						break;
					}
					case "delete-local":
						await this.io.remove(d.path);
						delete next[d.path];
						delete cacheNext[d.path];
						report.deletedLocal.push(d.path);
						break;
					case "upload":
						await queueUpload(d.path, undefined, d.sha);
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
			newHead = await this.push(ctx.head, ctx.treeSha, uploads, remoteDeletes, device);
			report.commit = newHead;
			for (const u of uploads) {
				next[u.path] = u.sha;
				if (!report.merged.includes(u.path) && !report.conflictCopies.includes(u.path)) report.uploaded.push(u.path);
			}
			for (const p of remoteDeletes) {
				delete next[p];
				report.deletedRemote.push(p);
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
		state.baseNorm = baseNorm;
		state.cache = cacheNext;
		state.lastSync = Date.now();
		state.dirty = report.errors.length > 0;
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
		const localData = await this.io.read(d.path);
		const remoteData = await host.gh.getBlob(d.remote);
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

		let strategy: string = this.s.conflictStrategy;
		if (strategy === "ask") {
			const choice = await host.askConflict({
				path: d.path,
				localText,
				remoteText,
				localSize: localData.byteLength,
				remoteSize: remoteData.byteLength,
			});
			if (typeof choice === "object") {
				// Hand-picked result from the per-change conflict view.
				const merged = encodeText(choice.custom);
				const sha = await gitBlobSha(merged);
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
				await writeRemote();
				host.log(`Conflict on ${d.path}: took the GitHub version.`);
				return;
			case "keep-both":
				return keepBoth(true);
			case "auto":
			case "markers": {
				if (localText === null || remoteText === null) return keepBoth(true);
				if (!d.base && strategy === "auto") return keepBoth(true);
				let baseText = "";
				if (d.base) {
					const b = asText(d.path, await host.gh.getBlob(d.base));
					if (b === null) return keepBoth(true);
					baseText = b;
				}
				const res = merge3(baseText, localText, remoteText, { local: `this device (${device})`, remote: "GitHub" });
				if (!res || (!res.clean && strategy === "auto")) return keepBoth(true);
				const merged = encodeText(res.text);
				await this.io.write(d.path, merged);
				await recordWrite(d.path, await gitBlobSha(merged), merged);
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

	private async push(head: string, baseTree: string, uploads: Upload[], deletes: string[], device: string): Promise<string> {
		const gh = this.host.gh;
		// Trees are built in chained chunks (each based on the previous one), so memory stays
		// bounded to roughly one chunk and no single request gets too large.
		let tree = baseTree;
		let chunk: NewTreeEntry[] = [];
		let chunkBytes = 0;
		const flush = async () => {
			if (!chunk.length) return;
			tree = await gh.createTree(tree, chunk);
			chunk = [];
			chunkBytes = 0;
		};

		for (let i = 0; i < uploads.length; i += UPLOAD_BATCH) {
			// Low concurrency for writes: GitHub's secondary rate limit punishes parallel content creation.
			await pool(uploads.slice(i, i + UPLOAD_BATCH), 2, async (u) => {
				const data = u.data ?? (await this.io.read(u.path));
				u.data = undefined;
				u.sha = await gitBlobSha(data);
				const text = data.byteLength <= INLINE_MAX ? asText(u.path, data) : null;
				if (text !== null) {
					chunk.push({ path: u.path, mode: u.mode, type: "blob", content: text });
					chunkBytes += data.byteLength;
				} else {
					const sha = await gh.createBlob(arrayBufferToBase64(data));
					chunk.push({ path: u.path, mode: u.mode, type: "blob", sha });
					chunkBytes += 100;
				}
			});
			if (chunkBytes >= TREE_CHUNK_BYTES || chunk.length >= TREE_CHUNK_ENTRIES) await flush();
		}
		for (const p of deletes) {
			chunk.push({ path: p, mode: "100644", type: "blob", sha: null });
			if (chunk.length >= TREE_CHUNK_ENTRIES) await flush();
		}
		await flush();

		const commit = await gh.createCommit(this.commitMessage(uploads, deletes, device), tree, [head]);
		if (!(await gh.updateRef(this.s.branch, commit))) throw new NotFastForward();
		this.host.log(`Pushed commit ${commit.slice(0, 7)} (${uploads.length} changed, ${deletes.length} deleted).`);
		return commit;
	}

	/**
	 * Make this device match GitHub exactly. Files that would be overwritten or removed are moved
	 * to the trash first, so local-only work stays recoverable.
	 */
	async resetToRemote(confirm: (plan: ResetPlan) => Promise<boolean>): Promise<ResetPlan> {
		const state = this.host.state;
		const ctx = await this.gather(false, {}, true);
		const head = ctx.upToDate ? state.head : ctx.head;
		if (!head) throw new Error("The branch on GitHub is empty. Nothing to reset to.");
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
			const data = await this.host.gh.getBlob(sha);
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
			`Reset to GitHub: ${plan.overwrite.length} replaced, ${plan.download.length} downloaded, ${plan.remove.length} removed (old versions in trash).`,
		);
		return plan;
	}

	/**
	 * Restore the whole vault, or one folder, to how it was at `commit`. Local changes are synced
	 * first, then the restore is pushed as a new commit on top (history is never rewritten), then
	 * pulled down to this device.
	 */
	async restoreTo(commit: string, folder: string, confirm: (plan: RestorePlan) => Promise<boolean>): Promise<RestorePlan> {
		if (this.s.mode === "pull") throw new Error("Restore needs to push to GitHub, which pull-only mode does not allow.");
		await this.run(this.s.mode);
		const gh = this.host.gh;
		const head = await gh.getRef(this.s.branch);
		if (!head) throw new Error("The branch on GitHub is empty.");
		const scope = this.buildScope();
		const prefix = folder.replace(/^\/+|\/+$/g, "");
		const inScope = (p: string) => scope(p) && safePath(p) && (!prefix || p === prefix || p.startsWith(prefix + "/"));
		const read = async (tree: string) => {
			const m = new Map<string, { sha: string; mode: string }>();
			for (const e of await gh.listTree(tree)) {
				if (e.type === "blob" && (e.mode === "100644" || e.mode === "100755") && inScope(e.path)) m.set(e.path, { sha: e.sha, mode: e.mode });
			}
			return m;
		};
		const headTree = await gh.getCommitTree(head);
		const cur = await read(headTree);
		const tgt = await read(await gh.getCommitTree(commit));

		const plan: RestorePlan = { changed: [], added: [], removed: [] };
		const entries: NewTreeEntry[] = [];
		for (const [p, e] of tgt) {
			const c = cur.get(p);
			if (!c) plan.added.push(p);
			else if (c.sha !== e.sha) plan.changed.push(p);
			else continue;
			entries.push({ path: p, mode: e.mode, type: "blob", sha: e.sha });
		}
		for (const p of cur.keys()) {
			if (tgt.has(p)) continue;
			plan.removed.push(p);
			entries.push({ path: p, mode: "100644", type: "blob", sha: null });
		}
		if (!entries.length) return plan;
		if (!(await confirm(plan))) throw new SyncCancelled("Restore cancelled.");

		let tree = headTree;
		for (let i = 0; i < entries.length; i += TREE_CHUNK_ENTRIES) tree = await gh.createTree(tree, entries.slice(i, i + TREE_CHUNK_ENTRIES));
		const what = prefix ? `"${prefix}"` : "vault";
		const message = `${this.host.deviceName()}: restore ${what} to ${commit.slice(0, 7)}\n\n${plan.changed.length} restored, ${plan.added.length} brought back, ${plan.removed.length} removed\n\nDevice: ${this.host.deviceName()}`;
		const newCommit = await gh.createCommit(message, tree, [head]);
		if (!(await gh.updateRef(this.s.branch, newCommit))) throw new Error("Another device pushed during the restore. Nothing was changed; please try again.");
		this.host.log(`Restored ${what} to ${commit.slice(0, 7)} as commit ${newCommit.slice(0, 7)}.`);
		await this.run("sync");
		return plan;
	}

	private commitMessage(uploads: Upload[], deletes: string[], device: string): string {
		const parts: string[] = [];
		const added = uploads.filter((u) => !this.host.state.base[u.path]).length;
		const changed = uploads.length - added;
		if (added) parts.push(`${added} added`);
		if (changed) parts.push(`${changed} updated`);
		if (deletes.length) parts.push(`${deletes.length} deleted`);
		const files = [...uploads.map((u) => u.path), ...deletes].slice(0, 10);
		const summary = parts.join(", ") || "sync";
		const subject = this.s.commitTemplate
			.split("{{device}}").join(device)
			.split("{{summary}}").join(summary)
			.split("{{date}}").join(new Date().toISOString())
			.split("{{count}}").join(String(uploads.length + deletes.length));
		const more = uploads.length + deletes.length - files.length;
		const list = `${files.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- …and ${more} more` : ""}`;
		return `${subject}\n\n${list}\n\nDevice: ${device}`;
	}
}
