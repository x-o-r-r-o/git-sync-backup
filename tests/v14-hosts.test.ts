import { test } from "node:test";
import assert from "node:assert/strict";
import { Bitbucket } from "../src/bitbucket.ts";
import { GitHub } from "../src/github.ts";
import { GitLab } from "../src/gitlab.ts";
import { Gitea } from "../src/gitea.ts";
import type { CommitRequest, Remote } from "../src/remote.ts";
import { FakeRepo, bitbucketTransport, giteaTransport, gitlabTransport } from "./support/fakehosts.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const PATH = "Notes/My file #1 ü.md";
const PATH_ENC = "Notes/My%20file%20%231%20%C3%BC.md";

/** Runs `fn` with globalThis.fetch replaced; the GitHub client reaches it through the requestUrl stub. */
async function withFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>, fn: () => Promise<void>) {
	const saved = globalThis.fetch;
	globalThis.fetch = (async (url: string, init: RequestInit) => handler(url, init)) as typeof fetch;
	try {
		await fn();
	} finally {
		globalThis.fetch = saved;
	}
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const gh = (apiBase = "https://api.github.com") => new GitHub(() => ({ token: "t", apiBase, owner: "o", repo: "r" }));

const cfg = (apiBase: string, owner = "me", repo = "vault") => () => ({ token: "t", apiBase, owner, repo });
const gitea = (repo: FakeRepo, apiBase = "https://gitea.test/api/v1") => new Gitea(cfg(apiBase), giteaTransport(repo));
const gitlab = (repo: FakeRepo, apiBase = "https://gitlab.test/api/v4") => new GitLab(cfg(apiBase), gitlabTransport(repo));
const bitbucket = (repo: FakeRepo) => new Bitbucket(cfg("https://bb.test/2.0"), null, bitbucketTransport(repo).transport);

async function repoWithBranches(n: number): Promise<FakeRepo> {
	const repo = new FakeRepo();
	const head = await repo.apply("main", "init", [{ op: "create", path: "a.md", content: b64("a") }]);
	for (let i = 0; i < n; i++) repo.branches.set(`b${i}`, head);
	return repo;
}

// ---- listBranches ----

test("listBranches: Gitea, GitLab and Bitbucket page through every branch", async () => {
	for (const make of [gitea, gitlab, bitbucket] as ((r: FakeRepo) => Remote)[]) {
		const repo = await repoWithBranches(130);
		const list = await make(repo).listBranches!();
		assert.equal(list.length, 131, make.name);
		assert.deepEqual(list[0], { name: "main", sha: repo.head() });
		assert.ok(list.some((b) => b.name === "b129"));
	}
});

test("listBranches: GitHub pages 100 at a time", async () => {
	const branches = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ name: `b${from + i}`, commit: { sha: `s${from + i}` } }));
	const seen: string[] = [];
	await withFetch(
		(url) => {
			const u = new URL(url);
			seen.push(u.pathname);
			const page = Number(u.searchParams.get("page"));
			return json(page === 1 ? branches(100, 0) : branches(7, 100));
		},
		async () => {
			const list = await gh().listBranches();
			assert.equal(list.length, 107);
			assert.deepEqual(list[106], { name: "b106", sha: "s106" });
		},
	);
	assert.deepEqual(seen, ["/repos/o/r/branches", "/repos/o/r/branches"]);
});

// ---- webUrl ----

test("webUrl: GitHub (incl. Enterprise) file, history and repo pages", () => {
	assert.equal(gh().webUrl("file", PATH, SHA), `https://github.com/o/r/blob/${SHA}/${PATH_ENC}`);
	assert.equal(gh().webUrl("history", PATH, "feature/x"), `https://github.com/o/r/commits/feature/x/${PATH_ENC}`);
	assert.equal(gh().webUrl("repo", "", "main"), "https://github.com/o/r");
	assert.equal(gh("https://ghe.example.com/api/v3").webUrl("file", "a.md", "main"), "https://ghe.example.com/o/r/blob/main/a.md");
	assert.equal(gh("https://api.octocorp.ghe.com").webUrl("repo", "", "main"), "https://octocorp.ghe.com/o/r");
});

test("webUrl: GitLab (self-managed, subgroups)", () => {
	const gl = new GitLab(cfg("https://git.example.com/api/v4", "group/sub", "vault"), gitlabTransport(new FakeRepo()));
	assert.equal(gl.webUrl("file", PATH, SHA), `https://git.example.com/group/sub/vault/-/blob/${SHA}/${PATH_ENC}`);
	assert.equal(gl.webUrl("history", PATH, "main"), `https://git.example.com/group/sub/vault/-/commits/main/${PATH_ENC}`);
	assert.equal(gl.webUrl("repo", "", "main"), "https://git.example.com/group/sub/vault");
	assert.equal(gitlab(new FakeRepo(), "https://gitlab.com/api/v4").webUrl("repo", "", "main"), "https://gitlab.com/me/vault");
});

test("webUrl: Gitea uses commit/ for shas and branch/ otherwise", () => {
	const g = gitea(new FakeRepo(), "https://codeberg.org/api/v1");
	assert.equal(g.webUrl("file", PATH, SHA), `https://codeberg.org/me/vault/src/commit/${SHA}/${PATH_ENC}`);
	assert.equal(g.webUrl("file", PATH, "main"), `https://codeberg.org/me/vault/src/branch/main/${PATH_ENC}`);
	assert.equal(g.webUrl("history", PATH, "main"), `https://codeberg.org/me/vault/commits/branch/main/${PATH_ENC}`);
	assert.equal(g.webUrl("history", PATH, SHA), `https://codeberg.org/me/vault/commits/commit/${SHA}/${PATH_ENC}`);
	assert.equal(g.webUrl("repo", "", "main"), "https://codeberg.org/me/vault");
});

