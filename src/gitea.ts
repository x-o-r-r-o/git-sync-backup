// Gitea / Forgejo (including Codeberg) via API v1. Commits use the ChangeFiles endpoint
// (POST /repos/{owner}/{repo}/contents), which writes many files in one atomic commit.

import { b64decode, b64encode, compareByWalking, httpRequest, obsidianTransport } from "./http.ts";
import type { HttpResponse, Transport } from "./http.ts";
import { NotFastForward } from "./remote.ts";
import type { CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry } from "./remote.ts";

export interface HostConfig {
	token: string;
	apiBase: string;
	owner: string;
	repo: string;
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
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

	async request(method: string, path: string, body?: unknown, opts: { accept?: string; okStatuses?: number[] } = {}): Promise<HttpResponse> {
		const c = this.cfg();
		if (!c.token) throw new Error("No token set. Add one in the plugin settings.");
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
	private async json(method: string, path: string, body?: unknown): Promise<any> {
		return (await this.request(method, path, body)).json;
	}

	async getUser() {
		const u = await this.json("GET", "/user");
		return { login: u.login ?? u.username };
	}
	async getRepo() {
		const res = await this.request("GET", this.repoPath, undefined, { okStatuses: [404] });
		if (res.status === 404) return null;
		const r = res.json;
		return { private: !!r.private, default_branch: r.default_branch || "main", html_url: r.html_url, size: r.size ?? 0 };
	}
	async createRepo(name: string, org?: string) {
		const r = await this.json("POST", org ? `/orgs/${encodeURIComponent(org)}/repos` : "/user/repos", { name, private: true, auto_init: false, description: "Obsidian vault (synced by Vault Sync)" });
		return { html_url: r.html_url };
	}
	async listRepos(maxPages = 3) {
		const out: { owner: string; name: string; private: boolean; updated: string; defaultBranch: string }[] = [];
		for (let page = 1; page <= maxPages; page++) {
			const list: any[] = await this.json("GET", `/user/repos?limit=50&page=${page}`);
			for (const r of list) out.push({ owner: r.owner?.login ?? r.owner?.username, name: r.name, private: !!r.private, updated: r.updated_at, defaultBranch: r.default_branch || "main" });
			if (list.length < 50) break;
		}
		return out.sort((a, b) => b.updated.localeCompare(a.updated));
	}

	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.repoPath}/branches/${encPath(branch)}?_=${Date.now()}`, undefined, { okStatuses: [404, 409] });
		return res.status < 300 ? (res.json.commit?.id ?? null) : null;
	}
	async createRef(ref: string, sha: string): Promise<void> {
		if (ref.startsWith("refs/tags/")) await this.json("POST", `${this.repoPath}/tags`, { tag_name: ref.slice(10), target: sha });
		else await this.json("POST", `${this.repoPath}/branches`, { new_branch_name: ref.replace(/^refs\/heads\//, ""), old_ref_name: sha });
	}
	async getCommitTree(sha: string): Promise<string> {
		const c = await this.json("GET", `${this.repoPath}/git/commits/${sha}?stat=false&files=false`);
		return c.commit?.tree?.sha ?? c.tree?.sha;
	}
	async listTree(treeSha: string): Promise<TreeEntry[]> {
		const out: TreeEntry[] = [];
		for (let page = 1; page < 1000; page++) {
			const t = await this.json("GET", `${this.repoPath}/git/trees/${treeSha}?recursive=true&per_page=1000&page=${page}`);
			for (const e of t.tree ?? []) out.push({ path: e.path, mode: e.mode, type: e.type, sha: e.sha, size: e.size });
			if (!t.truncated || !(t.tree ?? []).length) break;
		}
		return out;
	}
	async getBlob(sha: string): Promise<ArrayBuffer> {
		const b = await this.json("GET", `${this.repoPath}/git/blobs/${sha}`);
		return b64decode(b.content ?? "");
	}
	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		await this.json("POST", `${this.repoPath}/contents/${encPath(path)}`, { content: base64, message, branch, new_branch: branch });
	}

	/**
	 * ChangeFiles needs to know which files already exist (update vs create) and their blob shas
	 * (optimistic locking). Large changes are split into several commits.
	 */
	async commit(req: CommitRequest): Promise<CommitResult> {
		const head = await this.getRef(req.branch);
		if (head !== req.parent) throw new NotFastForward();
		const existing = new Map((await this.listTree(req.parentTree)).filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));

		type Op = { operation: "create" | "update" | "delete"; path: string; content?: string; sha?: string };
		let parent = req.parent;
		let fastForward = true;
		let part = 0;
		const send = async (files: Op[], last: boolean) => {
			if (!files.length) return;
			part++;
			const [subject, ...rest] = req.message.split("\n");
			const message = part > 1 || !last ? `${subject} (part ${part})\n${rest.join("\n")}` : req.message;
			const res = await this.request("POST", `${this.repoPath}/contents`, { branch: req.branch, message, files }, { okStatuses: [409, 422] });
			if (res.status === 409 || res.status === 422) throw new NotFastForward();
			const c = res.json.commit ?? res.json;
			const parents: string[] = (c.parents ?? []).map((x: any) => x.sha);
			if (parents.length && parents[0] !== parent) fastForward = false;
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

	async compare(base: string, head: string): Promise<Relation> {
		const exists = await this.request("GET", `${this.repoPath}/git/commits/${base}?stat=false&files=false`, undefined, { okStatuses: [404, 422] });
		if (exists.status >= 300) return "missing";
		return compareByWalking(async (sha, page) => (await this.json("GET", `${this.repoPath}/commits?sha=${sha}&limit=50&page=${page}&stat=false&files=false&verification=false`)).map((c: any) => c.sha), base, head);
	}

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ sha: branch, limit: String(perPage), stat: "false", files: "false", verification: "false" });
		if (path) q.set("path", path);
		const list: any[] = await this.json("GET", `${this.repoPath}/commits?${q.toString()}`);
		return list.map((c) => ({ sha: c.sha, message: c.commit?.message ?? "", date: c.commit?.author?.date ?? c.created ?? "", author: c.commit?.author?.name ?? "" }));
	}
	async getCommitFiles(sha: string) {
		const c = await this.json("GET", `${this.repoPath}/git/commits/${sha}?stat=false&files=true`);
		return { parent: c.parents?.[0]?.sha ?? null, files: (c.files ?? []).map((f: any) => ({ filename: f.filename, status: f.status === "deleted" ? "removed" : f.status })) };
	}
	async getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		const res = await this.request("GET", `${this.repoPath}/raw/${encPath(path)}?ref=${encodeURIComponent(ref)}`, undefined, { accept: "*/*", okStatuses: [404] });
		return res.status === 404 ? null : res.arrayBuffer;
	}
	async listTags() {
		const list: any[] = await this.json("GET", `${this.repoPath}/tags?limit=50`);
		return list.map((t) => ({ name: t.name, sha: t.commit?.sha ?? t.id }));
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
