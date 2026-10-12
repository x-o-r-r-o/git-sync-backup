import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, device } from "./support/fakes.ts";

const lines = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join("\n") + "\n";

function setup(overrides = {}) {
	const gh = new FakeGitHub();
	const a = device("A", gh, overrides);
	const b = device("B", gh, overrides);
	return { gh, a, b };
}

test("first device uploads, second device downloads", async () => {
	const { gh, a, b } = setup();
	a.fs.put("Notes/one.md", "hello\n");
	a.fs.put("Daily/2026-10-12.md", "today\n");
	a.fs.put("img/pic.png", "\u0000PNGDATA");
	const r1 = await a.sync();
	assert.equal(r1.uploaded.length, 3);
	assert.ok(gh.headFiles().has(".gitattributes"));
	await b.sync();
	assert.equal(b.fs.text("Notes/one.md"), "hello\n");
	assert.equal(b.fs.text("img/pic.png"), "\u0000PNGDATA");
	assert.ok(!b.fs.files.has(".gitattributes"), "hidden repo files are not pulled");
	const r3 = await b.sync();
	assert.equal(r3.upToDate, true);
});

test("non-overlapping edits on two devices merge automatically", async () => {
	const { a, b } = setup();
	a.fs.put("n.md", lines(10));
	await a.sync();
	await b.sync();
	a.fs.put("n.md", lines(10).replace("line 1\n", "line 1 edited on A\n"));
	b.fs.put("n.md", lines(10).replace("line 9\n", "line 9 edited on B\n"));
	await a.sync();
	const rb = await b.sync();
	assert.deepEqual(rb.merged, ["n.md"]);
	await a.sync();
	const expected = lines(10).replace("line 1\n", "line 1 edited on A\n").replace("line 9\n", "line 9 edited on B\n");
	assert.equal(a.fs.text("n.md"), expected);
	assert.equal(b.fs.text("n.md"), expected);
});

test("overlapping edits keep both versions, nothing lost", async () => {
	const { gh, a, b } = setup();
	a.fs.put("n.md", "same\n");
	await a.sync();
	await b.sync();
	a.fs.put("n.md", "from A\n");
	b.fs.put("n.md", "from B\n");
	await a.sync();
	const rb = await b.sync();
	assert.equal(rb.conflictCopies.length, 1);
	assert.equal(b.fs.text("n.md"), "from A\n");
	assert.equal(b.fs.text(rb.conflictCopies[0]), "from B\n");
	await a.sync();
	assert.equal(a.fs.text(rb.conflictCopies[0]), "from B\n");
	assert.equal(gh.headFiles().get(rb.conflictCopies[0]), "from B\n");
});

test("markers strategy writes git conflict markers", async () => {
	const { a, b } = setup({ conflictStrategy: "markers" });
	a.fs.put("n.md", "x\nsame\ny\n");
	await a.sync();
	await b.sync();
	a.fs.put("n.md", "x\nA\ny\n");
	b.fs.put("n.md", "x\nB\ny\n");
	await a.sync();
	await b.sync();
	assert.match(b.fs.text("n.md")!, /<<<<<<< this device \(B\)\nB\n=======\nA\n>>>>>>> GitHub/);
});

test("ask strategy uses the user's choice", async () => {
	const { a, b } = setup({ conflictStrategy: "ask" });
	a.fs.put("n.md", "0\n");
	await a.sync();
	await b.sync();
	a.fs.put("n.md", "A\n");
	b.fs.put("n.md", "B\n");
	await a.sync();
	b.host.conflictChoice = "local";
	await b.sync();
	assert.equal(b.calls.conflicts, 1);
	await a.sync();
	assert.equal(a.fs.text("n.md"), "B\n");
});