test("webUrl: Bitbucket src and history-node pages", () => {
	const bb = new Bitbucket(cfg("https://api.bitbucket.org/2.0", "ws", "vault"), null, bitbucketTransport(new FakeRepo()).transport);
	assert.equal(bb.webUrl("file", PATH, SHA), `https://bitbucket.org/ws/vault/src/${SHA}/${PATH_ENC}`);
	assert.equal(bb.webUrl("history", PATH, "main"), `https://bitbucket.org/ws/vault/history-node/main/${PATH_ENC}`);
	assert.equal(bb.webUrl("repo", "", "main"), "https://bitbucket.org/ws/vault");
});

// ---- createPullRequest ----

test("createPullRequest: Gitea, GitLab and Bitbucket send the host's fields and return the web address", async () => {
	let repo = new FakeRepo();
	assert.deepEqual(await gitea(repo).createPullRequest!("dev", "main", "T", "B"), { url: "https://gitea.test/me/vault/pulls/1" });
	assert.deepEqual(repo.prs[0], { head: "dev", base: "main", title: "T", body: "B" });

	repo = new FakeRepo();
	assert.deepEqual(await gitlab(repo).createPullRequest!("dev", "main", "T", "B"), { url: "https://gitlab.test/me/vault/-/merge_requests/1" });
	assert.deepEqual(repo.prs[0], { source_branch: "dev", target_branch: "main", title: "T", description: "B" });

	repo = new FakeRepo();
	assert.deepEqual(await bitbucket(repo).createPullRequest!("dev", "main", "T", "B"), { url: "https://bitbucket.test/me/vault/pull-requests/1" });
	assert.deepEqual(repo.prs[0], { title: "T", description: "B", source: { branch: { name: "dev" } }, destination: { branch: { name: "main" } } });
});

test("createPullRequest: GitHub POST /pulls", async () => {
	let sent: { url: string; method?: string; body: unknown } | null = null;
	await withFetch(
		(url, init) => {
			sent = { url, method: init.method, body: JSON.parse(String(init.body)) };
			return json({ number: 5, html_url: "https://github.com/o/r/pull/5" }, 201);
		},
		async () => {
			assert.deepEqual(await gh().createPullRequest("dev", "main", "T", "B"), { url: "https://github.com/o/r/pull/5" });
		},
	);
	assert.deepEqual(sent, { url: "https://api.github.com/repos/o/r/pulls", method: "POST", body: { title: "T", head: "dev", base: "main", body: "B" } });
});

// ---- commit author ----

async function commitWith(remote: Remote, repo: FakeRepo, author?: { name: string; email: string }) {
	const parent = repo.head()!;
	const parentTree = await remote.getCommitTree(parent);
	const req: CommitRequest = { branch: "main", parent, parentTree, message: "m", upserts: [{ path: "n.md", mode: "100644", load: async () => enc(String(Math.random())) }], deletes: [] };
	if (author) req.author = author;
	await remote.commit(req);
}

test("commit author: Gitea, GitLab and Bitbucket send it only when set", async () => {
	const who = { name: "Fadi Q", email: "f@example.com" };
	const cases: [string, (r: FakeRepo) => Remote, unknown][] = [
		["gitea", gitea, { name: "Fadi Q", email: "f@example.com" }],
		["gitlab", gitlab, { name: "Fadi Q", email: "f@example.com" }],
		["bitbucket", bitbucket, "Fadi Q <f@example.com>"],
	];
	for (const [name, make, expected] of cases) {
		const repo = await repoWithBranches(0);
		const remote = make(repo);
		await commitWith(remote, repo, who);
		assert.deepEqual(repo.lastAuthor, expected, name);
		await commitWith(remote, repo);
		assert.equal(repo.lastAuthor, undefined, `${name}: no author without req.author`);
	}
});

test("commit author: GitHub createCommit carries author with a date", async () => {
	const commits: Record<string, unknown>[] = [];
	await withFetch(
		(url, init) => {
			const u = new URL(url);
			if (u.pathname.endsWith("/git/trees")) return json({ sha: "tree2" }, 201);
			if (u.pathname.endsWith("/git/commits")) {
				commits.push(JSON.parse(String(init.body)));
				return json({ sha: "c2" }, 201);
			}
			if (u.pathname.includes("/git/refs/heads/")) return json({ object: { sha: "c2" } });
			if (u.pathname.includes("/git/ref/heads/")) return json({ object: { sha: "c1" } });
			return json({ message: "no route" }, 404);
		},
		async () => {
			const req: CommitRequest = { branch: "main", parent: "c1", parentTree: "t1", message: "m", upserts: [{ path: "a.md", mode: "100644", load: async () => enc("x"), text: () => "x" }], deletes: [] };
			await gh().commit({ ...req, author: { name: "Fadi", email: "f@example.com" } });
			await gh().commit(req);
		},
	);
	const a = commits[0].author as { name: string; email: string; date: string };
	assert.equal(a.name, "Fadi");
	assert.equal(a.email, "f@example.com");
	assert.ok(!Number.isNaN(Date.parse(a.date)));
	assert.equal(commits[1].author, undefined);
	assert.deepEqual(commits[1], { message: "m", tree: "tree2", parents: ["c1"] });
});
