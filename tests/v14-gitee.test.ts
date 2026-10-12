import { test } from "node:test";
import assert from "node:assert/strict";
import { Gitee, GITEE_MAX_FILE_BYTES } from "../src/gitee.ts";
import { NotFastForward, RemoteError } from "../src/remote.ts";
import type { HttpRequest, HttpResponse } from "../src/http.ts";
import { FakeRepo } from "./support/fakehosts.ts";
import { device } from "./support/fakes.ts";

// ---------- fake Gitee API v5 at https://gitee.test/api/v5, repo me/vault ----------

const te = new TextEncoder();
const toAB = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const b64 = (s: string | Uint8Array) => Buffer.from(typeof s === "string" ? te.encode(s) : s).toString("base64");
const ok = (json: unknown, headers: Record<string, string> = {}, status = 200): HttpResponse => ({ status, json, arrayBuffer: toAB(te.encode(JSON.stringify(json))), headers });
const raw = (data: Uint8Array): HttpResponse => ({ status: 200, json: null, arrayBuffer: toAB(data), headers: {} });
const err = (status: number, message = "error"): HttpResponse => ({ status, json: { message }, arrayBuffer: new ArrayBuffer(0), headers: {} });
const hex = (s: string) => Buffer.from(s).toString("hex");
const unhex = (s: string) => Buffer.from(s, "hex").toString();

interface FakeOpts {
	/** Recursive tree listings report truncated: true (forces the per-folder walk). */
	truncateTrees?: boolean;
	/** Runs before each contents write (simulates another device pushing mid-commit). */
	beforeWrite?: (n: number) => Promise<void> | void;
}

