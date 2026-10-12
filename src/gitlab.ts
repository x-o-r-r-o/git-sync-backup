// GitLab (gitlab.com or self-managed) via API v4. Commits use POST /projects/:id/repository/commits,
// which writes many files in one atomic commit.

import { b64encode, httpRequest, obsidianTransport } from "./http.ts";
import type { HttpResponse, Transport } from "./http.ts";
import type { HostConfig } from "./gitea.ts";
import { NotFastForward } from "./remote.ts";
import type { CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry } from "./remote.ts";

const BATCH_BYTES = 8 * 1024 * 1024;

export class GitLab implements Remote {
	readonly kind = "gitlab" as const;
	readonly label = "GitLab";
	private cfg: () => HostConfig;
	private transport: Transport;

	constructor(cfg: () => HostConfig, transport: Transport = obsidianTransport) {
		this.cfg = cfg;
		this.transport = transport;
	}

	private get base() {
		return (this.cfg().apiBase || "https://gitlab.com/api/v4").replace(/\/+$/, "");
	}
	/** Project id: URL-encoded "group/subgroup/project". */
	private get project() {
		const c = this.cfg();
		return `/projects/${encodeURIComponent(`${c.owner}/${c.repo}`)}`;
	}
	private file(path: string) {
		return encodeURIComponent(path);
	}

