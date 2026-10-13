// 1.6: history sidebar logic (commit parsing, decoded file lists, filter) and "Use the repository version"
// (recoverable replace, next sync uploads nothing).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendPage, decodeCommitFiles, deviceOf, filterFiles, normalizeStatus, parentPathOf, parseCommit, replacedCopyPath, replaceWithRepositoryVersion } from "../src/history.ts";
import type { ReplaceIO } from "../src/history.ts";
import { Codec } from "../src/codec.ts";
import { createEncryption, EncryptionLayer } from "../src/crypto.ts";
import { VaultIO } from "../src/io.ts";
import { device, FakeGitHub } from "./support/fakes.ts";

const enc = new TextEncoder();
const ab = (s: string) => enc.encode(s).buffer as ArrayBuffer;

test("history: device from the trailer, else an older 'Name:' title; plugin version; title", () => {
	assert.equal(deviceOf("Vault sync: 3 files\n\nDevice: Fadi's iPhone\nPlugin: 1.5.0"), "Fadi's iPhone");
	assert.equal(deviceOf("MacBook: sync 2 files"), "MacBook");
	assert.equal(deviceOf("Initial commit"), null);
	const c = parseCommit({ sha: "abcdef1234", message: "Sync 2 files\n\nDevice: Laptop\nPlugin: 1.6.0", date: "2026-10-01T10:00:00Z", author: "fadi" });
	assert.deepEqual(c, { sha: "abcdef1234", title: "Sync 2 files", date: "2026-10-01T10:00:00Z", author: "fadi", device: "Laptop", plugin: "1.6.0" });
	assert.equal(parseCommit({ sha: "abcdef1234", message: "", date: "", author: "" }).title, "abcdef1");
});

test("history: Load more drops commits already shown (the branch moved between pages)", () => {
	const c = (sha: string) => ({ sha, message: sha, date: "", author: "" });
	const first = appendPage([], [c("e"), c("d"), c("c")]);
	const next = appendPage(first, [c("c"), c("b"), c("a")]);
	assert.deepEqual(next.map((x) => x.sha), ["e", "d", "c", "b", "a"]);
});

test("history: host statuses map to added / modified / deleted / renamed", () => {
	assert.equal(normalizeStatus("added"), "added");
	assert.equal(normalizeStatus("removed"), "deleted");
	assert.equal(normalizeStatus("deleted"), "deleted");
	assert.equal(normalizeStatus("renamed"), "renamed");
	assert.equal(normalizeStatus("changed"), "modified");
	assert.equal(normalizeStatus("modified"), "modified");
});

test("history: changed files decode to vault paths, skip files that aren't ours, sort, keep renames", async () => {
	const names: Record<string, string> = { "x1": "Notes/b.md", "x2": "Notes/a.md", "x3": "Old/a.md", "x4": "c.md" };
	const decode = async (raw: string) => names[raw] ?? null;
	const files = await decodeCommitFiles(
		[
			{ filename: "x1", status: "modified" },
			{ filename: ".vault-sync-encryption.json", status: "added" },
			{ filename: "x2", status: "renamed", previous: "x3" },
			{ filename: "x4", status: "renamed", previous: "not-ours" },
			{ filename: "x1-gone", status: "removed" },
		],
		decode,
	);
	assert.deepEqual(files, [
		{ path: "c.md", status: "added" },
		{ path: "Notes/a.md", previous: "Old/a.md", status: "renamed" },
		{ path: "Notes/b.md", status: "modified" },
	]);
	assert.equal(parentPathOf(files[1]), "Old/a.md");
	assert.equal(parentPathOf(files[2]), "Notes/b.md");
	assert.deepEqual(filterFiles(files, "old/").map((f) => f.path), ["Notes/a.md"]);
	assert.deepEqual(filterFiles(files, " NOTES ").map((f) => f.path), ["Notes/a.md", "Notes/b.md"]);
	assert.equal(filterFiles(files, "  ").length, 3);
	// A decoder that fails on a name (wrong key, garbage) hides that file instead of failing the list.
	assert.deepEqual(await decodeCommitFiles([{ filename: "bad", status: "added" }], async () => {
		throw new Error("decrypt");
	}), []);
});

test("history: encrypted repository paths show decrypted names", async () => {
	const { master } = await createEncryption("pass phrase for tests");
	const layer = await EncryptionLayer.fromMaster(master);
	const gh = new FakeGitHub();
	const d = device("A", gh);
	d.host.codec = () => new Codec([layer]);
	d.fs.put("Secret/plan.md", "the plan");
	await d.sync();
	const raw = [...gh.rawFiles().keys()];
	assert.ok(raw.every((p) => !p.includes("plan")), "stored names are encrypted");
	// Every file of the commit, as the host lists it: only the note shows, under its real name.
	const files = await decodeCommitFiles(raw.map((filename) => ({ filename, status: "added" })), (p) => d.engine.vaultPathOf(p));
	assert.deepEqual(files, [{ path: "Secret/plan.md", status: "added" }]);
});

