// 1.5.0 engine changes: push-only mode keeps the repository's edit as a conflict copy (not for the
// backup mirror), template-aware rename detection, and the cached folder walk for nested hidden files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, FakeFS, device } from "./support/fakes.ts";
import { decide, templateLines, coreSimilarity } from "../src/plan.ts";
import { VaultIO, nestedHiddenIndex, NESTED_WALK_MS } from "../src/io.ts";

// ---- 6. push-only mode keeps both ----

function pushConflict(backupMirror = false) {
	const gh = new FakeGitHub();
	const a = device("Laptop", gh);
	const b = device("Phone", gh);
	if (backupMirror) a.host.backupMirror = true;
	return { gh, a, b };
}

test("push only: changed here and in the repository: the repository's version is kept as a conflict copy, this device's version uploaded", async () => {
	const { gh, a, b } = pushConflict();
	a.fs.put("Notes/plan.md", "v1\n");
	await a.sync();
	await b.sync();
	b.fs.put("Notes/plan.md", "v1\nfrom the phone\n");
	await b.sync();
	a.fs.put("Notes/plan.md", "v1\nfrom the laptop\n");
	const r = await a.sync("push");
	// The local file itself is never modified in push mode.
	assert.equal(a.fs.text("Notes/plan.md"), "v1\nfrom the laptop\n");
	assert.equal(r.conflictCopies.length, 1);
	const copy = r.conflictCopies[0];
	assert.match(copy, /^Notes\/plan \(conflict GitHub \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
	assert.equal(a.fs.text(copy), "v1\nfrom the phone\n", "the repository's edit is kept here");
	const head = gh.headFiles();
	assert.equal(head.get("Notes/plan.md"), "v1\nfrom the laptop\n");
	assert.equal(head.get(copy), "v1\nfrom the phone\n", "the copy is uploaded too, so every device sees both");
	// Nothing left over: the next push has nothing to do, and the other device gets both files.
	const again = await a.sync("push");
	assert.equal(again.conflictCopies.length, 0);
	assert.deepEqual(again.uploaded, []);
	await b.sync();
	assert.equal(b.fs.text("Notes/plan.md"), "v1\nfrom the laptop\n");
	assert.equal(b.fs.text(copy), "v1\nfrom the phone\n");
});

test("push only, backup mirror: the mirror's own edit is overwritten and never copied into the vault", async () => {
	const { gh, a, b } = pushConflict(true);
	a.fs.put("plan.md", "v1\n");
	await a.sync("push");
	await b.sync();
	b.fs.put("plan.md", "v1\nedited in the mirror\n");
	await b.sync();
	a.fs.put("plan.md", "v1\nfrom the laptop\n");
	const before = [...a.fs.files.keys()].sort();
	const r = await a.sync("push");
	assert.deepEqual(r.conflictCopies, []);
	assert.deepEqual([...a.fs.files.keys()].sort(), before, "no file written into the vault");
	assert.equal(a.fs.text("plan.md"), "v1\nfrom the laptop\n");
	assert.equal(gh.headFiles().get("plan.md"), "v1\nfrom the laptop\n");
});

test("decide, push mode: both changed gives an upload that keeps the remote version only when asked; a local deletion still never wins over a remote edit", () => {
	const base = { "a.md": "b", "gone.md": "b" };
	const local = new Map([["a.md", "l"]]);
	const remote = new Map([["a.md", "r"], ["gone.md", "r2"]]);
	const kept = decide(base, local, remote, "push", undefined, { pushKeepsRemote: true });
	assert.deepEqual(kept.decisions, [{ kind: "upload", path: "a.md", sha: "l", keepRemote: "r" }]);
	assert.equal(kept.settled["gone.md"], "b", "deleted here, edited there: left alone");
	const mirror = decide(base, local, remote, "push");
	assert.deepEqual(mirror.decisions, [{ kind: "upload", path: "a.md", sha: "l" }]);
	// Only remote changed: still ignored in push mode, nothing copied.
	const quiet = decide({ "a.md": "b" }, new Map([["a.md", "b"]]), new Map([["a.md", "r"]]), "push", undefined, { pushKeepsRemote: true });
	assert.deepEqual(quiet.decisions, []);
});

// ---- 7. template-aware rename detection ----

const TEMPLATE = Array.from({ length: 15 }, (_, i) => `Template field ${i + 1}: ...`).join("\n") + "\n";
const move = (fs: FakeFS, from: string, to: string) => {
	fs.files.set(to, fs.files.get(from)!);
	fs.files.delete(from);
};

test("rich template: a deleted template-only note and a new note from the same template are not paired when the other device edited the old note", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("Meetings/alpha.md", TEMPLATE + "Met Alex about the budget.\n");
	a.fs.put("Meetings/beta.md", TEMPLATE + "Called Bea, project is late.\n");
	a.fs.put("Meetings/old.md", TEMPLATE);
	await a.sync();
	await b.sync();
	const edited = TEMPLATE + "Notes from B: renew the lease by Friday.\n";
	b.fs.put("Meetings/old.md", edited);
	await b.sync();
	a.fs.files.delete("Meetings/old.md");
	const fresh = TEMPLATE + "New meeting with Chen.\nAgreed on the scope.\n";
	a.fs.put("Meetings/new.md", fresh);
	const r = await a.sync();
	assert.deepEqual(r.renamed, []);
	assert.deepEqual(r.merged, []);
	// Edit beats delete: B's notes stay in the old note; the new note is just the new note.
	assert.equal(a.fs.text("Meetings/old.md"), edited);
	assert.equal(a.fs.text("Meetings/new.md"), fresh);
	assert.equal(gh.headFiles().get("Meetings/old.md"), edited);
	assert.equal(gh.headFiles().get("Meetings/new.md"), fresh);
});

test("rich template: a real note renamed and edited next to its template siblings is still paired when the other device edited it", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	const own = Array.from({ length: 10 }, (_, i) => `Own line ${i + 1}`).join("\n") + "\n";
	a.fs.put("Meetings/alpha.md", TEMPLATE + "Met Alex about the budget.\n");
	a.fs.put("Meetings/beta.md", TEMPLATE + "Called Bea, project is late.\n");
	a.fs.put("Meetings/draft.md", TEMPLATE + own);
	await a.sync();
	await b.sync();
	b.fs.put("Meetings/draft.md", TEMPLATE + own + "Added by B\n");
	await b.sync();
	move(a.fs, "Meetings/draft.md", "Meetings/final.md");
	a.fs.put("Meetings/final.md", TEMPLATE + own.replace("Own line 1\n", "Own line 1 (A)\n"));
	const r = await a.sync();
	assert.ok(r.renamed.some((x) => x.startsWith("Meetings/draft.md → Meetings/final.md")), r.renamed.join(", "));
	const want = TEMPLATE + own.replace("Own line 1\n", "Own line 1 (A)\n") + "Added by B\n";
	assert.equal(a.fs.text("Meetings/final.md"), want);
	assert.ok(!a.fs.files.has("Meetings/draft.md"));
	assert.equal(gh.headFiles().get("Meetings/final.md"), want);
});