	gitUrl(): string {
		const c = this.cfg();
		return `${this.base.replace(/\/api\/v4$/i, "")}/${c.owner}/${c.repo}.git`;
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
				headers: { "PRIVATE-TOKEN": c.token, Accept: opts.accept ?? "application/json" },
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
		return { login: (await this.json("GET", "/user")).username };
	}
	async getRepo() {
		const res = await this.request("GET", this.project, undefined, { okStatuses: [404] });
		if (res.status === 404) return null;
		const r = res.json;
		return { private: r.visibility !== "public", default_branch: r.default_branch || "main", html_url: r.web_url, size: 0 };
	}
	async createRepo(name: string, org?: string) {
		const body: Record<string, unknown> = { name, path: name, visibility: "private", initialize_with_readme: false };
		if (org) body.namespace_id = (await this.json("GET", `/namespaces/${encodeURIComponent(org)}`)).id;
		return { html_url: (await this.json("POST", "/projects", body)).web_url };
	}
	async listRepos(maxPages = 3) {
		const out: { owner: string; name: string; private: boolean; updated: string; defaultBranch: string }[] = [];
		for (let page = 1; page <= maxPages; page++) {
			const list: any[] = await this.json("GET", `/projects?membership=true&per_page=100&page=${page}&order_by=last_activity_at&simple=true`);
			for (const r of list) out.push({ owner: r.namespace?.full_path ?? r.path_with_namespace.split("/").slice(0, -1).join("/"), name: r.path, private: r.visibility !== "public", updated: r.last_activity_at, defaultBranch: r.default_branch || "main" });
			if (list.length < 100) break;
		}
		return out;
	}

	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.project}/repository/branches/${encodeURIComponent(branch)}?_=${Date.now()}`, undefined, { okStatuses: [404] });
		return res.status < 300 ? res.json.commit?.id ?? null : null;
	}
	async createRef(ref: string, sha: string): Promise<void> {
		if (ref.startsWith("refs/tags/")) await this.json("POST", `${this.project}/repository/tags?tag_name=${encodeURIComponent(ref.slice(10))}&ref=${sha}`);
		else await this.json("POST", `${this.project}/repository/branches?branch=${encodeURIComponent(ref.replace(/^refs\/heads\//, ""))}&ref=${sha}`);
	}
	/** GitLab lists trees by ref, so a commit sha serves as the tree id. */
	async getCommitTree(sha: string): Promise<string> {
		return sha;
	}
	async listTree(ref: string): Promise<TreeEntry[]> {
		const out: TreeEntry[] = [];
		let url = `${this.project}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&pagination=keyset`;
		for (let i = 0; i < 2000 && url; i++) {
			const res = await this.request("GET", url, undefined, { okStatuses: [404] });
			if (res.status === 404) break;
			for (const e of res.json ?? []) out.push({ path: e.path, mode: e.mode, type: e.type, sha: e.id });
			const link = Object.entries(res.headers).find(([k]) => k.toLowerCase() === "link")?.[1] ?? "";
			const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
			url = next ? next.replace(this.base, "") : "";
		}
		return out;
	}
	async getBlob(sha: string): Promise<ArrayBuffer> {
		return (await this.request("GET", `${this.project}/repository/blobs/${sha}/raw`, undefined, { accept: "*/*" })).arrayBuffer;
	}
	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		await this.json("POST", `${this.project}/repository/files/${this.file(path)}`, { branch, content: base64, encoding: "base64", commit_message: message });
	}

	async commit(req: CommitRequest): Promise<CommitResult> {
		const head = await this.getRef(req.branch);
		if (head !== req.parent) throw new NotFastForward();
		const existing = new Set((await this.listTree(req.parent)).filter((e) => e.type === "blob").map((e) => e.path));

		// The head check above guards against concurrent pushes (GitLab's last_commit_id must equal the
		// file's own last commit, which we don't track, so it isn't used).
		type Action = { action: "create" | "update" | "delete"; file_path: string; content?: string; encoding?: "base64" };
		let parent = req.parent;
		let fastForward = true;
		let part = 0;
		const send = async (actions: Action[], last: boolean) => {
			if (!actions.length) return;
			part++;
			const [subject, ...rest] = req.message.split("\n");
			const commit_message = part > 1 || !last ? `${subject} (part ${part})\n${rest.join("\n")}` : req.message;
			const res = await this.request("POST", `${this.project}/repository/commits`, { branch: req.branch, commit_message, actions }, { okStatuses: [400, 409] });
			if (res.status === 400 || res.status === 409) throw new NotFastForward();
			const parents: string[] = res.json.parent_ids ?? [];
			if (parents.length && parents[0] !== parent) fastForward = false;
			parent = res.json.id;
		};
		let batch: Action[] = [];
		let bytes = 0;
		let done = 0;
		for (const u of req.upserts) {
			const data = await u.load();
			if (bytes + data.byteLength > BATCH_BYTES && batch.length) {
				await send(batch, false);
				batch = [];
				bytes = 0;
			}
			batch.push({ action: existing.has(u.path) ? "update" : "create", file_path: u.path, content: b64encode(data), encoding: "base64" });
			bytes += data.byteLength;
			req.progress?.(++done, req.upserts.length);
		}
		for (const p of req.deletes) if (existing.has(p)) batch.push({ action: "delete", file_path: p });
		await send(batch, true);
		return { sha: parent, fastForward };
	}

	async compare(base: string, head: string): Promise<Relation> {
		if (base === head) return "identical";
		const res = await this.request("GET", `${this.project}/repository/merge_base?refs[]=${base}&refs[]=${head}`, undefined, { okStatuses: [400, 404] });
		if (res.status >= 300) return "missing";
		const mb = res.json.id;
		if (mb === base) return "ahead";
		if (mb === head) return "behind";
		return "diverged";
	}

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ ref_name: branch, per_page: String(perPage) });
		if (path) q.set("path", path);
		const list: any[] = await this.json("GET", `${this.project}/repository/commits?${q.toString()}`);
		return list.map((c) => ({ sha: c.id, message: c.message ?? c.title ?? "", date: c.authored_date ?? c.created_at ?? "", author: c.author_name ?? "" }));
	}
	async getCommitFiles(sha: string) {
		const c = await this.json("GET", `${this.project}/repository/commits/${sha}`);
		const diff: any[] = await this.json("GET", `${this.project}/repository/commits/${sha}/diff?per_page=100`);
		return { parent: c.parent_ids?.[0] ?? null, files: diff.map((d) => ({ filename: d.deleted_file ? d.old_path : d.new_path, status: d.deleted_file ? "removed" : d.new_file ? "added" : "modified" })) };
	}
	async getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		const res = await this.request("GET", `${this.project}/repository/files/${this.file(path)}/raw?ref=${encodeURIComponent(ref)}`, undefined, { accept: "*/*", okStatuses: [404] });
		return res.status === 404 ? null : res.arrayBuffer;
	}
	async listTags() {
		const list: any[] = await this.json("GET", `${this.project}/repository/tags?per_page=100`);
		return list.map((t) => ({ name: t.name, sha: t.commit?.id }));
	}
	async rateLimit() {
		return null;
	}
	async countFiles(branch: string): Promise<number> {
		const head = await this.getRef(branch);
		if (!head) return 0;
		return (await this.listTree(head)).filter((e) => e.type === "blob").length;
	}
}