function giteeServer(repo: FakeRepo, opts: FakeOpts = {}) {
	const log: { method: string; path: string; query: URLSearchParams; body: any; auth: string }[] = [];
	const pulls: any[] = [];
	let writes = 0;
	const fileAtHead = (branch: string) => {
		const h = repo.head(branch);
		return h ? repo.commits.get(h)!.files : new Map<string, string>();
	};
	const commitJson = (sha: string) => {
		const c = repo.commits.get(sha)!;
		const parent = c.parents[0] ? repo.commits.get(c.parents[0])!.files : new Map<string, string>();
		const files = [...c.files].filter(([p, s]) => parent.get(p) !== s).map(([p]) => ({ filename: p, status: parent.has(p) ? "modified" : "added" }));
		for (const p of parent.keys()) if (!c.files.has(p)) files.push({ filename: p, status: "removed" });
		return { sha, commit: { message: c.message, author: { name: "me", date: c.date }, tree: { sha: `t${sha}` } }, parents: c.parents.map((s) => ({ sha: s })), files };
	};
	// Trees: `t<commit>` is the root, `t<commit>_<hex dir>` a folder.
	const treeEntries = (id: string, recursive: boolean) => {
		const [commit, dirHex] = id.slice(1).split("_");
		const c = repo.commits.get(commit);
		if (!c) return null;
		const prefix = dirHex ? `${unhex(dirHex)}/` : "";
		const out: any[] = [];
		const dirs = new Set<string>();
		for (const [p, sha] of c.files) {
			if (!p.startsWith(prefix)) continue;
			const rest = p.slice(prefix.length);
			const parts = rest.split("/");
			for (let i = 1; i < parts.length; i++) {
				const d = parts.slice(0, i).join("/");
				if ((recursive || i === 1) && !dirs.has(d)) {
					dirs.add(d);
					out.push({ path: d, mode: "40000", type: "tree", sha: `t${commit}_${hex(prefix + d)}`, size: 0 });
				}
			}
			if (recursive || parts.length === 1) out.push({ path: rest, mode: "100644", type: "blob", sha, size: repo.blobs.get(sha)!.length });
		}
		return out;
	};
	const paged = (all: unknown[], q: URLSearchParams) => {
		const per = Number(q.get("per_page") ?? 20);
		const page = Number(q.get("page") ?? 1);
		return ok(all.slice((page - 1) * per, page * per), { total_page: String(Math.max(1, Math.ceil(all.length / per))), total_count: String(all.length) });
	};

	const transport = async (req: HttpRequest): Promise<HttpResponse> => {
		const u = new URL(req.url);
		assert.equal(u.searchParams.get("access_token"), null, "token never goes in the URL");
		const path = decodeURIComponent(u.pathname.replace(/^\/api\/v5/, ""));
		const q = u.searchParams;
		const body = typeof req.body === "string" ? JSON.parse(req.body) : undefined;
		log.push({ method: req.method, path, query: q, body, auth: req.headers.Authorization });
		if (req.headers.Authorization !== "token t") return err(401, "401 Unauthorized: Access token does not exist");
		const R = "/repos/me/vault";
		let m: RegExpExecArray | null;

		if (path === "/user") return ok({ login: "me", name: "Me" });
		if (path === "/user/repos" && req.method === "GET") {
			const all = Array.from({ length: 130 }, (_, i) => ({ name: `Display ${i}`, path: `repo-${i}`, full_name: `me/repo-${i}`, private: i % 2 === 0, public: i % 2 !== 0, updated_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), default_branch: "master" }));
			return paged(all, q);
		}
		if (path === "/user/repos" && req.method === "POST") return ok({ html_url: `https://gitee.test/me/${body.path}.git`, private: body.private }, {}, 201);
		if (path === R && req.method === "GET") return ok({ private: true, public: false, default_branch: "master", html_url: "https://gitee.test/me/vault.git", size: null });

		if (path === `${R}/branches` && req.method === "GET") return paged([...repo.branches].map(([name, sha]) => ({ name, commit: { sha } })), q);
		if (path === `${R}/branches` && req.method === "POST") {
			const sha = repo.head(body.refs) ?? body.refs;
			if (!repo.commits.has(sha)) return err(400, "refs not found");
			repo.branches.set(body.branch_name, sha);
			return ok({ name: body.branch_name, commit: { sha } }, {}, 201);
		}
		if ((m = /^\/repos\/me\/vault\/branches\/(.+)$/.exec(path))) {
			const h = repo.head(m[1]);
			return h ? ok({ name: m[1], commit: { sha: h, commit: { tree: { sha: `t${h}` } } } }) : err(404, "Branch Not Found");
		}
		if (path === `${R}/tags` && req.method === "POST") {
			repo.tags.set(body.tag_name, repo.head(body.refs) ?? body.refs);
			return ok({ name: body.tag_name }, {}, 201);
		}
		if (path === `${R}/tags`) return paged([...repo.tags].map(([name, sha]) => ({ name, message: "", commit: { sha } })), q);

		if ((m = /^\/repos\/me\/vault\/commits\/(\w+)$/.exec(path))) return repo.commits.has(m[1]) ? ok(commitJson(m[1])) : err(404, "Not Found");
		if (path === `${R}/commits`) {
			const start = repo.head(q.get("sha")!) ?? q.get("sha")!;
			const all = repo.history(start);
			const fp = q.get("path");
			const list = fp ? all.filter((s) => { const c = repo.commits.get(s)!; const p = c.parents[0] ? repo.commits.get(c.parents[0])!.files.get(fp) : undefined; return c.files.get(fp) !== p; }) : all;
			return paged(list.map(commitJson), q);
		}
		if ((m = /^\/repos\/me\/vault\/git\/trees\/(t\w+)$/.exec(path))) {
			const recursive = q.get("recursive") === "1";
			const entries = treeEntries(m[1], recursive);
			if (!entries) return err(404);
			if (recursive && opts.truncateTrees) return ok({ sha: m[1], tree: entries.slice(0, 1), truncated: true });
			return ok({ sha: m[1], tree: entries, truncated: false });
		}
		if ((m = /^\/repos\/me\/vault\/git\/blobs\/(\w+)$/.exec(path))) {
			const data = repo.blobs.get(m[1]);
			return data ? ok({ sha: m[1], size: data.length, content: b64(data), encoding: "base64" }) : err(404);
		}
		if ((m = /^\/repos\/me\/vault\/raw\/(.+)$/.exec(path))) {
			const ref = q.get("ref")!;
			const sha = repo.commits.get(repo.head(ref) ?? ref)?.files.get(m[1]);
			return sha ? raw(repo.blobs.get(sha)!) : err(404);
		}
		if ((m = /^\/repos\/me\/vault\/contents\/(.+)$/.exec(path))) {
			const file = m[1];
			const params = req.method === "DELETE" ? Object.fromEntries(q) : body;
			await opts.beforeWrite?.(++writes);
			const branch = params.branch ?? "master";
			const files = fileAtHead(branch);
			const parent = repo.head(branch);
			let op: string;
			if (req.method === "POST") {
				if (files.has(file)) return err(400, "文件名已存在");
				op = "create";
			} else if (req.method === "PUT" || req.method === "DELETE") {
				if (!files.has(file)) return err(404, "文件不存在");
				if (files.get(file) !== params.sha) return err(400, "sha 不匹配: file has been changed");
				op = req.method === "PUT" ? "update" : "delete";
			} else return err(405);
			if (params.content && Buffer.from(params.content, "base64").length > 1024 * 1024 * 60) return err(400, "文件过大");
			const sha = await repo.apply(branch, params.message, [{ op, path: file, content: params.content }]);
			const blob = repo.commits.get(sha)!.files.get(file);
			return ok({ content: blob ? { path: file, sha: blob } : null, commit: { sha, parents: parent ? [{ sha: parent }] : [] } }, {}, req.method === "POST" ? 201 : 200);
		}
		if (path === `${R}/pulls` && req.method === "POST") {
			pulls.push(body);
			return ok({ number: pulls.length, html_url: `https://gitee.test/me/vault/pulls/${pulls.length}` }, {}, 201);
		}
		return err(404, `fake gitee: no route ${req.method} ${path}`);
	};
	return { transport, log, pulls };
}

