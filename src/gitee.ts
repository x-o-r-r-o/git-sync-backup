// Gitee (gitee.com) via API v5 (https://gitee.com/api/v5/swagger).
//
// IMPORTANT: Gitee has no atomic multi-file commit endpoint. commit() writes each file with the
// per-file contents API (POST create, PUT update with the blob sha, DELETE with the blob sha), so a
// sync of N changed files produces N commits on the branch, applied one after another. This is not
// atomic: if another device pushes mid-way, Gitee rejects the next stale write (blob sha lock) and we
// throw NotFastForward after a partial push. That is safe: the engine re-reads the remote and the next
// sync converges, because every file write we did make is a complete, correct file.
//
// Before writing anything we check that the branch head is still `req.parent`. Between our own
// per-file commits, a commit whose parent is not our previous commit means someone else pushed in the
// meantime (on other files); we keep going and report fastForward: false.
//
// Other limitations: the contents API cannot set the executable bit or write symlinks/submodules
// (every file is written as 100644), and Gitee refuses large files through the API (we refuse files
// over GITEE_MAX_FILE_BYTES up front with a clear message). Authentication uses the personal access
// token in an `Authorization: token <t>` header, which Gitee reads like the `access_token` parameter,
// so the token never appears in URLs.

import { b64decode, b64encode, compareByWalking, header, httpRequest, obsidianTransport } from "./http.ts";
import type { HttpResponse, Transport } from "./http.ts";
import type { HostConfig } from "./gitea.ts";
import { NotFastForward, RemoteError } from "./remote.ts";
import type { CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry, WebLink } from "./remote.ts";

/** Largest file we send through the contents API (Gitee's per-file limit for free accounts). */
export const GITEE_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_API = "https://gitee.com/api/v5";
const PER_PAGE = 100;

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const stripGit = (u: string) => u.replace(/\.git$/i, "");

// Shapes of the Gitee API responses this client reads (only the fields used).
interface GeUser { login?: string; name?: string }
interface GeRepo { private?: boolean; public?: boolean; default_branch?: string; html_url?: string; size?: number | null; name: string; path?: string; full_name?: string; updated_at?: string; pushed_at?: string; owner?: GeUser; namespace?: { path?: string } }
interface GeBranch { name: string; commit?: { sha?: string } }
interface GeCommit { sha: string; commit?: { tree?: { sha: string }; message?: string; author?: { name?: string; date?: string }; committer?: { date?: string } }; parents?: { sha: string }[]; files?: { filename: string; status?: string }[] }
interface GeTree { tree?: TreeEntry[]; truncated?: boolean }
interface GeBlob { content?: string }
interface GeTag { name: string; commit?: { sha?: string } }
interface GeWrite { content?: { sha?: string } | null; commit?: { sha?: string; parents?: { sha: string }[] } }

export class Gitee implements Remote {
	readonly kind = "gitee" as const;
	readonly label = "Gitee";
	private cfg: () => HostConfig;
	private transport: Transport;

	constructor(cfg: () => HostConfig, transport: Transport = obsidianTransport) {
		this.cfg = cfg;
		this.transport = transport;
	}

