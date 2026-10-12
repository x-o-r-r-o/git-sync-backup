import { test } from "node:test";
import assert from "node:assert/strict";
import { AzureDevOps } from "../src/azure.ts";
import { NotFastForward } from "../src/remote.ts";
import type { CommitRequest } from "../src/remote.ts";
import type { HttpRequest, HttpResponse } from "../src/http.ts";
import { FakeRepo } from "./support/fakehosts.ts";
import { device } from "./support/fakes.ts";

// ---- Fake Azure DevOps server (REST 7.1 subset) at https://dev.azure.com/{org}/{project}/_apis/git ----

const te = new TextEncoder();
const td = new TextDecoder();
const toAB = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const ok = (json: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, json, arrayBuffer: toAB(te.encode(JSON.stringify(json))), headers });
const raw = (data: Uint8Array): HttpResponse => ({ status: 200, json: null, arrayBuffer: toAB(data), headers: {} });
const err = (status: number, message: string): HttpResponse => ({ status, json: { message, typeKey: "Fake" }, arrayBuffer: new ArrayBuffer(0), headers: {} });
const ZERO = "0".repeat(40);

const ORG = "my org";
const PROJECT = "Vault Project";
const REPO = "vault";
const TOKEN = "pat-123";

interface FakeLog {
	requests: HttpRequest[];
	pushes: { refUpdates: { name: string; oldObjectId: string }[]; commits: { comment: string; author?: { name: string; email: string }; changes: { changeType: string; item: { path: string }; newContent?: { content: string; contentType: string } }[] }[] }[];
	pullRequests: unknown[];
	createdRepos: { name: string; projectId: string }[];
}