test("deletions propagate to the trash", async () => {
	const { a, b } = setup();
	a.fs.put("keep.md", "k\n");
	a.fs.put("Old/gone.md", "g\n");
	await a.sync();
	await b.sync();
	b.fs.files.delete("Old/gone.md");
	const rb = await b.sync();
	assert.deepEqual(rb.deletedRemote, ["Old/gone.md"]);
	const ra = await a.sync();
	assert.deepEqual(ra.deletedLocal, ["Old/gone.md"]);
	assert.ok(a.fs.trash.includes("Old/gone.md"));
	assert.ok(a.fs.files.has("keep.md"));
});

test("edit beats delete", async () => {
	const { a, b } = setup();
	a.fs.put("x.md", "v1\n");
	await a.sync();
	await b.sync();
	a.fs.files.delete("x.md");
	b.fs.put("x.md", "v2 edited\n");
	await a.sync();
	await b.sync();
	await a.sync();
	assert.equal(a.fs.text("x.md"), "v2 edited\n");
	assert.equal(b.fs.text("x.md"), "v2 edited\n");
});

test("delete guard can skip a mass deletion", async () => {
	const { gh, a } = setup({ deleteGuardMin: 3, deleteGuardPercent: 10 });
	for (let i = 0; i < 20; i++) a.fs.put(`f${i}.md`, `${i}\n`);
	await a.sync();
	for (let i = 0; i < 15; i++) a.fs.files.delete(`f${i}.md`);
	a.host.deleteChoice = "skip";
	const r = await a.sync();
	assert.equal(a.calls.deletes, 1);
	assert.equal(r.deletedRemote.length, 0);
	assert.ok(gh.headFiles().has("f0.md"));
});

test("config dir sync respects excludes; out-of-scope remote files survive", async () => {
	const { gh, a, b } = setup({ syncConfigDir: true });
	a.fs.put(".obsidian/app.json", "{}");
	a.fs.put(".obsidian/workspace.json", "{layout}");
	a.fs.put(".obsidian/plugins/vault-sync-github/sync-state.json", "{}");
	a.fs.put("n.md", "n\n");
	await a.sync();
	const head = gh.headFiles();
	assert.ok(head.has(".obsidian/app.json"));
	assert.ok(!head.has(".obsidian/workspace.json"));
	assert.ok(!head.has(".obsidian/plugins/vault-sync-github/sync-state.json"));
	// A file only on GitHub that the plugin does not manage (e.g. a workflow) must never be deleted.
	await gh.createTree; // no-op reference
	const t = gh.trees.get(gh.commits.get(gh.refs.get("main")!)!.tree)!;
	t.set(".github/workflows/x.yml", { sha: await gh.createBlob(Buffer.from("on: push").toString("base64")), mode: "100644" });
	a.fs.put("n.md", "n2\n");
	await a.sync();
	assert.ok(gh.headFiles().has(".github/workflows/x.yml"));
	await b.sync();
	assert.equal(b.fs.text(".obsidian/app.json"), "{}");
	assert.ok(!b.fs.files.has(".github/workflows/x.yml"));
});

test("concurrent push from another device is retried, both changes land", async () => {
	const { gh, a, b } = setup();
	a.fs.put("a.md", "a\n");
	await a.sync();
	await b.sync();
	a.fs.put("from-a.md", "A\n");
	b.fs.put("from-b.md", "B\n");
	gh.interject = async () => {
		await b.sync();
	};
	await a.sync();
	const head = gh.headFiles();
	assert.ok(head.has("from-a.md") && head.has("from-b.md"));
	assert.equal(a.fs.text("from-b.md"), "B\n");
});

test("too-large files are skipped and never deleted remotely", async () => {
	const { gh, a, b } = setup();
	a.fs.put("big.bin", "x".repeat(50));
	await a.sync();
	b.host.settings.maxFileSizeMB = 0.00001; // ~10 bytes
	await b.sync();
	assert.ok(!b.fs.files.has("big.bin"));
	b.fs.put("other.md", "o\n");
	await b.sync();
	assert.ok(gh.headFiles().has("big.bin"));
});

