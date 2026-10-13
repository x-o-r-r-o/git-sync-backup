// Regression tests for the sync-engine audit fixes: template notes mistaken for renames, baselines
// after a rewritten history, big files read by the rename pass, LFS size limits, conflict markers
// inside a side, recoverable replacements, deferred folder pruning and unlistable folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, FakeFS, device } from "./support/fakes.ts";
import { lineSimilarity, detectSimilarRenames } from "../src/plan.ts";
import type { Decision } from "../src/plan.ts";
import { merge3 } from "../src/merge.ts";
import { findConflictBlocks, resolveBlock } from "../src/conflict-editor.ts";
import { VaultIO } from "../src/io.ts";
import { pointerFor } from "../src/lfs.ts";

const tpl = (d: string) => `---\ntags: [daily]\n---\n# ${d}\n\n## Tasks\n\n## Notes\n\n## Log\n`;

// ---- 1. similar-rename detection ----

test("daily-note template: deleting an unedited day while another device wrote in it never moves those entries into the new day", async () => {
	const gh = new FakeGitHub();
	const a = device("Desktop", gh);
	const b = device("Phone", gh);
	a.fs.put("Daily/2026-10-12.md", tpl("2026-10-12"));
	await a.sync();
	await b.sync();
	const edited = tpl("2026-10-12").replace("## Log\n", "## Log\n- met Sam, owes me 200\n");
	b.fs.put("Daily/2026-10-12.md", edited);
	await b.sync();
	a.fs.files.delete("Daily/2026-10-12.md");
	a.fs.put("Daily/2026-10-13.md", tpl("2026-10-13"));
	const r = await a.sync();
	assert.equal(r.renamed.length, 0);
	assert.deepEqual(r.merged, []);
	// Edit beats delete: the phone's entries stay in the 12th, the 13th is just the new template.
	assert.equal(a.fs.text("Daily/2026-10-12.md"), edited);
	assert.equal(a.fs.text("Daily/2026-10-13.md"), tpl("2026-10-13"));
	assert.equal(gh.headFiles().get("Daily/2026-10-12.md"), edited);
	assert.equal(gh.headFiles().get("Daily/2026-10-13.md"), tpl("2026-10-13"));
});

test("daily-note template, mirrored: renamed-looking on GitHub while this device wrote in the old day: the old day is kept", async () => {
	const gh = new FakeGitHub();
	const a = device("Desktop", gh);
	const b = device("Phone", gh);
	a.fs.put("Daily/2026-10-12.md", tpl("2026-10-12"));
	await a.sync();
	await b.sync();
	b.fs.files.delete("Daily/2026-10-12.md");
	b.fs.put("Daily/2026-10-13.md", tpl("2026-10-13"));
	await b.sync();
	const edited = tpl("2026-10-12").replace("## Log\n", "## Log\n- call the bank\n");
	a.fs.put("Daily/2026-10-12.md", edited);
	const r = await a.sync();
	assert.equal(r.renamed.length, 0);
	assert.equal(a.fs.text("Daily/2026-10-12.md"), edited);
	assert.equal(a.fs.text("Daily/2026-10-13.md"), tpl("2026-10-13"));
	assert.equal(gh.headFiles().get("Daily/2026-10-12.md"), edited);
});

test("lineSimilarity: ignores blank and markup-only lines and needs several shared lines", () => {
	assert.equal(lineSimilarity("a\nb\n", "a\nb\n"), 0, "two shared lines are not enough");
	assert.equal(lineSimilarity("---\n\n---\n```\n", "---\n\n---\n```\n"), 0, "markup-only lines carry no evidence");
	assert.equal(lineSimilarity("one\ntwo\nthree\n", "one\ntwo\nthree\n"), 1);
	assert.ok(lineSimilarity(tpl("2026-10-12"), tpl("2026-10-13")) < 0.8);
	const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
	assert.ok(lineSimilarity(body, body.replace("line 1\n", "line 1 (edited)\n")) >= 0.8);
});

test("detectSimilarRenames: an old file with no same-extension candidate is never read", async () => {
	const base = { "video.mp4": "b1" };
	const local = new Map([["note.md", "l1"]]);
	const remote = new Map([["video.mp4", "b1"]]);
	const decisions: Decision[] = [
		{ kind: "delete-remote", path: "video.mp4" },
		{ kind: "upload", path: "note.md", sha: "l1" },
	];
	const reads: string[] = [];
	const out = await detectSimilarRenames(decisions, base, local, remote, {
		text: async (side, path) => {
			reads.push(`${side}:${path}`);
			return "x";
		},
	});
	assert.deepEqual(reads, []);
	assert.deepEqual(out, decisions);
});

