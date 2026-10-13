import { test } from "node:test";
import assert from "node:assert/strict";
import { findConflictBlocks, resolveBlock, conflictResolver } from "../src/conflict-editor.ts";
import type { ConflictBlock, ConflictChoice } from "../src/conflict-editor.ts";
import { merge3 } from "../src/merge.ts";

function applyAll(text: string, blocks: ConflictBlock[], choice: ConflictChoice): string {
	let out = text;
	for (const b of [...blocks].reverse()) out = out.slice(0, b.from) + resolveBlock(b, choice) + out.slice(b.to);
	return out;
}

const simple = "intro\n<<<<<<< this device (Mac)\nlocal line\n=======\nremote line\n>>>>>>> GitHub\noutro\n";

test("simple block: labels, sides and offsets", () => {
	const blocks = findConflictBlocks(simple);
	assert.equal(blocks.length, 1);
	const b = blocks[0];
	assert.equal(b.oursLabel, "this device (Mac)");
	assert.equal(b.theirsLabel, "GitHub");
	assert.equal(b.ours, "local line\n");
	assert.equal(b.theirs, "remote line\n");
	assert.equal(b.base, undefined);
	assert.equal(b.from, "intro\n".length);
	assert.equal(simple.slice(b.from, b.to), "<<<<<<< this device (Mac)\nlocal line\n=======\nremote line\n>>>>>>> GitHub\n");
});

test("resolve choices", () => {
	const [b] = findConflictBlocks(simple);
	assert.equal(applyAll(simple, [b], "ours"), "intro\nlocal line\noutro\n");
	assert.equal(applyAll(simple, [b], "theirs"), "intro\nremote line\noutro\n");
	assert.equal(applyAll(simple, [b], "both"), "intro\nlocal line\nremote line\noutro\n");
});

test("multiple blocks resolved in reverse order", () => {
	const text = "a\n<<<<<<< L\n1\n2\n=======\nx\n>>>>>>> R\nb\n<<<<<<< L\n=======\ny\n>>>>>>> R\nc\n<<<<<<< L\nz\n=======\n>>>>>>> R";
	const blocks = findConflictBlocks(text);
	assert.equal(blocks.length, 3);
	assert.deepEqual(blocks.map((b) => [b.ours, b.theirs]), [["1\n2\n", "x\n"], ["", "y\n"], ["z\n", ""]]);
	assert.equal(blocks[2].to, text.length); // last block has no trailing newline
	assert.equal(applyAll(text, blocks, "ours"), "a\n1\n2\nb\nc\nz\n");
	assert.equal(applyAll(text, blocks, "theirs"), "a\nx\nb\ny\nc\n");
	assert.equal(applyAll(text, blocks, "both"), "a\n1\n2\nx\nb\ny\nc\nz\n");
});

test("diff3 base section", () => {
	const text = "<<<<<<< HEAD\nmine\n||||||| merged common ancestors\nold\n=======\ntheirs\n>>>>>>> feature\n";
	const [b] = findConflictBlocks(text);
	assert.equal(b.ours, "mine\n");
	assert.equal(b.base, "old\n");
	assert.equal(b.theirs, "theirs\n");
	assert.equal(b.oursLabel, "HEAD");
	assert.equal(applyAll(text, [b], "both"), "mine\ntheirs\n");
});

test("markers inside fenced code blocks are ignored", () => {
	const text = [
		"```diff",
		"<<<<<<< a",
		"x",
		"=======",
		"y",
		">>>>>>> b",
		"```",
		"~~~~",
		"<<<<<<< a",
		"```",
		"=======",
		">>>>>>> b",
		"~~~~",
		"<<<<<<< real",
		"ok",
		"=======",
		"ko",
		">>>>>>> real",
		"",
	].join("\n");
	const blocks = findConflictBlocks(text);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].oursLabel, "real");
	assert.equal(blocks[0].ours, "ok\n");
});