test("templateLines / coreSimilarity: lines common to nearby notes are ignored", () => {
	const t = templateLines([TEMPLATE + "x one\n", TEMPLATE + "y two\n", TEMPLATE + "z three\n"]);
	assert.equal(t.size, 15);
	assert.equal(coreSimilarity(TEMPLATE, TEMPLATE + "fresh\n", t).shared, 0);
	const c = coreSimilarity(TEMPLATE + "a\nb\nc\nd\n", TEMPLATE + "a\nb\nc\nd (edited)\n", t);
	assert.equal(c.shared, 3);
	assert.equal(c.score, 3 / 5);
	assert.equal(templateLines([]).size, 0);
});

// ---- 5. cached walk for nested hidden files ----

function countingIO() {
	const fs = new FakeFS();
	fs.put("A/note.md", "a");
	fs.put("A/.gitignore", "*.log\n");
	fs.put("B/note.md", "b");
	const app = fs.app();
	const lists: string[] = [];
	const orig = app.vault.adapter.list;
	app.vault.adapter.list = async (dir: string) => {
		lists.push(dir);
		return orig(dir);
	};
	return { fs, app, io: new VaultIO(app), lists, idx: nestedHiddenIndex(app) };
}
const only = new Set([".gitignore"]);

test("nested hidden scan: no folder walk when nothing changed and it isn't due; known .gitignore files are still re-read", async () => {
	const { fs, io, lists, idx } = countingIO();
	const first = await io.listNestedHidden(() => true, only);
	assert.deepEqual(first.map((f) => f.path), ["A/.gitignore"]);
	assert.equal(idx.walks, 1);
	assert.ok(lists.length >= 2, "first call lists every folder");
	lists.length = 0;
	fs.put("A/.gitignore", "*.log\n*.tmp\n");
	fs.put("B/.gitignore", "new\n");
	const second = await io.listNestedHidden(() => true, only);
	assert.deepEqual(lists, [], "no folder listed");
	assert.equal(idx.walks, 1);
	assert.deepEqual(second.map((f) => [f.path, f.size]), [["A/.gitignore", "*.log\n*.tmp\n".length]], "the known file is fresh; a new one waits for the next walk");
	// A known file removed is noticed without a walk (it must not linger as present).
	fs.files.delete("A/.gitignore");
	assert.deepEqual(await io.listNestedHidden(() => true, only), []);
	assert.equal(idx.walks, 1);
});

