import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble, diffLines, diffStats, sameIgnoringEol, segments } from "../src/diff.ts";
import { conflictCopyOriginal, conflictCopyPath, restoredCopyPath } from "../src/util.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

// ---------- pure ----------

test("diffLines + stats", () => {
	const ops = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
	assert.deepEqual(diffStats(ops), { added: 2, removed: 1 });
	assert.deepEqual(ops.map((o) => o.t), ["eq", "del", "add", "eq", "add"]);
});

test("segments + assemble with per-change picks", () => {
	const local = "title\nmine 1\nsame\nmine 2\n";
	const remote = "title\ntheirs 1\nsame\ntheirs 2\n";
	const segs = segments(diffLines(local, remote));
	assert.equal(segs.filter((s) => s.kind === "change").length, 2);
	assert.equal(assemble(segs, ["a", "b"]), "title\nmine 1\nsame\ntheirs 2\n");
	assert.equal(assemble(segs, ["both", "a"]), "title\nmine 1\ntheirs 1\nsame\nmine 2\n");
});

test("assemble handles missing trailing newline", () => {
	const segs = segments(diffLines("x\nend", "x\nother"));
	assert.equal(assemble(segs, ["both"]), "x\nend\nother");
});

test("sameIgnoringEol", () => {
	assert.ok(sameIgnoringEol("a\r\nb\r\n", "a\nb\n"));
	assert.ok(!sameIgnoringEol("a\r\nb", "a\nc"));
});

test("conflict copy names round-trip to the original", () => {
	const d = new Date(2026, 9, 12, 9, 5);
	assert.equal(conflictCopyOriginal(conflictCopyPath("Notes/My note.md", "iPhone", d)), "Notes/My note.md");
	assert.equal(conflictCopyOriginal(conflictCopyPath("README", "Mac", d)), "README");
	assert.equal(conflictCopyOriginal("Notes/normal (conflict) note.md"), null);
	assert.equal(conflictCopyOriginal(restoredCopyPath("a.md", "abcdef1234", d)), null);
});

// ---------- engine ----------

function pair(overrides = {}) {
	const gh = new FakeGitHub();
	return { gh, a: device("A", gh, overrides), b: device("B", gh, overrides) };
}

test("deferred files are left alone on both sides and synced later", async () => {
	const { gh, a } = pair();
	a.fs.put("keep.md", "k\n");
	await a.sync();
	a.fs.put("later.md", "not yet\n");
	a.fs.put("now.md", "now\n");
	const r = await a.engine.run("sync", { defer: new Set(["later.md"]) });
	assert.deepEqual(r.uploaded, ["now.md"]);
	assert.ok(!gh.headFiles().has("later.md"));
	const r2 = await a.sync();
	assert.deepEqual(r2.uploaded, ["later.md"]);
});

test("line-ending-only edits are not uploaded", async () => {
	const { gh, a } = pair();
	a.fs.put("n.md", "one\ntwo\n");
	await a.sync();
	const before = gh.commits.size;
	a.fs.put("n.md", "one\r\ntwo\r\n");
	const r = await a.sync();
	assert.equal(r.uploaded.length, 0);
	assert.equal(gh.commits.size, before);
	// A real edit is still uploaded.
	a.fs.put("n.md", "one\r\ntwo changed\r\n");
	assert.deepEqual((await a.sync()).uploaded, ["n.md"]);
});

test("line-ending-only edits are uploaded when the option is off", async () => {
	const { a } = pair({ ignoreLineEndingChanges: false });
	a.fs.put("n.md", "one\n");
	await a.sync();
	a.fs.put("n.md", "one\r\n");
	assert.deepEqual((await a.sync()).uploaded, ["n.md"]);
});

test("ask conflict: change-by-change result is written and uploaded", async () => {
	const { gh, a, b } = pair({ conflictStrategy: "ask" });
	a.fs.put("c.md", "t\nx\n");
	await a.sync();
	await b.sync();
	a.fs.put("c.md", "t\nfrom A\n");
	b.fs.put("c.md", "t\nfrom B\n");
	await a.sync();
	b.host.askConflict = async () => ({ custom: "t\nfrom B\nfrom A\n" });
	const r = await b.sync();
	assert.deepEqual(r.merged, ["c.md"]);
	assert.equal(b.fs.text("c.md"), "t\nfrom B\nfrom A\n");
	assert.equal(gh.headFiles().get("c.md"), "t\nfrom B\nfrom A\n");
});

