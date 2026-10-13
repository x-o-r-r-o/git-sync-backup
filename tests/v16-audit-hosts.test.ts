import { test } from "node:test";
import assert from "node:assert/strict";
import { Bitbucket } from "../src/bitbucket.ts";
import type { BlobCache } from "../src/bitbucket.ts";
import { GitLab } from "../src/gitlab.ts";
import { Gitea } from "../src/gitea.ts";
import { GitHub } from "../src/github.ts";
import { sameOrigin } from "../src/http.ts";
import type { HttpRequest, HttpResponse } from "../src/http.ts";
import { NotFastForward } from "../src/remote.ts";
import type { CommitRequest } from "../src/remote.ts";
import { parseSetupPayload } from "../src/setuplink.ts";
import { redactSecrets, tokenLooksLike, urlHost } from "../src/util.ts";
import { FakeRepo, bitbucketTransport, giteaTransport, gitlabTransport } from "./support/fakehosts.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const cfg = (apiBase: string) => () => ({ token: "t", apiBase, owner: "me", repo: "vault" });
const req = (parent: string, upserts: CommitRequest["upserts"]): CommitRequest => ({ branch: "main", parent, parentTree: parent, message: "mine", upserts, deletes: [] });
const up = (path: string, text: string) => ({ path, mode: "100644", load: async () => enc(text) });

// ---- 1. Bitbucket: the new commit comes from the Location header, not the branch head ----

async function bbRace(noLocation: boolean) {
	const repo = new FakeRepo();
	const c1 = await repo.apply("main", "init", [{ op: "create", path: "a.md", content: b64("a") }]);
	const inner = bitbucketTransport(repo, { noLocation }).transport;
	// Another device commits right after our POST /src lands, before we look at the branch.
	const transport = async (r: HttpRequest): Promise<HttpResponse> => {
		const res = await inner(r);
		if (r.method === "POST" && new URL(r.url).pathname.endsWith("/src")) await repo.apply("main", "theirs", [{ op: "create", path: "theirs.md", content: b64("t") }]);
		return res;
	};
	return { repo, c1, bb: new Bitbucket(cfg("https://bb.test/2.0"), null, transport) };
}

test("Bitbucket commit: takes its commit from Location, never another device's commit made just after", async () => {
	const { repo, c1, bb } = await bbRace(false);
	const res = await bb.commit(req(c1, [up("mine.md", "m")]));
	const mine = repo.commits.get(res.sha);
	assert.ok(mine, "returned sha is a real commit");
	assert.equal(mine.message, "mine");
	assert.deepEqual(mine.parents, [c1]);
	assert.notEqual(res.sha, repo.head(), "the other device's commit is not adopted");
});

test("Bitbucket commit: without Location, a branch head that isn't ours on top of our parent is NotFastForward", async () => {
	const { c1, bb } = await bbRace(true);
	await assert.rejects(() => bb.commit(req(c1, [up("mine.md", "m")])), NotFastForward);
});

// ---- 7. Bitbucket: the token only goes to the API origin ----