test("nested hidden scan: a folder created or renamed makes the next request walk again", async () => {
	const { fs, io, idx } = countingIO();
	await io.listNestedHidden(() => true, only);
	fs.put("New/.gitignore", "x\n");
	idx.foldersChanged();
	const found = await io.listNestedHidden(() => true, only);
	assert.equal(idx.walks, 2);
	assert.deepEqual(found.map((f) => f.path).sort(), ["A/.gitignore", "New/.gitignore"]);
	await io.listNestedHidden(() => true, only);
	assert.equal(idx.walks, 2, "once is enough");
});

test("nested hidden scan: a full scan walks again (sharing a walk that just ran), and so does the 30-minute limit", async () => {
	const { fs, io, idx } = countingIO();
	await io.listNestedHidden(() => true, only, { full: true });
	assert.equal(idx.walks, 1);
	// The .gitignore loader and the sync's own scan in one sync: one walk.
	await io.listNestedHidden(() => true, only, { full: true });
	assert.equal(idx.walks, 1);
	const realNow = Date.now;
	try {
		const t0 = realNow();
		Date.now = () => t0 + 2 * 60_000;
		fs.put("B/.gitignore", "y\n");
		await io.listNestedHidden(() => true, only);
		assert.equal(idx.walks, 1, "not a full scan and not due yet");
		const full = await io.listNestedHidden(() => true, only, { full: true });
		assert.equal(idx.walks, 2);
		assert.deepEqual(full.map((f) => f.path).sort(), ["A/.gitignore", "B/.gitignore"]);
		Date.now = () => t0 + 2 * 60_000 + NESTED_WALK_MS + 1000;
		await io.listNestedHidden(() => true, only);
		assert.equal(idx.walks, 3, "due after 30 minutes without events");
	} finally {
		Date.now = realNow;
	}
});

test("nested hidden scan: hidden folders inside normal folders are re-walked every time, the folder walk is not", async () => {
	const { fs, io, idx, lists } = countingIO();
	fs.put("A/.assets/one.png", "1");
	assert.deepEqual((await io.listNestedHidden(() => true)).map((f) => f.path).sort(), ["A/.assets/one.png", "A/.gitignore"]);
	lists.length = 0;
	fs.put("A/.assets/two.png", "2");
	const again = await io.listNestedHidden(() => true);
	assert.deepEqual(again.map((f) => f.path).sort(), ["A/.assets/one.png", "A/.assets/two.png", "A/.gitignore"]);
	assert.deepEqual(lists, ["A/.assets"], "only the known hidden folder is listed");
	assert.equal(idx.walks, 1);
});

test("sync engine: two syncs in a row share one folder walk; a folder event triggers the next", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { useGitignore: true });
	a.fs.put("Project/.gitignore", "*.log\n");
	a.fs.put("Project/note.md", "n");
	await a.sync();
	await a.sync();
	const idx = nestedHiddenIndex(a.host.app);
	assert.equal(idx.walks, 1);
	a.fs.put("Other/.gitignore", "*.tmp\n");
	idx.foldersChanged();
	await a.sync();
	assert.equal(idx.walks, 2);
	assert.ok(gh.headFiles().has("Other/.gitignore"));
});
