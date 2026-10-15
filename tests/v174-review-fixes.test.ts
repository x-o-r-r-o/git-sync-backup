import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, device } from "./support/fakes.ts";
import { nestedHiddenIndex } from "../src/io.ts";
import { mergeJson } from "../src/smartmerge.ts";
import { parsePointer } from "../src/lfs.ts";

// Bugs found in the 1.7.4 review, each reproduced first (these failed before the fixes).

test("downloaded nested hidden file is not deleted on next sync", async () => {
	const gh = new FakeGitHub();
	const opts = { syncHidden: true, syncHiddenNested: true };
	const a = device("A", gh, opts);
	const b = device("B", gh, opts);
	a.fs.put("Notes/a.md", "a\n");
	await a.sync();
	await b.sync();
	a.fs.put("Notes/.assets/pic.txt", "p\n");
	nestedHiddenIndex(a.host.app).foldersChanged();
	await a.sync();
	const r2 = await b.sync();
	assert.equal(b.fs.text("Notes/.assets/pic.txt"), "p\n");
	const r3 = await b.sync();
	assert.ok(gh.headFiles().has("Notes/.assets/pic.txt"), "still in repo");
});

test("downloaded nested hidden file is not deleted on next sync", async () => {
	const gh = new FakeGitHub();
	const opts = { useGitignore: true };
	const a = device("A", gh, opts);
	const b = device("B", gh, opts);
	a.fs.put("Notes/a.md", "a\n");
	await a.sync();
	await b.sync();
	a.fs.put("Notes/.gitignore", "p\n");
	nestedHiddenIndex(a.host.app).foldersChanged();
	await a.sync();
	const r2 = await b.sync();
	assert.equal(b.fs.text("Notes/.gitignore"), "p\n");
	const r3 = await b.sync();
	assert.ok(gh.headFiles().has("Notes/.gitignore"), "still in repo");
});

test("freeUpSpace: freed big file shows up as on-demand", async () => {
	const gh = new FakeGitHub();
	const a = device("Mac", gh);
	const phone = device("Phone", gh);
	a.fs.put("img/huge.png", "x".repeat(4000));
	a.fs.put("note.md", "n\n");
	await a.sync();
	let pinned = ["img/huge.png"];
	phone.host.deviceScope = () => ({ include: [], exclude: [], maxDownloadMB: 0.001, pinned });
	await phone.sync();
	assert.ok(phone.fs.files.has("img/huge.png"));
	pinned = [];
	await phone.sync();
	const plan = await phone.engine.freeUpSpace(async () => true);
	assert.deepEqual(plan.files, ["img/huge.png"]);
	const r = await phone.sync();
	assert.deepEqual(Object.keys(phone.host.state.remoteOnly), ["img/huge.png"]);
});

const body = Array.from({ length: 12 }, (_, i) => `line ${i} of the note with content`).join("\n") + "\n";

test("rename-merge + NotFastForward retry", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	const c = device("C", gh);
	a.fs.put("N.md", body);
	await a.sync();
	await b.sync();
	await c.sync();
	// B renames + edits
	b.fs.files.delete("N.md");
	b.fs.put("M.md", body.replace("line 0", "line ZERO"));
	await b.sync();
	// A edits old file elsewhere
	a.fs.put("N.md", body.replace("line 11", "line ELEVEN"));
	c.fs.put("other.md", "o\n");
	gh.interject = async () => { await c.sync(); };
	const r = await a.sync();
	assert.equal(r.conflictCopies.length, 0);
});

test("push mode keepRemote + NotFastForward retry", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	const c = device("C", gh);
	a.fs.put("N.md", "base\n");
	await a.sync(); await b.sync(); await c.sync();
	b.fs.put("N.md", "remote edit\n");
	await b.sync();
	a.fs.put("N.md", "local edit\n");
	c.fs.put("other.md", "o\n");
	gh.interject = async () => { await c.sync(); };
	const r = await a.sync("push");
	assert.equal([...gh.headFiles().keys()].filter((p) => p.includes("conflict") || p.includes("GitHub")).length, 1);
});

test("pull-mode device: repaired community-plugins.json conflicts on every remote change", async () => {
	const gh = new FakeGitHub();
	const opts = { syncConfigDir: true };
	const a = device("A", gh, opts);
	const b = device("B", gh, opts);
	a.fs.put(".obsidian/community-plugins.json", '["x"]');
	await a.sync();
	await b.sync("pull");
	await b.sync("pull");
	a.fs.put(".obsidian/community-plugins.json", '["x","y"]');
	await a.sync();
	const r = await b.sync("pull");
	assert.equal(r.conflictCopies.length, 0);
});

test("JSON name lists (plugin ids) merge as sets: additions on both sides kept, removals honoured", () => {
	const r = mergeJson('["a","b","c"]', '["a","b","c","mine"]', '["a","c","theirs"]');
	assert.ok(r?.clean);
	assert.deepEqual(JSON.parse(r!.text), ["a", "c", "mine", "theirs"]);
	// Lists with duplicates aren't sets: still a conflict, never silently merged.
	assert.equal(mergeJson('["a"]', '["a","a","x"]', '["a","y"]')?.clean ?? false, false);
});

test("LFS pointers with CRLF line endings or the legacy spec line are still pointers", () => {
	const oid = "a".repeat(64);
	const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
	assert.deepEqual(parsePointer(enc(`version https://git-lfs.github.com/spec/v1\r\noid sha256:${oid}\r\nsize 12345\r\n`)), { oid, size: 12345 });
	assert.deepEqual(parsePointer(enc(`version https://hawser.github.com/spec/v1\noid sha256:${oid}\nsize 7\n`)), { oid, size: 7 });
	assert.equal(parsePointer(enc("just a note\n")), null);
});
