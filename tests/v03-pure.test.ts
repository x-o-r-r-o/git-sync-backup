import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, detectRenames } from "../src/plan.ts";
import { mergeJson, mergeMarkdown, smartMerge } from "../src/smartmerge.ts";

const M = (o: Record<string, string>) => new Map(Object.entries(o));
const plan = (b: Record<string, string>, l: Record<string, string>, r: Record<string, string>) => {
	const L = M(l), R = M(r);
	return detectRenames(decide(b, L, R, "sync").decisions, b, L, R);
};

test("renames: remote rename becomes a local move", () => {
	const d = plan({ "a.md": "X" }, { "a.md": "X" }, { "b.md": "X" });
	assert.deepEqual(d, [{ kind: "move-local", path: "b.md", from: "a.md", sha: "X" }]);
});

test("renames: remote rename + local edit moves then uploads the edit", () => {
	const d = plan({ "a.md": "X" }, { "a.md": "Y" }, { "b.md": "X" });
	assert.deepEqual(d, [{ kind: "move-local", path: "b.md", from: "a.md", sha: "X", upload: "Y" }]);
});

test("renames: local rename is annotated (upload + delete)", () => {
	const d = plan({ "a.md": "X" }, { "b.md": "X" }, { "a.md": "X" });
	assert.deepEqual(d, [
		{ kind: "delete-remote", path: "a.md", renamedTo: "b.md" },
		{ kind: "upload", path: "b.md", sha: "X", renamedFrom: "a.md" },
	]);
});

test("renames: local rename + remote edit adopts the edit under the new name", () => {
	const d = plan({ "a.md": "X" }, { "b.md": "X" }, { "a.md": "Z" });
	assert.deepEqual(d, [{ kind: "adopt-remote-edit", path: "b.md", from: "a.md", sha: "Z" }]);
});

test("renames: folder rename pairs every file; copies are not renames", () => {
	const d = plan(
		{ "F/1.md": "A", "F/2.md": "B", "c.md": "C" },
		{ "F/1.md": "A", "F/2.md": "B", "c.md": "C", "copy.md": "C" },
		{ "G/1.md": "A", "G/2.md": "B", "c.md": "C" },
	);
	assert.deepEqual(d.map((x) => [x.kind, x.path]).sort(), [["move-local", "G/1.md"], ["move-local", "G/2.md"], ["upload", "copy.md"]].sort());
});

test("renames: identical content in two new places only matches once", () => {
	const d = plan({ "a.md": "X" }, { "a.md": "X" }, { "b.md": "X", "c.md": "X" });
	assert.equal(d.filter((x) => x.kind === "move-local").length, 1);
	assert.equal(d.filter((x) => x.kind === "download").length, 1);
});

// ---------- smart merge ----------

const canvas = (nodes: object[], edges: object[] = []) => JSON.stringify({ nodes, edges }, null, "\t");

test("canvas: nodes added on both sides are both kept", () => {
	const base = canvas([{ id: "n1", type: "text", text: "hello", x: 0, y: 0 }]);
	const local = canvas([{ id: "n1", type: "text", text: "hello", x: 0, y: 0 }, { id: "n2", type: "text", text: "mine", x: 10, y: 0 }]);
	const remote = canvas([{ id: "n1", type: "text", text: "hello", x: 0, y: 0 }, { id: "n3", type: "text", text: "theirs", x: 0, y: 10 }]);
	const m = mergeJson(base, local, remote)!;
	assert.equal(m.clean, true);
	assert.deepEqual(JSON.parse(m.text).nodes.map((n: { id: string }) => n.id), ["n1", "n2", "n3"]);
	assert.ok(m.text.includes("\t"), "keeps tab indentation");
});

test("canvas: move on one side + text edit on the other merge per key", () => {
	const base = canvas([{ id: "n1", text: "a\nb\n", x: 0, y: 0 }]);
	const local = canvas([{ id: "n1", text: "a\nb\n", x: 50, y: 0 }]);
	const remote = canvas([{ id: "n1", text: "a\nB\n", x: 0, y: 0 }]);
	const n = JSON.parse(mergeJson(base, local, remote)!.text).nodes[0];
	assert.deepEqual(n, { id: "n1", text: "a\nB\n", x: 50, y: 0 });
});

test("canvas: deleted node vs untouched stays deleted; deleted vs edited keeps the edit", () => {
	const base = canvas([{ id: "a", text: "1" }, { id: "b", text: "2" }]);
	const local = canvas([{ id: "b", text: "2" }]);
	const remote = canvas([{ id: "a", text: "1" }, { id: "b", text: "2 edited" }]);
	const ids = JSON.parse(mergeJson(base, local, remote)!.text).nodes;
	assert.deepEqual(ids, [{ id: "b", text: "2 edited" }]);
	const keep = mergeJson(base, canvas([{ id: "b", text: "2" }]), canvas([{ id: "a", text: "1 edited" }, { id: "b", text: "2" }]))!;
	assert.deepEqual(JSON.parse(keep.text).nodes.map((n: { id: string }) => n.id).sort(), ["a", "b"]);
});

test("json: same key changed differently is a conflict", () => {
	const m = mergeJson('{"theme":"a"}', '{"theme":"b"}', '{"theme":"c"}')!;
	assert.equal(m.clean, false);
});

test("json: invalid JSON returns null", () => {
	assert.equal(mergeJson("{}", "{oops", "{}"), null);
});

test("frontmatter: tags added on both sides are unioned, body merged", () => {
	const base = "---\ntitle: Note\ntags:\n  - a\n---\nline 1\n\nline 2\n";
	const local = "---\ntitle: Note\ntags:\n  - a\n  - mine\n---\nline 1 edited\n\nline 2\n";
	const remote = "---\ntitle: Note\ntags:\n  - a\n  - theirs\n---\nline 1\n\nline 2 edited\n";
	const m = mergeMarkdown(base, local, remote)!;
	assert.equal(m.clean, true);
	assert.equal(m.text, "---\ntitle: Note\ntags:\n  - a\n  - mine\n  - theirs\n---\nline 1 edited\n\nline 2 edited\n");
});

test("frontmatter: inline lists, removals and different keys", () => {
	const base = "---\naliases: [x, y]\nstatus: draft\n---\nbody\n";
	const local = "---\naliases: [x, y, z]\nstatus: draft\n---\nbody\n";
	const remote = "---\naliases: [y]\nstatus: done\n---\nbody\n";
	const m = mergeMarkdown(base, local, remote)!;
	assert.equal(m.text, "---\naliases: [y, z]\nstatus: done\n---\nbody\n");
});

test("frontmatter: scalar changed both ways is not merged (null)", () => {
	assert.equal(mergeMarkdown("---\ns: a\n---\n", "---\ns: b\n---\n", "---\ns: c\n---\n"), null);
});

test("smartMerge routes by extension", () => {
	assert.equal(smartMerge("x.canvas", "{}", '{"a":1}', '{"b":2}')!.kind, "canvas");
	assert.equal(smartMerge("x.txt", "", "a", "b"), null);
	assert.equal(smartMerge("x.md", "a\n", "b\n", "c\n"), null, "no frontmatter: plain path");
});