test("restore whole vault to an earlier commit (forward commit, local updated)", async () => {
	const { gh, a, b } = pair();
	a.fs.put("n.md", "v1\n");
	a.fs.put("Keep/k.md", "k1\n");
	await a.sync();
	const point = gh.refs.get("main")!;
	a.fs.put("n.md", "v2\n");
	a.fs.files.delete("Keep/k.md");
	a.fs.put("new.md", "created later\n");
	await a.sync();
	await b.sync();

	let asked = 0;
	const plan = await a.engine.restoreTo(point, "", async (p) => {
		asked++;
		assert.deepEqual(p, { changed: ["n.md"], added: ["Keep/k.md"], removed: ["new.md"] });
		return true;
	});
	assert.equal(asked, 1);
	assert.equal(plan.changed.length + plan.added.length + plan.removed.length, 3);
	assert.equal(a.fs.text("n.md"), "v1\n");
	assert.equal(a.fs.text("Keep/k.md"), "k1\n");
	assert.ok(!a.fs.files.has("new.md"));
	const head = gh.commits.get(gh.refs.get("main")!)!;
	assert.match(head.message, /restore vault/);
	assert.ok(head.parents.length === 1, "forward commit, not a rewrite");
	await b.sync();
	assert.equal(b.fs.text("n.md"), "v1\n");
});

test("restore a single folder leaves everything else alone", async () => {
	const { gh, a } = pair();
	a.fs.put("Projects/p.md", "p1\n");
	a.fs.put("Daily/d.md", "d1\n");
	await a.sync();
	const point = gh.refs.get("main")!;
	a.fs.put("Projects/p.md", "p2\n");
	a.fs.put("Daily/d.md", "d2\n");
	await a.sync();
	await a.engine.restoreTo(point, "Projects", async () => true);
	assert.equal(a.fs.text("Projects/p.md"), "p1\n");
	assert.equal(a.fs.text("Daily/d.md"), "d2\n");
});

test("restore can be cancelled without changing anything", async () => {
	const { gh, a } = pair();
	a.fs.put("n.md", "v1\n");
	await a.sync();
	const point = gh.refs.get("main")!;
	a.fs.put("n.md", "v2\n");
	await a.sync();
	const head = gh.refs.get("main");
	await assert.rejects(() => a.engine.restoreTo(point, "", async () => false), /cancelled/);
	assert.equal(gh.refs.get("main"), head);
	assert.equal(a.fs.text("n.md"), "v2\n");
});

test("reset to GitHub discards local changes, old versions go to trash", async () => {
	const { gh, a, b } = pair();
	a.fs.put("n.md", "remote\n");
	a.fs.put("gone.md", "x\n");
	await a.sync();
	await b.sync();
	b.fs.put("n.md", "local edit\n");
	b.fs.put("local-only.md", "draft\n");
	b.fs.files.delete("gone.md");
	const plan = await b.engine.resetToRemote(async () => true);
	assert.deepEqual(plan, { overwrite: ["n.md"], download: ["gone.md"], remove: ["local-only.md"] });
	assert.equal(b.fs.text("n.md"), "remote\n");
	assert.equal(b.fs.text("gone.md"), "x\n");
	assert.ok(!b.fs.files.has("local-only.md"));
	assert.ok(b.fs.trash.includes("n.md") && b.fs.trash.includes("local-only.md"));
	assert.equal((await b.sync()).upToDate, true);
	assert.ok(!gh.headFiles().has("local-only.md"));
});

test("incremental scan: config dir is only re-read when due", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { syncConfigDir: true });
	let full = true;
	const paths = new Set<string>();
	a.host.localChanges = () => ({ full, paths: new Set(paths) });
	a.host.markLocalChangesSynced = (c) => {
		if (c.full) full = false;
		for (const p of c.paths) paths.delete(p);
	};
	a.fs.put(".obsidian/app.json", "{}");
	a.fs.put("n.md", "1\n");
	await a.sync();
	assert.ok(gh.headFiles().has(".obsidian/app.json"));

	a.fs.put(".obsidian/app.json", '{"changed":1}');
	await a.sync();
	assert.equal(gh.headFiles().get(".obsidian/app.json"), "{}", "not re-read yet (within 5 min)");

	a.host.state.lastConfigScan = 0;
	await a.sync();
	assert.equal(gh.headFiles().get(".obsidian/app.json"), '{"changed":1}');
});

test("incremental scan: a flagged path is re-hashed even if mtime and size match", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	let full = true;
	const paths = new Set<string>();
	a.host.localChanges = () => ({ full, paths: new Set(paths) });
	a.host.markLocalChangesSynced = (c) => {
		if (c.full) full = false;
		for (const p of c.paths) paths.delete(p);
	};
	a.fs.put("n.md", "aaaa\n");
	await a.sync();
	const f = a.fs.files.get("n.md")!;
	a.fs.files.set("n.md", { data: new TextEncoder().encode("bbbb\n"), mtime: f.mtime }); // same size + mtime
	assert.equal((await a.sync()).upToDate, true, "unflagged: trusted cache");
	paths.add("n.md");
	assert.deepEqual((await a.sync()).uploaded, ["n.md"]);
	assert.equal(gh.headFiles().get("n.md"), "bbbb\n");
});
