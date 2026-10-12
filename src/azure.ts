// Azure DevOps Repos (dev.azure.com or Azure DevOps Server) via REST API 7.1. Commits use the Pushes
// API, which applies many file changes atomically and refuses the push when the branch moved
// (oldObjectId no longer matches): a compare-and-swap on the branch, so no pre-check is needed.
// Config: owner = "{organization}/{project}", repo = repository name.

import { b64encode, compareByWalking, header, httpRequest, obsidianTransport } from "./http.ts";
import type { HttpResponse, Transport } from "./http.ts";
import type { HostConfig } from "./gitea.ts";
import { NotFastForward } from "./remote.ts";
import type { CommitInfo, CommitRequest, CommitResult, Relation, Remote, TreeEntry, WebLink } from "./remote.ts";

const API_VERSION = "7.1";
const ZERO = "0000000000000000000000000000000000000000";
// Raw bytes per push (base64 grows it by a third); larger changes are split into chained pushes.
const BATCH_BYTES = 8 * 1024 * 1024;
const enc = encodeURIComponent;
const isSha = (s: string) => /^[0-9a-f]{40}$/i.test(s);

// Shapes of the Azure DevOps responses this client reads (only the fields used).
interface AzList<T> { value?: T[]; count?: number }
interface AzRepo { name: string; webUrl?: string; remoteUrl?: string; defaultBranch?: string; size?: number; project?: { id?: string; name?: string; visibility?: string; lastUpdateTime?: string } }
interface AzRef { name: string; objectId: string; peeledObjectId?: string }
interface AzRefUpdate { name?: string; success?: boolean; updateStatus?: string; customMessage?: string }
interface AzCommit { commitId: string; treeId?: string; parents?: string[]; comment?: string; author?: { name?: string; email?: string; date?: string }; committer?: { date?: string } }
interface AzTreeEntry { relativePath: string; mode?: string; gitObjectType?: string; objectId: string; size?: number }
interface AzChange { changeType?: string; item?: { path?: string; gitObjectType?: string; isFolder?: boolean }; sourceServerItem?: string; originalPath?: string }
interface AzPush { commits?: { commitId: string }[]; refUpdates?: { name?: string; newObjectId?: string }[] }
interface AzConnection { authenticatedUser?: { providerDisplayName?: string; customDisplayName?: string; properties?: { Account?: { $value?: string } } } }

type Change = { changeType: "add" | "edit" | "delete"; item: { path: string }; newContent?: { content: string; contentType: "base64encoded" } };

export class AzureDevOps implements Remote {
	readonly kind = "azure" as const;
	readonly label = "Azure DevOps";
	private cfg: () => HostConfig;
	private transport: Transport;

	constructor(cfg: () => HostConfig, transport: Transport = obsidianTransport) {
		this.cfg = cfg;
		this.transport = transport;
	}

	private get base() {
		return (this.cfg().apiBase || "https://dev.azure.com").replace(/\/+$/, "");
	}
	/** Organization and project from owner "org/project" (a lone org assumes project = repo name). */
	private get scope(): { org: string; project: string } {
		const c = this.cfg();
		const owner = c.owner.replace(/^\/+|\/+$/g, "");
		const i = owner.indexOf("/");
		return i < 0 ? { org: owner, project: c.repo } : { org: owner.slice(0, i), project: owner.slice(i + 1) };
	}
	private get orgPath() {
		return `/${enc(this.scope.org)}`;
	}
	private get projectPath() {
		const s = this.scope;
		return `/${enc(s.org)}/${enc(s.project)}`;
	}
	private get repoPath() {
		return `${this.projectPath}/_apis/git/repositories/${enc(this.cfg().repo)}`;
	}

	gitUrl(): string {
		return `${this.base}${this.projectPath}/_git/${enc(this.cfg().repo)}`;
	}
	authHeader(): string {
		return `Basic ${btoa(`:${this.cfg().token}`)}`;
	}