// ---- 3. no big downloads in the rename pass ----

test("rename pass: a deleted binary next to a new note downloads nothing", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("video.mp4", "\u0000" + "v".repeat(300_000));
	a.fs.put("big.md", "x\n".repeat(1_500_000)); // 3 MB of text
	await a.sync();
	const orig = gh.getBlob.bind(gh);
	let bytes = 0;
	(gh as unknown as { getBlob: (s: string) => Promise<ArrayBuffer> }).getBlob = async (sha: string) => {
		const d = await orig(sha);
		bytes += d.byteLength;
		return d;
	};
	a.fs.files.delete("video.mp4");
	a.fs.files.delete("big.md");
	a.fs.put("note.md", "hello\n");
	a.fs.put("note.mp4", "\u0000other");
	const r = await a.sync();
	assert.equal(bytes, 0);
	assert.deepEqual(r.deletedRemote.sort(), ["big.md", "video.mp4"]);
});

// ---- 2. baselines after a rewritten history ----

test("after a force-push, 'sync current file' keeps no stale baseline: the next sync deletes nothing", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("keep.md", "k\n");
	a.fs.put("cur.md", "c\n");
	await a.sync();
	const t = await gh.createTree(null, [{ path: "cur.md", mode: "100644", type: "blob", content: "c\n" }]);
	const c = await gh.createCommit("rewrite", t, []);
	gh.refs.set("main", c);
	await a.engine.run("sync", { only: new Set(["cur.md"]) });
	const r = await a.sync();
	assert.deepEqual(r.deletedLocal, []);
	assert.equal(a.fs.text("keep.md"), "k\n");
	assert.equal(gh.headFiles().get("keep.md"), "k\n");
});

// ---- 4. LFS files above the file size limit ----

test("an LFS file whose real size is above the size limit is skipped, not downloaded", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { maxFileSizeMB: 1 });
	const b = device("B", gh, { maxFileSizeMB: 1 });
	a.fs.put("note.md", "n\n");
	await a.sync();
	const head = gh.refs.get("main")!;
	const ptr = pointerFor("a".repeat(64), 5 * 1024 * 1024);
	const t = await gh.createTree(await gh.getCommitTree(head), [{ path: "movie.mov", mode: "100644", type: "blob", content: ptr }]);
	gh.refs.set("main", await gh.createCommit("add lfs file", t, [head]));
	const r = await b.sync();
	assert.ok(!b.fs.files.has("movie.mov"));
	assert.ok(r.skipped.some((s) => s.startsWith("movie.mov (remote file larger than 1 MB")));
	assert.deepEqual(r.errors, []);
	// Never seen as deleted here later.
	const r2 = await b.sync();
	assert.deepEqual(r2.deletedRemote, []);
	assert.ok(gh.headFiles().has("movie.mov"));
});

// ---- 5. marker-like lines inside a side ----

test("merge3: no conflict markers around a side that already contains a marker-like line", () => {
	const base = "x\nold\ny\n";
	const local = "x\nMy Title\n=======\nmy paragraph\ny\n";
	const remote = "x\ntheir line\ny\n";
	assert.equal(merge3(base, local, remote, { local: "A", remote: "GitHub" }), null);
	// Clean merges are unaffected.
	assert.equal(merge3("a\nb\nc\n", "a\n=======\nb\nc\n", "a\nb\nc!\n", { local: "A", remote: "G" })?.text, "a\n=======\nb\nc!\n");
});

test("conflict sync with a '=======' line in a note keeps both versions instead of writing markers", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { conflictStrategy: "markers" });
	const b = device("B", gh);
	a.fs.put("n.md", "x\nold\ny\n");
	await a.sync();
	await b.sync();
	b.fs.put("n.md", "x\ntheir line\ny\n");
	await b.sync();
	a.fs.put("n.md", "x\nMy Title\n=======\nmy paragraph\ny\n");
	const r = await a.sync();
	assert.equal(r.conflictCopies.length, 1);
	assert.equal(a.fs.text("n.md"), "x\ntheir line\ny\n");
	assert.equal(a.fs.text(r.conflictCopies[0]), "x\nMy Title\n=======\nmy paragraph\ny\n");
});

