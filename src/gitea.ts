// Gitea / Forgejo (including Codeberg) via API v1. Commits use the ChangeFiles endpoint
// (POST /repos/{owner}/{repo}/contents), which writes many files in one atomic commit.

import { b64decode, b64encode, compareByWalking, header, httpRequest, obsidianTransport } from "./http.ts";
import type { HttpResponse, Transport } from "./http.ts";
import { NotFastForward } from "./remote.ts";
import { SyncError } from "./errors.ts";
import type { BlobHint, CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry, WebLink } from "./remote.ts";
import { gitBlobSha } from "./util.ts";

export interface HostConfig {
	token: string;
	apiBase: string;
	owner: string;
	repo: string;
	/** Refresh a sign-in token after a 401 (GitHub, GitLab); true = retry with the new token. */
	onUnauthorized?: (failedToken: string) => Promise<boolean>;
	/** The token is an OAuth access token (GitLab sign-in): sent as Bearer instead of PRIVATE-TOKEN. */
	bearer?: boolean;
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

// Shapes of the Gitea API responses this client reads (only the fields used).
interface GtUser { login?: string; username?: string }
interface GtRepo { private?: boolean; default_branch?: string; html_url: string; size?: number; name: string; updated_at: string; owner?: GtUser }
interface GtBranch { name?: string; commit?: { id?: string } }
interface GtCommit { sha: string; commit?: { tree?: { sha: string }; message?: string; author?: { name?: string; date?: string } }; tree?: { sha: string }; created?: string; parents?: { sha: string }[]; files?: { filename: string; status: string; previous_filename?: string }[] }
interface GtTree { tree?: TreeEntry[]; truncated?: boolean }
interface GtBlob { content?: string | null; size?: number }
interface GtTag { name: string; id?: string; commit?: { sha: string } }
interface GtChangeFiles { commit?: { sha: string; parents?: { sha: string }[] }; sha?: string; parents?: { sha: string }[] }
// Keep each ChangeFiles request comfortably under typical proxy body limits.
const BATCH_BYTES = 8 * 1024 * 1024;

export class Gitea implements Remote {
	readonly kind = "gitea" as const;
	readonly label = "Gitea";
	private cfg: () => HostConfig;
	private transport: Transport;

	constructor(cfg: () => HostConfig, transport: Transport = obsidianTransport) {
		this.cfg = cfg;
		this.transport = transport;
	}

	private get base() {
		return this.cfg().apiBase.replace(/\/+$/, "");
	}
	private get repoPath() {
		const c = this.cfg();
		return `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
	}

	gitUrl(): string {
		const c = this.cfg();
		return `${this.base.replace(/\/api\/v1$/i, "")}/${c.owner}/${c.repo}.git`;
	}
	authHeader(): string {
		return `Basic ${btoa(`oauth2:${this.cfg().token}`)}`;
	}
	/** Web pages: /src/{commit|branch}/<ref>/<path> and /commits/{commit|branch}/<ref>/<path>. */
	webUrl(kind: WebLink, path: string, ref: string): string | null {
		const c = this.cfg();
		const repo = `${this.base.replace(/\/api\/v1$/i, "")}/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
		if (kind === "repo") return repo;
		const refPart = /^[0-9a-f]{40}$/i.test(ref) ? `commit/${ref}` : `branch/${encPath(ref)}`;
		const tail = path ? `/${encPath(path)}` : "";
		return `${repo}/${kind === "file" ? "src" : "commits"}/${refPart}${tail}`;
	}

	async request(method: string, path: string, body?: unknown, opts: { accept?: string; okStatuses?: number[] } = {}): Promise<HttpResponse> {
		const c = this.cfg();
		if (!c.token) throw new SyncError("noToken", { host: this.label });
		return httpRequest(
			this.transport,
			{
				url: this.base + path,
				method,
				headers: { Authorization: `token ${c.token}`, Accept: opts.accept ?? "application/json" },
				body: body !== undefined ? JSON.stringify(body) : undefined,
				contentType: body !== undefined ? "application/json" : undefined,
			},
			{ okStatuses: opts.okStatuses, hostLabel: this.label },
		);
	}
	private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		return (await this.request(method, path, body)).json as T;
	}