	/** `path` is relative to the API base; api-version is added unless the path already has one. */
	async request(method: string, path: string, body?: unknown, opts: { accept?: string; okStatuses?: number[] } = {}): Promise<HttpResponse> {
		const c = this.cfg();
		if (!c.token) throw new Error("No token set. Add one in the plugin settings.");
		const url = this.base + path + (/[?&]api-version=/.test(path) ? "" : `${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`);
		return httpRequest(
			this.transport,
			{
				url,
				method,
				headers: { Authorization: this.authHeader(), Accept: opts.accept ?? "application/json" },
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
		// connectionData is only published as a preview resource.
		const c = await this.json<AzConnection>("GET", `${this.orgPath}/_apis/connectionData?api-version=${API_VERSION}-preview`);
		const u = c.authenticatedUser;
		return { login: u?.properties?.Account?.$value ?? u?.providerDisplayName ?? u?.customDisplayName ?? "" };
	}
	async getRepo() {
		const res = await this.request("GET", this.repoPath, undefined, { okStatuses: [404] });
		if (res.status === 404) return null;
		const r = res.json as AzRepo;
		return { private: r.project?.visibility !== "public", default_branch: (r.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, ""), html_url: r.webUrl ?? this.gitUrl(), size: r.size ?? 0 };
	}
	/** `org` may name another "organization/project" (or just a project in this organization). */
	async createRepo(name: string, org?: string) {
		let { org: organization, project } = this.scope;
		if (org) {
			const i = org.indexOf("/");
			if (i < 0) project = org;
			else [organization, project] = [org.slice(0, i), org.slice(i + 1)];
		}
		const p = await this.json<{ id: string }>("GET", `/${enc(organization)}/_apis/projects/${enc(project)}`);
		const r = await this.json<AzRepo>("POST", `/${enc(organization)}/${enc(project)}/_apis/git/repositories`, { name, project: { id: p.id } });
		return { html_url: r.webUrl ?? `${this.base}/${enc(organization)}/${enc(project)}/_git/${enc(name)}` };
	}
	/** Every repository of the organization (Azure returns them in one response, so no paging). */
	async listRepos() {
		const { org } = this.scope;
		const list = (await this.json<AzList<AzRepo>>("GET", `${this.orgPath}/_apis/git/repositories`)).value ?? [];
		return list
			.map((r) => ({
				owner: `${org}/${r.project?.name ?? ""}`,
				name: r.name,
				private: r.project?.visibility !== "public",
				updated: r.project?.lastUpdateTime ?? "",
				defaultBranch: (r.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, ""),
			}))
			.sort((a, b) => b.updated.localeCompare(a.updated));
	}

	/** Refs whose name starts with refs/{filter}, following continuation tokens. */
	private async refs(filter: string): Promise<AzRef[]> {
		const out: AzRef[] = [];
		let token = "";
		for (let page = 0; page < 200; page++) {
			const res = await this.request("GET", `${this.repoPath}/refs?filter=${enc(filter)}&peelTags=true&$top=1000${token ? `&continuationToken=${enc(token)}` : ""}`, undefined, { okStatuses: [404] });
			if (res.status === 404) break;
			out.push(...((res.json as AzList<AzRef> | null)?.value ?? []));
			token = header(res, "x-ms-continuationtoken") ?? "";
			if (!token) break;
		}
		return out;
	}
	async getRef(branch: string): Promise<string | null> {
		// The filter is a prefix match (heads/main also returns heads/main-old): pick the exact name.
		const name = `refs/heads/${branch}`;
		return (await this.refs(`heads/${branch}`)).find((r) => r.name === name)?.objectId ?? null;
	}
	async createRef(ref: string, sha: string): Promise<void> {
		const name = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
		const res = await this.json<AzList<AzRefUpdate>>("POST", `${this.repoPath}/refs`, [{ name, oldObjectId: ZERO, newObjectId: sha }]);
		const u = res.value?.[0];
		if (u && u.success === false) throw new Error(`Azure DevOps could not create ${name}: ${u.customMessage ?? u.updateStatus ?? "refused"}`);
	}
	async getCommitTree(sha: string): Promise<string> {
		const c = await this.json<AzCommit>("GET", `${this.repoPath}/commits/${enc(sha)}`);
		if (!c.treeId) throw new Error(`Commit ${sha} has no tree`);
		return c.treeId;
	}
	async listTree(treeSha: string): Promise<TreeEntry[]> {
		const t = await this.json<{ treeEntries?: AzTreeEntry[] }>("GET", `${this.repoPath}/trees/${enc(treeSha)}?recursive=true`);
		return (t.treeEntries ?? []).map((e) => ({
			path: e.relativePath.replace(/^\/+/, ""),
			mode: e.mode ?? (e.gitObjectType === "tree" ? "040000" : "100644"),
			type: e.gitObjectType === "tree" ? "tree" : e.gitObjectType === "commit" ? "commit" : "blob",
			sha: e.objectId,
			size: e.gitObjectType === "blob" ? e.size : undefined,
		}));
	}
	async getBlob(sha: string): Promise<ArrayBuffer> {
		return (await this.request("GET", `${this.repoPath}/blobs/${enc(sha)}?$format=octetstream`, undefined, { accept: "application/octet-stream" })).arrayBuffer;
	}
	async putFile(path: string, message: string, base64: string, branch: string): Promise<void> {
		const head = await this.getRef(branch);
		const changes: Change[] = [{ changeType: head ? "edit" : "add", item: { path: `/${path}` }, newContent: { content: base64, contentType: "base64encoded" } }];
		if (head) {
			const existing = await this.listTree(await this.getCommitTree(head));
			if (!existing.some((e) => e.type === "blob" && e.path === path)) changes[0].changeType = "add";
		}
		await this.push(branch, head ?? ZERO, message, changes);
	}

	/** One push of one commit; returns the new head. Stale oldObjectId → NotFastForward. */
	private async push(branch: string, oldObjectId: string, message: string, changes: Change[], author?: { name: string; email: string }): Promise<string> {
		const commit: Record<string, unknown> = { comment: message, changes };
		if (author) commit.author = { name: author.name, email: author.email, date: new Date().toISOString() };
		const res = await this.request("POST", `${this.repoPath}/pushes`, { refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId }], commits: [commit] }, { okStatuses: [400, 409] });
		if (res.status === 400 || res.status === 409) {
			const m = String((res.json as { message?: string } | null)?.message ?? "");
			// TF401028: the ref was updated by another client. Also an add of a file that now exists or an
			// edit/delete of one that is gone: the tree changed under us.
			if (res.status === 409 || /TF401028|TF401035|already been updated|stale|already exists|could not be found|TF401174|TF401019/i.test(m)) throw new NotFastForward();
			throw new Error(`Azure DevOps refused the push: ${m || `HTTP ${res.status}`}`);
		}
		const body = res.json as AzPush;
		const sha = body.refUpdates?.[0]?.newObjectId ?? body.commits?.[body.commits.length - 1]?.commitId;
		if (!sha) throw new Error("Azure DevOps did not return the new commit");
		return sha;
	}

