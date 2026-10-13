import { test } from "node:test";
import assert from "node:assert/strict";
import { commitDevice, computeHunks, hunkAt, nextHunk, revertEdit, revertHunk, traceLine } from "../src/change-diff.ts";

test("hunks: identical texts have none", () => {
	assert.deepEqual(computeHunks("a\nb\n", "a\nb\n"), []);
});

test("hunks: added, changed and deleted lines", () => {
	assert.deepEqual(computeHunks("a\nb\nc", "a\nx\nc"), [{ kind: "change", from: 1, to: 2, oldFrom: 1, oldLines: ["b"] }]);
	assert.deepEqual(computeHunks("a\nc", "a\nb\nc"), [{ kind: "add", from: 1, to: 2, oldFrom: 1, oldLines: [] }]);
	assert.deepEqual(computeHunks("a\nb\nc", "a\nc"), [{ kind: "delete", from: 1, to: 1, oldFrom: 1, oldLines: ["b"] }]);
	// Appended at the end, deleted at the end, inserted at the top.
	assert.deepEqual(computeHunks("a\nb", "a\nb\nc"), [{ kind: "add", from: 2, to: 3, oldFrom: 2, oldLines: [] }]);
	assert.deepEqual(computeHunks("a\nb\nc", "a\nb"), [{ kind: "delete", from: 2, to: 2, oldFrom: 2, oldLines: ["c"] }]);
	assert.deepEqual(computeHunks("b\nc", "a\nb\nc"), [{ kind: "add", from: 0, to: 1, oldFrom: 0, oldLines: [] }]);
});

test("hunks: several changes, CRLF base, empty texts", () => {
	const h = computeHunks("1\n2\n3\n4\n5\n6", "1\nX\n3\n4\n6\nY");
	assert.deepEqual(
		h.map((x) => [x.kind, x.from, x.to, x.oldLines.join("|")]),
		[
			["change", 1, 2, "2"],
			["delete", 4, 4, "5"],
			["add", 5, 6, ""],
		],
	);
	assert.deepEqual(computeHunks("a\r\nb\r\n", "a\nb\n"), [], "line endings alone are not a change");
	assert.deepEqual(computeHunks("", "a"), [{ kind: "change", from: 0, to: 1, oldFrom: 0, oldLines: [""] }]);
});

test("hunkAt / nextHunk", () => {
	const h = computeHunks("1\n2\n3\n4\n5\n6", "1\nX\n3\n4\n6\nY");
	assert.equal(hunkAt(h, 1, 6)?.kind, "change");
	assert.equal(hunkAt(h, 0, 6), null);
	assert.equal(hunkAt(h, 4, 6)?.kind, "delete", "a deletion belongs to the line below it");
	assert.equal(hunkAt(h, 5, 6)?.kind, "add");
	const end = computeHunks("a\nb\nc", "a\nb");
	assert.equal(hunkAt(end, 1, 2)?.kind, "delete", "a deletion at the end belongs to the last line");
	assert.equal(nextHunk(h, 0, 1)?.from, 1);
	assert.equal(nextHunk(h, 1, 1)?.from, 4);
	assert.equal(nextHunk(h, 5, 1)?.from, 1, "wraps around");
	assert.equal(nextHunk(h, 5, -1)?.from, 4);
	assert.equal(nextHunk(h, 1, -1)?.from, 5, "wraps around backwards");
	assert.equal(nextHunk([], 0, 1), null);
});

