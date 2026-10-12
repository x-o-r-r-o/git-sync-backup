// Minimal GitHub REST client built on Obsidian's requestUrl, which works on desktop and
// mobile and is not subject to CORS. No git binary, no isomorphic-git.

import { arrayBufferToBase64, requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { webBase } from "./auth.ts";
import { NotFastForward, RemoteError } from "./remote.ts";
import type { CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry } from "./remote.ts";
import { pool, sleep } from "./util.ts";

export type { CommitInfo, TreeEntry } from "./remote.ts";

export interface GitHubConfig {
	token: string;
	apiBase: string;
	owner: string;
	repo: string;
	/** Called once after a 401 with the token that failed (e.g. to refresh a sign-in token); true = retry. */
	onUnauthorized?: (failedToken: string) => Promise<boolean>;
}

export interface NewTreeEntry {
	path: string;
	mode: string;
	type: "blob";
	sha?: string | null;
	content?: string;
}

export class GitHubError extends RemoteError {}

/**
 * Parses GitHub's `github-authentication-token-expiration` header ("2026-11-01 12:00:00 -0700" or
 * "... UTC"). Done by hand because Safari/iOS's Date.parse rejects that format.
 */
export function parseTokenExpiry(v: string | undefined): number | null {
	const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)\s*(?:(UTC|Z)|([+-])(\d\d):?(\d\d))?/i.exec((v ?? "").trim());
	if (!m) return null;
	const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	const offset = m[8] ? (m[8] === "-" ? -1 : 1) * (+m[9] * 60 + +m[10]) * 60_000 : 0;
	return utc - offset;
}

// Text up to this size is sent inline in tree requests (saves one API call per file).
const INLINE_MAX = 400 * 1024;
const TREE_CHUNK_BYTES = 3 * 1024 * 1024;
const TREE_CHUNK_ENTRIES = 400;
const UPLOAD_BATCH = 8;

function header(res: RequestUrlResponse, name: string): string | undefined {
	const h = res.headers ?? {};
	const key = Object.keys(h).find((k) => k.toLowerCase() === name);
	return key ? h[key] : undefined;
}

// Shapes of the GitHub REST responses this client reads (only the fields used).
interface GhRepo { private: boolean; default_branch: string; html_url: string; size: number }
interface GhRepoListItem { owner: { login: string }; name: string; private: boolean; updated_at: string; default_branch: string }
interface GhRef { object: { sha: string } }
interface GhSha { sha: string }
interface GhCommit { tree: { sha: string } }
interface GhTree { tree: TreeEntry[]; truncated: boolean }
interface GhCommitListItem { sha: string; commit: { message: string; author?: { date?: string; name?: string }; committer?: { date?: string } } }
interface GhCommitDetail { parents?: { sha: string }[]; files?: { filename: string; status: string }[] }
interface GhTag { name: string; commit: { sha: string } }
interface GhRateLimit { resources: { core: { limit: number; remaining: number; reset: number } } }

