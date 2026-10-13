import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec } from "../src/codec.ts";
import { createEncryption, EncryptionLayer } from "../src/crypto.ts";
import { traceLine } from "../src/change-diff.ts";
import { decodeCommitFiles, followRenames, renamedFromMessage } from "../src/history.ts";
import type { HistoryFile, RenameSource } from "../src/history.ts";
import type { CommitInfo } from "../src/remote.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const dec = new TextDecoder();

/** What the plugin builds for a host: commits per vault path and decoded commit files. */
function sourceOf(d: ReturnType<typeof device>, gh: FakeGitHub): RenameSource {
	return {
		list: async (p, n) => gh.listCommits("main", await d.engine.remotePathOf(p), n),
		files: async (sha) => decodeCommitFiles((await gh.getCommitFiles(sha)).files, (raw) => d.engine.vaultPathOf(raw)),
	};
}

function rename(d: ReturnType<typeof device>, from: string, to: string, text?: string) {
	d.fs.files.set(to, d.fs.files.get(from)!);
	d.fs.files.delete(from);
	if (text !== undefined) d.fs.put(to, text);
}

async function history(name: string, codec?: () => Codec) {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	if (codec) a.host.codec = codec;
	a.fs.put("Notes/Old.md", "one\ntwo\n");
	await a.sync();
	a.fs.put("Notes/Old.md", "one\ntwo edited\n");
	await a.sync();
	rename(a, "Notes/Old.md", `Notes/${name}.md`);
	assert.equal((await a.sync()).renamed.length, 1, "synced as a rename");
	a.fs.put(`Notes/${name}.md`, "one\ntwo edited\nthree\n");
	await a.sync();
	return { gh, a, src: sourceOf(a, gh) };
}

test("file history follows a rename: versions before it keep the old name", async () => {
	const { a, src } = await history("New");
	const list = await followRenames("Notes/New.md", 30, src);
	assert.deepEqual(list.map((c) => c.path), ["Notes/New.md", "Notes/New.md", "Notes/Old.md", "Notes/Old.md"]);
	// Every version opens under the name it had then.
	const texts = await Promise.all(list.map(async (c) => dec.decode((await a.engine.readRemoteFile(c.path, c.sha))!)));
	assert.deepEqual(texts, ["one\ntwo edited\nthree\n", "one\ntwo edited\n", "one\ntwo edited\n", "one\ntwo\n"]);

	// "Who last changed this line" reaches the edit made under the old name.
	const load = async (k: number) => {
		const d = await a.engine.readRemoteFile(list[k].path, list[k].sha);
		return d ? dec.decode(d) : null;
	};
	const r = await traceLine("one\ntwo edited\nthree\n", 1, list.length, load, list.length < 30);
	assert.deepEqual(r, { kind: "commit", index: 2, atLeast: false }, "the edit before the rename");
	const first = await traceLine("one\ntwo edited\nthree\n", 0, list.length, load, list.length < 30);
	assert.deepEqual(first, { kind: "commit", index: 3, atLeast: false }, "the file's first version, not 'at least'");

	// Without following, history stops at the rename.
	assert.equal((await src.list("Notes/New.md", 30)).length, 2);
});

test("file history follows renames through encryption (names decrypted, blobs identical)", async () => {
	const { master } = await createEncryption("a long test passphrase");
	const layer = await EncryptionLayer.fromMaster(master);
	const { gh, src } = await history("Secret", () => new Codec([layer]));
	for (const p of gh.rawFiles().keys()) assert.ok(!p.includes("Old") && !p.includes("Secret"), "names stay encrypted");
	const list = await followRenames("Notes/Secret.md", 30, src);
	assert.deepEqual(list.map((c) => c.path), ["Notes/Secret.md", "Notes/Secret.md", "Notes/Old.md", "Notes/Old.md"]);
});

test("followRenames: limit, chains, loops, full pages and the commit-message fallback", async () => {
	const c = (sha: string, message = "x"): CommitInfo => ({ sha, message, date: "", author: "" });
	const lists: Record<string, CommitInfo[]> = {
		"c.md": [c("5"), c("4")],
		"b.md": [c("4"), c("3")], // the rename commit 4 also deleted b.md: listed for both names
		"a.md": [c("3"), c("2", "A: 1 renamed\n\n- z.md → a.md")], // 3 deleted a.md (renamed it away)
		"z.md": [c("0")],
	};
	const files: Record<string, HistoryFile[]> = {
		"4": [{ path: "c.md", previous: "b.md", status: "renamed" }],
		"3": [{ path: "b.md", previous: "a.md", status: "renamed" }],
		"2": [{ path: "a.md", status: "added" }], // host saw a delete plus an add
	};
	let fileCalls = 0;
	const src: RenameSource = {
		list: async (p, n) => (lists[p] ?? []).slice(0, n),
		files: async (sha) => (fileCalls++, files[sha] ?? []),
	};
	const all = await followRenames("c.md", 30, src);
	assert.deepEqual(all.map((x) => `${x.sha}:${x.path}`), ["5:c.md", "4:c.md", "3:b.md", "2:a.md", "0:z.md"]);
	assert.deepEqual((await followRenames("c.md", 3, src)).map((x) => x.sha), ["5", "4", "3"], "limit");
	fileCalls = 0;
	await followRenames("c.md", 2, src);
	assert.equal(fileCalls, 0, "a full page doesn't look for renames");

	const loop: RenameSource = {
		list: async (p) => (p === "x.md" ? [c("2")] : [c("1")]),
		files: async (sha) => (sha === "2" ? [{ path: "x.md", previous: "y.md", status: "renamed" }] : [{ path: "y.md", previous: "x.md", status: "renamed" }]),
	};
	assert.deepEqual((await followRenames("x.md", 30, loop)).map((x) => x.path), ["x.md", "y.md"], "a name is followed once");

	const failing: RenameSource = { list: async () => [c("1")], files: async () => Promise.reject(new Error("offline")) };
	assert.equal((await followRenames("x.md", 30, failing)).length, 1, "no commit files: history as before");

	assert.equal(renamedFromMessage("A: 2 renamed\n\n- a.md → b.md\n- c.md → d.md\n\nDevice: A", "d.md"), "c.md");
	assert.equal(renamedFromMessage("A: 1 updated\n\n- d.md", "d.md"), null);
});