test("revert: every hunk goes back to the last-synced text", () => {
	const cases: [string, string][] = [
		["a\nb\nc", "a\nx\nc"],
		["a\nc", "a\nb\nc"],
		["a\nb\nc", "a\nc"],
		["a\nb", "a\nb\nc"],
		["a\nb\nc", "a\nb"],
		["b\nc", "a\nb\nc"],
		["a\nb\nc", "b\nc"],
		["a\nb\n", "a\nb"],
		["a\nb", "a\nb\n"],
		["", "x\ny"],
		["x\ny", ""],
		["1\n2\n3\n4\n5\n6", "1\nX\n3\n4\n6\nY"],
		["one\ntwo\nthree\n", "zero\none\n2\nthree\nfour\n"],
	];
	for (const [base, cur] of cases) {
		const hunks = computeHunks(base, cur);
		assert.ok(hunks.length > 0, `${JSON.stringify([base, cur])} has changes`);
		// Revert each hunk alone: only that region changes back.
		for (const h of hunks) {
			const after = revertHunk(cur, h);
			const left = computeHunks(base, after);
			assert.equal(left.length, hunks.length - 1, `${JSON.stringify([base, cur, h])} leaves the other hunks`);
		}
		// Revert them all, last first (earlier positions stay valid): back to the base.
		let text = cur;
		for (const h of [...hunks].reverse()) text = revertHunk(text, h);
		assert.equal(text, base, JSON.stringify([base, cur]));
	}
});

test("revert: the edit touches only the hunk's lines", () => {
	const cur = "keep\nnew\nkeep2";
	const [h] = computeHunks("keep\nkeep2", cur);
	assert.deepEqual(revertEdit(cur, h), { from: 5, to: 9, insert: "" });
	const cur2 = "keep\nkeep2";
	const [d] = computeHunks("keep\ngone\nkeep2", cur2);
	assert.deepEqual(revertEdit(cur2, d), { from: 5, to: 5, insert: "gone\n" });
});

test("trace: finds the commit that last changed a line, loading lazily", async () => {
	// Newest first: v0 changed line 1 ("b2"), v1 added line 2 ("c"), v2 created the file.
	const versions = ["a\nb2\nc", "a\nb\nc", "a\nb"];
	const loaded: number[] = [];
	const load = async (k: number) => {
		loaded.push(k);
		return versions[k] ?? null;
	};
	assert.deepEqual(await traceLine("a\nb2\nc", 1, 3, load, true), { kind: "commit", index: 0, atLeast: false });
	assert.deepEqual(loaded, [0, 1], "stops as soon as the line differs");
	assert.deepEqual(await traceLine("a\nb2\nc", 2, 3, load, true), { kind: "commit", index: 1, atLeast: false });
	assert.deepEqual(await traceLine("a\nb2\nc", 0, 3, load, true), { kind: "commit", index: 2, atLeast: false });
	assert.deepEqual(await traceLine("a\nb2\nc", 0, 3, load, false), { kind: "commit", index: 2, atLeast: true }, "history cut off");
});

test("trace: follows a line as lines move above it; local edits and missing versions", async () => {
	const versions = ["new top\na\nb\nc", "a\nb\nc"];
	const load = async (k: number) => versions[k] ?? null;
	// "c" moved from line 2 to line 3 in v0, but v1 already had it.
	assert.deepEqual(await traceLine("new top\na\nb\nc", 3, 2, load, true), { kind: "commit", index: 1, atLeast: false });
	assert.deepEqual(await traceLine("new top\na\nb\nc", 0, 2, load, true), { kind: "commit", index: 0, atLeast: false });
	// Edited here since the last sync, with an unsynced line above.
	assert.deepEqual(await traceLine("x\nnew top\na\nB\nc", 3, 2, load, true), { kind: "local" });
	assert.deepEqual(await traceLine("x\nnew top\na\nB\nc", 4, 2, load, true), { kind: "commit", index: 1, atLeast: false });
	// A version where the file didn't exist (or wasn't text): the newer one introduced the line.
	assert.deepEqual(await traceLine("a", 0, 2, async (k) => (k === 0 ? "a" : null), true), { kind: "commit", index: 0, atLeast: false });
	assert.deepEqual(await traceLine("a", 0, 0, load, true), { kind: "none" });
});

test("commitDevice reads the Device trailer", () => {
	assert.equal(commitDevice("vault: sync\n\nDevice: Fadi's iPhone\nPlugin: 1.6.0"), "Fadi's iPhone");
	assert.equal(commitDevice("manual commit"), null);
});
