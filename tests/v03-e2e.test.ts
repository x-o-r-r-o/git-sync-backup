import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, device } from "./support/fakes.ts";

function pair(overrides = {}) {
	const gh = new FakeGitHub();
	const a = device("A", gh, overrides), b = device("B", gh, overrides);
	if (process.env.VSG_DEBUG) { a.host.log = (m) => console.log("A:", m); b.host.log = (m) => console.log("B:", m); }
	return { gh, a, b };
}
const countBlobs = (gh: FakeGitHub) => {
	let n = 0;
	const orig = gh.getBlob.bind(gh);
	gh.getBlob = async (sha: string) => {
		n++;
		return orig(sha);
	};
	return () => n;
};
const rename = (fs: { files: Map<string, unknown> }, from: string, to: string) => {
	fs.files.set(to, fs.files.get(from)!);
	fs.files.delete(from);
};

test("rename on one device is applied as a rename on the other (no re-download)", async () => {
	const { gh, a, b } = pair();
	a.fs.put("Inbox/idea.md", "big idea\n");
	await a.sync();
	await b.sync();
	rename(a.fs, "Inbox/idea.md", "Projects/idea.md");
	const ra = await a.sync();
	assert.deepEqual(ra.renamed, ["Inbox/idea.md → Projects/idea.md"]);
	assert.match(gh.commits.get(gh.refs.get("main")!)!.message, /^A: 1 renamed/);
	const blobs = countBlobs(gh);
	const rb = await b.sync();
	assert.deepEqual(rb.renamed, ["Inbox/idea.md → Projects/idea.md"]);
	assert.equal(blobs(), 0, "no download needed");
	assert.equal(b.fs.text("Projects/idea.md"), "big idea\n");
	assert.ok(!b.fs.files.has("Inbox/idea.md"));
	assert.equal((await b.sync()).upToDate, true);
});

test("folder rename does not trigger the delete guard", async () => {
	const { a, b } = pair({ deleteGuardMin: 3, deleteGuardPercent: 10 });
	for (let i = 0; i < 20; i++) a.fs.put(`Old/n${i}.md`, `${i}\n`);
	await a.sync();
	await b.sync();
	for (let i = 0; i < 20; i++) rename(a.fs, `Old/n${i}.md`, `New/n${i}.md`);
	await a.sync();
	assert.equal(a.calls.deletes, 0);
	await b.sync();
	assert.equal(b.calls.deletes, 0);
	assert.equal(b.fs.text("New/n7.md"), "7\n");
	assert.ok(![...b.fs.files.keys()].some((p) => p.startsWith("Old/")));
});

test("renamed here + edited on GitHub: the edit lands under the new name, no duplicate", async () => {
	const { gh, a, b } = pair();
	a.fs.put("draft.md", "v1\n");
	await a.sync();
	await b.sync();
	b.fs.put("draft.md", "v1 edited on B\n");
	await b.sync();
	rename(a.fs, "draft.md", "final.md");
	const r = await a.sync();
	assert.equal(r.renamed.length, 1);
	assert.equal(a.fs.text("final.md"), "v1 edited on B\n");
	assert.ok(!a.fs.files.has("draft.md"));
	const head = gh.headFiles();
	assert.ok(!head.has("draft.md"));
	assert.equal(head.get("final.md"), "v1 edited on B\n");
	await b.sync();
	assert.equal(b.fs.text("final.md"), "v1 edited on B\n");
	assert.ok(!b.fs.files.has("draft.md"));
});

test("renamed on GitHub + edited here: the edit moves to the new name", async () => {
	const { gh, a, b } = pair();
	a.fs.put("draft.md", "v1\n");
	await a.sync();
	await b.sync();
	rename(b.fs, "draft.md", "final.md");
	await b.sync();
	a.fs.put("draft.md", "v1 edited on A\n");
	const r = await a.sync();
	assert.equal(r.renamed.length, 1);
	assert.equal(a.fs.text("final.md"), "v1 edited on A\n");
	assert.ok(!a.fs.files.has("draft.md"));
	assert.equal(gh.headFiles().get("final.md"), "v1 edited on A\n");
	assert.ok(!gh.headFiles().has("draft.md"));
});

