// Bitbucket Cloud via API 2.0.
//
// Bitbucket's API doesn't expose git blob hashes, which the sync engine relies on. This client computes
// them itself (download once, hash) and keeps a small persisted cache: file → {blob sha, size} at a
// commit, plus blob sha → where to fetch it. Later syncs only re-fetch the paths Bitbucket's diffstat
// reports as changed between the cached commit and the new one.
//
// Commits use POST /src (multipart): many files in one commit, with `parents` set to the commit we
// based our changes on so a concurrent push from another device is rejected instead of overwritten.

import { buildMultipart, compareByWalking, httpRequest, obsidianTransport } from "./http.ts";
import type { HttpResponse, Transport } from "./http.ts";
import type { HostConfig } from "./gitea.ts";
import { NotFastForward } from "./remote.ts";
import type { CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry } from "./remote.ts";
import { gitBlobSha, pool } from "./util.ts";

export interface BlobCache {
	commit: string;
	files: Record<string, { sha: string; size: number }>;
	/** blob sha → a path and commit where that content can be fetched. */
	blobs: Record<string, { path: string; commit: string }>;
}

export interface BlobCacheStore {
	load(): Promise<BlobCache | null>;
	save(cache: BlobCache): Promise<void>;
}

const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const BATCH_BYTES = 8 * 1024 * 1024;

// Shapes of the Bitbucket API responses this client reads (only the fields used).
interface BbPage<T> {
	values?: T[];
	next?: string;
}
interface BbRepo {
	is_private?: boolean;
	mainbranch?: { name?: string };
	links?: { html?: { href?: string } };
	size?: number;
	slug: string;
	workspace?: { slug?: string };
	updated_on?: string;
}
interface BbSrcEntry {
	type: "commit_file" | "commit_directory";
	path: string;
	size?: number;
}
interface BbDiffstat {
	status?: string;
	old?: { path?: string } | null;
	new?: { path?: string } | null;
}
interface BbCommit {
	hash: string;
	message?: string;
	date?: string;
	author?: { raw?: string; user?: { display_name?: string } };
	parents?: { hash: string }[];
}

export class Bitbucket implements Remote {
	readonly kind = "bitbucket" as const;
	readonly label = "Bitbucket";
	private cfg: () => HostConfig;
	private store: BlobCacheStore | null;
	private transport: Transport;
	private cache: BlobCache | null = null;
	private cacheLoaded = false;

	constructor(cfg: () => HostConfig, store: BlobCacheStore | null = null, transport: Transport = obsidianTransport) {
		this.cfg = cfg;
		this.store = store;
		this.transport = transport;
	}

	private get base() {
		return (this.cfg().apiBase || "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
	}
	private get repoPath() {
		const c = this.cfg();
		return `/repositories/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}`;
	}
	/** Atlassian API tokens are entered as "email:token" (Basic); access tokens are used as Bearer. */
	private authValue(): string {
		const t = this.cfg().token;
		return t.includes(":") ? `Basic ${btoa(t)}` : `Bearer ${t}`;
	}

	gitUrl(): string {
		const c = this.cfg();
		const web = this.base.includes("api.bitbucket.org") ? "https://bitbucket.org" : this.base.replace(/\/2\.0$/, "").replace("//api.", "//");
		return `${web}/${c.owner}/${c.repo}.git`;
	}
	authHeader(): string {
		const t = this.cfg().token;
		return `Basic ${btoa(t.includes(":") ? t : `x-token-auth:${t}`)}`;
	}

	async request(method: string, path: string, body?: unknown, opts: { accept?: string; okStatuses?: number[] } = {}): Promise<HttpResponse> {
		if (!this.cfg().token) throw new Error("No token set. Add one in the plugin settings.");
		const url = path.startsWith("http") ? path : this.base + path;
		return httpRequest(
			this.transport,
			{
				url,
				method,
				headers: { Authorization: this.authValue(), Accept: opts.accept ?? "application/json" },
				body: body !== undefined ? JSON.stringify(body) : undefined,
				contentType: body !== undefined ? "application/json" : undefined,
			},
			{ okStatuses: opts.okStatuses, hostLabel: this.label },
		);
	}
	private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		return (await this.request(method, path, body)).json as T;
	}
	private async pages<T>(path: string, limit = 50): Promise<T[]> {
		const out: T[] = [];
		let url: string | undefined = path;
		for (let i = 0; url && i < limit; i++) {
			const page: BbPage<T> = await this.json<BbPage<T>>("GET", url);
			out.push(...(page.values ?? []));
			url = page.next;
		}
		return out;
	}

