// Live tests against the real GitHub API. (Empty-repo initialisation is covered by the
// in-memory tests and was verified live on first run.) Two simulated devices (in-memory vaults) sync
// through a real private repository.
//   VSG_LIVE_TOKEN=$(gh auth token) VSG_LIVE_REPO=owner/repo npm run test:live
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { GitHub } from "../../src/github.ts";
import { device } from "../support/fakes.ts";
import { gitBlobSha } from "../../src/util.ts";

const token = process.env.VSG_LIVE_TOKEN ?? "";
const [owner, repo] = (process.env.VSG_LIVE_REPO ?? "/").split("/");
const live = !!token && !!owner && !!repo;
const run = Date.now().toString(36);

const cfg = () => ({ token, apiBase: "https://api.github.com", owner, repo });
const gh = new GitHub(cfg);
const enc = new TextEncoder();
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** New branch on an orphan commit holding only .gitattributes, so each test is isolated. */
async function freshBranch(name: string): Promise<string> {
	const branch = `test/${run}/${name}`;
	const tree = await gh.createTree(null, [{ path: ".gitattributes", mode: "100644", type: "blob", content: "* -text\n" }]);
	const commit = await gh.createCommit("test base", tree, []);
	await gh.createRef(`refs/heads/${branch}`, commit);
	return branch;
}

function pair(branch: string, extra = {}) {
	const a = device("Mac", gh as any, { owner, repo, branch, ...extra });
	const b = device("iPhone", gh as any, { owner, repo, branch, ...extra });
	return { a, b };
}

async function remoteFiles(branch: string): Promise<Map<string, string>> {
	const head = (await gh.getRef(branch))!;
	const tree = await gh.listTree(await gh.getCommitTree(head));
	return new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
}

before(() => {
	if (!live) console.log("Skipping live tests: set VSG_LIVE_TOKEN and VSG_LIVE_REPO");
});

test("live: files round-trip byte-exact and shas match GitHub", { skip: !live }, async () => {
	const branch = await freshBranch("roundtrip");
	const { a, b } = pair(branch);
	const png = randomBytes(200_000);
	const bigText = "x".repeat(450_000) + "\nend\n"; // above the inline limit -> blob API
	a.fs.put("Notes/Hello.md", "# Hello\n\nFirst note.\n");
	a.fs.put("Notes/Café ☕ ünïcode.md", "unicode name ✓\n");
	a.fs.put("Deep/a/b/c/nested.md", "deep\n");
	a.fs.put("big.txt", bigText);
	a.fs.files.set("img/photo.png", { data: new Uint8Array(png), mtime: 1 });
	const r1 = await a.sync();
	assert.equal(r1.uploaded.length, 5, JSON.stringify(r1));

	// Every sha GitHub stored must equal the sha we computed locally (proves inline upload is lossless).
	const remote = await remoteFiles(branch);
	for (const [p, f] of a.fs.files) assert.equal(remote.get(p), await gitBlobSha(ab(f.data)), p);
	assert.ok(remote.has(".gitattributes"));
	assert.equal((await a.sync()).upToDate, true);

	await b.sync();
	for (const [p, f] of a.fs.files) assert.deepEqual(b.fs.files.get(p)?.data, f.data, p);
	assert.equal((await b.sync()).upToDate, true);
});

test("live: non-overlapping edits merge across devices", { skip: !live }, async () => {
	const branch = await freshBranch("merge");
	const { a, b } = pair(branch);
	const base = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
	a.fs.put("n.md", base);
	await a.sync();
	await b.sync();
	a.fs.put("n.md", base.replace("line 1\n", "line 1 (Mac)\n"));
	b.fs.put("n.md", base.replace("line 10\n", "line 10 (iPhone)\n"));
	await a.sync();
	const rb = await b.sync();
	assert.deepEqual(rb.merged, ["n.md"]);
	await a.sync();
	const want = base.replace("line 1\n", "line 1 (Mac)\n").replace("line 10\n", "line 10 (iPhone)\n");
	assert.equal(a.fs.text("n.md"), want);
	assert.equal(b.fs.text("n.md"), want);
});

test("live: overlapping edits keep both versions", { skip: !live }, async () => {
	const branch = await freshBranch("conflict");
	const { a, b } = pair(branch);
	a.fs.put("c.md", "original\n");
	await a.sync();
	await b.sync();
	a.fs.put("c.md", "Mac version\n");
	b.fs.put("c.md", "iPhone version\n");
	await a.sync();
	const rb = await b.sync();
	assert.equal(rb.conflictCopies.length, 1);
	await a.sync();
	assert.equal(a.fs.text("c.md"), "Mac version\n");
	assert.equal(a.fs.text(rb.conflictCopies[0]), "iPhone version\n");
});