test("use repository version: replaced copy name", () => {
	const at = new Date(2026, 9, 13, 9, 5);
	assert.equal(replacedCopyPath("Notes/plan.md", at), "Notes/plan (this device 2026-10-13 0905).md");
	assert.equal(replacedCopyPath("README", at, 2), "README (this device 2026-10-13 0905-2)");
});

test("use repository version: local edit goes to the recoverable trash, next sync uploads nothing", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("n.md", "synced\n");
	await a.sync();
	const head = gh.refs.get("main");
	a.fs.put("n.md", "local edit I regret\n");
	// Even with "delete permanently" as the user's preference, the replaced version stays recoverable.
	a.fs.permanentDelete = true;
	const io = new VaultIO(a.host.app);
	const r = await replaceWithRepositoryVersion(io, "n.md", await a.engine.readRemoteFile("n.md", head!), new Date(2026, 9, 13, 12, 0));
	assert.deepEqual(r, { kind: "replaced", trashedAs: "n (this device 2026-10-13 1200).md" });
	assert.equal(a.fs.text("n.md"), "synced\n");
	assert.deepEqual(a.fs.trash, ["n (this device 2026-10-13 1200).md"]);
	assert.ok(!a.fs.files.has("n (this device 2026-10-13 1200).md"), "the copy is not left in the vault");
	await a.sync();
	assert.equal(gh.refs.get("main"), head, "no commit: the file equals the repository again");
	assert.equal(gh.headFiles().get("n.md"), "synced\n");

	// System trash preferred when available; a second replace in the same minute gets its own name.
	a.fs.systemTrash = true;
	a.fs.put("n (this device 2026-10-13 1200).md", "an unrelated file with that name");
	a.fs.put("n.md", "another edit\n");
	const r2 = await replaceWithRepositoryVersion(io, "n.md", await a.engine.readRemoteFile("n.md", head!), new Date(2026, 9, 13, 12, 0));
	assert.deepEqual(r2, { kind: "replaced", trashedAs: "n (this device 2026-10-13 1200-2).md" });
	assert.deepEqual(a.fs.systemTrashed, ["n (this device 2026-10-13 1200-2).md"]);
	assert.equal(a.fs.text("n (this device 2026-10-13 1200).md"), "an unrelated file with that name", "never overwritten");
});

test("use repository version: newer repository version replaces the local edit without a conflict", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("n.md", "v1\n");
	await a.sync();
	await b.sync();
	b.fs.put("n.md", "v2 from B\n");
	await b.sync();
	const head = gh.refs.get("main")!;
	a.fs.put("n.md", "v1 edited on A\n");
	const r = await replaceWithRepositoryVersion(new VaultIO(a.host.app), "n.md", await a.engine.readRemoteFile("n.md", head));
	assert.equal(r.kind, "replaced");
	await a.sync();
	assert.equal(a.calls.conflicts, 0);
	assert.equal(gh.refs.get("main"), head, "nothing uploaded");
	assert.equal(a.fs.text("n.md"), "v2 from B\n");
	assert.ok(![...a.fs.files.keys()].some((p) => p.includes("conflict")), "no conflict copy");
});

test("use repository version: encrypted repository, same / missing / restored cases", async () => {
	const { master } = await createEncryption("pass phrase for tests");
	const layer = await EncryptionLayer.fromMaster(master);
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.host.codec = () => new Codec([layer]);
	a.fs.put("s.md", "secret\n");
	await a.sync();
	const head = gh.refs.get("main")!;
	const io = new VaultIO(a.host.app);
	const remote = await a.engine.readRemoteFile("s.md", head);
	assert.equal(new TextDecoder().decode(remote!), "secret\n", "decrypted content");
	assert.deepEqual(await replaceWithRepositoryVersion(io, "s.md", remote), { kind: "same" });
	assert.deepEqual(await replaceWithRepositoryVersion(io, "nope.md", await a.engine.readRemoteFile("nope.md", head)), { kind: "missing" });
	a.fs.files.delete("s.md");
	assert.deepEqual(await replaceWithRepositoryVersion(io, "s.md", remote), { kind: "restored" });
	assert.equal(a.fs.text("s.md"), "secret\n");
	await a.sync();
	assert.equal(gh.refs.get("main"), head);
	assert.deepEqual(a.fs.trash, []);
});

test("use repository version: a failing trash leaves the file untouched and the copy in the vault", async () => {
	const files = new Map<string, ArrayBuffer>([["n.md", ab("mine")]]);
	const io: ReplaceIO = {
		read: async (p) => files.get(p)!,
		stat: async (p) => (files.has(p) ? { mtime: 0, size: files.get(p)!.byteLength } : null),
		write: async (p, d) => void files.set(p, d),
		removeRecoverable: async () => {
			throw new Error("trash unavailable");
		},
	};
	await assert.rejects(() => replaceWithRepositoryVersion(io, "n.md", ab("theirs"), new Date(2026, 0, 1, 0, 0)), /trash unavailable/);
	assert.equal(new TextDecoder().decode(files.get("n.md")), "mine");
	assert.equal(new TextDecoder().decode(files.get("n (this device 2026-01-01 0000).md")), "mine");
});