	private get base() {
		return (this.cfg().apiBase || DEFAULT_API).replace(/\/+$/, "");
	}
	/** Web root (https://gitee.com) derived from the API base. */
	private get web() {
		return this.base.replace(/\/api\/v5$/i, "");
	}
	private get repoPath() {
		const c = this.cfg();
		return `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
	}

	gitUrl(): string {
		const c = this.cfg();
		return `${this.web}/${c.owner}/${c.repo}.git`;
	}
	authHeader(): string {
		return `Basic ${btoa(`oauth2:${this.cfg().token}`)}`;
	}

	async request(method: string, path: string, body?: unknown, opts: { accept?: string; okStatuses?: number[] } = {}): Promise<HttpResponse> {
		const c = this.cfg();
		if (!c.token) throw new Error("No token set. Add one in the plugin settings.");
		return httpRequest(
			this.transport,
			{
				url: path.startsWith("http") ? path : this.base + path,
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
	/**
	 * Reads a paged list until an empty page, the last page by Gitee's total_page header, or a page
	 * that repeats the previous one (an endpoint that ignores paging).
	 */
	private async paged<T>(path: string, maxPages: number, key: (x: T) => string): Promise<T[]> {
		const out: T[] = [];
		const seen = new Set<string>();
		const sep = path.includes("?") ? "&" : "?";
		for (let page = 1; page <= maxPages; page++) {
			const res = await this.request("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
			const list = (res.json as T[] | null) ?? [];
			if (!list.length || seen.has(key(list[0]))) break;
			for (const x of list) {
				seen.add(key(x));
				out.push(x);
			}
			const total = Number(header(res, "total_page") ?? NaN);
			if (Number.isFinite(total) ? page >= total : list.length < PER_PAGE) break;
		}
		return out;
	}

	// ---------- account / repo ----------

	async getUser() {
		const u = await this.json<GeUser>("GET", "/user");
		return { login: u.login ?? "" };
	}
	async getRepo() {
		const res = await this.request("GET", this.repoPath, undefined, { okStatuses: [404] });
		if (res.status === 404) return null;
		const r = res.json as GeRepo;
		return { private: r.private ?? r.public === false, default_branch: r.default_branch || "master", html_url: stripGit(r.html_url ?? ""), size: r.size ?? 0 };
	}
	async createRepo(name: string, org?: string) {
		const r = await this.json<GeRepo>("POST", org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos", { name, path: name, private: true, auto_init: false, description: "Obsidian vault (synced by Vault Sync)" });
		return { html_url: stripGit(r.html_url ?? "") };
	}
	async listRepos(maxPages = 3) {
		const list = await this.paged<GeRepo>("/user/repos?sort=updated&direction=desc", maxPages, (r) => r.full_name ?? r.name);
		return list
			.map((r) => {
				const [owner, slug] = (r.full_name ?? "").split("/");
				return { owner: owner || r.namespace?.path || r.owner?.login || "", name: slug || r.path || r.name, private: r.private ?? r.public === false, updated: r.updated_at ?? r.pushed_at ?? "", defaultBranch: r.default_branch || "master" };
			})
			.sort((a, b) => b.updated.localeCompare(a.updated));
	}

	// ---------- refs ----------

	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.repoPath}/branches/${encPath(branch)}?_=${Date.now()}`, undefined, { okStatuses: [400, 404, 409] });
		return res.status < 300 ? ((res.json as GeBranch).commit?.sha ?? null) : null;
	}
	async createRef(ref: string, sha: string): Promise<void> {
		if (ref.startsWith("refs/tags/")) await this.json<unknown>("POST", `${this.repoPath}/tags`, { refs: sha, tag_name: ref.slice(10) });
		else await this.json<unknown>("POST", `${this.repoPath}/branches`, { refs: sha, branch_name: ref.replace(/^refs\/heads\//, "") });
	}
	async listBranches() {
		const list = await this.paged<GeBranch>(`${this.repoPath}/branches`, 20, (b) => b.name);
		return list.map((b) => ({ name: b.name, sha: b.commit?.sha ?? "" }));
	}
	async getCommitTree(sha: string): Promise<string> {
		const c = await this.json<GeCommit>("GET", `${this.repoPath}/commits/${sha}`);
		const tree = c.commit?.tree?.sha;
		if (!tree) throw new Error(`Commit ${sha} has no tree`);
		return tree;
	}

	// ---------- content ----------

	async listTree(treeSha: string): Promise<TreeEntry[]> {
		const t = await this.json<GeTree>("GET", `${this.repoPath}/git/trees/${treeSha}?recursive=1`);
		if (!t.truncated) return (t.tree ?? []).map((e) => ({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, size: e.size }));
		// Too large for one recursive listing: walk the folders one level at a time.
		const out: TreeEntry[] = [];
		const walk = async (sha: string, prefix: string) => {
			const level = await this.json<GeTree>("GET", `${this.repoPath}/git/trees/${sha}`);
			for (const e of level.tree ?? []) {
				const path = prefix + e.path;
				if (e.type === "tree") await walk(e.sha, `${path}/`);
				else out.push({ path, mode: e.mode, type: e.type, sha: e.sha, size: e.size });
			}
		};
		await walk(treeSha, "");
		return out;
	}
	async getBlob(sha: string): Promise<ArrayBuffer> {
		const b = await this.json<GeBlob>("GET", `${this.repoPath}/git/blobs/${sha}`);
		return b64decode(b.content ?? "");
	}
	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		await this.json<unknown>("POST", `${this.repoPath}/contents/${encPath(path)}`, { content: base64, message, branch });
	}

	/** Turns a refused contents write into NotFastForward (stale sha / file state) or a readable error. */
	private refused(res: HttpResponse, path: string): Error {
		const raw = (res.json as { message?: unknown } | null)?.message;
		const m = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : JSON.stringify(raw);
		if (res.status === 413 || /too large|too big|exceed|过大|超过|超出/i.test(m)) return new RemoteError(`Gitee refused "${path}": the file is too large for Gitee's API.`, res.status);
		if (res.status === 409 || /sha|exist|conflict|match|changed|已存在|不存在|冲突|不一致|不匹配/i.test(m)) return new NotFastForward();
		return new RemoteError(`Gitee refused the commit of "${path}": ${m || `HTTP ${res.status}`}`, res.status);
	}

	/** Per-file commits (see the header comment): one Gitee commit for each upsert and delete. */
	async commit(req: CommitRequest): Promise<CommitResult> {
		const head = await this.getRef(req.branch);
		if (head !== req.parent) throw new NotFastForward();
		const existing = req.existing ?? new Map((await this.listTree(req.parentTree)).filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
		const deletes = req.deletes.filter((p) => existing.has(p));
		const total = req.upserts.length + deletes.length;
		const [subject, ...rest] = req.message.split("\n");
		const body = rest.length ? `\n${rest.join("\n")}` : "";
		const who = req.author ? { author: { name: req.author.name, email: req.author.email }, committer: { name: req.author.name, email: req.author.email } } : {};

		let parent = req.parent;
		let fastForward = true;
		let n = 0;
		const blobShas = new Map<string, string>();
		const write = async (method: "POST" | "PUT" | "DELETE", path: string, payload: Record<string, unknown>) => {
			n++;
			const message = total > 1 ? `${subject} (${n}/${total})${body}` : req.message;
			const url = `${this.repoPath}/contents/${encPath(path)}`;
			const okStatuses = [400, 404, 409, 413, 422];
			let res: HttpResponse;
			if (method === "DELETE") {
				// Gitee reads DELETE parameters from the query string.
				const q = new URLSearchParams({ sha: String(payload.sha), message, branch: req.branch });
				if (req.author) {
					q.set("author[name]", req.author.name);
					q.set("author[email]", req.author.email);
				}
				res = await this.request("DELETE", `${url}?${q.toString()}`, undefined, { okStatuses });
			} else res = await this.request(method, url, { ...payload, message, branch: req.branch, ...who }, { okStatuses });
			if (res.status >= 300) throw this.refused(res, path);
			const w = (res.json ?? {}) as GeWrite;
			let sha = w.commit?.sha;
			const parents = (w.commit?.parents ?? []).map((p) => p.sha);
			if (!sha) {
				// Older responses may omit the commit: read the new head instead.
				sha = (await this.getRef(req.branch)) ?? undefined;
				if (!sha || sha === parent) throw new Error("Gitee did not return the new commit");
			} else if (parents.length && parents[0] !== parent) fastForward = false;
			if (w.content?.sha) blobShas.set(path, w.content.sha);
			parent = sha;
		};

		let done = 0;
		for (const u of req.upserts) {
			const data = await u.load();
			if (data.byteLength > GITEE_MAX_FILE_BYTES) {
				throw new RemoteError(`"${u.path}" is ${(data.byteLength / 1048576).toFixed(1)} MB; Gitee's API accepts files up to ${GITEE_MAX_FILE_BYTES / 1048576} MB. Exclude it from sync or make it smaller.`, 413);
			}
			const prev = existing.get(u.path);
			if (prev) await write("PUT", u.path, { content: b64encode(data), sha: prev });
			else await write("POST", u.path, { content: b64encode(data) });
			req.progress?.(++done, req.upserts.length);
		}
		for (const p of deletes) await write("DELETE", p, { sha: existing.get(p) });
		return { sha: parent, fastForward, blobShas };
	}

	async compare(base: string, head: string): Promise<Relation> {
		if (base === head) return "identical";
		const exists = await this.request("GET", `${this.repoPath}/commits/${base}`, undefined, { okStatuses: [400, 404, 422] });
		if (exists.status >= 300) return "missing";
		return compareByWalking(
			async (sha, page) => {
				const res = await this.request("GET", `${this.repoPath}/commits?sha=${sha}&per_page=${PER_PAGE}&page=${page}`);
				const total = Number(header(res, "total_page") ?? NaN);
				return { shas: ((res.json as GeCommit[] | null) ?? []).map((c) => c.sha), more: Number.isFinite(total) ? page < total : undefined };
			},
			base,
			head,
		);
	}

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ sha: branch, per_page: String(Math.min(perPage, PER_PAGE)) });
		if (path) q.set("path", path);
		const list = await this.json<GeCommit[]>("GET", `${this.repoPath}/commits?${q.toString()}`);
		return list.map((c) => ({ sha: c.sha, message: c.commit?.message ?? "", date: c.commit?.author?.date ?? c.commit?.committer?.date ?? "", author: c.commit?.author?.name ?? "" }));
	}
	async getCommitFiles(sha: string) {
		const c = await this.json<GeCommit>("GET", `${this.repoPath}/commits/${sha}`);
		return { parent: c.parents?.[0]?.sha ?? null, files: (c.files ?? []).map((f) => ({ filename: f.filename, status: f.status === "deleted" ? "removed" : (f.status ?? "modified") })) };
	}
	async getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		const res = await this.request("GET", `${this.repoPath}/raw/${encPath(path)}?ref=${encodeURIComponent(ref)}`, undefined, { accept: "*/*", okStatuses: [404] });
		return res.status === 404 ? null : res.arrayBuffer;
	}
	async listTags() {
		const list = await this.paged<GeTag>(`${this.repoPath}/tags`, 30, (t) => t.name);
		return list.map((t) => ({ name: t.name, sha: t.commit?.sha ?? "" }));
	}
	async rateLimit() {
		return null;
	}
	async countFiles(branch: string): Promise<number> {
		const head = await this.getRef(branch);
		if (!head) return 0;
		return (await this.listTree(await this.getCommitTree(head))).filter((e) => e.type === "blob").length;
	}

	// ---------- web ----------

	webUrl(kind: WebLink, path: string, ref: string): string | null {
		const c = this.cfg();
		const repo = `${this.web}/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
		if (kind === "repo") return repo;
		const r = encPath(ref);
		return kind === "file" ? `${repo}/blob/${r}/${encPath(path)}` : `${repo}/commits/${r}/${encPath(path)}`;
	}
	async createPullRequest(head: string, base: string, title: string, body: string): Promise<{ url: string }> {
		const pr = await this.json<{ html_url?: string; number?: number }>("POST", `${this.repoPath}/pulls`, { title, head, base, body });
		const c = this.cfg();
		return { url: pr.html_url ?? `${this.web}/${c.owner}/${c.repo}/pulls/${pr.number ?? ""}` };
	}
}
