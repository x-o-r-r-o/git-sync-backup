import { test } from "node:test";
import assert from "node:assert/strict";
import { webBase } from "../src/auth.ts";
import { Bitbucket } from "../src/bitbucket.ts";
import type { BlobCache } from "../src/bitbucket.ts";
import { GitHub } from "../src/github.ts";
import { GitLab } from "../src/gitlab.ts";
import { Gitea } from "../src/gitea.ts";
import { compareByWalking, httpRequest } from "../src/http.ts";
import type { HttpRequest, HttpResponse } from "../src/http.ts";
import { FakeRepo, bitbucketTransport, giteaTransport, gitlabTransport } from "./support/fakehosts.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64");
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const okRes = (json: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, json, arrayBuffer: new ArrayBuffer(0), headers });

async function linearRepo(n: number): Promise<{ repo: FakeRepo; shas: string[] }> {
	const repo = new FakeRepo();
	const shas: string[] = [];
	for (let i = 0; i < n; i++) shas.push(await repo.apply("main", `c${i}`, [{ op: i ? "update" : "create", path: "a.md", content: b64(`v${i}`) }]));
	return { repo, shas };
}

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
const gh = () => new GitHub(() => ({ token: "t", apiBase: "https://api.github.com", owner: "o", repo: "r" }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("compareByWalking: a short page is not the end of history; X-HasMore / next links are honoured", async () => {
	const { repo, shas } = await linearRepo(30);
	const fake = giteaTransport(repo);
	// Server clamps `limit` to 10 (MAX_RESPONSE_ITEMS) and sends no X-HasMore.
	const clamped = async (req: HttpRequest) => fake({ ...req, url: req.url.replace(/limit=\d+/, "limit=10") });
	const gitea = new Gitea(() => ({ token: "t", apiBase: "https://gitea.test/api/v1", owner: "me", repo: "vault" }), clamped);
	assert.equal(await gitea.compare(shas[0], shas[29]), "ahead");
	assert.equal(await gitea.compare(shas[29], shas[0]), "behind");

	let calls = 0;
	const rel = await compareByWalking(async () => (calls++, { shas: ["x"], more: false }), "a", "b");
	assert.equal(rel, "diverged");
	assert.equal(calls, 2, "more:false stops each walk after one page");
});

test("GitLab: listTree reports sizes, looked up once per blob", async () => {
	const repo = new FakeRepo();
	const head = await repo.apply("main", "init", [
		{ op: "create", path: "big.bin", content: b64("x".repeat(5000)) },
		{ op: "create", path: "n/small.md", content: b64("hi") },
		{ op: "create", path: "copy.md", content: b64("hi") },
	]);
	const calls = { head: 0 };
	const gl = new GitLab(() => ({ token: "t", apiBase: "https://gitlab.test/api/v4", owner: "me", repo: "vault" }), gitlabTransport(repo, calls));
	const sizes = Object.fromEntries((await gl.listTree(head)).map((e) => [e.path, e.size]));
	assert.deepEqual(sizes, { "big.bin": 5000, "n/small.md": 2, "copy.md": 2 });
	assert.equal(calls.head, 2, "identical blobs share one lookup");
	await gl.listTree(head);
	assert.equal(calls.head, 2, "cached for the next listing");
	assert.equal(await gl.countFiles("main"), 3);
	assert.equal(calls.head, 2, "countFiles needs no sizes");
});

test("GitLab: sizes survive a restart; a failed size lookup never fails the listing", async () => {
	const repo = new FakeRepo();
	const head = await repo.apply("main", "init", [
		{ op: "create", path: "a.md", content: b64("hello") },
		{ op: "create", path: "b.md", content: b64("world!") },
	]);
	let saved: unknown = null;
	const store = { load: async () => saved, save: async (v: unknown) => void (saved = v) };
	const cfg = () => ({ token: "t", apiBase: "https://gitlab.test/api/v4", owner: "me", repo: "vault" });
	const calls = { head: 0 };
	await new GitLab(cfg, gitlabTransport(repo, calls), store).listTree(head);
	assert.equal(calls.head, 2);
	// A new session (plugin reload): sizes come from the saved file, no HEAD requests.
	const after = { head: 0 };
	const sizes = Object.fromEntries((await new GitLab(cfg, gitlabTransport(repo, after), store).listTree(head)).map((e) => [e.path, e.size]));
	assert.deepEqual(sizes, { "a.md": 5, "b.md": 6 });
	assert.equal(after.head, 0, "nothing looked up again after a restart");

	// HEAD failing (e.g. rate limited): the listing still works, sizes are just unknown.
	const base = gitlabTransport(repo, { head: 0 });
	const failing: typeof base = async (req) => {
		if (req.method === "HEAD") throw new Error("network down");
		return base(req);
	};
	const list = await new GitLab(cfg, failing).listTree(head);
	assert.deepEqual(list.map((e) => [e.path, e.size]), [["a.md", undefined], ["b.md", undefined]]);
});

test("webBase: GitHub Enterprise Cloud data residency hosts", () => {
	assert.equal(webBase("https://api.octocorp.ghe.com"), "https://octocorp.ghe.com");
	assert.equal(webBase("https://api.octocorp.ghe.com/"), "https://octocorp.ghe.com");
	assert.equal(webBase("https://ghe.example.com/api/v3"), "https://ghe.example.com");
	assert.equal(webBase(""), "https://github.com");
});

test("Bitbucket: git credentials for API tokens, app passwords and access tokens", () => {
	const auth = (token: string) => atob(new Bitbucket(() => ({ token, apiBase: "", owner: "me", repo: "vault" })).authHeader().replace(/^Basic /, ""));
	assert.equal(auth("me@example.com:ATATT123"), "x-bitbucket-api-token-auth:ATATT123");
	assert.equal(auth("fadi:apppw"), "fadi:apppw");
	assert.equal(auth("acc3ss"), "x-token-auth:acc3ss");
});

test("Bitbucket: file attributes become modes; executables are committed with x-attributes", async () => {
	const repo = new FakeRepo();
	await repo.apply("main", "init", [
		{ op: "create", path: "a.md", content: b64("a") },
		{ op: "create", path: "run.sh", content: b64("#!/bin/sh") },
		{ op: "create", path: "link", content: b64("a.md") },
	]);
	const attrs: Record<string, string[]> = { "run.sh": ["executable"], link: ["link"], "bin/tool": ["executable"] };
	const bb = bitbucketTransport(repo);
	const bodies: string[] = [];
	const transport = async (req: HttpRequest) => {
		if (req.method === "POST" && req.body instanceof ArrayBuffer) bodies.push(new TextDecoder().decode(req.body));
		const res = await bb.transport(req);
		const values = (res.json as { values?: { path: string; type: string; attributes?: string[] }[] } | null)?.values;
		if (/\/src\//.test(req.url) && values) for (const v of values) if (attrs[v.path]) v.attributes = attrs[v.path];
		return res;
	};
	const store = { c: null as BlobCache | null };
	const remote = new Bitbucket(
		() => ({ token: "t", apiBase: "https://bb.test/2.0", owner: "me", repo: "vault" }),
		{ load: async () => store.c, save: async (c) => void (store.c = JSON.parse(JSON.stringify(c))) },
		transport,
	);
	const modes = async (sha: string) => Object.fromEntries((await remote.listTree(sha)).map((e) => [e.path, e.mode]));
	// Links stay plain files, as before 1.3, so links that already synced never look deleted.
	assert.deepEqual(await modes(repo.head()!), { "a.md": "100644", "run.sh": "100755", link: "100644" });

	// Changed paths (incremental listing) get their attributes too.
	await repo.apply("main", "add tool", [{ op: "create", path: "bin/tool", content: b64("#!/bin/sh\necho") }]);
	assert.equal((await modes(repo.head()!))["bin/tool"], "100755");

	const parent = repo.head()!;
	await remote.commit({
		branch: "main",
		parent,
		parentTree: parent,
		message: "m",
		upserts: [
			{ path: "run.sh", mode: "100755", load: async () => enc("#!/bin/sh\nexit 0") },
			{ path: "a.md", mode: "100644", load: async () => enc("a2") },
		],
		deletes: [],
	});
	const body = bodies.at(-1)!;
	const part = (name: string) => body.split(/--+vaultsync\w+/).find((p) => p.includes(`name="/${name}"`)) ?? "";
	assert.match(part("run.sh"), /Content-Disposition: form-data; name="[^"]*run.sh"; filename="run.sh"; x-attributes:"executable"/, "inside Content-Disposition, as Bitbucket documents");
	assert.doesNotMatch(part("a.md"), /x-attributes/);
});

test("pagination: GitHub commit files and tags, Gitea tags, GitLab commit diff", async () => {
	const files = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${from + i}`, status: "added" }));
	const tags = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ name: `t${from + i}`, commit: { sha: "s" } }));
	await withFetch(
		(url) => {
			const u = new URL(url);
			const page = Number(u.searchParams.get("page") ?? 1);
			if (u.pathname.endsWith("/commits/abc")) return json({ parents: [{ sha: "p" }], files: page === 1 ? files(300, 0) : page === 2 ? files(300, 300) : files(5, 600) });
			if (u.pathname.endsWith("/tags")) return json(page === 1 ? tags(100, 0) : tags(3, 100));
			return json({ message: "no route" }, 404);
		},
		async () => {
			const c = await gh().getCommitFiles("abc");
			assert.equal(c.files.length, 605);
			assert.equal(c.parent, "p");
			assert.equal((await gh().listTags()).length, 103);
		},
	);

	const repo = new FakeRepo();
	const head = await repo.apply("main", "init", [{ op: "create", path: "a.md", content: b64("a") }]);
	for (let i = 0; i < 120; i++) repo.tags.set(`v${i}`, head);
	const gitea = new Gitea(() => ({ token: "t", apiBase: "https://gitea.test/api/v1", owner: "me", repo: "vault" }), giteaTransport(repo));
	assert.equal((await gitea.listTags()).length, 120);

	const diffs = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ new_path: `d${from + i}`, old_path: `d${from + i}` }));
	const glTransport = async (req: HttpRequest): Promise<HttpResponse> => {
		const u = new URL(req.url);
		if (u.pathname.endsWith("/diff")) {
			const page = Number(u.searchParams.get("page"));
			return okRes(page === 1 ? diffs(100, 0) : diffs(40, 100), { "X-Next-Page": page === 1 ? "2" : "" });
		}
		return okRes({ id: "abc", parent_ids: ["p"] });
	};
	const gl = new GitLab(() => ({ token: "t", apiBase: "https://gitlab.test/api/v4", owner: "me", repo: "vault" }), glTransport);
	assert.equal((await gl.getCommitFiles("abc")).files.length, 140);
});

test("GitHub: secondary rate limit without Retry-After waits a minute once, then explains", async () => {
	let n = 0;
	await withFetch(
		() => (n++ === 0 ? json({ message: "You have exceeded a secondary rate limit." }, 403) : json({ login: "me" })),
		async () => {
			const c = gh();
			const waits: number[] = [];
			c.delay = async (ms) => void waits.push(ms);
			assert.equal((await c.getUser()).login, "me");
			assert.deepEqual(waits, [60_000]);
		},
	);
	await withFetch(
		() => json({ message: "You have exceeded a secondary rate limit." }, 429),
		async () => {
			const c = gh();
			const waits: number[] = [];
			c.delay = async (ms) => void waits.push(ms);
			await assert.rejects(c.getUser(), /secondary rate limit hit\. Try again in a minute/);
			assert.deepEqual(waits, [60_000]);
		},
	);
});

test("network failure: no wait after the final attempt (GitHub and other hosts)", async () => {
	await withFetch(
		() => {
			throw new Error("offline");
		},
		async () => {
			const c = gh();
			const waits: number[] = [];
			c.delay = async (ms) => void waits.push(ms);
			await assert.rejects(c.getUser(), /offline/);
			assert.deepEqual(waits, [1000, 2000, 4000]);
		},
	);
	const waits: number[] = [];
	let tries = 0;
	await assert.rejects(
		httpRequest(
			async () => {
				tries++;
				throw new Error("offline");
			},
			{ url: "https://x.test/", method: "GET", headers: {} },
			{ hostLabel: "X", wait: async (ms) => void waits.push(ms) },
		),
		/offline/,
	);
	assert.equal(tries, 4);
	assert.deepEqual(waits, [1000, 2000, 4000]);
});