test("Bitbucket: a pagination link to another server is refused and never receives the token", async () => {
	const seen: string[] = [];
	const transport = async (r: HttpRequest): Promise<HttpResponse> => {
		seen.push(r.url);
		return { status: 200, json: { values: [{ name: "main", target: { hash: "x" } }], next: "https://evil.test/2.0/repositories/me/vault/refs/branches?page=2" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
	};
	const bb = new Bitbucket(cfg("https://bb.test/2.0"), null, transport);
	await assert.rejects(() => bb.listBranches(), /another server/);
	assert.ok(seen.every((u) => u.startsWith("https://bb.test/")), seen.join(", "));
	// Same origin is still followed (host case and default port don't matter).
	assert.equal(sameOrigin("https://BB.test:443/2.0/x", "https://bb.test/2.0"), true);
	assert.equal(sameOrigin("http://bb.test/2.0/x", "https://bb.test/2.0"), false);
	assert.equal(sameOrigin("https://bb.test.evil/2.0", "https://bb.test/2.0"), false);
});

// ---- 8. Bitbucket: a file replaced by a folder ----

test("Bitbucket listTree: a file replaced by a folder is dropped, not hashed as a folder listing", async () => {
	const repo = new FakeRepo();
	const store = { c: null as BlobCache | null };
	const bb = new Bitbucket(cfg("https://bb.test/2.0"), { load: async () => store.c, save: async (c) => void (store.c = JSON.parse(JSON.stringify(c))) }, bitbucketTransport(repo).transport);
	const c1 = await repo.apply("main", "init", [{ op: "create", path: "x", content: b64("file") }, { op: "create", path: "keep.md", content: b64("k") }]);
	await bb.listTree(c1);
	const c2 = await repo.apply("main", "dir", [{ op: "delete", path: "x" }, { op: "create", path: "x/y.md", content: b64("inside") }]);
	const list = await bb.listTree(c2);
	assert.deepEqual(list.map((e) => e.path).sort(), ["keep.md", "x/y.md"]);
	assert.equal(store.c?.commit, c2);
});

// ---- 2. GitLab: pagination links from another origin ----

test("GitLab listTree: pagination works when the Link header names another origin, and requests stay on the API base", async () => {
	const repo = new FakeRepo();
	const ops = Array.from({ length: 7 }, (_, i) => ({ op: "create", path: `n${i}.md`, content: b64(String(i)) }));
	const head = await repo.apply("main", "init", ops);
	for (const origin of ["http://GITLAB.test", "http://internal-proxy:8080"]) {
		const inner = gitlabTransport(repo);
		const urls: string[] = [];
		const transport = async (r: HttpRequest): Promise<HttpResponse> => {
			urls.push(r.url);
			const res = await inner(r);
			const link = res.headers.Link;
			return link ? { ...res, headers: { ...res.headers, Link: link.replace("https://gitlab.test", origin) } } : res;
		};
		const gl = new GitLab(cfg("https://gitlab.test/api/v4"), transport);
		const list = await gl.listTree(head);
		assert.equal(list.length, 7, origin);
		assert.ok(urls.every((u) => u.startsWith("https://gitlab.test/api/v4/projects/")), urls.join("\n"));
	}
});

test("GitLab listTree: a pagination link outside the API is refused", async () => {
	const transport = async (): Promise<HttpResponse> => ({ status: 200, json: [{ path: "a", mode: "100644", type: "blob", id: "1" }], arrayBuffer: new ArrayBuffer(0), headers: { Link: '<https://gitlab.test/elsewhere?x=1>; rel="next"' } });
	const gl = new GitLab(cfg("https://gitlab.test/api/v4"), transport);
	await assert.rejects(() => gl.listTree("abc"), /pagination link/);
});

// ---- 5. GitLab: a 404 on the first tree page ----

test("GitLab listTree: 404 for an unknown commit throws; 'Tree Not Found' at an existing commit is an empty tree", async () => {
	const mk = (treeMsg: string, commitExists: boolean) =>
		new GitLab(cfg("https://gitlab.test/api/v4"), async (r: HttpRequest): Promise<HttpResponse> => {
			const p = new URL(r.url).pathname;
			if (p.endsWith("/repository/tree")) return { status: 404, json: { message: treeMsg }, arrayBuffer: new ArrayBuffer(0), headers: {} };
			if (p.includes("/repository/commits/")) return commitExists ? { status: 200, json: { id: "abc" }, arrayBuffer: new ArrayBuffer(0), headers: {} } : { status: 404, json: { message: "404 Commit Not Found" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
			return { status: 404, json: { message: "404 Not Found" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
		});
	await assert.rejects(() => mk("404 Not Found", true).listTree("abc"), /HTTP 404/);
	await assert.rejects(() => mk("404 Tree Not Found", false).listTree("abc"), /HTTP 404/);
	assert.deepEqual(await mk("404 Tree Not Found", true).listTree("abc"), []);
});

// ---- 3 + 4. Gitea: blob size cap and tree page limit ----

test("Gitea getBlob: above the server's blob size limit, never returns empty bytes; uses the path hint", async () => {
	const repo = new FakeRepo();
	const head = await repo.apply("main", "init", [{ op: "create", path: "big/file.bin", content: b64("pretend this is 20 MiB") }]);
	const sha = repo.commits.get(head)!.files.get("big/file.bin")!;
	const inner = giteaTransport(repo);
	const transport = async (r: HttpRequest): Promise<HttpResponse> => {
		if (new URL(r.url).pathname.includes("/git/blobs/")) return { status: 200, json: { content: null, size: 20 * 1024 * 1024, sha }, arrayBuffer: new ArrayBuffer(0), headers: {} };
		return inner(r);
	};
	const g = new Gitea(cfg("https://gitea.test/api/v1"), transport);
	await assert.rejects(() => g.getBlob(sha), /too large for this server's API/);
	assert.equal(new TextDecoder().decode(await g.getBlob(sha, { path: "big/file.bin", ref: head })), "pretend this is 20 MiB");
	// A raw file that doesn't match the requested blob is refused.
	await assert.rejects(() => g.getBlob("0".repeat(40), { path: "big/file.bin", ref: head }), /did not match/);
	// Empty files are still fine.
	const empty = new Gitea(cfg("https://gitea.test/api/v1"), async () => ({ status: 200, json: { content: "", size: 0 }, arrayBuffer: new ArrayBuffer(0), headers: {} }));
	assert.equal((await empty.getBlob("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")).byteLength, 0);
});

test("Gitea listTree: running out of pages throws instead of returning a partial listing", async () => {
	let pages = 0;
	const g = new Gitea(cfg("https://gitea.test/api/v1"), async () => {
		pages++;
		return { status: 200, json: { tree: [{ path: `f${pages}`, mode: "100644", type: "blob", sha: "1" }], truncated: true }, arrayBuffer: new ArrayBuffer(0), headers: {} };
	});
	await assert.rejects(() => g.listTree("t"), /too large to list/);
	assert.equal(pages, 999);
});

// ---- 9. GitHub: the branch must still be at our parent before the ref update ----

test("GitHub commit: a branch moved (or rolled back) since we started is NotFastForward; the ref is not touched", async () => {
	const gh = new GitHub(() => ({ token: "t", apiBase: "https://api.github.com", owner: "o", repo: "r" }));
	let patched = false;
	Object.assign(gh, {
		createTree: async () => "t2",
		createBlob: async () => "b",
		createCommit: async () => "c2",
		getRef: async () => "older",
		updateRef: async () => ((patched = true), true),
	});
	await assert.rejects(() => gh.commit(req("c1", [{ ...up("a.md", "x"), text: () => "x" }])), NotFastForward);
	assert.equal(patched, false);
});

// ---- 10. Setup links: path segments ----

test("setup link: '.', '..' and empty owner/repo segments are refused", () => {
	const link = (owner: string, repo: string) => Buffer.from(JSON.stringify({ v: 1, provider: "gitlab", owner, repo, branch: "main" })).toString("base64url");
	assert.ok(parseSetupPayload(link("group/sub", "vault")));
	for (const [o, r] of [["..", "vault"], ["me", ".."], [".", "vault"], ["group/..", "vault"], ["me", "a/./b"], ["group//sub", "vault"], ["me/", "vault"]]) assert.equal(parseSetupPayload(link(o, r)), null, `${o} ${r}`);
});

// ---- 11. Redaction ----

test("redactSecrets: Bitbucket ATCTT tokens and 'token <hex>' / Authorization headers", () => {
	const hex = "0123456789abcdef0123456789abcdef01234567";
	const out = redactSecrets(`a ATCTT3xFfGF0abcdefghijklmnop b\nAuthorization: token ${hex}\n{"Authorization": "token abcdef0123456789abcdef"}\ntoken: ${hex}\nBearer ghp_abcdefghijklmnop\n${"a".repeat(64)}`);
	assert.ok(!out.includes("ATCTT3x"), out);
	assert.ok(!out.includes(hex), out);
	assert.ok(!out.includes("abcdef0123456789abcdef"), out);
	assert.ok(!out.includes("ghp_"), out);
	assert.ok(!out.includes("a".repeat(64)), out);
	assert.equal(redactSecrets("plain text with a token word"), "plain text with a token word");
});

// ---- 6 + 12. Token binding helpers ----

test("tokenLooksLike: only formats that fit the host", () => {
	assert.equal(tokenLooksLike("github", "ghp_abcdefghijklmnop"), true);
	assert.equal(tokenLooksLike("github", "github_pat_11ABC_def"), true);
	assert.equal(tokenLooksLike("github", "glpat-abcdefghij"), false);
	assert.equal(tokenLooksLike("gitlab", "glpat-abcdefghij"), true);
	assert.equal(tokenLooksLike("gitlab", "ghp_abcdefghijklmnop"), false);
	assert.equal(tokenLooksLike("bitbucket", "ATCTT3xFfGF0abc"), true);
	assert.equal(tokenLooksLike("bitbucket", "ATBBabcdef123"), true);
	assert.equal(tokenLooksLike("bitbucket", "me@example.com:ATATT3xyz"), true);
	assert.equal(tokenLooksLike("bitbucket", "ghp_abcdefghijklmnop"), false);
	assert.equal(tokenLooksLike("gitea", "0123456789abcdef0123456789abcdef01234567"), true);
	assert.equal(tokenLooksLike("gitea", "ghp_abcdefghijklmnop"), false);
	assert.equal(tokenLooksLike("other", "anything"), false);
});

test("urlHost: host name and port, lower-cased", () => {
	assert.equal(urlHost("https://Git.Example.com/api/v1"), "git.example.com");
	assert.equal(urlHost("http://git.example.com:3000/api/v1"), "git.example.com:3000");
	assert.equal(urlHost("https://git.example.com:443/x"), "git.example.com");
	assert.equal(urlHost("not a url"), null);
});