test("canvas edited on two devices merges node by node", async () => {
	const { a, b } = pair();
	const c = (nodes: object[]) => JSON.stringify({ nodes, edges: [] }, null, "\t");
	a.fs.put("Board.canvas", c([{ id: "1", text: "start", x: 0, y: 0 }]));
	await a.sync();
	await b.sync();
	a.fs.put("Board.canvas", c([{ id: "1", text: "start", x: 100, y: 0 }, { id: "2", text: "from A" }]));
	b.fs.put("Board.canvas", c([{ id: "1", text: "start", x: 0, y: 0 }, { id: "3", text: "from B" }]));
	await a.sync();
	const r = await b.sync();
	assert.deepEqual(r.merged, ["Board.canvas"]);
	assert.equal(r.conflictCopies.length, 0);
	const nodes = JSON.parse(b.fs.text("Board.canvas")!).nodes;
	assert.deepEqual(nodes.map((n: { id: string }) => n.id).sort(), ["1", "2", "3"]);
	assert.equal(nodes.find((n: { id: string }) => n.id === "1").x, 100);
});

test("frontmatter tags added on two devices merge instead of conflicting", async () => {
	const { a, b } = pair();
	a.fs.put("n.md", "---\ntags:\n  - x\n---\nBody\n");
	await a.sync();
	await b.sync();
	a.fs.put("n.md", "---\ntags:\n  - x\n  - from-a\n---\nBody\n");
	b.fs.put("n.md", "---\ntags:\n  - x\n  - from-b\n---\nBody\n");
	await a.sync();
	const r = await b.sync();
	assert.equal(r.conflictCopies.length, 0);
	assert.equal(b.fs.text("n.md"), "---\ntags:\n  - x\n  - from-b\n  - from-a\n---\nBody\n");
});

test("device scope: include-only folders; other folders untouched both ways", async () => {
	const { gh, a, b } = pair();
	a.fs.put("Work/w.md", "w\n");
	a.fs.put("Personal/p.md", "p\n");
	await a.sync();
	b.host.deviceScope = () => ({ include: ["Work/"], exclude: [], maxDownloadMB: 0 });
	b.fs.put("Personal/local-only.md", "stays here\n");
	await b.sync();
	assert.equal(b.fs.text("Work/w.md"), "w\n");
	assert.ok(!b.fs.files.has("Personal/p.md"), "not downloaded");
	assert.ok(!gh.headFiles().has("Personal/local-only.md"), "not uploaded");
	assert.ok(gh.headFiles().has("Personal/p.md"), "never deleted remotely");
});

test("device scope: download size limit skips big remote files without deleting them", async () => {
	const { gh, a, b } = pair();
	a.fs.put("img/huge.png", "x".repeat(3000));
	a.fs.put("n.md", "n\n");
	await a.sync();
	b.host.deviceScope = () => ({ include: [], exclude: [], maxDownloadMB: 0.001 }); // ~1 KB
	const r = await b.sync();
	assert.ok(!b.fs.files.has("img/huge.png"));
	assert.ok(r.skipped.some((s) => s.includes("download limit")));
	b.fs.put("other.md", "o\n");
	await b.sync();
	assert.ok(gh.headFiles().has("img/huge.png"));
});

test("free up space removes only local copies that are safe on GitHub", async () => {
	const { gh, a } = pair();
	a.fs.put("Archive/old.md", "old\n");
	a.fs.put("Archive/unsynced.md", "x\n");
	a.fs.put("Keep/k.md", "k\n");
	await a.sync();
	a.fs.put("Archive/unsynced.md", "changed locally, not on GitHub\n");
	a.host.deviceScope = () => ({ include: [], exclude: ["Archive/"], maxDownloadMB: 0 });
	const plan = await a.engine.freeUpSpace(async () => true);
	assert.deepEqual(plan.files, ["Archive/old.md"]);
	assert.ok(!a.fs.files.has("Archive/old.md"));
	assert.ok(a.fs.files.has("Archive/unsynced.md"), "kept: differs from GitHub");
	assert.ok(gh.headFiles().has("Archive/old.md"));
	await a.sync();
	assert.ok(gh.headFiles().has("Archive/old.md"), "still not deleted remotely");
});

test("first sync can prefer the GitHub version (download into a non-empty vault)", async () => {
	const { a, b } = pair();
	a.fs.put("Welcome.md", "real vault welcome\n");
	await a.sync();
	b.fs.put("Welcome.md", "default welcome of a fresh vault\n");
	const r = await b.engine.run("sync", { firstSyncPrefer: "remote" });
	assert.equal(r.conflictCopies.length, 0);
	assert.equal(b.fs.text("Welcome.md"), "real vault welcome\n");
});