	async commit(req: CommitRequest): Promise<CommitResult> {
		const existing = req.existing ?? new Map((await this.listTree(req.parentTree)).filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
		let parent = req.parent;
		let part = 0;
		const send = async (changes: Change[], last: boolean) => {
			if (!changes.length) return;
			part++;
			const [subject, ...rest] = req.message.split("\n");
			const message = part > 1 || !last ? `${subject} (part ${part})\n${rest.join("\n")}` : req.message;
			parent = await this.push(req.branch, parent, message, changes, req.author);
		};

		// Send each batch as soon as it is full, so memory stays bounded on phones.
		let batch: Change[] = [];
		let bytes = 0;
		let done = 0;
		for (const u of req.upserts) {
			const data = await u.load();
			if (bytes + data.byteLength > BATCH_BYTES && batch.length) {
				await send(batch, false);
				batch = [];
				bytes = 0;
			}
			batch.push({ changeType: existing.has(u.path) ? "edit" : "add", item: { path: `/${u.path}` }, newContent: { content: b64encode(data), contentType: "base64encoded" } });
			bytes += data.byteLength;
			req.progress?.(++done, req.upserts.length);
		}
		for (const p of req.deletes) if (existing.has(p)) batch.push({ changeType: "delete", item: { path: `/${p}` } });
		await send(batch, true);
		// The push is refused unless the branch is still at `parent`, so every success is a fast-forward.
		return { sha: parent, fastForward: true };
	}

	private commitsQuery(version: string, versionType: "commit" | "branch", top: number, skip = 0, itemPath?: string): string {
		let q = `searchCriteria.itemVersion.version=${enc(version)}&searchCriteria.itemVersion.versionType=${versionType}&searchCriteria.$top=${top}`;
		if (skip) q += `&searchCriteria.$skip=${skip}`;
		if (itemPath) q += `&searchCriteria.itemPath=${enc(`/${itemPath}`)}`;
		return `${this.repoPath}/commits?${q}`;
	}

	async compare(base: string, head: string): Promise<Relation> {
		const exists = await this.request("GET", `${this.repoPath}/commits/${enc(base)}`, undefined, { okStatuses: [400, 404] });
		if (exists.status >= 300) return "missing";
		// The server may clamp $top, so a short page proves nothing: only an empty page ends the walk, and
		// $skip counts what was actually received (per walk start), not page × $top.
		const received = new Map<string, number>();
		return compareByWalking(
			async (sha, page) => {
				const skip = page === 1 ? 0 : (received.get(sha) ?? 0);
				const shas = ((await this.json<AzList<AzCommit>>("GET", this.commitsQuery(sha, "commit", 100, skip))).value ?? []).map((c) => c.commitId);
				received.set(sha, skip + shas.length);
				return shas;
			},
			base,
			head,
		);
	}

	async listCommits(branch: string, path?: string, perPage = 30): Promise<CommitInfo[]> {
		const list = (await this.json<AzList<AzCommit>>("GET", this.commitsQuery(branch, isSha(branch) ? "commit" : "branch", perPage, 0, path))).value ?? [];
		return list.map((c) => ({ sha: c.commitId, message: c.comment ?? "", date: c.author?.date ?? c.committer?.date ?? "", author: c.author?.name ?? "" }));
	}
	async getCommitFiles(sha: string) {
		const c = await this.json<AzCommit>("GET", `${this.repoPath}/commits/${enc(sha)}`);
		const files: { filename: string; status: string }[] = [];
		const top = 1000;
		for (let page = 0; page < 100; page++) {
			const res = await this.json<{ changes?: AzChange[] }>("GET", `${this.repoPath}/commits/${enc(sha)}/changes?top=${top}&skip=${page * top}`);
			const list = res.changes ?? [];
			for (const ch of list) {
				if (ch.item?.isFolder || ch.item?.gitObjectType === "tree" || !ch.item?.path) continue;
				const path = ch.item.path.replace(/^\/+/, "");
				const type = (ch.changeType ?? "").toLowerCase();
				if (type.includes("delete")) files.push({ filename: path, status: "removed" });
				else if (type.includes("rename")) {
					// Report a rename as delete + add: the plain statuses every host's callers understand.
					const from = (ch.sourceServerItem ?? ch.originalPath ?? "").replace(/^\/+/, "");
					if (from && from !== path) files.push({ filename: from, status: "removed" });
					files.push({ filename: path, status: "added" });
				} else files.push({ filename: path, status: type.includes("add") ? "added" : "modified" });
			}
			if (list.length < top) break;
		}
		return { parent: c.parents?.[0] ?? null, files };
	}
	async getFileAt(path: string, ref: string): Promise<ArrayBuffer | null> {
		const q = `path=${enc(`/${path}`)}&versionDescriptor.version=${enc(ref)}&versionDescriptor.versionType=${isSha(ref) ? "commit" : "branch"}&$format=octetStream&download=true`;
		const res = await this.request("GET", `${this.repoPath}/items?${q}`, undefined, { accept: "application/octet-stream", okStatuses: [404] });
		return res.status === 404 ? null : res.arrayBuffer;
	}
	async listTags() {
		return (await this.refs("tags/")).map((r) => ({ name: r.name.replace(/^refs\/tags\//, ""), sha: r.peeledObjectId ?? r.objectId }));
	}
	async listBranches() {
		return (await this.refs("heads/")).map((r) => ({ name: r.name.replace(/^refs\/heads\//, ""), sha: r.objectId }));
	}
	async rateLimit() {
		return null;
	}
	async countFiles(branch: string): Promise<number> {
		const head = await this.getRef(branch);
		if (!head) return 0;
		return (await this.listTree(await this.getCommitTree(head))).filter((e) => e.type === "blob").length;
	}

	webUrl(kind: WebLink, path: string, ref: string): string | null {
		const repo = this.gitUrl();
		if (kind === "repo") return repo;
		const version = isSha(ref) ? `GC${ref}` : `GB${enc(ref)}`;
		return `${repo}?path=${enc(`/${path}`)}&version=${version}${kind === "history" ? "&_a=history" : ""}`;
	}
	async createPullRequest(head: string, base: string, title: string, body: string): Promise<{ url: string }> {
		// Azure caps the description at 4000 characters.
		const pr = await this.json<{ pullRequestId: number; repository?: { webUrl?: string } }>("POST", `${this.repoPath}/pullrequests`, {
			sourceRefName: `refs/heads/${head}`,
			targetRefName: `refs/heads/${base}`,
			title,
			description: body.length > 4000 ? `${body.slice(0, 3997)}...` : body,
		});
		return { url: `${pr.repository?.webUrl ?? this.gitUrl()}/pullrequest/${pr.pullRequestId}` };
	}
}