test("live: deletes propagate, delete guard blocks mass delete, edit beats delete", { skip: !live }, async () => {
	const branch = await freshBranch("delete");
	const { a, b } = pair(branch, { deleteGuardMin: 3, deleteGuardPercent: 10 });
	for (let i = 0; i < 12; i++) a.fs.put(`f/${i}.md`, `${i}\n`);
	a.fs.put("edit-vs-delete.md", "v1\n");
	await a.sync();
	await b.sync();

	b.fs.files.delete("f/0.md");
	await b.sync();
	const ra = await a.sync();
	assert.deepEqual(ra.deletedLocal, ["f/0.md"]);

	for (let i = 1; i < 12; i++) a.fs.files.delete(`f/${i}.md`);
	a.host.deleteChoice = "skip";
	await a.sync();
	assert.equal(a.calls.deletes, 1);
	assert.ok((await remoteFiles(branch)).has("f/5.md"));

	a.fs.files.delete("edit-vs-delete.md");
	b.fs.put("edit-vs-delete.md", "v2 from iPhone\n");
	await b.sync();
	a.host.deleteChoice = "proceed";
	await a.sync();
	assert.equal(a.fs.text("edit-vs-delete.md"), "v2 from iPhone\n");
});

test("live: concurrent push is detected and retried", { skip: !live }, async () => {
	const branch = await freshBranch("race");
	const { a, b } = pair(branch);
	a.fs.put("seed.md", "s\n");
	await a.sync();
	await b.sync();
	a.fs.put("from-mac.md", "mac\n");
	b.fs.put("from-iphone.md", "iphone\n");
	const realUpdate = gh.updateRef.bind(gh);
	let raced = false;
	(gh as any).updateRef = async (br: string, sha: string) => {
		if (!raced) {
			raced = true;
			(gh as any).updateRef = realUpdate;
			await b.sync(); // iPhone pushes first
		}
		return realUpdate(br, sha);
	};
	await a.sync();
	const remote = await remoteFiles(branch);
	assert.ok(remote.has("from-mac.md") && remote.has("from-iphone.md"));
	assert.equal(a.fs.text("from-iphone.md"), "iphone\n");
});

test("live: config folder sync honours excludes", { skip: !live }, async () => {
	const branch = await freshBranch("config");
	const { a, b } = pair(branch, { syncConfigDir: true });
	a.fs.put(".obsidian/app.json", '{"x":1}');
	a.fs.put(".obsidian/snippets/my.css", "body{}");
	a.fs.put(".obsidian/workspace.json", "{}");
	a.fs.put(".obsidian/plugins/vault-sync-git/sync-state.json", "{}");
	await a.sync();
	const remote = await remoteFiles(branch);
	assert.ok(remote.has(".obsidian/app.json") && remote.has(".obsidian/snippets/my.css"));
	assert.ok(!remote.has(".obsidian/workspace.json"));
	assert.ok(!remote.has(".obsidian/plugins/vault-sync-git/sync-state.json"));
	await b.sync();
	assert.equal(b.fs.text(".obsidian/snippets/my.css"), "body{}");
});

test("live: 450-file upload is one commit built from chunked trees", { skip: !live }, async () => {
	const branch = await freshBranch("bulk");
	const { a } = pair(branch);
	for (let i = 0; i < 450; i++) a.fs.put(`bulk/note-${i}.md`, `# Note ${i}\n`);
	const before = (await gh.listCommits(branch, undefined, 10)).length;
	const r = await a.sync();
	assert.equal(r.uploaded.length, 450);
	assert.equal((await gh.listCommits(branch, undefined, 10)).length, before + 1);
	assert.equal([...(await remoteFiles(branch)).keys()].filter((p) => p.startsWith("bulk/")).length, 450);
	assert.equal((await a.sync()).upToDate, true);
});

test("live: history, restore and recover-deleted APIs; snapshot tag", { skip: !live }, async () => {
	const branch = await freshBranch("history");
	const { a } = pair(branch);
	a.fs.put("h.md", "version 1\n");
	await a.sync();
	a.fs.put("h.md", "version 2\n");
	await a.sync();
	const commits = await gh.listCommits(branch, "h.md");
	assert.equal(commits.length, 2);
	assert.match(commits[0].message, /^Mac: 1 updated/);
	const old = await gh.getFileAt("h.md", commits[1].sha);
	assert.equal(new TextDecoder().decode(old!), "version 1\n");

	a.fs.files.delete("h.md");
	await a.sync();
	const [latest] = await gh.listCommits(branch, undefined, 1);
	const detail = await gh.getCommitFiles(latest.sha);
	assert.ok(detail.files.some((f) => f.filename === "h.md" && f.status === "removed"));
	assert.equal(new TextDecoder().decode((await gh.getFileAt("h.md", detail.parent!))!), "version 2\n");
	assert.equal(await gh.getFileAt("h.md", latest.sha), null);

	const tag = `snapshot-test-${run}`;
	await gh.createRef(`refs/tags/${tag}`, latest.sha);
	const res = await gh.request("GET", `/repos/${owner}/${repo}/git/ref/tags/${tag}`);
	assert.equal(res.json.object.sha, latest.sha);
});

test("live: bad token gives a clear error", { skip: !live }, async () => {
	const bad = new GitHub(() => ({ ...cfg(), token: "ghp_invalid" }));
	await assert.rejects(() => bad.getUser(), /invalid or expired/);
});