	// ---------- account / repo ----------

	async getUser() {
		try {
			const u = await this.json<{ username?: string; nickname?: string; display_name?: string }>("GET", "/user");
			return { login: u.username ?? u.nickname ?? u.display_name ?? "" };
		} catch (e) {
			// Repository access tokens can't read /user; accept them if they can read the repository.
			const c = this.cfg();
			if (c.owner && c.repo && (await this.getRepo().catch(() => null))) return { login: c.owner };
			throw e;
		}
	}
	async getRepo() {
		const res = await this.request("GET", this.repoPath, undefined, { okStatuses: [404] });
		if (res.status === 404) return null;
		const r = res.json as BbRepo;
		return { private: r.is_private !== false, default_branch: r.mainbranch?.name || "main", html_url: r.links?.html?.href ?? "", size: r.size ?? 0 };
	}
	async createRepo(name: string, org?: string) {
		const ws = org ?? this.cfg().owner;
		const r = await this.json<BbRepo>("POST", `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(name)}`, { scm: "git", is_private: true });
		return { html_url: r.links?.html?.href ?? "" };
	}
	async listRepos(maxPages = 3) {
		const list = await this.pages<BbRepo>("/repositories?role=member&pagelen=100&sort=-updated_on", maxPages);
		return list.map((r) => ({ owner: r.workspace?.slug ?? "", name: r.slug, private: r.is_private !== false, updated: r.updated_on ?? "", defaultBranch: r.mainbranch?.name || "main" }));
	}

	// ---------- refs ----------