const cfg = () => ({ token: "t", apiBase: "https://gitee.test/api/v5", owner: "me", repo: "vault" });
const bytes = (s: string) => toAB(te.encode(s));

async function seeded(opts: FakeOpts = {}) {
	const repo = new FakeRepo();
	await repo.apply("main", "init", [
		{ op: "create", path: "a.md", content: b64("A\n") },
		{ op: "create", path: "Notes/b.md", content: b64("B\n") },
		{ op: "create", path: "Notes/Deep/c.md", content: b64("C\n") },
	]);
	const server = giteeServer(repo, opts);
	return { repo, server, remote: new Gitee(cfg, server.transport) };
}

// ---------- tests ----------

test("Gitee: account, repo and listing", async () => {
	const { repo, server, remote } = await seeded();
	assert.equal((await remote.getUser()).login, "me");
	assert.deepEqual(await remote.getRepo(), { private: true, default_branch: "master", html_url: "https://gitee.test/me/vault", size: 0 });
	assert.equal((await remote.createRepo("new-vault")).html_url, "https://gitee.test/me/new-vault");
	assert.equal(server.log.at(-1)!.body.private, true);
	const repos = await remote.listRepos(5);
	assert.equal(repos.length, 130, "follows total_page across pages");
	assert.deepEqual(repos[0], { owner: "me", name: "repo-129", private: false, updated: repos[0].updated, defaultBranch: "master" });
	assert.ok(server.log.every((l) => l.auth === "token t"), "token sent as Authorization header");

	const head = repo.head()!;
	assert.equal(await remote.getRef("main"), head);
	assert.equal(await remote.getRef("nope"), null);
	const tree = await remote.getCommitTree(head);
	const files = (await remote.listTree(tree)).filter((e) => e.type === "blob").map((e) => e.path).sort();
	assert.deepEqual(files, ["Notes/Deep/c.md", "Notes/b.md", "a.md"]);
	assert.equal(await remote.countFiles("main"), 3);
	assert.equal(await remote.countFiles("nope"), 0);
	assert.equal(await remote.rateLimit(), null);
});