test("live: restore folder to an earlier commit, then reset another device to GitHub", { skip: !live }, async () => {
	const branch = await freshBranch("restore");
	const { a, b } = pair(branch);
	a.fs.put("Projects/p.md", "p1\n");
	a.fs.put("Daily/d.md", "d1\n");
	await a.sync();
	const point = (await gh.getRef(branch))!;
	a.fs.put("Projects/p.md", "p2\n");
	a.fs.put("Projects/new.md", "new\n");
	a.fs.put("Daily/d.md", "d2\n");
	await a.sync();
	const plan = await a.engine.restoreTo(point, "Projects", async () => true);
	assert.deepEqual(plan, { changed: ["Projects/p.md"], added: [], removed: ["Projects/new.md"] });
	assert.equal(a.fs.text("Projects/p.md"), "p1\n");
	assert.equal(a.fs.text("Daily/d.md"), "d2\n");
	const remote = await remoteFiles(branch);
	assert.ok(!remote.has("Projects/new.md"));

	await b.sync();
	b.fs.put("Daily/d.md", "unsynced local edit\n");
	const reset = await b.engine.resetToRemote(async () => true);
	assert.deepEqual(reset.overwrite, ["Daily/d.md"]);
	assert.equal(b.fs.text("Daily/d.md"), "d2\n");
	assert.equal((await b.sync()).upToDate, true);
});

test("live: tags and rate limit endpoints", { skip: !live }, async () => {
	const rl = await gh.rateLimit();
	assert.ok(rl.limit > 0 && rl.remaining >= 0);
	const tags = await gh.listTags();
	assert.ok(Array.isArray(tags));
});

test("live: renames travel as renames; canvas merges node by node", { skip: !live }, async () => {
	const branch = await freshBranch("v03");
	const { a, b } = pair(branch);
	const c = (nodes: object[]) => JSON.stringify({ nodes, edges: [] }, null, "\t");
	a.fs.put("Inbox/idea.md", "idea\n");
	a.fs.put("Board.canvas", c([{ id: "1", text: "start", x: 0, y: 0 }]));
	await a.sync();
	await b.sync();
	a.fs.files.set("Projects/idea.md", a.fs.files.get("Inbox/idea.md")!);
	a.fs.files.delete("Inbox/idea.md");
	a.fs.put("Board.canvas", c([{ id: "1", text: "start", x: 0, y: 0 }, { id: "2", text: "A" }]));
	b.fs.put("Board.canvas", c([{ id: "1", text: "start", x: 0, y: 0 }, { id: "3", text: "B" }]));
	const ra = await a.sync();
	assert.deepEqual(ra.renamed, ["Inbox/idea.md → Projects/idea.md"]);
	const rb = await b.sync();
	assert.deepEqual(rb.renamed, ["Inbox/idea.md → Projects/idea.md"]);
	assert.deepEqual(rb.merged, ["Board.canvas"]);
	assert.equal(b.fs.text("Projects/idea.md"), "idea\n");
	const remote = await remoteFiles(branch);
	assert.ok(remote.has("Projects/idea.md") && !remote.has("Inbox/idea.md"));
	await a.sync();
	assert.deepEqual(JSON.parse(a.fs.text("Board.canvas")!).nodes.map((n: { id: string }) => n.id).sort(), ["1", "2", "3"]);
});

test("live: end-to-end encrypted sync between two devices", { skip: !live }, async () => {
	const { Codec } = await import("../../src/codec.ts");
	const { createEncryption, EncryptionLayer, b64, unb64, MARKER_PATH } = await import("../../src/crypto.ts");
	const { encryptionGuard } = await import("../../src/encryption.ts");
	const branch = await freshBranch("e2ee");
	const { meta, master } = await createEncryption("live test passphrase 123");
	const layer = await EncryptionLayer.fromMaster(unb64(b64(master)));
	const mk = (name: string) => {
		const d = device(name, gh as any, { owner, repo, branch });
		let rec: any = { meta, master: b64(master) };
		d.host.codec = () => new Codec([layer]);
		d.host.checkEncryption = encryptionGuard(() => rec, (r) => (rec = r), async (sha) => JSON.parse(new TextDecoder().decode(await gh.getBlob(sha))));
		return d;
	};
	const a = mk("Mac"), b = mk("iPhone");
	a.fs.put("Private/Secret plan.md", "launch on friday\n");
	a.fs.files.set("img/x.png", { data: new Uint8Array(randomBytes(5000)), mtime: 1 });
	await a.sync();
	const remote = await remoteFiles(branch);
	assert.ok(remote.has(MARKER_PATH));
	for (const p of remote.keys()) assert.ok(!/Secret|plan|x\.png/.test(p), `leaked name ${p}`);
	await b.sync();
	assert.equal(b.fs.text("Private/Secret plan.md"), "launch on friday\n");
	assert.deepEqual(b.fs.files.get("img/x.png")!.data, a.fs.files.get("img/x.png")!.data);
	assert.equal((await b.sync()).upToDate, true);
	b.fs.put("Private/Secret plan.md", "launch on friday\nbring snacks\n");
	await b.sync();
	await a.sync();
	assert.equal(a.fs.text("Private/Secret plan.md"), "launch on friday\nbring snacks\n");
});