test("backup (push) mode never changes local files", async () => {
	const { a, b } = setup();
	a.fs.put("n.md", "1\n");
	await a.sync();
	await b.sync("push");
	assert.ok(!b.fs.files.has("n.md"));
	b.fs.put("b.md", "b\n");
	await b.sync("push");
	await a.sync();
	assert.equal(a.fs.text("b.md"), "b\n");
	assert.equal(a.fs.text("n.md"), "1\n");
});

test("pull mode never pushes", async () => {
	const { gh, a, b } = setup();
	a.fs.put("n.md", "1\n");
	await a.sync();
	await b.sync("pull");
	b.fs.put("local-only.md", "x\n");
	await b.sync("pull");
	assert.ok(!gh.headFiles().has("local-only.md"));
	assert.equal(b.fs.text("n.md"), "1\n");
});

test("unsafe remote paths are never written", async () => {
	const { gh, a, b } = setup();
	a.fs.put("ok.md", "ok\n");
	await a.sync();
	const t = gh.trees.get(gh.commits.get(gh.refs.get("main")!)!.tree)!;
	const x = await gh.createBlob(Buffer.from("x").toString("base64"));
	t.set("../escape.md", { sha: x, mode: "100644" }); // out of scope (dot segment)
	t.set("notes//double.md", { sha: x, mode: "100644" }); // caught by the path safety check
	const r = await b.sync();
	assert.ok(!b.fs.files.has("../escape.md"));
	assert.ok(!b.fs.files.has("notes//double.md"));
	assert.ok(r.skipped.some((s) => s.includes("unsafe path")));
	assert.equal(b.fs.text("ok.md"), "ok\n");
});

test("large first upload is chunked into one commit", async () => {
	const { gh, a, b } = setup();
	for (let i = 0; i < 1200; i++) a.fs.put(`bulk/n${i}.md`, `note ${i}\n`);
	const commitsBefore = gh.commits.size;
	const r = await a.sync();
	assert.equal(r.uploaded.length, 1200);
	assert.equal(gh.commits.size - commitsBefore, 2); // init commit + one sync commit
	await b.sync();
	assert.equal(b.fs.text("bulk/n1199.md"), "note 1199\n");
});

test("no empty commit when local already matches remote content", async () => {
	const { gh, a, b } = setup();
	a.fs.put("n.md", "1\n");
	await a.sync();
	await b.sync();
	a.fs.put("n.md", "same edit\n");
	b.fs.put("n.md", "same edit\n");
	await a.sync();
	const before = gh.commits.size;
	await b.sync();
	assert.equal(gh.commits.size, before);
	assert.equal((await b.sync()).upToDate, true);
});

test("stale (cached) remote head never causes local deletions", async () => {
	const { gh, a } = setup();
	a.fs.put("one.md", "1\n");
	await a.sync();
	const older = gh.refs.get("main")!;
	a.fs.put("two.md", "2\n");
	await a.sync();
	gh.staleRef = older; // GitHub/HTTP cache serves the previous head
	await assert.rejects(() => a.sync(), /outdated branch state/);
	assert.ok(a.fs.files.has("two.md"), "two.md must survive");
	gh.staleRef = null;
	assert.equal((await a.sync()).upToDate, true);
});

test("rewritten remote history never deletes local files", async () => {
	const { gh, a } = setup();
	a.fs.put("keep.md", "k\n");
	await a.sync();
	// Simulate a force-push to an unrelated history without keep.md.
	const t = await gh.createTree(null, [{ path: "other.md", mode: "100644", type: "blob", content: "o\n" }]);
	const c = await gh.createCommit("rewrite", t, []);
	gh.refs.set("main", c);
	await a.sync();
	assert.equal(a.fs.text("keep.md"), "k\n");
	assert.equal(a.fs.text("other.md"), "o\n");
	assert.ok(gh.headFiles().has("keep.md"), "re-uploaded");
});