test("Gitee: truncated recursive tree falls back to a per-folder walk", async () => {
	const { repo, remote } = await seeded({ truncateTrees: true });
	const entries = await remote.listTree(await remote.getCommitTree(repo.head()!));
	assert.deepEqual(entries.map((e) => e.path).sort(), ["Notes/Deep/c.md", "Notes/b.md", "a.md"]);
	assert.ok(entries.every((e) => e.type === "blob" && e.sha.length === 40));
});

test("Gitee: first commit in an empty repo, blob round trip, getFileAt", async () => {
	const repo = new FakeRepo();
	const remote = new Gitee(cfg, giteeServer(repo).transport);
	assert.equal(await remote.getRef("main"), null);
	const content = new Uint8Array([0, 1, 2, 250, 255, 10, 13]);
	await remote.putFile("bin/x.bin", "first", b64(content), "main");
	const head = repo.head()!;
	const [entry] = (await remote.listTree(await remote.getCommitTree(head))).filter((e) => e.type === "blob");
	assert.equal(entry.path, "bin/x.bin");
	assert.deepEqual(new Uint8Array(await remote.getBlob(entry.sha)), content);
	assert.deepEqual(new Uint8Array((await remote.getFileAt("bin/x.bin", head))!), content);
	assert.deepEqual(new Uint8Array((await remote.getFileAt("bin/x.bin", "main"))!), content);
	assert.equal(await remote.getFileAt("missing.md", head), null);
});

test("Gitee: commit = one create/update/delete per file, locked by blob sha", async () => {
	const { repo, server, remote } = await seeded();
	const parent = repo.head()!;
	const parentTree = await remote.getCommitTree(parent);
	const before = repo.commits.size;
	const progress: number[] = [];
	server.log.length = 0;
	const res = await remote.commit({
		branch: "main",
		parent,
		parentTree,
		message: "Vault sync\n\ndetails",
		upserts: [
			{ path: "a.md", mode: "100644", load: async () => bytes("A2\n") },
			{ path: "New/n.md", mode: "100644", load: async () => bytes("N\n") },
		],
		deletes: ["Notes/b.md", "never-existed.md"],
		progress: (d) => progress.push(d),
		author: { name: "Fadi", email: "f@example.com" },
	});
	assert.equal(repo.commits.size - before, 3, "one commit per file (not atomic)");
	assert.equal(res.sha, repo.head());
	assert.equal(res.fastForward, true);
	assert.deepEqual([...repo.files().entries()].sort(), [["New/n.md", "N\n"], ["Notes/Deep/c.md", "C\n"], ["a.md", "A2\n"]]);
	assert.deepEqual(progress, [1, 2]);
	assert.ok(res.blobShas?.get("a.md") && res.blobShas.get("New/n.md"));

	const writes = server.log.filter((l) => l.path.includes("/contents/"));
	assert.deepEqual(writes.map((w) => `${w.method} ${w.path.replace("/repos/me/vault/contents/", "")}`), ["PUT a.md", "POST New/n.md", "DELETE Notes/b.md"]);
	const parentFiles = repo.commits.get(parent)!.files;
	assert.equal(writes[0].body.sha, parentFiles.get("a.md"), "update carries the old blob sha");
	assert.equal(writes[0].body.author.email, "f@example.com");
	assert.equal(writes[0].body.message, "Vault sync (1/3)\n\ndetails");
	assert.equal(writes[2].query.get("sha"), parentFiles.get("Notes/b.md"), "delete carries the old blob sha");
	assert.equal(writes[2].query.get("branch"), "main");
	// Chain: each of our commits sits on the previous one.
	const chain = repo.history(res.sha).slice(0, 4);
	assert.equal(chain[3], parent);
});