	async getRef(branch: string): Promise<string | null> {
		const res = await this.request("GET", `${this.repoPath}/refs/branches/${encodeURIComponent(branch)}?_=${Date.now()}`, undefined, { okStatuses: [404] });
		return res.status < 300 ? ((res.json as { target?: { hash?: string } }).target?.hash ?? null) : null;
	}
	async createRef(ref: string, sha: string): Promise<void> {
		if (ref.startsWith("refs/tags/")) await this.json<unknown>("POST", `${this.repoPath}/refs/tags`, { name: ref.slice(10), target: { hash: sha } });
		else await this.json<unknown>("POST", `${this.repoPath}/refs/branches`, { name: ref.replace(/^refs\/heads\//, ""), target: { hash: sha } });
	}
	/** Bitbucket lists files by commit, so the commit hash serves as the tree id. */
	async getCommitTree(sha: string): Promise<string> {
		return sha;
	}

	// ---------- content ----------

	private async loadCache(): Promise<BlobCache | null> {
		if (!this.cacheLoaded) {
			this.cache = (await this.store?.load().catch(() => null)) ?? null;
			this.cacheLoaded = true;
		}
		return this.cache;
	}
	private async saveCache(c: BlobCache) {
		this.cache = c;
		await this.store?.save(c);
	}

	private async raw(commit: string, path: string): Promise<ArrayBuffer | null> {
		const res = await this.request("GET", `${this.repoPath}/src/${commit}/${encPath(path)}`, undefined, { accept: "*/*", okStatuses: [404] });
		return res.status === 404 ? null : res.arrayBuffer;
	}

	private async fullListing(commit: string, blobs: BlobCache["blobs"]): Promise<BlobCache["files"]> {
		const paths: string[] = [];
		const walk = async (dir: string) => {
			for (const e of await this.pages<BbSrcEntry>(`${this.repoPath}/src/${commit}/${dir ? encPath(dir) + "/" : ""}?pagelen=100`, 1000)) {
				if (e.type === "commit_directory") await walk(e.path);
				else paths.push(e.path);
			}
		};
		await walk("");
		const files: BlobCache["files"] = {};
		await pool(paths, 4, async (p) => {
			const data = await this.raw(commit, p);
			if (!data) return;
			const sha = await gitBlobSha(data);
			files[p] = { sha, size: data.byteLength };
			blobs[sha] = { path: p, commit };
		});
		return files;
	}

	/**
	 * Paths that differ between two commits (direction doesn't matter: each is re-fetched).
	 * `topic=false` asks for a plain two-dot diff; Bitbucket's default is relative to the merge base,
	 * which would miss changes when the cache sits ahead of `b` (timeline, restore, force-push).
	 */
	private async changedPaths(a: string, b: string): Promise<Set<string>> {
		const out = new Set<string>();
		for (const d of await this.pages<BbDiffstat>(`${this.repoPath}/diffstat/${b}..${a}?pagelen=500&topic=false`, 1000)) {
			if (d.old?.path) out.add(d.old.path);
			if (d.new?.path) out.add(d.new.path);
		}
		return out;
	}

	async listTree(commit: string): Promise<TreeEntry[]> {
		const cache = await this.loadCache();
		const blobs = { ...(cache?.blobs ?? {}) };
		let files: BlobCache["files"];
		if (cache && cache.commit === commit) files = cache.files;
		else if (cache) {
			try {
				const changed = await this.changedPaths(cache.commit, commit);
				files = { ...cache.files };
				await pool([...changed], 4, async (p) => {
					const data = await this.raw(commit, p);
					if (!data) {
						delete files[p];
						return;
					}
					const sha = await gitBlobSha(data);
					files[p] = { sha, size: data.byteLength };
					blobs[sha] = { path: p, commit };
				});
			} catch {
				files = await this.fullListing(commit, blobs);
			}
		} else files = await this.fullListing(commit, blobs);
		await this.saveCache({ commit, files, blobs });
		return Object.entries(files).map(([path, f]) => ({ path, mode: "100644", type: "blob" as const, sha: f.sha, size: f.size }));
	}

	async getBlob(sha: string): Promise<ArrayBuffer> {
		const where = (await this.loadCache())?.blobs[sha];
		const data = where ? await this.raw(where.commit, where.path) : null;
		if (!data) throw new Error("Bitbucket: this file version is not available");
		return data;
	}

	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		const bin = atob(base64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		await this.postSrc([{ name: "message", value: message }, { name: "branch", value: branch }, { name: `/${path}`, value: bytes.buffer, filename: path.split("/").pop() }]);
	}

	private async postSrc(parts: { name: string; value: string | ArrayBuffer; filename?: string }[]): Promise<HttpResponse> {
		const { body, contentType } = buildMultipart(parts);
		return httpRequest(
			this.transport,
			{ url: `${this.base}${this.repoPath}/src`, method: "POST", headers: { Authorization: this.authValue(), Accept: "application/json" }, body, contentType },
			{ okStatuses: [400, 409], hostLabel: this.label },
		);
	}

	async commit(req: CommitRequest): Promise<CommitResult> {
		if ((await this.getRef(req.branch)) !== req.parent) throw new NotFastForward();
		const cache = await this.loadCache();
		const files = cache?.commit === req.parent ? { ...cache.files } : null;
		const blobs = { ...(cache?.blobs ?? {}) };
		const stored = new Map<string, { sha: string; size: number }>();

		let parent = req.parent;
		let fastForward = true;
		let part = 0;
		const send = async (fileParts: { name: string; value: ArrayBuffer; filename: string }[], deletes: string[], last: boolean) => {
			if (!fileParts.length && !deletes.length) return;
			part++;
			const [subject, ...rest] = req.message.split("\n");
			const message = part > 1 || !last ? `${subject} (part ${part})\n${rest.join("\n")}` : req.message;
			const res = await this.postSrc([
				{ name: "message", value: message },
				{ name: "branch", value: req.branch },
				{ name: "parents", value: parent },
				...deletes.map((p) => ({ name: "files", value: p })),
				...fileParts,
			]);
			if (res.status === 409) throw new NotFastForward();
			if (res.status === 400) {
				const m = String((res.json as { error?: { message?: string } } | null)?.error?.message ?? "");
				if (/parent|tip|head|conflict|outdated/i.test(m)) throw new NotFastForward();
				throw new Error(`Bitbucket refused the commit: ${m || "HTTP 400"}`);
			}
			const head = await this.getRef(req.branch);
			if (!head || head === parent) throw new Error("Bitbucket did not create the commit");
			const info = await this.json<BbCommit>("GET", `${this.repoPath}/commit/${head}`);
			if (info.parents?.[0]?.hash !== parent) fastForward = false;
			parent = head;
		};

		let batch: { name: string; value: ArrayBuffer; filename: string }[] = [];
		let bytes = 0;
		let done = 0;
		for (const u of req.upserts) {
			const data = await u.load();
			if (bytes + data.byteLength > BATCH_BYTES && batch.length) {
				await send(batch, [], false);
				batch = [];
				bytes = 0;
			}
			batch.push({ name: `/${u.path}`, value: data, filename: u.path.split("/").pop() ?? u.path });
			stored.set(u.path, { sha: await gitBlobSha(data), size: data.byteLength });
			bytes += data.byteLength;
			req.progress?.(++done, req.upserts.length);
		}
		await send(batch, req.deletes, true);

		// Keep the hash cache current so the next sync doesn't re-download what we just uploaded.
		if (files && fastForward) {
			for (const p of req.deletes) delete files[p];
			for (const [p, f] of stored) {
				files[p] = f;
				blobs[f.sha] = { path: p, commit: parent };
			}
			await this.saveCache({ commit: parent, files, blobs });
		}
		return { sha: parent, fastForward };
	}

	async compare(base: string, head: string): Promise<Relation> {
		if (base === head) return "identical";
		const res = await this.request("GET", `${this.repoPath}/merge-base/${base}..${head}`, undefined, { okStatuses: [404] });
		if (res.status === 404) {
			const exists = await this.request("GET", `${this.repoPath}/commit/${base}`, undefined, { okStatuses: [404] });
			if (exists.status === 404) return "missing";
			return compareByWalking(async (sha, page) => (await this.json<BbPage<BbCommit>>("GET", `${this.repoPath}/commits/${sha}?pagelen=50&page=${page}`)).values?.map((c) => c.hash) ?? [], base, head);
		}
		const mb = (res.json as { hash?: string }).hash;
		if (mb === base) return "ahead";
		if (mb === head) return "behind";
		return "diverged";
	}

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const q = new URLSearchParams({ pagelen: String(perPage) });
		if (path) q.set("path", path);
		const page = await this.json<BbPage<BbCommit>>("GET", `${this.repoPath}/commits/${encodeURIComponent(branch)}?${q.toString()}`);
		return (page.values ?? []).map((c) => ({ sha: c.hash, message: c.message ?? "", date: c.date ?? "", author: c.author?.user?.display_name ?? c.author?.raw ?? "" }));
	}
	async getCommitFiles(sha: string) {
		const c = await this.json<BbCommit>("GET", `${this.repoPath}/commit/${sha}`);
		const stats = await this.pages<BbDiffstat>(`${this.repoPath}/diffstat/${sha}?pagelen=500`, 20);
		return {
			parent: c.parents?.[0]?.hash ?? null,
			files: stats.map((d) => ({ filename: d.new?.path ?? d.old?.path ?? "", status: d.status === "removed" ? "removed" : d.status === "added" ? "added" : "modified" })),
		};
	}
	getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		return this.raw(ref, path);
	}
	async listTags() {
		const list = await this.pages<{ name: string; target?: { hash?: string } }>(`${this.repoPath}/refs/tags?pagelen=100`, 5);
		return list.map((t) => ({ name: t.name, sha: t.target?.hash ?? "" }));
	}
	async rateLimit() {
		return null;
	}
	async countFiles(branch: string): Promise<number> {
		const head = await this.getRef(branch);
		return head ? (await this.listTree(head)).length : 0;
	}
}
