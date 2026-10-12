import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, device } from "./support/fakes.ts";

const body = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `line ${i + 1}${i === 0 ? tag : ""}`).join("\n") + "\n";
const move = (fs: { files: Map<string, unknown> }, from: string, to: string) => {
	fs.files.set(to, fs.files.get(from)!);
	fs.files.delete(from);
};

function pair() {
	const gh = new FakeGitHub();
	return { gh, a: device("A", gh), b: device("B", gh) };
}

test("renamed AND edited on one device, untouched on the other: applied as a rename", async () => {
	const { gh, a, b } = pair();
	a.fs.put("Inbox/idea.md", body(10));
	await a.sync();
	await b.sync();
	move(a.fs, "Inbox/idea.md", "Projects/idea.md");
	a.fs.put("Projects/idea.md", body(10, " (edited)"));
	const ra = await a.sync();
	assert.deepEqual(ra.renamed, ["Inbox/idea.md → Projects/idea.md"]);
	assert.match(gh.commits.get(gh.refs.get("main")!)!.message, /1 renamed/);
	const rb = await b.sync();
	assert.deepEqual(rb.renamed, ["Inbox/idea.md → Projects/idea.md"]);
	assert.equal(b.fs.text("Projects/idea.md"), body(10, " (edited)"));
	assert.ok(!b.fs.files.has("Inbox/idea.md"));
});

test("renamed + edited here while the other device edited the old file: both edits under the new name", async () => {
	const { gh, a, b } = pair();
	a.fs.put("draft.md", body(12));
	await a.sync();
	await b.sync();
	b.fs.put("draft.md", body(12).replace("line 12\n", "line 12 (B)\n"));
	await b.sync();
	move(a.fs, "draft.md", "final.md");
	a.fs.put("final.md", body(12, " (A)"));
	const r = await a.sync();
	assert.ok(r.renamed.some((x) => x.startsWith("draft.md → final.md")));
	const want = body(12, " (A)").replace("line 12\n", "line 12 (B)\n");
	assert.equal(a.fs.text("final.md"), want);
	assert.ok(!a.fs.files.has("draft.md"));
	assert.equal(gh.headFiles().get("final.md"), want);
	assert.ok(!gh.headFiles().has("draft.md"));
	await b.sync();
	assert.equal(b.fs.text("final.md"), want);
	assert.ok(!b.fs.files.has("draft.md"));
});

test("renamed + edited on the other device while this one edited the old file: merged under the new name", async () => {
	const { gh, a, b } = pair();
	a.fs.put("draft.md", body(12));
	await a.sync();
	await b.sync();
	move(b.fs, "draft.md", "final.md");
	b.fs.put("final.md", body(12, " (B renamed)"));
	await b.sync();
	a.fs.put("draft.md", body(12).replace("line 12\n", "line 12 (A)\n"));
	const r = await a.sync();
	assert.ok(r.renamed.some((x) => x.startsWith("draft.md → final.md")));
	const want = body(12, " (B renamed)").replace("line 12\n", "line 12 (A)\n");
	assert.equal(a.fs.text("final.md"), want);
	assert.ok(!a.fs.files.has("draft.md"));
	assert.equal(gh.headFiles().get("final.md"), want);
	assert.ok(!gh.headFiles().has("draft.md"));
});

test("dissimilar delete + add are not paired", async () => {
	const { a, b } = pair();
	a.fs.put("old.md", body(10));
	await a.sync();
	await b.sync();
	a.fs.files.delete("old.md");
	a.fs.put("new.md", "completely different\ncontent here\n");
	const r = await a.sync();
	assert.equal(r.renamed.length, 0);
	assert.deepEqual(r.deletedRemote, ["old.md"]);
});