function azureTransport(repo: FakeRepo, log: FakeLog = { requests: [], pushes: [], pullRequests: [], createdRepos: [] }) {
	const commitInfo = (sha: string) => {
		const c = repo.commits.get(sha)!;
		return { commitId: sha, treeId: `t${sha}`, parents: c.parents, comment: c.message, author: { name: "Fake", email: "f@x", date: c.date } };
	};
	const changed = (sha: string) => {
		const c = repo.commits.get(sha)!;
		const parent = c.parents[0] ? repo.commits.get(c.parents[0])!.files : new Map<string, string>();
		const out: { changeType: string; item: { path: string; gitObjectType: string } }[] = [];
		for (const [p, s] of c.files) if (parent.get(p) !== s) out.push({ changeType: parent.has(p) ? "edit" : "add", item: { path: `/${p}`, gitObjectType: "blob" } });
		for (const p of parent.keys()) if (!c.files.has(p)) out.push({ changeType: "delete", item: { path: `/${p}`, gitObjectType: "blob" } });
		return out;
	};
	const refList = () => [...[...repo.branches].map(([n, s]) => ({ name: `refs/heads/${n}`, objectId: s })), ...[...repo.tags].map(([n, s]) => ({ name: `refs/tags/${n}`, objectId: `tagobj${n}`, peeledObjectId: s }))];

	return async (req: HttpRequest): Promise<HttpResponse> => {
		log.requests.push(req);
		const u = new URL(req.url);
		assert.equal(u.origin, "https://dev.azure.com");
		assert.equal(req.headers.Authorization, `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`);
		assert.match(u.searchParams.get("api-version") ?? "", /^7\.1/, `api-version on ${req.url}`);
		// Decode each segment separately: a badly encoded name would split into the wrong segments.
		const seg = u.pathname.split("/").slice(1).map(decodeURIComponent);
		const q = u.searchParams;
		const body = typeof req.body === "string" ? JSON.parse(req.body) : undefined;
		if (seg[0] !== ORG) return err(404, "TF400813: organization not found");
		const rest = seg.slice(1).join("/");
		if (rest === "_apis/connectionData") return ok({ authenticatedUser: { providerDisplayName: "Me Myself", properties: { Account: { $type: "System.String", $value: "me@example.com" } } } });
		if (rest === "_apis/git/repositories") return ok({ count: 1, value: [{ name: REPO, defaultBranch: "refs/heads/main", project: { name: PROJECT, visibility: "private", lastUpdateTime: "2026-01-01T00:00:00Z" } }] });
		if (seg[1] === "_apis" && seg[2] === "projects") return seg[3] === PROJECT ? ok({ id: "proj-guid", name: PROJECT }) : err(404, "TF200016: project does not exist");
		if (seg[1] !== PROJECT || seg[2] !== "_apis" || seg[3] !== "git" || seg[4] !== "repositories") return err(404, "not found");
		if (seg.length === 5 && req.method === "POST") {
			log.createdRepos.push({ name: body.name, projectId: body.project.id });
			return ok({ name: body.name, webUrl: `https://dev.azure.com/${encodeURIComponent(ORG)}/${encodeURIComponent(PROJECT)}/_git/${encodeURIComponent(body.name)}` });
		}
		if (seg[5] !== REPO) return err(404, "TF401019: The Git repository with name or identifier does not exist");
		const R = seg.slice(6);
		const what = R.join("/");
		if (R.length === 0) return ok({ name: REPO, defaultBranch: repo.head() ? "refs/heads/main" : undefined, size: 42, webUrl: "https://dev.azure.com/web/vault", project: { visibility: "private" } });

		if (what === "refs" && req.method === "GET") {
			const filter = `refs/${q.get("filter") ?? ""}`;
			const all = refList().filter((r) => r.name.startsWith(filter));
			// Tiny pages to exercise continuation tokens.
			const per = Math.min(Number(q.get("$top") ?? 1000), 2);
			const start = Number(q.get("continuationToken") ?? 0);
			const page = all.slice(start, start + per);
			return ok({ count: page.length, value: page }, start + per < all.length ? { "x-ms-continuationtoken": String(start + per) } : {});
		}
		if (what === "refs" && req.method === "POST") {
			const value = (body as { name: string; oldObjectId: string; newObjectId: string }[]).map((r) => {
				if (r.name.startsWith("refs/tags/")) repo.tags.set(r.name.slice(10), r.newObjectId);
				else if (repo.branches.has(r.name.slice(11)) && r.oldObjectId === ZERO) return { name: r.name, success: false, updateStatus: "staleOldObjectId" };
				else repo.branches.set(r.name.slice(11), r.newObjectId);
				return { name: r.name, success: true, updateStatus: "succeeded" };
			});
			return ok({ count: value.length, value });
		}
		if (R[0] === "commits" && R.length === 2) return repo.commits.has(R[1]) ? ok(commitInfo(R[1])) : err(404, `TF401175: commit ${R[1]} not found`);
		if (R[0] === "commits" && R[2] === "changes") {
			const all = changed(R[1]);
			const top = Number(q.get("top") ?? 100);
			const skip = Number(q.get("skip") ?? 0);
			return ok({ changes: all.slice(skip, skip + top), changeCounts: {} });
		}
		if (what === "commits") {
			const version = q.get("searchCriteria.itemVersion.version")!;
			const type = q.get("searchCriteria.itemVersion.versionType");
			const start = type === "branch" ? repo.head(version) : version;
			if (!start || !repo.commits.has(start)) return err(404, "not found");
			let list = repo.history(start);
			const item = q.get("searchCriteria.itemPath");
			if (item) list = list.filter((sha) => changed(sha).some((c) => c.item.path === item));
			const top = Math.min(Number(q.get("searchCriteria.$top") ?? 100), type === "commit" ? 3 : 100); // clamps commit walks
			const skip = Number(q.get("searchCriteria.$skip") ?? 0);
			return ok({ count: 0, value: list.slice(skip, skip + top).map(commitInfo) });
		}
		if (R[0] === "trees") {
			assert.equal(q.get("recursive"), "true");
			const c = repo.commits.get(R[1].slice(1))!;
			const dirs = new Set<string>();
			for (const p of c.files.keys()) p.split("/").slice(0, -1).forEach((_, i, a) => dirs.add(a.slice(0, i + 1).join("/")));
			const treeEntries = [
				...[...dirs].map((d) => ({ relativePath: d, mode: "40000", gitObjectType: "tree", objectId: `tree-${d}`, size: 0 })),
				...[...c.files].map(([p, sha]) => ({ relativePath: p, mode: "100644", gitObjectType: "blob", objectId: sha, size: repo.blobs.get(sha)!.length })),
			];
			return ok({ objectId: R[1], treeEntries });
		}
		if (R[0] === "blobs") {
			assert.equal(q.get("$format"), "octetstream");
			const b = repo.blobs.get(R[1]);
			return b ? raw(b) : err(404, "blob not found");
		}
		if (what === "items") {
			const path = q.get("path")!.replace(/^\//, "");
			const v = q.get("versionDescriptor.version")!;
			const sha = q.get("versionDescriptor.versionType") === "branch" ? repo.head(v) : v;
			const blob = sha ? repo.commits.get(sha)?.files.get(path) : undefined;
			return blob ? raw(repo.blobs.get(blob)!) : err(404, `TF401174: The item '/${path}' could not be found`);
		}
		if (what === "pushes" && req.method === "POST") {
			log.pushes.push(body);
			await (repo.interject?.() as unknown);
			repo.interject = null;
			const ru = body.refUpdates[0];
			const branch = ru.name.replace(/^refs\/heads\//, "");
			const head = repo.head(branch) ?? ZERO;
			if (ru.oldObjectId !== head) return err(409, `TF401028: The reference '${ru.name}' has already been updated by another client, so you cannot update it. Please try again.`);
			const commit = body.commits[0];
			const ops: { op: string; path: string; content?: string }[] = [];
			const files = head === ZERO ? new Map<string, string>() : repo.commits.get(head)!.files;
			for (const ch of commit.changes) {
				assert.ok(ch.item.path.startsWith("/"), "absolute item path");
				const path = ch.item.path.slice(1);
				if (ch.changeType === "add" && files.has(path)) return err(400, `TF401317: The path '${ch.item.path}' already exists`);
				if (ch.changeType !== "add" && !files.has(path)) return err(400, `TF401174: The item '${ch.item.path}' could not be found`);
				if (ch.changeType !== "delete") assert.equal(ch.newContent.contentType, "base64encoded");
				ops.push({ op: ch.changeType === "add" ? "create" : ch.changeType === "edit" ? "update" : "delete", path, content: ch.newContent?.content });
			}
			const sha = await repo.apply(branch, commit.comment, ops);
			return ok({ pushId: log.pushes.length, commits: [{ commitId: sha }], refUpdates: [{ name: ru.name, oldObjectId: ru.oldObjectId, newObjectId: sha }] });
		}
		if (what === "pullrequests" && req.method === "POST") {
			log.pullRequests.push(body);
			return ok({ pullRequestId: 17, repository: { webUrl: "https://dev.azure.com/web/vault" } });
		}
		return err(404, `fake: no route ${req.method} ${u.pathname}`);
	};
}

function setup() {
	const repo = new FakeRepo();
	const log: FakeLog = { requests: [], pushes: [], pullRequests: [], createdRepos: [] };
	const az = new AzureDevOps(() => ({ token: TOKEN, apiBase: "", owner: `${ORG}/${PROJECT}`, repo: REPO }), azureTransport(repo, log));
	return { repo, log, az };
}
const bytes = (s: string) => toAB(te.encode(s));
const req = (r: Partial<CommitRequest> & Pick<CommitRequest, "parent" | "parentTree">): CommitRequest => ({ branch: "main", message: "msg", upserts: [], deletes: [], ...r });
const up = (path: string, data: string | Uint8Array) => ({ path, mode: "100644", load: async () => (typeof data === "string" ? bytes(data) : toAB(data)) });

test("Azure: user, repo, repo listing, create repo", async () => {
	const { az, log } = setup();
	assert.deepEqual(await az.getUser(), { login: "me@example.com" });
	const r = await az.getRepo();
	assert.equal(r?.private, true);
	assert.equal(r?.default_branch, "main");
	const list = await az.listRepos();
	assert.deepEqual(list, [{ owner: `${ORG}/${PROJECT}`, name: REPO, private: true, updated: "2026-01-01T00:00:00Z", defaultBranch: "main" }]);
	const made = await az.createRepo("new vault");
	assert.deepEqual(log.createdRepos, [{ name: "new vault", projectId: "proj-guid" }]);
	assert.equal(made.html_url, "https://dev.azure.com/my%20org/Vault%20Project/_git/new%20vault");
	// Every call carried api-version (asserted by the fake); segments are percent-encoded.
	assert.ok(log.requests.every((x) => x.url.includes("/my%20org/")));
	const missing = new AzureDevOps(() => ({ token: TOKEN, apiBase: "https://dev.azure.com/", owner: `${ORG}/${PROJECT}`, repo: "nope" }), azureTransport(new FakeRepo()));
	assert.equal(await missing.getRepo(), null);
});

test("Azure: initial push, atomic create/edit/delete, blob round trip, odd paths", async () => {
	const { az, repo, log } = setup();
	assert.equal(await az.getRef("main"), null);
	await az.putFile("README.md", "init", Buffer.from("hi\n").toString("base64"), "main");
	assert.equal(log.pushes[0].refUpdates[0].oldObjectId, ZERO);
	const h1 = (await az.getRef("main"))!;
	assert.equal(h1, repo.head());

	const bin = new Uint8Array([0, 255, 1, 128, 10, 13]);
	const odd = ["dir with space/a #1.md", "ünïcødé/日本語.md", "100% & more?.md"];
	const r1 = await az.commit(req({
		parent: h1,
		parentTree: await az.getCommitTree(h1),
		message: "add files",
		upserts: [up("img/x.bin", bin), ...odd.map((p) => up(p, `body of ${p}`))],
		author: { name: "Dev", email: "dev@example.com" },
	}));
	assert.equal(r1.fastForward, true);
	assert.equal(r1.sha, repo.head());
	const push = log.pushes.at(-1)!;
	assert.equal(push.commits.length, 1, "one atomic commit");
	assert.deepEqual(push.commits[0].author && { name: push.commits[0].author.name, email: push.commits[0].author.email }, { name: "Dev", email: "dev@example.com" });
	assert.ok(push.commits[0].changes.every((c) => c.changeType === "add"));

	const tree = await az.listTree(await az.getCommitTree(r1.sha));
	const blobs = tree.filter((e) => e.type === "blob");
	assert.deepEqual(blobs.map((e) => e.path).sort(), ["README.md", "img/x.bin", ...odd].sort());
	assert.ok(tree.some((e) => e.type === "tree" && e.path === "img"));
	const xb = blobs.find((e) => e.path === "img/x.bin")!;
	assert.equal(xb.size, 6);
	assert.deepEqual(new Uint8Array(await az.getBlob(xb.sha)), bin);
	for (const p of odd) assert.equal(td.decode((await az.getFileAt(p, r1.sha))!), `body of ${p}`);
	assert.equal(td.decode((await az.getFileAt(odd[0], "main"))!), `body of ${odd[0]}`);
	assert.equal(await az.getFileAt("nope.md", r1.sha), null);
	assert.equal(await az.countFiles("main"), 5);

	// Edit + delete, with add/edit decided from `existing` (no tree listing needed).
	const listed = log.requests.length;
	const r2 = await az.commit(req({
		parent: r1.sha,
		parentTree: `t${r1.sha}`,
		upserts: [up("README.md", "changed\n"), up("new.md", "new\n")],
		deletes: [odd[1], "never-existed.md"],
		existing: new Map(blobs.map((e) => [e.path, e.sha])),
	}));
	assert.ok(!log.requests.slice(listed).some((x) => x.url.includes("/trees/")));
	const ch = log.pushes.at(-1)!.commits[0].changes.map((c) => `${c.changeType} ${c.item.path}`);
	assert.deepEqual(ch, ["edit /README.md", "add /new.md", `delete /${odd[1]}`]);
	const files = repo.files();
	assert.equal(files.get("README.md"), "changed\n");
	assert.equal(files.has(odd[1]), false);
	const cf = await az.getCommitFiles(r2.sha);
	assert.equal(cf.parent, r1.sha);
	assert.deepEqual(cf.files.sort((a, b) => a.filename.localeCompare(b.filename)), [
		{ filename: "README.md", status: "modified" },
		{ filename: "new.md", status: "added" },
		{ filename: odd[1], status: "removed" },
	].sort((a, b) => a.filename.localeCompare(b.filename)));
});

test("Azure: stale oldObjectId and stale add/edit become NotFastForward", async () => {
	const { az, repo } = setup();
	await az.putFile("a.md", "init", Buffer.from("a").toString("base64"), "main");
	const h1 = repo.head()!;
	// Another client pushes first.
	repo.interject = () => repo.apply("main", "other", [{ op: "create", path: "b.md", content: Buffer.from("b").toString("base64") }]);
	await assert.rejects(az.commit(req({ parent: h1, parentTree: `t${h1}`, upserts: [up("c.md", "c")] })), NotFastForward);
	assert.equal(repo.files().has("c.md"), false);
	// Wrong idea of the tree (caller thinks a.md is absent): the add is refused as well.
	const h2 = repo.head()!;
	await assert.rejects(az.commit(req({ parent: h2, parentTree: `t${h2}`, upserts: [up("a.md", "x")], existing: new Map() })), NotFastForward);
});

test("Azure: large changes are split into chained pushes", async () => {
	const { az, repo, log } = setup();
	await az.putFile("seed.md", "init", Buffer.from("s").toString("base64"), "main");
	const h = repo.head()!;
	const big = () => new Uint8Array(5 * 1024 * 1024).fill(65);
	const progress: number[] = [];
	const r = await az.commit(req({ parent: h, parentTree: `t${h}`, message: "bulk\n\nbody", upserts: [up("a.bin", big()), up("b.bin", big()), up("c.bin", big())], deletes: ["seed.md"], progress: (d) => progress.push(d) }));
	const pushes = log.pushes.slice(1);
	assert.equal(pushes.length, 3);
	assert.equal(pushes[0].refUpdates[0].oldObjectId, h);
	for (let i = 1; i < 3; i++) assert.notEqual(pushes[i].refUpdates[0].oldObjectId, h, "chained on the previous push");
	assert.match(pushes[0].commits[0].comment, /^bulk \(part 1\)/);
	assert.deepEqual(progress, [1, 2, 3]);
	assert.equal(r.sha, repo.head());
	assert.deepEqual([...repo.files().keys()].sort(), ["a.bin", "b.bin", "c.bin"]);
});

test("Azure: compare, history, branches, tags, refs", async () => {
	const { az, repo } = setup();
	await az.putFile("n.md", "v1", Buffer.from("v1\n").toString("base64"), "main");
	const first = repo.head()!;
	for (let i = 2; i <= 8; i++) {
		const h = repo.head()!;
		await az.commit(req({ parent: h, parentTree: `t${h}`, upserts: [up(i % 2 ? "n.md" : "other.md", `v${i}\n`)] }));
	}
	const last = repo.head()!;
	assert.equal(await az.compare(first, last), "ahead");
	assert.equal(await az.compare(last, first), "behind");
	assert.equal(await az.compare(last, last), "identical");
	assert.equal(await az.compare("f".repeat(40), last), "missing");
	// Diverged: a side branch from `first`.
	await az.createRef("refs/heads/side", first);
	await az.commit(req({ branch: "side", parent: first, parentTree: `t${first}`, upserts: [up("s.md", "s")] }));
	assert.equal(await az.compare(repo.head("side")!, last), "diverged");

	const hist = await az.listCommits("main", "n.md", 10);
	assert.equal(hist.length, 4, "commits touching n.md: v1, v3, v5, v7");
	assert.ok(hist.every((c) => c.sha && c.date && typeof c.message === "string"));
	assert.equal((await az.listCommits("main")).length, 8);

	// Prefix filter: heads/main must not match heads/main-old.
	await az.createRef("refs/heads/main-old", first);
	assert.equal(await az.getRef("main"), last);
	assert.equal(await az.getRef("main-old"), first);
	await assert.rejects(az.createRef("refs/heads/main", first), /could not create/);
	const branches = await az.listBranches();
	assert.deepEqual(branches.map((b) => b.name).sort(), ["main", "main-old", "side"]);
	await az.createRef("refs/tags/snap-1", last);
	await az.createRef("refs/tags/snap-2", first);
	await az.createRef("refs/tags/snap-3", first);
	const tags = await az.listTags();
	assert.deepEqual(tags.find((t) => t.name === "snap-1"), { name: "snap-1", sha: last }, "peeled sha");
	assert.equal(tags.length, 3, "continuation token followed");
	assert.equal(await az.rateLimit(), null);
});

test("Azure: URLs, auth header and pull requests", async () => {
	const { az, log } = setup();
	const base = "https://dev.azure.com/my%20org/Vault%20Project/_git/vault";
	assert.equal(az.gitUrl(), base);
	assert.equal(az.authHeader(), `Basic ${Buffer.from(`:${TOKEN}`).toString("base64")}`);
	const sha = "a".repeat(40);
	assert.equal(az.webUrl("repo", "x", "main"), base);
	assert.equal(az.webUrl("file", "dir a/n #1.md", sha), `${base}?path=%2Fdir%20a%2Fn%20%231.md&version=GC${sha}`);
	assert.equal(az.webUrl("history", "ü.md", "feature/x"), `${base}?path=%2F%C3%BC.md&version=GBfeature%2Fx&_a=history`);
	const pr = await az.createPullRequest("feature", "main", "Title", "x".repeat(5000));
	assert.equal(pr.url, "https://dev.azure.com/web/vault/pullrequest/17");
	const body = log.pullRequests[0] as { sourceRefName: string; targetRefName: string; title: string; description: string };
	assert.equal(body.sourceRefName, "refs/heads/feature");
	assert.equal(body.targetRefName, "refs/heads/main");
	assert.equal(body.description.length, 4000);
	// A lone organization assumes the project is named like the repository.
	const lone = new AzureDevOps(() => ({ token: TOKEN, apiBase: "https://tfs.example/tfs/Coll/", owner: "Org", repo: "R" }));
	assert.equal(lone.gitUrl(), "https://tfs.example/tfs/Coll/Org/R/_git/R");
});

test("Azure: two devices sync end-to-end through the engine", async () => {
	const { az, repo } = setup();
	const a = device("A", az as any);
	const b = device("B", az as any);
	a.fs.put("Notes/one.md", "hello\n\nworld\n");
	a.fs.put("Notes/two #2.md", "two\n");
	a.fs.put("img/x.png", "\u0000bin");
	await a.sync();
	assert.ok(repo.files().has("Notes/one.md"));
	await b.sync();
	assert.equal(b.fs.text("img/x.png"), "\u0000bin");
	assert.equal((await b.sync()).upToDate, true);
	a.fs.put("Notes/one.md", "hello from A\n\nworld\n");
	b.fs.put("Notes/one.md", "hello\n\nworld from B\n");
	b.fs.files.delete("Notes/two #2.md");
	await a.sync();
	const rb = await b.sync();
	assert.deepEqual(rb.merged, ["Notes/one.md"]);
	await a.sync();
	assert.equal(a.fs.text("Notes/one.md"), "hello from A\n\nworld from B\n");
	assert.equal(repo.files().has("Notes/two #2.md"), false);

	// Concurrent push from B while A commits: the push is refused and the engine retries.
	a.fs.put("a.md", "A\n");
	b.fs.put("b.md", "B\n");
	let raced = false;
	const orig = az.commit.bind(az);
	(az as any).commit = async (r: CommitRequest) => {
		if (!raced) {
			raced = true;
			(az as any).commit = orig;
			await b.sync();
		}
		return orig(r);
	};
	await a.sync();
	assert.ok(raced);
	assert.ok(repo.files().has("a.md") && repo.files().has("b.md"));
	await a.sync();
	assert.equal(a.fs.text("b.md"), "B\n");
});
