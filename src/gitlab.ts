// GitLab (gitlab.com or self-managed) via API v4. Commits use POST /projects/:id/repository/commits,
// which writes many files in one atomic commit.

import { b64encode, header, httpRequest, obsidianTransport } from "./http.ts";
import type { HttpResponse, Transport } from "./http.ts";
import type { HostConfig } from "./gitea.ts";
import { NotFastForward } from "./remote.ts";
import type { CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry } from "./remote.ts";
import { gitBlobSha, pool } from "./util.ts";

const BATCH_BYTES = 8 * 1024 * 1024;

// Shapes of the GitLab API responses this client reads (only the fields used).
interface GlProject { visibility?: string; default_branch?: string; web_url: string; path: string; path_with_namespace: string; last_activity_at: string; namespace?: { full_path?: string } }
interface GlBranch { commit?: { id?: string } }
interface GlTreeItem { path: string; mode: string; type: "blob" | "tree" | "commit"; id: string }
interface GlCommit { id: string; message?: string; title?: string; authored_date?: string; created_at?: string; author_name?: string; parent_ids?: string[] }
interface GlDiff { new_path: string; old_path: string; new_file?: boolean; deleted_file?: boolean }
interface GlTag { name: string; commit?: { id: string } }

/** Minimal JSON store (the plugin's per-repository cache file). */
export interface SizeStore {
	load(): Promise<unknown>;
	save(value: unknown): Promise<void>;
}

export class GitLab implements Remote {
	readonly kind = "gitlab" as const;
	readonly label = "GitLab";
	private cfg: () => HostConfig;
	private transport: Transport;
	/**
	 * Blob sha → size in bytes. /repository/tree returns no sizes, but the sync engine needs them for its
	 * size limits, so they are looked up once per blob (HEAD, X-Gitlab-Size) and remembered here. Costs
	 * one HEAD per file on the first listing after start-up, then only for new content.
	 */
	private sizes = new Map<string, number>();
	/** Device-local file that keeps `sizes` across restarts (optional). */
	private sizeStore: SizeStore | null;
	private sizesLoaded = false;

	constructor(cfg: () => HostConfig, transport: Transport = obsidianTransport, sizeStore: SizeStore | null = null) {
		this.sizeStore = sizeStore;
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
	private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		return (await this.request(method, path, body)).json as T;
	}

