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
import type { ConflictChoice, ConflictInfo, DeleteGuardChoice, SyncState, VaultSyncSettings } from "./types.ts";
import { asText, conflictCopyPath, encodeText, errMsg, gitBlobSha, isHiddenPath, pool } from "./util.ts";

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
}

export class SyncCancelled extends Error {}
class NotFastForward extends Error {}

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
		const ctx = await this.gather(false);
		const plan = decide(this.host.state.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope);
		return { decisions: plan.decisions, skipped: ctx.skipped };
	}

	async run(mode: SyncMode): Promise<SyncReport> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.runOnce(mode);
			} catch (e) {
				if (e instanceof NotFastForward && attempt < 3) {
					this.host.log("Remote moved during sync (another device pushed). Retrying.");
					continue;
				}
				throw e;
			}
		}
	}

	private async gather(initIfEmpty: boolean) {
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

		// ---- local ----
		const files = await this.io.list(baseScope, this.s.syncConfigDir);
		const localShas = new Map<string, string>();
		const cacheNext: SyncState["cache"] = {};
		for (const f of files) {
			if (f.size > maxBytes) {
				skip(f.path, `local file larger than ${this.s.maxFileSizeMB} MB`);
				continue;
			}
			const c = state.cache[f.path];
			let sha: string;
			if (c && c.m === f.mtime && c.s === f.size) sha = c.h;
			else sha = await gitBlobSha(await this.io.read(f.path));
			cacheNext[f.path] = { m: f.mtime, s: f.size, h: sha };
			localShas.set(f.path, sha);
		}

		// ---- remote ----
		let head = await this.host.gh.getRef(this.s.branch);
		if (!head && initIfEmpty) head = await this.initRemote();

		// Fast path: nothing changed anywhere since last sync.
		const baseInScope = Object.keys(state.base).filter(scope);
		const unchangedLocal = localShas.size === baseInScope.length && [...localShas].every(([p, h]) => state.base[p] === h);
		if (head && head === state.head && unchangedLocal && !state.dirty) {
			return { scope, skipPaths, skipped, localShas, cacheNext, head, treeSha: null, remote: null, remoteShas: localShas, upToDate: true };
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
		return { scope, skipPaths, skipped, localShas, cacheNext, head, treeSha, remote, remoteShas, upToDate: false };
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

	private async runOnce(mode: SyncMode): Promise<SyncReport> {
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

		const ctx = await this.gather(mode !== "pull");
		report.skipped = ctx.skipped;
		const cacheNext = ctx.cacheNext;

		if (ctx.upToDate) {
			report.upToDate = true;
			state.cache = cacheNext;
			state.lastSync = Date.now();
			await host.saveState();
			return report;
		}

		const remote = ctx.remote ?? new Map<string, RemoteEntry>();
		const plan = decide(state.base, ctx.localShas, ctx.remoteShas, mode, ctx.scope);
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

		const recordWrite = async (path: string, sha: string) => {
			const st = await this.io.stat(path);
			if (st) cacheNext[path] = { m: st.mtime, s: st.size, h: sha };
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
						await recordWrite(d.path, d.sha);
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

		state.head = newHead;
		state.base = next;
		state.cache = cacheNext;
		state.lastSync = Date.now();
		state.dirty = report.errors.length > 0;
		await host.saveState();
		return report;
	}

	private async resolveConflict(
		d: Extract<Decision, { kind: "conflict" }>,
		mode: SyncMode,
		device: string,
		next: Record<string, string>,
		report: SyncReport,
		queueUpload: (path: string, data?: ArrayBuffer, sha?: string) => Promise<void>,
		recordWrite: (path: string, sha: string) => Promise<void>,
	): Promise<void> {
		const host = this.host;
		const localData = await this.io.read(d.path);
		const remoteData = await host.gh.getBlob(d.remote);
		const localText = asText(d.path, localData);
		const remoteText = asText(d.path, remoteData);

		const writeRemote = async () => {
			await this.io.write(d.path, remoteData);
			await recordWrite(d.path, d.remote);
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
			strategy = await host.askConflict({
				path: d.path,
				localText,
				remoteText,
				localSize: localData.byteLength,
				remoteSize: remoteData.byteLength,
			});
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
				await recordWrite(d.path, await gitBlobSha(merged));
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
		return `${subject}\n\n${files.map((f) => `- ${f}`).join("\n")}${more > 0 ? `\n- …and ${more} more` : ""}`;
	}
}