test("Gitee: NotFastForward when the head moved before committing (nothing written)", async () => {
	const { repo, server, remote } = await seeded();
	const parent = repo.head()!;
	const parentTree = await remote.getCommitTree(parent);
	await repo.apply("main", "other device", [{ op: "create", path: "other.md", content: b64("O\n") }]);
	server.log.length = 0;
	await assert.rejects(
		remote.commit({ branch: "main", parent, parentTree, message: "m", upserts: [{ path: "a.md", mode: "100644", load: async () => bytes("x") }], deletes: [] }),
		NotFastForward,
	);
	assert.equal(server.log.filter((l) => l.method !== "GET").length, 0);
});

test("Gitee: a stale file mid-commit raises NotFastForward after a partial push", async () => {
	let repo!: FakeRepo;
	const s = await seeded({
		beforeWrite: async (n) => {
			if (n === 2) await repo.apply("main", "other device", [{ op: "update", path: "Notes/b.md", content: b64("B from other\n") }]);
		},
	});
	repo = s.repo;
	const parent = repo.head()!;
	await assert.rejects(
		s.remote.commit({
			branch: "main",
			parent,
			parentTree: await s.remote.getCommitTree(parent),
			message: "m",
			upserts: [
				{ path: "a.md", mode: "100644", load: async () => bytes("A2\n") },
				{ path: "Notes/b.md", mode: "100644", load: async () => bytes("B mine\n") },
			],
			deletes: [],
		}),
		NotFastForward,
	);
	assert.equal(repo.files().get("a.md"), "A2\n", "first file landed");
	assert.equal(repo.files().get("Notes/b.md"), "B from other\n", "the other device's edit is not overwritten");
});

test("Gitee: another push between our per-file commits gives fastForward: false", async () => {
	let repo!: FakeRepo;
	const s = await seeded({
		beforeWrite: async (n) => {
			if (n === 2) await repo.apply("main", "other device", [{ op: "create", path: "other.md", content: b64("O\n") }]);
		},
	});
	repo = s.repo;
	const parent = repo.head()!;
	const res = await s.remote.commit({
		branch: "main",
		parent,
		parentTree: await s.remote.getCommitTree(parent),
		message: "m",
		upserts: [
			{ path: "a.md", mode: "100644", load: async () => bytes("A2\n") },
			{ path: "z.md", mode: "100644", load: async () => bytes("Z\n") },
		],
		deletes: [],
	});
	assert.equal(res.fastForward, false);
	assert.equal(res.sha, repo.head());
	assert.deepEqual([...repo.files().keys()].sort(), ["Notes/Deep/c.md", "Notes/b.md", "a.md", "other.md", "z.md"]);
});

test("Gitee: files over the API limit are refused with a clear error", async () => {
	const { repo, remote } = await seeded();
	const parent = repo.head()!;
	await assert.rejects(
		remote.commit({ branch: "main", parent, parentTree: await remote.getCommitTree(parent), message: "m", upserts: [{ path: "big.bin", mode: "100644", load: async () => new ArrayBuffer(GITEE_MAX_FILE_BYTES + 1) }], deletes: [] }),
		(e: unknown) => e instanceof RemoteError && /big\.bin/.test(e.message) && /up to 50 MB/.test(e.message),
	);
	assert.equal(repo.head(), parent);
});

