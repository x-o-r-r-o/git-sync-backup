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

test("shared folder mapped to a subfolder of the repository: only that subfolder is touched", async () => {
	const { Codec, PrefixLayer } = await import("../src/codec.ts");
	const gh = new FakeGitHub();
	const owner = device("Owner", gh);
	owner.fs.put("README.md", "repo readme\n");
	owner.fs.put("docs/guide.md", "guide\n");
	await owner.sync();
	const a = device("A", gh);
	a.host.codec = () => new Codec([new PrefixLayer("Work", "docs")]);
	a.host.deviceScope = () => ({ include: ["/Work/"], exclude: [], maxDownloadMB: 0 });
	a.fs.put("Private.md", "never shared\n");
	await a.sync();
	assert.equal(a.fs.text("Work/guide.md"), "guide\n", "docs/ appears as Work/");
	assert.ok(!a.fs.files.has("Work/README.md") && !a.fs.files.has("README.md"), "files outside docs/ are ignored");
	a.fs.put("Work/new.md", "new\n");
	await a.sync();
	const remote = gh.headFiles();
	assert.equal(remote.get("docs/new.md"), "new\n");
	assert.equal(remote.get("README.md"), "repo readme\n", "untouched");
	assert.ok(!remote.has("Private.md") && !remote.has("Work/new.md"));
});

test("empty folders travel between devices, and are removed only while still empty", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("note.md", "n\n");
	await a.sync();
	await b.sync();
	a.fs.dirs.add("Projects/Empty");
	await a.sync();
	assert.match(gh.headFiles().get(".vault-sync/folders.json") ?? "", /Projects\/Empty/);
	await b.sync();
	assert.ok(b.fs.dirs.has("Projects/Empty"), "created on the other device");
	assert.equal((await b.sync()).upToDate, true, "and then nothing to do");

	// A deletes the folder: B removes its empty copy.
	a.fs.dirs.delete("Projects/Empty");
	await a.sync();
	assert.doesNotMatch(gh.headFiles().get(".vault-sync/folders.json") ?? "", /Projects\/Empty/);
	await b.sync();
	assert.ok(!b.fs.dirs.has("Projects/Empty"), "removed while empty");

	// A folder that gained a file on B is never removed.
	a.fs.dirs.add("Keep");
	await a.sync();
	await b.sync();
	b.fs.put("Keep/new.md", "x\n");
	a.fs.dirs.delete("Keep");
	await a.sync();
	await b.sync();
	assert.equal(b.fs.text("Keep/new.md"), "x\n");
});

test("make the repository match this device: one forward commit, on-demand files untouched", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("keep.md", "same\n");
	a.fs.put("edit.md", "old\n");
	a.fs.put("gone.md", "remove me\n");
	a.fs.put("big.bin", "x".repeat(4000));
	await a.sync();
	b.host.deviceScope = () => ({ include: [], exclude: [], maxDownloadMB: 0.001 });
	await b.sync(); // big.bin stays on demand on B
	b.fs.put("edit.md", "B's version\n");
	b.fs.files.delete("gone.md");
	b.fs.put("new.md", "new\n");
	const before = gh.refs.get("main");
	const plan = await b.engine.overwriteRemote(async () => true);
	assert.deepEqual(plan.upload.sort(), ["edit.md", "new.md"]);
	assert.deepEqual(plan.remove, ["gone.md"]);
	const files = gh.headFiles();
	assert.equal(files.get("edit.md"), "B's version\n");
	assert.ok(!files.has("gone.md") && files.has("new.md") && files.has("keep.md"));
	assert.ok(files.has("big.bin"), "on-demand file left alone");
	assert.notEqual(gh.refs.get("main"), before);
	assert.deepEqual((await b.engine.overwriteRemote(async () => true)).upload, [], "nothing left to do");
	await a.sync();
	assert.equal(a.fs.text("edit.md"), "B's version\n");
	assert.ok(!a.fs.files.has("gone.md"));
});

test("team flow: a conflict goes to a branch with a pull request instead of a copy", async () => {
	const gh = new FakeGitHub() as FakeGitHub & { createPullRequest?: unknown };
	const prs: { head: string; base: string; title: string }[] = [];
	gh.createPullRequest = async (head: string, base: string, title: string) => {
		prs.push({ head, base, title });
		return { url: "https://host.test/pr/1" };
	};
	const a = device("A", gh);
	const b = device("B", gh);
	b.host.conflictsAsPullRequest = () => true;
	a.fs.put("team.md", "same\n");
	await a.sync();
	await b.sync();
	a.fs.put("team.md", "from A\n");
	b.fs.put("team.md", "from B\n");
	await a.sync();
	const r = await b.sync();
	assert.deepEqual(r.conflictCopies, [], "no conflict copy");
	assert.deepEqual(r.pullRequests, ["https://host.test/pr/1"]);
	assert.equal(prs.length, 1);
	assert.equal(prs[0].base, "main");
	assert.match(prs[0].head, /^vault-sync\/conflict-b-/);
	// The branch holds B's version; main and B's note hold A's.
	const branchHead = gh.refs.get(prs[0].head)!;
	const branchTree = gh.trees.get(gh.commits.get(branchHead)!.tree)!;
	assert.equal(new TextDecoder().decode(gh.blobs.get(branchTree.get("team.md")!.sha)!), "from B\n");
	assert.equal(b.fs.text("team.md"), "from A\n");
	assert.equal(gh.headFiles().get("team.md"), "from A\n");
	assert.equal((await b.sync()).upToDate, true);

	// When the pull request can't be opened, it falls back to a conflict copy (nothing lost).
	gh.createPullRequest = async () => {
		throw new Error("no permission");
	};
	a.fs.put("team.md", "A again\n");
	b.fs.put("team.md", "B again\n");
	await a.sync();
	const r2 = await b.sync();
	assert.equal(r2.conflictCopies.length, 1);
	assert.equal(b.fs.text(r2.conflictCopies[0]), "B again\n");
});