	async getUser() {
		return { login: (await this.json<{ username: string }>("GET", "/user")).username };
	}
	async getRepo() {
		const res = await this.request("GET", this.project, undefined, { okStatuses: [404] });
		if (res.status === 404) return null;
		const r = res.json as GlProject;
		return { private: r.visibility !== "public", default_branch: r.default_branch || "main", html_url: r.web_url, size: 0 };
	}
	async createRepo(name: string, org?: string) {
		const body: Record<string, unknown> = { name, path: name, visibility: "private", initialize_with_readme: false };
		if (org) body.namespace_id = (await this.json<{ id: number }>("GET", `/namespaces/${encodeURIComponent(org)}`)).id;
		return { html_url: (await this.json<GlProject>("POST", "/projects", body)).web_url };
	}
	async listRepos(maxPages = 3) {
		const out: { owner: string; name: string; private: boolean; updated: string; defaultBranch: string }[] = [];
		for (let page = 1; page <= maxPages; page++) {
			const list = await this.json<GlProject[]>("GET", `/projects?membership=true&per_page=100&page=${page}&order_by=last_activity_at&simple=true`);
			for (const r of list) out.push({ owner: r.namespace?.full_path ?? r.path_with_namespace.split("/").slice(0, -1).join("/"), name: r.path, private: r.visibility !== "public", updated: r.last_activity_at, defaultBranch: r.default_branch || "main" });
			if (list.length < 100) break;
		}
		return out;
	}

	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.project}/repository/branches/${encodeURIComponent(branch)}?_=${Date.now()}`, undefined, { okStatuses: [404] });
		return res.status < 300 ? ((res.json as GlBranch).commit?.id ?? null) : null;
	}
	async createRef(ref: string, sha: string): Promise<void> {
		if (ref.startsWith("refs/tags/")) await this.json<unknown>("POST", `${this.project}/repository/tags?tag_name=${encodeURIComponent(ref.slice(10))}&ref=${sha}`);
		else await this.json<unknown>("POST", `${this.project}/repository/branches?branch=${encodeURIComponent(ref.replace(/^refs\/heads\//, ""))}&ref=${sha}`);
	}
	/** GitLab lists trees by ref, so a commit sha serves as the tree id. */
	async getCommitTree(sha: string): Promise<string> {
		return sha;
	}
	/** File list with sizes (see `sizes`). */
	async listTree(ref: string): Promise<TreeEntry[]> {
		const out = await this.listEntries(ref);
		if (!this.sizesLoaded && this.sizeStore) {
			this.sizesLoaded = true;
			try {
				const saved = (await this.sizeStore.load()) as { gitlabSizes?: Record<string, number> } | null;
				for (const [sha, n] of Object.entries(saved?.gitlabSizes ?? {})) if (typeof n === "number") this.sizes.set(sha, n);
			} catch {
				/* no saved sizes yet */
			}
		}
		const unknown = new Map<string, string>();
		for (const e of out) if (e.type === "blob" && !this.sizes.has(e.sha) && !unknown.has(e.sha)) unknown.set(e.sha, e.path);
		await pool([...unknown], 6, async ([sha, path]) => {
			// A size we can't get only means that file's size limit can't apply; never fail the sync for it.
			try {
				const res = await this.request("HEAD", `${this.project}/repository/files/${this.file(path)}?ref=${encodeURIComponent(ref)}`, undefined, { okStatuses: [404] });
				const size = Number(header(res, "x-gitlab-size") ?? NaN);
				if (res.status < 300 && Number.isFinite(size)) this.sizes.set(sha, size);
			} catch {
				/* unknown size */
			}
		});
		if (unknown.size && this.sizeStore) {
			try {
				await this.sizeStore.save({ gitlabSizes: Object.fromEntries(this.sizes) });
			} catch {
				/* best effort */
			}
		}
		for (const e of out) if (e.type === "blob") e.size = this.sizes.get(e.sha);
		return out;
	}
	/** File list without sizes (cheap: no per-file requests). */
	private async listEntries(ref: string): Promise<TreeEntry[]> {
		const out: TreeEntry[] = [];
		let url = `${this.project}/repository/tree?ref=${encodeURIComponent(ref)}&recursive=true&per_page=100&pagination=keyset`;
		for (let page = 0; url; page++) {
			if (page >= 5000) throw new Error("Repository is too large to list (more than 500,000 entries).");
			// A 404 is only "empty repository" on the first page; later it would silently truncate the
			// listing, and missing entries would look like remote deletions.
			const res = await this.request("GET", url, undefined, { okStatuses: page === 0 ? [404] : [] });
			if (res.status === 404) break;
			for (const e of (res.json as GlTreeItem[] | null) ?? []) out.push({ path: e.path, mode: e.mode, type: e.type, sha: e.id });
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
		await this.json<unknown>("POST", `${this.project}/repository/files/${this.file(path)}`, { branch, content: base64, encoding: "base64", commit_message: message });
	}

	async commit(req: CommitRequest): Promise<CommitResult> {
		const head = await this.getRef(req.branch);
		if (head !== req.parent) throw new NotFastForward();
		const existing = new Set(req.existing ? req.existing.keys() : (await this.listEntries(req.parent)).filter((e) => e.type === "blob").map((e) => e.path));
		// GitLab only locks a file when given the last commit that touched it (per file). Look it up so a
		// concurrent edit from another device makes our commit fail instead of silently winning.
		const lastCommit = async (path: string): Promise<string | undefined> => {
			const res = await this.request("HEAD", `${this.project}/repository/files/${this.file(path)}?ref=${req.parent}`, undefined, { okStatuses: [404] });
			return Object.entries(res.headers).find(([k]) => k.toLowerCase() === "x-gitlab-last-commit-id")?.[1];
		};

		type Action = { action: "create" | "update" | "delete"; file_path: string; content?: string; encoding?: "base64"; last_commit_id?: string };
		let parent = req.parent;
		let fastForward = true;
		let part = 0;
		const send = async (actions: Action[], last: boolean) => {
			if (!actions.length) return;
			part++;
			const [subject, ...rest] = req.message.split("\n");
			const commit_message = part > 1 || !last ? `${subject} (part ${part})\n${rest.join("\n")}` : req.message;
			const res = await this.request("POST", `${this.project}/repository/commits`, { branch: req.branch, commit_message, actions }, { okStatuses: [400, 409] });
			if (res.status === 409) throw new NotFastForward();
			if (res.status === 400) {
				const m = String((res.json as { message?: string } | null)?.message ?? "");
				if (/changed since|already exists|doesn't exist|does not exist|conflict/i.test(m)) throw new NotFastForward();
				throw new Error(`GitLab refused the commit: ${m || "HTTP 400"}`);
			}
			const created = res.json as GlCommit;
			const parents = created.parent_ids ?? [];
			if (parents.length && parents[0] !== parent) fastForward = false;
			parent = created.id;
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
			const update = existing.has(u.path);
			batch.push({ action: update ? "update" : "create", file_path: u.path, content: b64encode(data), encoding: "base64", ...(update ? { last_commit_id: await lastCommit(u.path) } : {}) });
			// Our own uploads need no size lookup on the next listing.
			this.sizes.set(u.sha ?? (await gitBlobSha(data)), data.byteLength);
			bytes += data.byteLength;
			req.progress?.(++done, req.upserts.length);
		}
		for (const p of req.deletes) if (existing.has(p)) batch.push({ action: "delete", file_path: p, last_commit_id: await lastCommit(p) });
		await send(batch, true);
		return { sha: parent, fastForward };
	}

	async compare(base: string, head: string): Promise<Relation> {
		if (base === head) return "identical";
		const res = await this.request("GET", `${this.project}/repository/merge_base?refs[]=${base}&refs[]=${head}`, undefined, { okStatuses: [400, 404] });
		if (res.status >= 300) return "missing";
		const mb = (res.json as { id: string }).id;
		if (mb === base) return "ahead";
		if (mb === head) return "behind";
		return "diverged";
	}

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ ref_name: branch, per_page: String(perPage) });
		if (path) q.set("path", path);
		const list = await this.json<GlCommit[]>("GET", `${this.project}/repository/commits?${q.toString()}`);
		return list.map((c) => ({ sha: c.id, message: c.message ?? c.title ?? "", date: c.authored_date ?? c.created_at ?? "", author: c.author_name ?? "" }));
	}
	async getCommitFiles(sha: string) {
		const c = await this.json<GlCommit>("GET", `${this.project}/repository/commits/${sha}`);
		const diff: GlDiff[] = [];
		for (let page = 1; page <= 30; page++) {
			const res = await this.request("GET", `${this.project}/repository/commits/${sha}/diff?per_page=100&page=${page}`);
			const list = (res.json as GlDiff[] | null) ?? [];
			diff.push(...list);
			// X-Next-Page is empty on the last page; without the header a short page is the end.
			const next = header(res, "x-next-page");
			if (!list.length || (next !== undefined ? !next : list.length < 100)) break;
		}
		return { parent: c.parent_ids?.[0] ?? null, files: diff.map((d) => ({ filename: d.deleted_file ? d.old_path : d.new_path, status: d.deleted_file ? "removed" : d.new_file ? "added" : "modified" })) };
	}
	async getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		const res = await this.request("GET", `${this.project}/repository/files/${this.file(path)}/raw?ref=${encodeURIComponent(ref)}`, undefined, { accept: "*/*", okStatuses: [404] });
		return res.status === 404 ? null : res.arrayBuffer;
	}
	async listTags() {
		const out: { name: string; sha: string }[] = [];
		for (let page = 1; page <= 30; page++) {
			const list = (await this.json<GlTag[] | null>("GET", `${this.project}/repository/tags?per_page=100&page=${page}`)) ?? [];
			for (const t of list) out.push({ name: t.name, sha: t.commit?.id ?? "" });
			if (list.length < 100) break;
		}
		return out;
	}
	async rateLimit() {
		return null;
	}
	async countFiles(branch: string): Promise<number> {
		const head = await this.getRef(branch);
		if (!head) return 0;
		return (await this.listEntries(head)).filter((e) => e.type === "blob").length;
	}
}
