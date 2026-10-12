// Minimal GitHub REST client built on Obsidian's requestUrl, which works on desktop and
// mobile and is not subject to CORS. No git binary, no isomorphic-git.

import { requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import { sleep } from "./util.ts";

export interface GitHubConfig {
	token: string;
	apiBase: string;
	owner: string;
	repo: string;
}

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	size?: number;
}

export interface NewTreeEntry {
	path: string;
	mode: string;
	type: "blob";
	sha?: string | null;
	content?: string;
}

export interface CommitInfo {
	sha: string;
	message: string;
	date: string;
	author: string;
}

export class GitHubError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

function header(res: RequestUrlResponse, name: string): string | undefined {
	const h = res.headers ?? {};
	const key = Object.keys(h).find((k) => k.toLowerCase() === name);
	return key ? h[key] : undefined;
}

function safeJson(res: RequestUrlResponse): any {
	try {
		return res.json;
	} catch {
		return null;
	}
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export class GitHub {
	private cfg: () => GitHubConfig;
	constructor(cfg: () => GitHubConfig) {
		this.cfg = cfg;
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
		const c = this.cfg();
		if (!c.token) throw new GitHubError("No GitHub token set. Add one in the plugin settings.", 401);
		const url = (c.apiBase || "https://api.github.com").replace(/\/+$/, "") + path;
		let lastErr: unknown;

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

			if (res.status < 300 || opts.okStatuses?.includes(res.status)) return res;

			const data = safeJson(res);
			const msg: string = data?.message ?? `HTTP ${res.status}`;

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
			if (res.status === 401) throw new GitHubError("GitHub token is invalid or expired.", 401);
			throw new GitHubError(`${msg} (${method} ${path.split("?")[0]})`, res.status);
		}
		throw lastErr instanceof Error ? lastErr : new GitHubError("Network error talking to GitHub", 0);
	}

	private async json(method: string, path: string, body?: unknown): Promise<any> {
		return (await this.request(method, path, body)).json;
	}

	// ---- account / repo ----

	async getUser(): Promise<{ login: string }> {
		return this.json("GET", "/user");
	}

	async getRepo(): Promise<{ private: boolean; default_branch: string; html_url: string; size: number } | null> {
		const res = await this.request("GET", this.repoPath, undefined, { okStatuses: [404] });
		return res.status === 404 ? null : res.json;
	}

	async createRepo(name: string, org?: string): Promise<{ html_url: string }> {
		const path = org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos";
		return this.json("POST", path, {
			name,
			private: true,
			auto_init: false,
			description: "Obsidian vault (synced by Vault Sync for GitHub)",
		});
	}

	// ---- refs / commits / trees / blobs ----

	/** Head commit sha of a branch, or null if the branch (or the whole repo) is empty/missing. */
	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.repoPath}/git/ref/heads/${encPath(branch)}?_=${Date.now()}`, undefined, {
			okStatuses: [404, 409],
		});
		if (res.status === 404 || res.status === 409) return null;
		return res.json.object.sha;
	}

	async createRef(ref: string, sha: string): Promise<void> {
		await this.json("POST", `${this.repoPath}/git/refs`, { ref, sha });
	}

	/** Fast-forward only. Returns false if someone else pushed first. */
	async updateRef(branch: string, sha: string): Promise<boolean> {
		const res = await this.request(
			"PATCH",
			`${this.repoPath}/git/refs/heads/${encPath(branch)}`,
			{ sha, force: false },
			{ okStatuses: [409, 422] },
		);
		return res.status < 300;
	}

	/**
	 * How `head` relates to `base`: "ahead" (head contains base), "behind" (head is older),
	 * "identical", "diverged" (history rewritten), or "missing" (base commit no longer exists).
	 */
	async compare(base: string, head: string): Promise<"ahead" | "behind" | "identical" | "diverged" | "missing"> {
		const res = await this.request("GET", `${this.repoPath}/compare/${base}...${head}?per_page=1`, undefined, {
			okStatuses: [404],
		});
		return res.status === 404 ? "missing" : res.json.status;
	}

	async getCommitTree(sha: string): Promise<string> {
		return (await this.json("GET", `${this.repoPath}/git/commits/${sha}`)).tree.sha;
	}

	async getTree(sha: string, recursive: boolean): Promise<{ tree: TreeEntry[]; truncated: boolean }> {
		return this.json("GET", `${this.repoPath}/git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
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
		return (await this.json("POST", `${this.repoPath}/git/blobs`, { content: base64, encoding: "base64" })).sha;
	}

	async createTree(baseTree: string | null, tree: NewTreeEntry[]): Promise<string> {
		const body: Record<string, unknown> = { tree };
		if (baseTree) body.base_tree = baseTree;
		return (await this.json("POST", `${this.repoPath}/git/trees`, body)).sha;
	}

	async createCommit(message: string, tree: string, parents: string[]): Promise<string> {
		return (await this.json("POST", `${this.repoPath}/git/commits`, { message, tree, parents })).sha;
	}

	/** Creates the first commit in an empty repo (the Git Data API refuses to work on empty repos). */
	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		await this.json("PUT", `${this.repoPath}/contents/${encPath(path)}`, { message, content: base64, branch });
	}

	/** Core API budget. This endpoint does not count against the limit. */
	async rateLimit(): Promise<{ limit: number; remaining: number; reset: number }> {
		return (await this.json("GET", "/rate_limit")).resources.core;
	}

	async listTags(): Promise<{ name: string; sha: string }[]> {
		const list: any[] = await this.json("GET", `${this.repoPath}/tags?per_page=100`);
		return list.map((t) => ({ name: t.name, sha: t.commit.sha }));
	}

	// ---- history ----

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ sha: branch, per_page: String(perPage) });
		if (path) q.set("path", path);
		const list: any[] = await this.json("GET", `${this.repoPath}/commits?${q.toString()}`);
		return list.map((c) => ({
			sha: c.sha,
			message: c.commit.message,
			date: c.commit.author?.date ?? c.commit.committer?.date ?? "",
			author: c.commit.author?.name ?? "",
		}));
	}

	async getCommitFiles(sha: string): Promise<{ parent: string | null; files: { filename: string; status: string }[] }> {
		const c = await this.json("GET", `${this.repoPath}/commits/${sha}`);
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