	async getUser() {
		const u = await this.json<GtUser>("GET", "/user");
		return { login: u.login ?? u.username ?? "" };
	}
	async getRepo() {
		const res = await this.request("GET", this.repoPath, undefined, { okStatuses: [404] });
		if (res.status === 404) return null;
		const r = res.json as GtRepo;
		return { private: !!r.private, default_branch: r.default_branch || "main", html_url: r.html_url, size: r.size ?? 0 };
	}
	async createRepo(name: string, org?: string) {
		const r = await this.json<GtRepo>("POST", org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos", { name, private: true, auto_init: false, description: "Obsidian vault (synced by Vault Sync)" });
		return { html_url: r.html_url };
	}
	async listRepos(maxPages = 6) {
		const out: { owner: string; name: string; private: boolean; updated: string; defaultBranch: string }[] = [];
		for (let page = 1; page <= maxPages; page++) {
			// Servers may return fewer than asked per page (MAX_RESPONSE_ITEMS): only an empty page ends the list.
			const list = (await this.json<GtRepo[] | null>("GET", `/user/repos?limit=50&page=${page}`)) ?? [];
			if (!list.length) break;
			for (const r of list) out.push({ owner: r.owner?.login ?? r.owner?.username ?? "", name: r.name, private: !!r.private, updated: r.updated_at, defaultBranch: r.default_branch || "main" });
		}
		return out.sort((a, b) => b.updated.localeCompare(a.updated));
	}

	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.repoPath}/branches/${encPath(branch)}?_=${Date.now()}`, undefined, { okStatuses: [404, 409] });
		return res.status < 300 ? ((res.json as GtBranch).commit?.id ?? null) : null;
	}
	async createRef(ref: string, sha: string): Promise<void> {
		if (ref.startsWith("refs/tags/")) await this.json<unknown>("POST", `${this.repoPath}/tags`, { tag_name: ref.slice(10), target: sha });
		else await this.json<unknown>("POST", `${this.repoPath}/branches`, { new_branch_name: ref.replace(/^refs\/heads\//, ""), old_ref_name: sha });
	}
	async getCommitTree(sha: string): Promise<string> {
		const c = await this.json<GtCommit>("GET", `${this.repoPath}/git/commits/${sha}?stat=false&files=false`);
		const tree = c.commit?.tree?.sha ?? c.tree?.sha;
		if (!tree) throw new SyncError("commitNoTree", { sha });
		return tree;
	}
	async listTree(treeSha: string): Promise<TreeEntry[]> {
		const out: TreeEntry[] = [];
		for (let page = 1; page < 1000; page++) {
			const t = await this.json<GtTree>("GET", `${this.repoPath}/git/trees/${treeSha}?recursive=true&per_page=1000&page=${page}`);
			for (const e of t.tree ?? []) out.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, size: e.size });
			if (!t.truncated || !(t.tree ?? []).length) return out;
		}
		// Stopping here would return a partial listing, and the missing files would look deleted.
		throw new SyncError("repoTooLarge", { host: this.label });
	}
	/**
	 * Blob content. Above the server's blob size limit (DEFAULT_MAX_BLOB_SIZE, 10 MiB by default)
	 * /git/blobs returns no content; then the file is read through /raw/{path} when the caller says
	 * where the blob lives, and checked against `sha`. Never returns empty bytes for a non-empty blob.
	 */
	async getBlob(sha: string, hint?: BlobHint): Promise<ArrayBuffer> {
		const b = await this.json<GtBlob>("GET", `${this.repoPath}/git/blobs/${sha}`);
		const size = typeof b.size === "number" ? b.size : null;
		if (typeof b.content === "string" && (b.content !== "" || !size)) {
			const data = b64decode(b.content);
			if (size === null || data.byteLength === size) return data;
		}
		if (!hint) throw new SyncError("blobTooLarge", { host: this.label });
		const data = await this.getFileAt(hint.path, hint.ref);
		if (!data || (await gitBlobSha(data)) !== sha) throw new SyncError("blobTooLargeMismatch", { host: this.label });
		return data;
	}
	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		await this.json<unknown>("POST", `${this.repoPath}/contents/${encPath(path)}`, { content: base64, message, branch, new_branch: branch });
	}

	/**
	 * ChangeFiles needs to know which files already exist (update vs create) and their blob shas
	 * (optimistic locking). Large changes are split into several commits.
	 */
	async commit(req: CommitRequest): Promise<CommitResult> {
		const head = await this.getRef(req.branch);
		if (head !== req.parent) throw new NotFastForward();
		const existing = req.existing ?? new Map((await this.listTree(req.parentTree)).filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

		type Op = { operation: "create" | "update" | "delete"; path: string; content?: string; sha?: string };
		let parent = req.parent;
		let fastForward = true;
		let part = 0;
		const send = async (files: Op[], last: boolean) => {
			if (!files.length) return;
			part++;
			const [subject, ...rest] = req.message.split("\n");
			const message = part > 1 || !last ? `${subject} (part ${part})\n${rest.join("\n")}` : req.message;
			const author = req.author ? { author: { name: req.author.name, email: req.author.email } } : {};
			const res = await this.request("POST", `${this.repoPath}/contents`, { branch: req.branch, message, files, ...author }, { okStatuses: [409, 422] });
			if (res.status === 409) throw new NotFastForward();
			if (res.status === 422) {
				const m = String((res.json as { message?: string } | null)?.message ?? "");
				// sha mismatch = someone changed the file meanwhile; other 422s are real errors.
				if (/sha|does not match|already exists|not exist/i.test(m)) throw new NotFastForward();
				throw new SyncError("commitRefused", { host: this.label, detail: m || "HTTP 422" });
			}
			const body = res.json as GtChangeFiles;
			const c = body.commit ?? { sha: body.sha ?? "", parents: body.parents };
			const parents = (c.parents ?? []).map((x) => x.sha);
			if (parents.length && parents[0] !== parent) fastForward = false;
			if (!c.sha) throw new SyncError("commitNotCreated", { host: this.label });
			parent = c.sha;
		};

		// Send each batch as soon as it is full, so memory stays bounded on phones.
		let batch: Op[] = [];
		let bytes = 0;
		let done = 0;
		for (const u of req.upserts) {
			const data = await u.load();
			if (bytes + data.byteLength > BATCH_BYTES && batch.length) {
				await send(batch, false);
				batch = [];
				bytes = 0;
			}
			const prev = existing.get(u.path);
			batch.push(prev ? { operation: "update", path: u.path, content: b64encode(data), sha: prev } : { operation: "create", path: u.path, content: b64encode(data) });
			bytes += data.byteLength;
			req.progress?.(++done, req.upserts.length);
		}
		for (const p of req.deletes) {
			const prev = existing.get(p);
			if (prev) batch.push({ operation: "delete", path: p, sha: prev });
		}
		await send(batch, true);
		return { sha: parent, fastForward };
	}

	/** All branches (GET /repos/{owner}/{repo}/branches). Pages may be clamped: only an empty page ends the list. */
	async listBranches(): Promise<{ name: string; sha: string }[]> {
		const out: { name: string; sha: string }[] = [];
		for (let page = 1; page <= 60; page++) {
			const list = (await this.json<GtBranch[] | null>("GET", `${this.repoPath}/branches?limit=50&page=${page}`)) ?? [];
			if (!list.length) break;
			for (const b of list) if (b.name) out.push({ name: b.name, sha: b.commit?.id ?? "" });
		}
		return out;
	}

	async createPullRequest(head: string, base: string, title: string, body: string): Promise<{ url: string }> {
		const pr = await this.json<{ html_url: string }>("POST", `${this.repoPath}/pulls`, { head, base, title, body });
		return { url: pr.html_url };
	}

	async compare(base: string, head: string): Promise<Relation> {
		const exists = await this.request("GET", `${this.repoPath}/git/commits/${base}?stat=false&files=false`, undefined, { okStatuses: [404, 422] });
		if (exists.status >= 300) return "missing";
		// Gitea may return fewer than `limit` items per page (MAX_RESPONSE_ITEMS), so rely on X-HasMore
		// when the server sends it and otherwise on an empty page.
		return compareByWalking(
			async (sha, page) => {
				const res = await this.request("GET", `${this.repoPath}/commits?sha=${sha}&limit=50&page=${page}&stat=false&files=false&verification=false`);
				const hasMore = header(res, "x-hasmore");
				return { shas: ((res.json as GtCommit[] | null) ?? []).map((c) => c.sha), more: hasMore === undefined ? undefined : hasMore === "true" };
			},
			base,
			head,
		);
	}

	async listCommits(branch: string, path?: string, perPage = 30, page = 1): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ sha: branch, limit: String(perPage), stat: "false", files: "false", verification: "false" });
		if (page > 1) q.set("page", String(page));
		if (path) q.set("path", path);
		const list = await this.json<GtCommit[]>("GET", `${this.repoPath}/commits?${q.toString()}`);
		return list.map((c) => ({ sha: c.sha, message: c.commit?.message ?? "", date: c.commit?.author?.date ?? c.created ?? "", author: c.commit?.author?.name ?? "" }));
	}
	async getCommitFiles(sha: string) {
		const c = await this.json<GtCommit>("GET", `${this.repoPath}/git/commits/${sha}?stat=false&files=true`);
		return {
			parent: c.parents?.[0]?.sha ?? null,
			files: (c.files ?? []).map((f) =>
				// A rename names its old path (history shows "old → new" and restores from the old path).
				f.previous_filename && f.previous_filename !== f.filename
					? { filename: f.filename, status: "renamed", previous: f.previous_filename }
					: { filename: f.filename, status: f.status === "deleted" ? "removed" : f.status },
			),
		};
	}
	async getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		const res = await this.request("GET", `${this.repoPath}/raw/${encPath(path)}?ref=${encodeURIComponent(ref)}`, undefined, { accept: "*/*", okStatuses: [404] });
		return res.status === 404 ? null : res.arrayBuffer;
	}
	async listTags() {
		// Pages may be shorter than `limit` (server-side clamp): only an empty page ends the list.
		const out: { name: string; sha: string }[] = [];
		for (let page = 1; page <= 30; page++) {
			const list = (await this.json<GtTag[] | null>("GET", `${this.repoPath}/tags?limit=50&page=${page}`)) ?? [];
			if (!list.length) break;
			for (const t of list) out.push({ name: t.name, sha: t.commit?.sha ?? t.id ?? "" });
		}
		return out;
	}
	async rateLimit() {
		return null;
	}
	async countFiles(branch: string): Promise<number> {
		const head = await this.getRef(branch);
		if (!head) return 0;
		return (await this.listTree(await this.getCommitTree(head))).filter((e) => e.type === "blob").length;
	}
}