test("conflict editor: a block with two bare separators is ambiguous and gets no buttons", () => {
	const text = "x\n<<<<<<< this device (A)\nMy Title\n=======\nmy paragraph\n=======\ntheir line\n>>>>>>> GitHub\ny\n";
	assert.deepEqual(findConflictBlocks(text), []);
	const ok = "<<<<<<< A\nmine\n=======\ntheirs\n>>>>>>> B\n";
	const [blk] = findConflictBlocks(ok);
	assert.equal(resolveBlock(blk, "ours"), "mine\n");
	// A well-formed block after an ambiguous one is still found.
	assert.equal(findConflictBlocks(text + ok).length, 1);
});

// ---- 6. replaced local content always goes somewhere recoverable ----

test("'take the repository version' keeps the local version recoverable even with permanent delete on", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { conflictStrategy: "remote" });
	const b = device("B", gh);
	a.fs.put("n.md", "base\n");
	await a.sync();
	await b.sync();
	b.fs.put("n.md", "remote\n");
	await b.sync();
	a.fs.put("n.md", "local only\n");
	a.fs.permanentDelete = true;
	await a.sync();
	assert.equal(a.fs.text("n.md"), "remote\n");
	assert.deepEqual(a.fs.trash, ["n.md"]);
	// With a system trash available, that is used first.
	a.fs.systemTrash = true;
	b.fs.put("n.md", "remote 2\n");
	await b.sync();
	a.fs.put("n.md", "local only 2\n");
	await a.sync();
	assert.deepEqual(a.fs.systemTrashed, ["n.md"]);
});

test("reset to remote: overwritten and removed local files go to the trash even with permanent delete on", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("n.md", "base\n");
	await a.sync();
	a.fs.put("n.md", "local edit\n");
	a.fs.put("extra.md", "local only\n");
	a.fs.permanentDelete = true;
	await a.engine.resetToRemote(async () => true);
	assert.equal(a.fs.text("n.md"), "base\n");
	assert.ok(!a.fs.files.has("extra.md"));
	assert.deepEqual(a.fs.trash.sort(), ["extra.md", "n.md"]);
});

// ---- 7 / 11. folders ----

function io(fs: FakeFS) {
	return new VaultIO(fs.app());
}

test("deferPruning: a folder emptied during a batch is only pruned afterwards, and kept if it got a new file", async () => {
	const fs = new FakeFS();
	fs.put("A/x.md", "x");
	fs.dirs.add("A");
	fs.put("B/y.md", "y");
	fs.dirs.add("B");
	const v = io(fs);
	await v.deferPruning(async () => {
		await v.remove("A/x.md");
		await v.remove("B/y.md");
		// Not pruned yet: a parallel download may be about to write here.
		assert.ok(fs.dirs.has("A"));
		await v.write("A/new.md", new TextEncoder().encode("n").buffer);
	});
	assert.equal(fs.text("A/new.md"), "n");
	assert.ok(fs.dirs.has("A"));
	assert.ok(!fs.dirs.has("B"), "an emptied folder is pruned once the batch is done");
});

test("folderHasChildren: a folder that can't be listed counts as non-empty and is never removed", async () => {
	const fs = new FakeFS();
	fs.dirs.add("F");
	fs.unlistable.add("F");
	const v = io(fs);
	assert.equal(await v.folderHasChildren("F"), true);
	await v.removeEmptyFolder("F");
	assert.ok(fs.dirs.has("F"));
});

// ---- 9. remote rename + edit: content fetched before renaming ----

test("renamed and edited on GitHub: a failed download leaves the note under its old name", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
	a.fs.put("draft.md", body);
	await a.sync();
	await b.sync();
	b.fs.files.delete("draft.md");
	b.fs.put("final.md", body.replace("line 1\n", "line 1 (edited)\n"));
	await b.sync();
	const orig = gh.getBlob.bind(gh);
	const finalSha = [...gh.trees.get(gh.commits.get(gh.refs.get("main")!)!.tree)!].find(([p]) => p === "final.md")![1].sha;
	let finalReads = 0;
	// The rename pass may read it once to compare; the download for the rename itself fails.
	(gh as unknown as { getBlob: (s: string) => Promise<ArrayBuffer> }).getBlob = async (sha: string) => {
		if (sha === finalSha && ++finalReads > 1) throw new Error("network down");
		return orig(sha);
	};
	const r = await a.sync();
	assert.ok(r.renamed.length === 0);
	assert.ok(r.errors.length > 0);
	assert.equal(a.fs.text("draft.md"), body);
	assert.ok(!a.fs.files.has("final.md"));
	(gh as unknown as { getBlob: typeof orig }).getBlob = orig;
	await a.sync();
	assert.equal(a.fs.text("final.md"), body.replace("line 1\n", "line 1 (edited)\n"));
	assert.ok(!a.fs.files.has("draft.md"));
});