test("Windows: a rename elsewhere to a name Windows can't store keeps the note here", async () => {
	const gh = new FakeGitHub();
	const mac = device("Mac", gh);
	const win = device("Win", gh);
	win.host.windows = true;
	mac.fs.put("Meeting.md", "notes\n");
	await mac.sync();
	await win.sync();
	mac.fs.files.set("Meeting: notes.md", mac.fs.files.get("Meeting.md")!);
	mac.fs.files.delete("Meeting.md");
	await mac.sync();
	const r = await win.sync();
	assert.deepEqual(r.deletedLocal, [], "not trashed");
	assert.equal(win.fs.text("Meeting.md"), "notes\n");
	assert.ok(r.skipped.some((x) => x.startsWith("Meeting: notes.md")));
	assert.ok(gh.headFiles().has("Meeting: notes.md"), "the repository keeps the new name");
	assert.ok(!gh.headFiles().has("Meeting.md"), "and Windows doesn't push the old one back");
});

test("empty folders: the list survives a failed push, can be updated on create-or-update hosts, and keeps other devices' entries", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("n.md", "n\n");
	a.fs.dirs.add("One");
	await a.sync();
	// A push that fails once (another device pushed): the new folder must still be listed afterwards.
	a.fs.dirs.add("Two");
	const realCommit = gh.commit.bind(gh);
	let failOnce = true;
	gh.commit = async (req: Parameters<typeof realCommit>[0]) => {
		if (failOnce) {
			failOnce = false;
			throw new Error("network down");
		}
		assert.ok((req.existing as Map<string, string>).has(".vault-sync/folders.json"), "the list is known to exist (update, not create)");
		return realCommit(req);
	};
	await a.sync().catch(() => undefined);
	await a.sync();
	assert.match(gh.headFiles().get(".vault-sync/folders.json") ?? "", /"Two"/);
	assert.ok(a.fs.dirs.has("Two"), "not removed locally after the failed attempt");
	// A phone that only syncs Notes/ must not drop A's folders from the list.
	gh.commit = realCommit;
	const phone = device("Phone", gh);
	phone.host.deviceScope = () => ({ include: ["Notes/"], exclude: [], maxDownloadMB: 0 });
	phone.fs.dirs.add("Notes/Empty");
	await phone.sync();
	const list = gh.headFiles().get(".vault-sync/folders.json") ?? "";
	assert.match(list, /"One"/);
	assert.match(list, /"Notes\/Empty"/);
});

test("empty folders: a push-only device keeps other devices' folders; a name Windows can't create doesn't block anything", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("n.md", "n\n");
	a.fs.dirs.add("FromA");
	a.fs.dirs.add("Q?");
	await a.sync();
	const backup = device("Backup", gh);
	await backup.sync("push");
	backup.fs.put("b.md", "b\n");
	await backup.sync("push");
	await backup.sync("push");
	const list = gh.headFiles().get(".vault-sync/folders.json") ?? "";
	assert.match(list, /"FromA"/, "a push-only device never drops folders it doesn't have");

	const win = device("Win", gh);
	win.host.windows = true;
	win.fs.dirs.add("Mine");
	await win.sync();
	assert.ok(win.fs.dirs.has("FromA") && !win.fs.dirs.has("Q?"), "creatable folders made, the other skipped");
	assert.match(gh.headFiles().get(".vault-sync/folders.json") ?? "", /"Mine"/, "its own folders still uploaded");
	assert.equal((await win.sync()).upToDate, true, "and the quick path works again");
});

test("Windows: renamed and edited elsewhere to a name Windows can't store: the old note is kept, not trashed", async () => {
	const gh = new FakeGitHub();
	const mac = device("Mac", gh);
	const win = device("Win", gh);
	win.host.windows = true;
	mac.fs.put("Notes/Meeting.md", "notes\n");
	await mac.sync();
	await win.sync();
	mac.fs.files.delete("Notes/Meeting.md");
	mac.fs.put("Notes/Meeting: notes.md", "notes, edited\n");
	await mac.sync();
	const r = await win.sync();
	assert.deepEqual(r.deletedLocal, []);
	assert.equal(win.fs.text("Notes/Meeting.md"), "notes\n");
});

test("Windows: a name seen before doesn't block later deletions in its folder; the kept note stays kept", async () => {
	const gh = new FakeGitHub();
	const mac = device("Mac", gh);
	const win = device("Win", gh);
	win.host.windows = true;
	mac.fs.put("Notes/Meeting.md", "notes\n");
	mac.fs.put("Notes/Other.md", "other\n");
	await mac.sync();
	await win.sync();
	mac.fs.files.delete("Notes/Meeting.md");
	mac.fs.put("Notes/Meeting: notes.md", "notes, edited\n");
	await mac.sync();
	await win.sync();
	// Later, an unrelated note in the same folder is deleted elsewhere: Windows follows.
	mac.fs.files.delete("Notes/Other.md");
	await mac.sync();
	const r = await win.sync();
	assert.deepEqual(r.deletedLocal, ["Notes/Other.md"]);
	assert.equal(win.fs.text("Notes/Meeting.md"), "notes\n", "the possibly renamed note is still kept");
});
