import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec } from "../src/codec.ts";
import type { Layer } from "../src/codec.ts";
import { smartMerge } from "../src/smartmerge.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const incremental = (d: ReturnType<typeof device>) => {
	d.host.localChanges = () => ({ full: false, paths: new Set() });
	d.host.settings.fullScanMinutes = 60;
};

test("settings-folder conflict copy is recorded, so incremental syncs never delete it", async () => {
	const gh = new FakeGitHub();
	const opts = { syncConfigDir: true, conflictStrategy: "keep-both" as const };
	const a = device("A", gh, opts);
	const b = device("B", gh, opts);
	a.fs.put(".obsidian/snippets/s.css", "a{}\n");
	await a.sync();
	await b.sync();
	a.fs.put(".obsidian/snippets/s.css", "a{color:red}\n");
	await a.sync();
	b.fs.put(".obsidian/snippets/s.css", "a{color:blue}\n");
	const r1 = await b.sync();
	assert.equal(r1.conflictCopies.length, 1);
	const copy = r1.conflictCopies[0];
	assert.ok(b.host.state.cache[copy], "copy recorded in the cache");
	await a.sync();
	assert.equal(a.fs.text(copy), "a{color:blue}\n");

	incremental(b);
	const r2 = await b.sync();
	assert.deepEqual(r2.deletedRemote, []);
	assert.ok(gh.headFiles().has(copy));
	const ra = await a.sync();
	assert.deepEqual(ra.deletedLocal, []);
	assert.deepEqual(a.fs.trash, []);
});

test("a synced settings file missing from the reused cache is kept until the next disk walk", async () => {
	const gh = new FakeGitHub();
	const b = device("B", gh, { syncConfigDir: true });
	b.fs.put(".obsidian/snippets/x.css", "x{}\n");
	await b.sync();
	// Simulate an older version that never cached it.
	delete b.host.state.cache[".obsidian/snippets/x.css"];
	incremental(b);
	const r = await b.sync();
	assert.deepEqual(r.deletedRemote, []);
	assert.ok(gh.headFiles().has(".obsidian/snippets/x.css"));
	assert.ok(b.host.state.base[".obsidian/snippets/x.css"], "baseline kept");
});

test("push mode leaves remote edits for later: the next sync still pulls them", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("x.md", "v1\n");
	await a.sync();
	await b.sync();
	a.fs.put("x.md", "v2\n");
	await a.sync();
	b.fs.put("y.md", "new\n");
	await b.sync("push");
	const r = await b.sync("sync");
	assert.equal(r.upToDate, false);
	assert.equal(b.fs.text("x.md"), "v2\n");
});

test("'sync current file' then a normal sync still pulls other remote edits", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("x.md", "v1\n");
	a.fs.put("y.md", "y1\n");
	await a.sync();
	await b.sync();
	a.fs.put("x.md", "v2\n");
	await a.sync();
	b.fs.put("y.md", "y2\n");
	await b.engine.run("sync", { only: new Set(["y.md"]) });
	await b.sync();
	assert.equal(b.fs.text("x.md"), "v2\n");
});

test("delete guard 'skip' asks again next time instead of hiding the deletions", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh, { deleteGuardMin: 1, deleteGuardPercent: 0 });
	for (const n of ["1", "2", "3"]) a.fs.put(n + ".md", n);
	await a.sync();
	await b.sync();
	a.fs.files.delete("1.md");
	a.fs.files.delete("2.md");
	await a.sync();
	b.host.deleteChoice = "skip";
	await b.sync();
	assert.ok(b.fs.files.has("1.md"));
	b.host.deleteChoice = "proceed";
	const r = await b.sync();
	assert.equal(r.upToDate, false);
	assert.equal(b.calls.deletes, 2);
	assert.deepEqual(r.deletedLocal.sort(), ["1.md", "2.md"]);
});

test("reset to remote compares against the real remote listing", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("x.md", "a\nb\n");
	await a.sync();
	// Line-ending-only change: synced as unchanged, but a reset must restore the exact remote bytes.
	a.fs.put("x.md", "a\r\nb\r\n");
	await a.sync();
	const plan = await a.engine.resetToRemote(async () => true);
	assert.deepEqual(plan.overwrite, ["x.md"]);
	assert.equal(a.fs.text("x.md"), "a\nb\n");
});