test("malformed and unbalanced blocks are ignored", () => {
	assert.deepEqual(findConflictBlocks("<<<<<<< a\nx\n>>>>>>> b\n"), []); // no separator
	assert.deepEqual(findConflictBlocks("<<<<<<< a\nx\n=======\ny\n"), []); // never closed
	assert.deepEqual(findConflictBlocks("<<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n"), []); // 8 chevrons
	assert.deepEqual(findConflictBlocks("text <<<<<<< a\nx\n=======\ny\n>>>>>>> b\n"), []); // not at line start
	assert.deepEqual(findConflictBlocks("no markers here\n======="), []);
	// A dangling opener followed by a valid block: only the valid one is found.
	const text = "<<<<<<< stray\nfoo\n<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n";
	const blocks = findConflictBlocks(text);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].oursLabel, "a");
	assert.equal(applyAll(text, blocks, "theirs"), "<<<<<<< stray\nfoo\ny\n");
});

test("CRLF line endings", () => {
	const text = "a\r\n<<<<<<< this device (PC)\r\nmine\r\n=======\r\ntheirs\r\n>>>>>>> GitHub\r\nb\r\n";
	const [b] = findConflictBlocks(text);
	assert.equal(b.oursLabel, "this device (PC)");
	assert.equal(b.theirsLabel, "GitHub");
	assert.equal(b.ours, "mine\r\n");
	assert.equal(b.theirs, "theirs\r\n");
	assert.equal(b.to, text.length - "b\r\n".length);
	assert.equal(applyAll(text, [b], "both"), "a\r\nmine\r\ntheirs\r\nb\r\n");
	assert.equal(applyAll(text, [b], "ours"), "a\r\nmine\r\nb\r\n");
});

test("round-trips merge3 output", () => {
	const r = merge3("one\ntwo\nthree\n", "one\nTWO-local\nthree\n", "one\nTWO-remote\nthree\n", { local: "this device (Mac)", remote: "GitHub" });
	assert.equal(r.clean, false);
	const blocks = findConflictBlocks(r.text);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].oursLabel, "this device (Mac)");
	assert.equal(applyAll(r.text, blocks, "ours"), "one\nTWO-local\nthree\n");
	assert.equal(applyAll(r.text, blocks, "theirs"), "one\nTWO-remote\nthree\n");
});

test("conflictResolver returns an extension", () => {
	assert.ok(conflictResolver({ ours: "Keep this device", theirs: "Keep repository", both: "Keep both" }));
});

test("editor decorations: bar, tinted sides, marker lines replaced (so Markdown can't style them)", async () => {
	const { EditorState } = await import("@codemirror/state");
	const { EditorView } = await import("@codemirror/view");
	const doc = "# T\n\n<<<<<<< this device\nMac wording.\n=======\nPhone wording.\n> quote\n>>>>>>> repository\n\nOutro\n";
	let state = EditorState.create({ doc, extensions: [conflictResolver({ ours: "a", theirs: "b", both: "c" })] });
	const decos = () => {
		const out: string[] = [];
		for (const d of state.facet(EditorView.decorations)) {
			if (typeof d === "function") continue;
			d.between(0, state.doc.length, (from, to, v) => {
				const spec = v.spec as { class?: string; widget?: { constructor: { name: string } }; block?: boolean };
				const line = state.doc.lineAt(from).number;
				out.push(`${line}:${spec.class ?? (spec.block ? "bar" : from === to ? "widget" : "replace")}`);
			});
		}
		return out.sort();
	};
	const got = decos();
	for (const want of ["3:bar", "3:vsg-cm-marker vsg-cm-marker-line-open", "3:replace", "4:vsg-cm-side vsg-cm-ours", "5:vsg-cm-marker vsg-cm-marker-line-sep", "5:replace", "6:vsg-cm-side vsg-cm-theirs", "7:vsg-cm-side vsg-cm-theirs", "8:vsg-cm-marker vsg-cm-marker-line-close", "8:replace"])
		assert.ok(got.includes(want), `missing ${want} in ${got.join(", ")}`);
	assert.ok(!got.some((g) => g.startsWith("1:") || g.startsWith("10:")), "nothing outside the block");
	// Typing elsewhere keeps the decorations; resolving removes them.
	state = state.update({ changes: { from: state.doc.length, insert: "more\n" } }).state;
	assert.ok(decos().includes("4:vsg-cm-side vsg-cm-ours"));
	const b = findConflictBlocks(state.doc.toString())[0];
	state = state.update({ changes: { from: b.from, to: b.to, insert: resolveBlock(b, "both") } }).state;
	assert.deepEqual(decos(), []);
});
