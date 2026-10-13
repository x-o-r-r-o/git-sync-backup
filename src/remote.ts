// What the sync engine needs from a git host. Implemented for GitHub (Git Data API), Gitea/Forgejo
// (ChangeFiles API) and GitLab (Commits API). Paths here are repository paths (after any codec).

export interface TreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	size?: number;
}

/** Where a blob can be found: a repository path at a commit (or branch). */
export interface BlobHint {
	path: string;
	ref: string;
}

export interface CommitInfo {
	sha: string;
	message: string;
	date: string;
	author: string;
}

/** A file to write in a commit. `sha` reuses an existing blob; otherwise `load` provides the bytes. */
export interface Upsert {
	path: string;
	mode: string;
	sha?: string;
	load: () => Promise<ArrayBuffer>;
	/** UTF-8 text form, when the host may send it inline (plain text files only). */
	text?: (bytes: ArrayBuffer) => string | null;
}

export interface CommitRequest {
	branch: string;
	parent: string;
	parentTree: string;
	message: string;
	upserts: Upsert[];
	deletes: string[];
	/** Repository path → blob sha at `parent`, when the caller already knows it (saves a tree listing). */
	existing?: Map<string, string>;
	/** Called as upload batches complete. */
	progress?: (done: number, total: number) => void;
	/** Commit author (the host's default identity when absent). */
	author?: { name: string; email: string };
}

/** Kind of web page for a file on the host. */
export type WebLink = "file" | "history" | "repo";

export interface CommitResult {
	sha: string;
	/** False when the host committed on top of a newer head (it merged non-conflicting changes). */
	fastForward: boolean;
	/** Blob shas the host stored, by path, when known. */
	blobShas?: Map<string, string>;
}

export type Relation = "ahead" | "behind" | "identical" | "diverged" | "missing";

export class NotFastForward extends Error {
	constructor() {
		super("The branch moved while syncing (another device pushed).");
	}
}

export class RemoteError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export interface Remote {
	readonly kind: "github" | "gitea" | "gitlab" | "bitbucket";
	readonly label: string;

	getUser(): Promise<{ login: string }>;
	getRepo(): Promise<{ private: boolean; default_branch: string; html_url: string; size: number } | null>;
	createRepo(name: string, org?: string): Promise<{ html_url: string }>;
	listRepos(maxPages?: number): Promise<{ owner: string; name: string; private: boolean; updated: string; defaultBranch: string }[]>;

	/** Head commit of a branch, or null if it (or the whole repo) is empty. */
	getRef(branch: string): Promise<string | null>;
	createRef(ref: string, sha: string): Promise<void>;
	getCommitTree(sha: string): Promise<string>;
	/** Full file list of a tree. */
	listTree(treeSha: string): Promise<TreeEntry[]>;
	/**
	 * Blob content by sha. `hint` (optional) says where the blob lives (repository path at commit
	 * `ref`); hosts whose blob endpoint has a size cap (Gitea) use it to fetch large files another way,
	 * and throw a clear error without it rather than return empty bytes.
	 */
	getBlob(sha: string, hint?: BlobHint): Promise<ArrayBuffer>;
	/** First commit in an empty repository. */
	putFile(path: string, message: string, base64: string, branch: string): Promise<void>;
	/** Atomic multi-file commit on top of `parent`. Throws NotFastForward if the host refuses. */
	commit(req: CommitRequest): Promise<CommitResult>;
	compare(base: string, head: string): Promise<Relation>;

	listCommits(branch: string, path?: string, perPage?: number): Promise<CommitInfo[]>;
	getCommitFiles(sha: string): Promise<{ parent: string | null; files: { filename: string; status: string }[] }>;
	getFileAt(path: string, ref: string): Promise<ArrayBuffer | null>;
	listTags(): Promise<{ name: string; sha: string }[]>;
	rateLimit(): Promise<{ limit: number; remaining: number; reset: number } | null>;
	countFiles(branch: string): Promise<number>;
	/** Raw HTTP access for host-specific extras (e.g. Git LFS). */
	request(method: string, path: string, body?: unknown, opts?: { accept?: string; okStatuses?: number[] }): Promise<{ status: number; json: unknown; arrayBuffer: ArrayBuffer; headers: Record<string, string> }>;
	/** HTTPS clone URL base of the repo (used by Git LFS). */
	gitUrl(): string;
	authHeader(): string;
	/** When the token expires (epoch ms), if the host reports it; null = unknown or never. */
	tokenExpiresAt?(): number | null;
	/** Branches of the repository (name → head commit). */
	listBranches?(): Promise<{ name: string; sha: string }[]>;
	/**
	 * Web address of a repository path: the file at `ref` (a commit sha or branch), its history on
	 * branch `ref`, or the repository itself (path ignored). Null when the host has no such page.
	 */
	webUrl?(kind: WebLink, path: string, ref: string): string | null;
	/** Opens a pull/merge request from branch `head` into `base`; returns its web address. */
	createPullRequest?(head: string, base: string, title: string, body: string): Promise<{ url: string }>;
}