function safeJson(res: RequestUrlResponse): { message?: string } | null {
	try {
		return res.json as { message?: string };
	} catch {
		return null;
	}
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export class GitHub implements Remote {
	readonly kind = "github" as const;
	readonly label = "GitHub";
	private cfg: () => GitHubConfig;
	private expiry: { token: string; at: number | null } | null = null;
	constructor(cfg: () => GitHubConfig) {
		this.cfg = cfg;
	}

	tokenExpiresAt(): number | null {
		const e = this.expiry;
		return e && e.token === this.cfg().token ? e.at : null;
	}

	gitUrl(): string {
		const c = this.cfg();
		return `${webBase(c.apiBase)}/${c.owner}/${c.repo}.git`;
	}

	authHeader(): string {
		return `Basic ${btoa(`x-access-token:${this.cfg().token}`)}`;
	}

	/**
	 * One atomic commit: blobs → chained trees (bounded memory, bounded request size) → commit →
	 * fast-forward-only ref update.
	 */
	async commit(req: CommitRequest): Promise<CommitResult> {
		let tree = req.parentTree;
		let chunk: NewTreeEntry[] = [];
		let chunkBytes = 0;
		const blobShas = new Map<string, string>();
		const flush = async () => {
			if (!chunk.length) return;
			tree = await this.createTree(tree, chunk);
			chunk = [];
			chunkBytes = 0;
		};
		const ups = req.upserts;
		for (let i = 0; i < ups.length; i += UPLOAD_BATCH) {
			req.progress?.(Math.min(i + UPLOAD_BATCH, ups.length), ups.length);
			// Low concurrency for writes: GitHub's secondary rate limit punishes parallel content creation.
			await pool(ups.slice(i, i + UPLOAD_BATCH), 2, async (u) => {
				if (u.sha) {
					chunk.push({ path: u.path, mode: u.mode, type: "blob", sha: u.sha });
					chunkBytes += 100;
					return;
				}
				const data = await u.load();
				const text = data.byteLength <= INLINE_MAX ? (u.text?.(data) ?? null) : null;
				if (text !== null) {
					chunk.push({ path: u.path, mode: u.mode, type: "blob", content: text });
					chunkBytes += data.byteLength;
				} else {
					const sha = await this.createBlob(arrayBufferToBase64(data));
					blobShas.set(u.path, sha);
					chunk.push({ path: u.path, mode: u.mode, type: "blob", sha });
					chunkBytes += 100;
				}
			});
			if (chunkBytes >= TREE_CHUNK_BYTES || chunk.length >= TREE_CHUNK_ENTRIES) await flush();
		}
		for (const p of req.deletes) {
			chunk.push({ path: p, mode: "100644", type: "blob", sha: null });
			if (chunk.length >= TREE_CHUNK_ENTRIES) await flush();
		}
		await flush();
		const sha = await this.createCommit(req.message, tree, [req.parent]);
		if (!(await this.updateRef(req.branch, sha))) throw new NotFastForward();
		return { sha, fastForward: true, blobShas };
	}

	private get repoPath(): string {
		const c = this.cfg();
		return `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
	}

	async request(
		method: string,
		path: string,
		body?: unknown,
		opts: { accept?: string; okStatuses?: number[] } = {},
	): Promise<RequestUrlResponse> {
		let c = this.cfg();
		if (!c.token) throw new GitHubError("No GitHub token set. Add one in the plugin settings.", 401);
		const url = (c.apiBase || "https://api.github.com").replace(/\/+$/, "") + path;
		let lastErr: unknown;
		let reauthed = false;

		for (let attempt = 0; attempt < 4; attempt++) {
			let res: RequestUrlResponse;
			try {
				res = await requestUrl({
					url,
					method,
					headers: {
						Authorization: `Bearer ${c.token}`,
						Accept: opts.accept ?? "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
						// GitHub marks responses cacheable for 60s and Obsidian's HTTP layer honours that.
						// A stale branch head would look like remote deletions, so always revalidate.
						"Cache-Control": "no-cache",
						Pragma: "no-cache",
					},
					contentType: body !== undefined ? "application/json" : undefined,
					body: body !== undefined ? JSON.stringify(body) : undefined,
					throw: false,
				});
			} catch (e) {
				// Network failure (offline, DNS, TLS). Retry with backoff.
				lastErr = e;
				await sleep(1000 * 2 ** attempt);
				continue;
			}

			if (res.status < 300 || opts.okStatuses?.includes(res.status)) {
				if (res.status < 300) {
					// Not every endpoint sends the header: keep what we learned for this token.
					const at = parseTokenExpiry(header(res, "github-authentication-token-expiration"));
					if (at !== null || this.expiry?.token !== c.token) this.expiry = { token: c.token, at };
				}
				return res;
			}

			const data = safeJson(res);
			const msg = data?.message ?? `HTTP ${res.status}`;

			if (res.status === 403 || res.status === 429) {
				const retryAfter = Number(header(res, "retry-after"));
				const remaining = header(res, "x-ratelimit-remaining");
				const reset = Number(header(res, "x-ratelimit-reset"));
				let waitMs = 0;
				if (retryAfter) waitMs = retryAfter * 1000;
				else if (remaining === "0" && reset) waitMs = reset * 1000 - Date.now() + 1000;
				if (waitMs > 0 && waitMs <= 60_000 && attempt < 3) {
					await sleep(waitMs);
					continue;
				}
				if (waitMs > 0) {
					throw new GitHubError(`GitHub rate limit hit. Try again in ${Math.ceil(waitMs / 60000)} min.`, res.status);
				}
			}
			if (res.status >= 500 && attempt < 3) {
				lastErr = new GitHubError(msg, res.status);
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			if (res.status === 401) {
				if (!reauthed && c.onUnauthorized && (await c.onUnauthorized(c.token))) {
					reauthed = true;
					c = this.cfg();
					attempt--;
					continue;
				}
				throw new GitHubError("GitHub token is invalid or expired.", 401);
			}
			throw new GitHubError(`${msg} (${method} ${path.split("?")[0]})`, res.status);
		}
		throw lastErr instanceof Error ? lastErr : new GitHubError("Network error talking to GitHub", 0);
	}

	private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		return (await this.request(method, path, body)).json as T;
	}

	// ---- account / repo ----

	async getUser(): Promise<{ login: string }> {
		return this.json<{ login: string }>("GET", "/user");
	}

	async getRepo(): Promise<{ private: boolean; default_branch: string; html_url: string; size: number } | null> {
		const res = await this.request("GET", this.repoPath, undefined, { okStatuses: [404] });
		return res.status === 404 ? null : (res.json as GhRepo);
	}

	/** Repositories the token can see, most recently updated first. */
	async listRepos(maxPages = 3): Promise<{ owner: string; name: string; private: boolean; updated: string; defaultBranch: string }[]> {
		const out: { owner: string; name: string; private: boolean; updated: string; defaultBranch: string }[] = [];
		// Signed in through the GitHub App (user-to-server tokens start with ghu_): /user/repos lists every
		// repository the user can see, but the app can only sync those it is installed on.
		if (this.cfg().token.startsWith("ghu_")) {
			const inst = await this.json<{ installations: { id: number }[] }>("GET", "/user/installations?per_page=100");
			for (const i of inst.installations ?? []) {
				for (let page = 1; page <= maxPages; page++) {
					const res = await this.json<{ repositories: GhRepoListItem[] }>("GET", `/user/installations/${i.id}/repositories?per_page=100&page=${page}`);
					const list = res.repositories ?? [];
					for (const r of list) out.push({ owner: r.owner.login, name: r.name, private: r.private, updated: r.updated_at, defaultBranch: r.default_branch });
					if (list.length < 100) break;
				}
			}
			return out.sort((a, b) => b.updated.localeCompare(a.updated));
		}
		for (let page = 1; page <= maxPages; page++) {
			const list = await this.json<GhRepoListItem[]>("GET", `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
			for (const r of list) out.push({ owner: r.owner.login, name: r.name, private: r.private, updated: r.updated_at, defaultBranch: r.default_branch });
			if (list.length < 100) break;
		}
		return out;
	}

	/** Number of files on a branch (0 if the branch or repo is empty). */
	async countFiles(branch: string): Promise<number> {
		const head = await this.getRef(branch);
		if (!head) return 0;
		return (await this.listTree(await this.getCommitTree(head))).filter((e) => e.type === "blob").length;
	}

	async createRepo(name: string, org?: string): Promise<{ html_url: string }> {
		const path = org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos";
		return this.json<{ html_url: string }>("POST", path, {
			name,
			private: true,
			auto_init: false,
			description: "Obsidian vault (synced by Vault Sync for Git)",
		});
	}

	// ---- refs / commits / trees / blobs ----

	/** Head commit sha of a branch, or null if the branch (or the whole repo) is empty/missing. */
	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.repoPath}/git/ref/heads/${encPath(branch)}?_=${Date.now()}`, undefined, {
			okStatuses: [404, 409],
		});
		if (res.status === 404 || res.status === 409) return null;
		return (res.json as GhRef).object.sha;
	}

	async createRef(ref: string, sha: string): Promise<void> {
		await this.json<unknown>("POST", `${this.repoPath}/git/refs`, { ref, sha });
	}

	/** Fast-forward only. Returns false if someone else pushed first. */
	async updateRef(branch: string, sha: string): Promise<boolean> {
		const res = await this.request(
			"PATCH",
			`${this.repoPath}/git/refs/heads/${encPath(branch)}`,
			{ sha, force: false },
			{ okStatuses: [409, 422] },
		);
		if (res.status < 300) return true;
		// Only a non-fast-forward means "another device pushed first"; anything else (e.g. a protected
		// branch) is a real error the user must see, not something to retry.
		const msg = String(safeJson(res)?.message ?? "");
		if (/fast[- ]forward/i.test(msg) || res.status === 409) return false;
		throw new GitHubError(`Could not update branch ${branch}: ${msg || `HTTP ${res.status}`}`, res.status);
	}

	/**
	 * How `head` relates to `base`: "ahead" (head contains base), "behind" (head is older),
	 * "identical", "diverged" (history rewritten), or "missing" (base commit no longer exists).
	 */
	async compare(base: string, head: string): Promise<Relation> {
		const res = await this.request("GET", `${this.repoPath}/compare/${base}...${head}?per_page=1`, undefined, {
			okStatuses: [404],
		});
		return res.status === 404 ? "missing" : (res.json as { status: Relation }).status;
	}

	async getCommitTree(sha: string): Promise<string> {
		return (await this.json<GhCommit>("GET", `${this.repoPath}/git/commits/${sha}`)).tree.sha;
	}

	async getTree(sha: string, recursive: boolean): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
		return this.json<GhTree>("GET", `${this.repoPath}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
	}

	/** Full file list of a tree, walking sub-trees if GitHub truncated the recursive listing. */
	async listTree(sha: string): Promise<TreeEntry[]> {
		const res = await this.getTree(sha, true);
		if (!res.truncated) return res.tree;
		const out: TreeEntry[] = [];
		const walk = async (treeSha: string, prefix: string) => {
			const t = await this.getTree(treeSha, false);
			for (const e of t.tree) {
				const p = prefix ? `${prefix}/${e.path}` : e.path;
				if (e.type === "tree") await walk(e.sha, p);
				else out.push({ ...e, path: p });
			}
		};
		await walk(sha, "");
		return out;
	}

	async getBlob(sha: string): Promise<ArrayBuffer> {
		const res = await this.request("GET", `${this.repoPath}/git/blobs/${sha}`, undefined, {
			accept: "application/vnd.github.raw+json",
		});
		return res.arrayBuffer;
	}

	async createBlob(base64: string): Promise<string> {
		return (await this.json<GhSha>("POST", `${this.repoPath}/git/blobs`, { content: base64, encoding: "base64" })).sha;
	}

	async createTree(baseTree: string | null, tree: NewTreeEntry[]): Promise<string> {
		const body: Record<string, unknown> = { tree };
		if (baseTree) body.base_tree = baseTree;
		return (await this.json<GhSha>("POST", `${this.repoPath}/git/trees`, body)).sha;
	}

	async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
		return (await this.json<GhSha>("POST", `${this.repoPath}/git/commits`, { message, tree, parents })).sha;
	}

	/** Creates the first commit in an empty repo (the Git Data API refuses to work on empty repos). */
	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		await this.json<unknown>("PUT", `${this.repoPath}/contents/${encPath(path)}`, { message, content: base64, branch });
	}

	/** Core API budget. This endpoint does not count against the limit. */
	async rateLimit(): Promise<{ limit: number; remaining: number; reset: number } | null> {
		return (await this.json<GhRateLimit>("GET", "/rate_limit")).resources.core;
	}

	async listTags(): Promise<{ name: string; sha: string }[]> {
		const list = await this.json<GhTag[]>("GET", `${this.repoPath}/tags?per_page=100`);
		return list.map((t) => ({ name: t.name, sha: t.commit.sha }));
	}

	// ---- history ----

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ sha: branch, per_page: String(perPage) });
		if (path) q.set("path", path);
		const list = await this.json<GhCommitListItem[]>("GET", `${this.repoPath}/commits?${q.toString()}`);
		return list.map((c) => ({
			sha: c.sha,
			message: c.commit.message,
			date: c.commit.author?.date ?? c.commit.committer?.date ?? "",
			author: c.commit.author?.name ?? "",
		}));
	}

	async getCommitFiles(sha: string): Promise<{ parent: string | null; files: { filename: string; status: string }[] }> {
		const c = await this.json<GhCommitDetail>("GET", `${this.repoPath}/commits/${sha}`);
		return { parent: c.parents?.[0]?.sha ?? null, files: c.files ?? [] };
	}

	/** File content at a commit, or null if it did not exist there. */
	async getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		const res = await this.request(
			"GET",
			`${this.repoPath}/contents/${encPath(path)}?ref=${encodeURIComponent(ref)}`,
			undefined,
			{ accept: "application/vnd.github.raw+json", okStatuses: [404] },
		);
		return res.status === 404 ? null : res.arrayBuffer;
	}
}
