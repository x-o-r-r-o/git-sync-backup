import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3 } from "../src/merge.ts";
import { compileGlobs } from "../src/glob.ts";
import { decide } from "../src/plan.ts";

const L = { local: "L", remote: "R" };

test("merge: non-overlapping edits merge cleanly", () => {
	const base = "a\nb\nc\nd\ne\n";
	const r = merge3(base, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n", L)!;
	assert.equal(r.clean, true);
	assert.equal(r.text, "A\nb\nc\nd\nE\n");
});

test("merge: insertions on both sides at different places", () => {
	const base = "1\n2\n3\n";
	const r = merge3(base, "0\n1\n2\n3\n", "1\n2\n3\n4\n", L)!;
	assert.equal(r.clean, true);
	assert.equal(r.text, "0\n1\n2\n3\n4\n");
});

test("merge: same change on both sides is clean", () => {
	const r = merge3("x\ny\n", "x\nz\n", "x\nz\n", L)!;
	assert.equal(r.clean, true);
	assert.equal(r.text, "x\nz\n");
});

test("merge: overlapping edits produce markers", () => {
	const r = merge3("a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n", L)!;
	assert.equal(r.clean, false);
	assert.equal(r.conflicts, 1);
	assert.equal(r.text, "a\n<<<<<<< L\nB1\n=======\nB2\n>>>>>>> R\nc\n");
});

test("merge: missing trailing newline handled", () => {
	const r = merge3("a\nb", "a\nb\nc", "z\na\nb", L)!;
	assert.equal(r.clean, true);
	assert.equal(r.text, "z\na\nb\nc");
});

test("merge: deletion vs edit elsewhere", () => {
	const r = merge3("a\nb\nc\nd\n", "a\nc\nd\n", "a\nb\nc\nD\n", L)!;
	assert.equal(r.clean, true);
	assert.equal(r.text, "a\nc\nD\n");
});

test("glob patterns", () => {
	const m = compileGlobs([".trash/", "*.tmp", "/Private", ".obsidian/workspace.json", ".obsidian/plugins/*/node_modules/", "**/cache"]);
	assert.ok(m(".trash/x.md"));
	assert.ok(m("a/b/c.tmp"));
	assert.ok(m("Private/secret.md"));
	assert.ok(!m("Notes/Private/ok.md"));
	assert.ok(m(".obsidian/workspace.json"));
	assert.ok(!m(".obsidian/workspace.json.bak"));
	assert.ok(m(".obsidian/plugins/foo/node_modules/x/y.js"));
	assert.ok(m("deep/a/cache/f"));
	assert.ok(!m("Notes/readme.md"));
});

const M = (o: Record<string, string>) => new Map(Object.entries(o));

test("plan: basic sync decisions", () => {
	const base = { same: "1", lchg: "1", rchg: "1", ldel: "1", rdel: "1", both: "1", editdel: "1" };
	const local = M({ same: "1", lchg: "2", rchg: "1", rdel: "1", both: "2", new_l: "9", editdel: "5" });
	const remote = M({ same: "1", lchg: "1", rchg: "3", ldel: "1", both: "3", new_r: "8" });
	const p = decide(base, local, remote, "sync");
	const by = Object.fromEntries(p.decisions.map((d) => [d.path, d.kind]));
	assert.deepEqual(by, {
		lchg: "upload",
		rchg: "download",
		ldel: "delete-remote",
		rdel: "delete-local",
		both: "conflict",
		new_l: "upload",
		new_r: "download",
		editdel: "upload", // edit beats delete
	});
	assert.equal(p.settled.same, "1");
});

test("plan: push mode never touches local", () => {
	const p = decide({ a: "1", b: "1" }, M({ a: "2", b: "1" }), M({ a: "1", b: "5", c: "7" }), "push");
	assert.deepEqual(p.decisions.map((d) => [d.path, d.kind]), [["a", "upload"]]);
	assert.equal(p.settled.b, "1");
});

test("plan: pull mode never touches remote", () => {
	const p = decide({ a: "1", b: "1" }, M({ a: "2", b: "1", n: "4" }), M({ a: "1", b: "5" }), "pull");
	assert.deepEqual(p.decisions.map((d) => [d.path, d.kind]), [["b", "download"]]);
});

test("plan: first sync with empty base never deletes", () => {
	const p = decide({}, M({ a: "1", b: "2" }), M({ b: "3", c: "4" }), "sync");
	assert.ok(!p.decisions.some((d) => d.kind.startsWith("delete")));
});

test("plan: out-of-scope base entries are ignored", () => {
	const p = decide({ "big.mp4": "1" }, M({}), M({}), "sync", (x) => x !== "big.mp4");
	assert.equal(p.decisions.length, 0);
});

test("globs: negation (last match wins), literal brackets, escapes", () => {
	const m = compileGlobs(["Attachments/", "!Attachments/keep/", "*.log", "!important.log", "\\!bang.md", "\\#hash.md", "/Team [Acme]/", "Archive [2024-2020]/"]);
	assert.equal(m("Attachments/a.png"), true);
	assert.equal(m("Attachments/keep/a.png"), false, "re-included by a later !pattern");
	assert.equal(m("logs/a.log"), true);
	assert.equal(m("important.log"), false);
	assert.equal(m("!bang.md"), true);
	assert.equal(m("#hash.md"), true);
	assert.equal(m("Team [Acme]/note.md"), true, "brackets are literal (shared folder names)");
	assert.equal(m("Team A/note.md"), false);
	assert.equal(m("Archive [2024-2020]/x.md"), true, "no regex range errors");
	// A later exclude still wins over an earlier re-include (mandatory excludes come last).
	const forced = compileGlobs(["!secret/", "secret/"]);
	assert.equal(forced("secret/a.md"), true);
	assert.equal(compileGlobs(["a\\n.md"])("an.md"), true, "escaped letters stay literal");
});

test("portable names and secret redaction", async () => {
	const { portableNameProblem, redactSecrets } = await import("../src/util.ts");
	assert.equal(portableNameProblem("Notes/plan.md"), null);
	assert.equal(portableNameProblem("Notes/a:b.md"), "char");
	assert.equal(portableNameProblem("Notes/what?.md"), "char");
	assert.equal(portableNameProblem("Folder./x.md"), "end");
	assert.equal(portableNameProblem("x/name .md "), "end");
	assert.equal(portableNameProblem("CON.md"), "reserved");
	assert.equal(portableNameProblem("lpt1"), "reserved");
	assert.equal(portableNameProblem("console.md"), null);
	const r = redactSecrets("Authorization: Bearer abcdefghijklmnop ghp_ABCDEFGHIJKLMNOPQRSTUV glpat-xxxxxxxxxxxxxxx ?access_token=s3cr3t&x=1");
	assert.ok(!/abcdefghijklmnop|ghp_ABC|glpat-x|s3cr3t/.test(r), r);
});