test("moving a file out of this device's include scope keeps it in the repository", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.host.deviceScope = () => ({ include: ["Notes/"], exclude: [], maxDownloadMB: 0 });
	a.fs.put("Notes/x.md", "x\n");
	await a.sync();
	await b.sync();
	a.fs.files.set("Other/x.md", a.fs.files.get("Notes/x.md")!);
	a.fs.files.delete("Notes/x.md");
	const r = await a.sync();
	assert.deepEqual(r.deletedRemote, []);
	assert.ok(r.skipped.some((s) => s.startsWith("Notes/x.md (moved to Other/x.md")));
	assert.ok(gh.headFiles().has("Notes/x.md"));
	const rb = await b.sync();
	assert.deepEqual(rb.deletedLocal, []);
	assert.equal(b.fs.text("Notes/x.md"), "x\n");

	// A real deletion still reaches the repository.
	a.fs.put("Notes/y.md", "y\n");
	await a.sync();
	a.fs.files.delete("Notes/y.md");
	const r2 = await a.sync();
	assert.deepEqual(r2.deletedRemote, ["Notes/y.md"]);
});

for (const caseInsensitive of [false, true]) {
	test(`case-only rename on another device renames the local file (case-insensitive disk: ${caseInsensitive})`, async () => {
		const gh = new FakeGitHub();
		const a = device("A", gh);
		const b = device("B", gh);
		b.fs.caseInsensitive = caseInsensitive;
		a.fs.put("Note.md", "n\n");
		await a.sync();
		await b.sync();
		a.fs.files.set("note.md", a.fs.files.get("Note.md")!);
		a.fs.files.delete("Note.md");
		await a.sync();
		const rb = await b.sync();
		assert.deepEqual(rb.deletedLocal, []);
		assert.deepEqual(rb.errors, []);
		assert.deepEqual([...b.fs.files.keys()], ["note.md"]);
		assert.deepEqual(b.fs.trash, []);
		assert.ok(rb.renamed.includes("Note.md → note.md"));
		assert.ok(b.host.state.base["note.md"] && !b.host.state.base["Note.md"]);
		const again = await b.sync();
		assert.equal(again.upToDate, true);
	});
}

test("case-only rename elsewhere while the file was edited here: edit kept under the new name", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("Note.md", "n\n");
	await a.sync();
	await b.sync();
	a.fs.files.set("note.md", a.fs.files.get("Note.md")!);
	a.fs.files.delete("Note.md");
	await a.sync();
	b.fs.put("Note.md", "edited\n");
	const rb = await b.sync();
	assert.deepEqual(rb.deletedLocal, []);
	assert.deepEqual([...b.fs.files.keys()], ["note.md"]);
	assert.equal(b.fs.text("note.md"), "edited\n");
	assert.deepEqual([...gh.headFiles().keys()].filter((k) => k.endsWith(".md")), ["note.md"]);
	assert.equal(gh.headFiles().get("note.md"), "edited\n");
});

test("a genuine case clash is still skipped, and nothing is deleted", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("Note.md", "1\n");
	a.fs.put("note.md", "2\n");
	await a.sync();
	const rb = await b.sync();
	assert.ok(rb.skipped.some((s) => s.includes("differs only by letter case from")));
	assert.equal(b.fs.files.size, 1);
});

test("same name in NFC (remote) and NFD (local) is one file: no duplicate upload", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	const nfc = "café.md".normalize("NFC");
	const nfd = "café.md".normalize("NFD");
	a.fs.put(nfc, "x\n");
	await a.sync();
	b.fs.put(nfd, "x\n");
	const r = await b.sync();
	assert.deepEqual(r.uploaded, []);
	assert.deepEqual(r.skipped, []);
	const remoteMd = [...gh.headFiles().keys()].filter((k) => k.endsWith(".md"));
	assert.deepEqual(remoteMd, [nfc]);

	// Edits flow both ways under each device's own spelling.
	b.fs.put(nfd, "from B\n");
	const r2 = await b.sync();
	assert.deepEqual(r2.uploaded, [nfd]);
	assert.deepEqual([...gh.headFiles().keys()].filter((k) => k.endsWith(".md")), [nfc]);
	await a.sync();
	assert.equal(a.fs.text(nfc), "from B\n");
	a.fs.put(nfc, "from A\n");
	await a.sync();
	await b.sync();
	assert.equal(b.fs.text(nfd), "from A\n");
	assert.equal(b.fs.files.size, 1);
});