test("Gitee: compare, history, commit files", async () => {
	const { repo, remote } = await seeded();
	const base = repo.head()!;
	// Long history: more than one page of commits (100 per page).
	for (let i = 0; i < 120; i++) await repo.apply("main", `c${i}`, [{ op: i === 0 ? "create" : "update", path: "log.md", content: b64(`${i}\n`) }]);
	const head = repo.head()!;
	assert.equal(await remote.compare(base, head), "ahead");
	assert.equal(await remote.compare(head, base), "behind");
	assert.equal(await remote.compare(head, head), "identical");
	assert.equal(await remote.compare("f".repeat(40), head), "missing");
	repo.branches.set("side", base);
	const side = await repo.apply("side", "side", [{ op: "create", path: "side.md", content: b64("s\n") }]);
	assert.equal(await remote.compare(side, head), "diverged");

	const hist = await remote.listCommits("main", "a.md", 10);
	assert.equal(hist.length, 1);
	assert.equal(hist[0].message, "init");
	assert.equal((await remote.listCommits("main", undefined, 5)).length, 5);
	const cf = await remote.getCommitFiles(head);
	assert.equal(cf.parent, repo.commits.get(head)!.parents[0]);
	assert.deepEqual(cf.files, [{ filename: "log.md", status: "modified" }]);
});

test("Gitee: branches, tags, web links, pull requests", async () => {
	const { repo, server, remote } = await seeded();
	const head = repo.head()!;
	await remote.createRef("refs/heads/feature", head);
	await remote.createRef("refs/tags/snap-1", head);
	assert.deepEqual((await remote.listBranches()).sort((a, b) => a.name.localeCompare(b.name)), [{ name: "feature", sha: head }, { name: "main", sha: head }]);
	assert.deepEqual(await remote.listTags(), [{ name: "snap-1", sha: head }]);

	assert.equal(remote.webUrl("file", "Notes/My note.md", head), `https://gitee.test/me/vault/blob/${head}/Notes/My%20note.md`);
	assert.equal(remote.webUrl("history", "Notes/b.md", "master"), "https://gitee.test/me/vault/commits/master/Notes/b.md");
	assert.equal(remote.webUrl("repo", "", "master"), "https://gitee.test/me/vault");
	assert.equal(remote.gitUrl(), "https://gitee.test/me/vault.git");

	const pr = await remote.createPullRequest("feature", "main", "Merge feature", "Body");
	assert.equal(pr.url, "https://gitee.test/me/vault/pulls/1");
	assert.deepEqual(server.pulls[0], { title: "Merge feature", head: "feature", base: "main", body: "Body" });

	const def = new Gitee(() => ({ token: "t", apiBase: "", owner: "me", repo: "vault" }), server.transport);
	assert.equal(def.webUrl("repo", "", "master"), "https://gitee.com/me/vault");
});

test("Gitee: missing or invalid token", async () => {
	const repo = new FakeRepo();
	const server = giteeServer(repo);
	await assert.rejects(new Gitee(() => ({ ...cfg(), token: "" }), server.transport).getUser(), /No token/);
	await assert.rejects(new Gitee(() => ({ ...cfg(), token: "bad" }), server.transport).getUser(), (e: unknown) => e instanceof RemoteError && e.status === 401);
});

test("Gitee: two devices sync end to end through the engine", async () => {
	const repo = new FakeRepo();
	const remote = new Gitee(cfg, giteeServer(repo).transport);
	const a = device("A", remote as any);
	const b = device("B", remote as any);
	a.fs.put("Notes/one.md", "hello\n\nworld\n");
	a.fs.put("Notes/two.md", "two\n");
	a.fs.put("img/x.png", "\u0000bin");
	await a.sync();
	assert.ok(repo.files().has("Notes/one.md"));
	await b.sync();
	assert.equal(b.fs.text("img/x.png"), "\u0000bin");
	assert.equal((await b.sync()).upToDate, true);

	a.fs.put("Notes/one.md", "hello from A\n\nworld\n");
	b.fs.put("Notes/one.md", "hello\n\nworld from B\n");
	b.fs.files.delete("Notes/two.md");
	await a.sync();
	const rb = await b.sync();
	assert.deepEqual(rb.merged, ["Notes/one.md"]);
	await a.sync();
	assert.equal(a.fs.text("Notes/one.md"), "hello from A\n\nworld from B\n");
	assert.equal(repo.files().get("Notes/one.md"), "hello from A\n\nworld from B\n");
	assert.ok(!repo.files().has("Notes/two.md"));
});