test("JSON merge falls back to the line merge for big integers and __proto__ keys", () => {
	const big = (a: number, b: number) => `{"id": 12345678901234567890, "a": ${a}, "b": ${b}}\n`;
	const m = smartMerge("x.json", big(1, 1), big(2, 1), big(1, 2));
	assert.equal(m, null);
	const proto = (a: number) => `{"__proto__": {"x": 1}, "a": ${a}, "b": 1}\n`;
	assert.equal(smartMerge("x.json", proto(1), proto(2), '{"__proto__": {"x": 1}, "a": 1, "b": 2}\n'), null);
	// Big numbers inside strings and ordinary numbers still merge by key.
	const ok = smartMerge("x.json", '{"id": "12345678901234567890", "a": 1.5, "b": 1}\n', '{"id": "12345678901234567890", "a": 2, "b": 1}\n', '{"id": "12345678901234567890", "a": 1.5, "b": 2}\n');
	assert.ok(ok?.clean);
	assert.deepEqual(JSON.parse(ok.text), { id: "12345678901234567890", a: 2, b: 2 });
});

test("a line-ending-only change is not shown as pending after it synced", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("x.md", "a\nb\n");
	await a.sync();
	a.fs.put("x.md", "a\r\nb\r\n");
	await a.sync();
	assert.deepEqual(a.engine.quickLocalPending(), []);
});

test("encryption toggled during a sync doesn't switch the codec of that sync", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const flip: Layer = {
		id: "test:",
		transformsContent: true,
		encode: async (_p, d) => new Uint8Array(new Uint8Array(d).map((x) => x ^ 1)).buffer,
		decode: async (_p, d) => new Uint8Array(new Uint8Array(d).map((x) => x ^ 1)).buffer,
	};
	a.host.codec = () => new Codec();
	let switched = false;
	a.host.progress = () => {
		if (switched) return;
		switched = true;
		a.host.codec = () => new Codec([flip]);
		a.engine.quickLocalPending(); // a UI refresh while the sync runs
	};
	a.fs.put("x.md", "plain\n");
	await a.sync();
	assert.equal(gh.headFiles().get("x.md"), "plain\n");
});

test("a file moved out of scope stays in the repository on every later sync, not just the first", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.host.deviceScope = () => ({ include: ["Notes/"], exclude: [], maxDownloadMB: 0 });
	a.fs.put("Notes/plan.md", "the plan\n");
	await a.sync();
	await b.sync();
	a.fs.files.set("Archive/plan.md", a.fs.files.get("Notes/plan.md")!);
	a.fs.files.delete("Notes/plan.md");
	for (let i = 0; i < 4; i++) {
		a.fs.put(`Notes/other${i}.md`, `${i}\n`); // unrelated edits keep the syncs non-trivial
		const r = await a.sync();
		assert.deepEqual(r.deletedRemote, [], `sync ${i + 1} must not delete it`);
	}
	assert.ok(gh.headFiles().has("Notes/plan.md"));
	assert.deepEqual((await b.sync()).deletedLocal, []);
	assert.equal(b.fs.text("Notes/plan.md"), "the plan\n");
	assert.equal((await a.sync()).upToDate, true, "and the quick 'nothing changed' path still works");
});

test("an empty file elsewhere is never taken as the moved copy", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.host.deviceScope = () => ({ include: ["Notes/"], exclude: [], maxDownloadMB: 0 });
	a.fs.put("Notes/Untitled.md", "");
	a.fs.put("Archive/old.md", "");
	await a.sync();
	a.fs.files.delete("Notes/Untitled.md");
	const r = await a.sync();
	assert.deepEqual(r.deletedRemote, ["Notes/Untitled.md"], "a real deletion of an empty note");
});

test("case rename never strands or overwrites a separate file with the new spelling (case-sensitive disk)", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("note.md", "lower\n");
	await a.sync();
	await b.sync();
	b.fs.put("Note.md", "a different file on B\n"); // B's disk is case-sensitive: two files
	// A renames note.md → Note.md by case only.
	a.fs.files.set("Note.md", a.fs.files.get("note.md")!);
	a.fs.files.delete("note.md");
	await a.sync();
	await b.sync().catch(() => undefined);
	const names = [...b.fs.files.keys()].filter((p) => p.endsWith(".md") || p.includes(".renaming"));
	assert.ok(!names.some((p) => p.includes(".renaming")), "no temporary file left behind");
	assert.ok(names.includes("Note.md"), "B's own Note.md still there");
	const texts = names.map((p) => b.fs.text(p));
	assert.ok(texts.includes("a different file on B\n") && texts.includes("lower\n"), "both contents kept");
});
