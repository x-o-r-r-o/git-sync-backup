import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec, RepoSubdirLayer, vaultCommitsPath } from "../src/codec.ts";
import { createEncryption, EncryptionLayer, MARKER_PATH, b64, markerPathFor, pickMarker, unb64 } from "../src/crypto.ts";
import type { EncryptionMeta } from "../src/crypto.ts";
import { encryptionGuard, EncryptionLocked } from "../src/encryption.ts";
import type { EncryptionRecord } from "../src/encryption.ts";
import { closeVerdict, syncProblems } from "../src/errors.ts";
import { compileGlobs } from "../src/glob.ts";
import { lfsPatternsForSubdir } from "../src/lfs.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const dec = new TextDecoder();

// ---------------- 2. "Sync and close" only quits after a fully successful sync ----------------

test("sync outcome: file errors, shared folders and the mirror each block closing, with a reason", () => {
	assert.deepEqual(syncProblems({ errors: [], sharedErrors: [], mirrorError: null }), []);
	const p = syncProblems({ errors: ["a.md: boom", "b.md: boom"], sharedErrors: ["Work: offline"], mirrorError: "401" });
	assert.equal(p.length, 3);
	assert.match(p[0], /2/);
	assert.match(p[0], /a\.md: boom/);
	assert.match(p[1], /Work: offline/);
	assert.match(p[2], /401/);

	// No new sync since before: stays open (offline, paused, not set up, or the error of the last run).
	assert.equal(closeVerdict(3, { seq: 3, ok: true, problems: [] }, null).quit, false);
	assert.equal(closeVerdict(0, null, null).quit, false);
	const failed = closeVerdict(3, null, "network down");
	assert.ok(!failed.quit && failed.message.includes("network down"));
	// The main repository synced but the mirror failed: stays open and says why.
	const partial = closeVerdict(3, { seq: 4, ok: false, problems: ["Backup mirror: 401"] }, null);
	assert.ok(!partial.quit && partial.message.includes("Backup mirror: 401"));
	// Everything synced.
	assert.equal(closeVerdict(3, { seq: 4, ok: true, problems: [] }, null).quit, true);
});

// ---------------- 4. per-vault encryption marker in a shared repository ----------------

async function newRecord(pass = "a long test passphrase"): Promise<EncryptionRecord> {
	const { meta, master } = await createEncryption(pass);
	return { meta, master: b64(master) };
}

/** A device whose vault lives in `sub` of the repository, encrypted when it holds a record. */
async function subVault(name: string, gh: FakeGitHub, sub: string, rec: EncryptionRecord | null) {
	const d = device(name, gh, { repoSubdir: sub });
	let record = rec;
	const layer = record ? await EncryptionLayer.fromMaster(unb64(record.master)) : null;
	d.host.codec = () => new Codec(layer ? [layer, new RepoSubdirLayer(sub)] : [new RepoSubdirLayer(sub)]);
	d.host.checkEncryption = encryptionGuard(
		() => record,
		(r) => (record = r),
		async (sha) => JSON.parse(dec.decode(await gh.getBlob(sha))) as EncryptionMeta,
	);
	return d;
}

test("encryption marker: two vaults in one repository, one encrypted, the other unaffected", async () => {
	const gh = new FakeGitHub();
	const rec = await newRecord();
	const a = await subVault("A", gh, "vaults/a", rec);
	const b = await subVault("B", gh, "vaults/b", null);
	a.fs.put("secret.md", "a's secret\n");
	await a.sync();
	let raw = gh.rawFiles();
	assert.ok(raw.has(markerPathFor("vaults/a")), "marker inside vault a's folder");
	assert.equal(markerPathFor("vaults/a"), "vaults/a/.vault-sync/encryption.json");
	assert.ok(!raw.has(MARKER_PATH), "no marker at the repository root");

	// The plain vault keeps syncing in its own folder, never locked by the other vault's encryption.
	b.fs.put("plain.md", "b's note\n");
	await b.sync();
	assert.equal(gh.headFiles().get("vaults/b/plain.md"), "b's note\n");
	assert.ok(!b.fs.files.has(".vault-sync/encryption.json"), "the marker is never a vault file");
	assert.equal((await b.sync()).upToDate, true);

	// Vault a: another device with the key reads it; one without the key is refused.
	const a2 = await subVault("A2", gh, "vaults/a", { ...rec });
	await a2.sync();
	assert.equal(a2.fs.text("secret.md"), "a's secret\n");
	assert.ok(!a2.fs.files.has(".vault-sync/encryption.json"));
	const a3 = await subVault("A3", gh, "vaults/a", null);
	await assert.rejects(a3.sync(), EncryptionLocked);

	// Removing unencrypted leftovers in vault a keeps its marker and never touches vault b.
	const removed = await a.engine.removeUnencryptedFiles(async () => true);
	assert.deepEqual(removed, []);
	raw = gh.rawFiles();
	assert.ok(raw.has(markerPathFor("vaults/a")));
	assert.ok(raw.has("vaults/b/plain.md"));
});

test("encryption marker: a root marker from an older version is read for migration only by the encrypted vault", async () => {
	const gh = new FakeGitHub();
	const rec = await newRecord();
	// An older version put vault a's marker at the repository root, next to vault b's plain files.
	const old = device("Old", gh);
	old.fs.put("vaults/b/plain.md", "b\n");
	await old.sync();
	const head = gh.refs.get("main")!;
	const markerJson = JSON.stringify(rec.meta, null, 2) + "\n";
	await gh.commit({
		branch: "main",
		parent: head,
		parentTree: gh.commits.get(head)!.tree,
		message: "old marker",
		upserts: [{ path: MARKER_PATH, mode: "100644", load: async () => new TextEncoder().encode(markerJson).buffer as ArrayBuffer }],
		deletes: [],
	});
	const a = await subVault("A", gh, "vaults/a", rec);
	a.fs.put("x.md", "x\n");
	await a.sync();
	assert.ok(gh.rawFiles().has(markerPathFor("vaults/a")), "migrated: a copy in the vault's own folder");
	assert.ok(gh.rawFiles().has(MARKER_PATH), "the root copy stays for devices on older versions");

	// The plain vault b isn't locked out by the root marker.
	const b = await subVault("B", gh, "vaults/b", null);
	await b.sync();
	assert.equal(b.fs.text("plain.md"), "b\n");

	// A new device of vault a without the key (its folder holds encrypted names) is still refused.
	const entries = [...gh.rawFiles().keys()].map((path) => ({ path, sha: "x" }));
	assert.equal(pickMarker(entries.filter((e) => e.path !== markerPathFor("vaults/a")), "vaults/a", false).legacy, true);
	assert.equal(pickMarker(entries.filter((e) => e.path !== markerPathFor("vaults/a")), "vaults/b", false).sha, null);
	assert.equal(pickMarker([{ path: MARKER_PATH, sha: "r" }], "", false).sha, "r", "a vault at the root uses the root marker");
});

// ---------------- 7. history limited to the vault's folder ----------------

test("history: commit lists are limited to the vault's repository folder", () => {
	assert.equal(vaultCommitsPath(""), undefined);
	assert.equal(vaultCommitsPath(undefined), undefined);
	assert.equal(vaultCommitsPath("/vaults/me/"), "vaults/me");
});

// ---------------- 8. .gitattributes patterns vs repository folder ----------------

test("lfs: root .gitattributes patterns are mapped to a vault kept in a repository folder", () => {
	const pats = ["*.psd", "/vaults/me/Assets/**", "vaults/me/big/*.bin", "vaults/other/*.zip", "/top.bin", "vaults/*/media/", "**/raw/*.cr2", "/vaults"];
	const mapped = lfsPatternsForSubdir(pats, "vaults/me");
	assert.deepEqual(mapped, ["*.psd", "/Assets/**", "/big/*.bin", "/media", "**/raw/*.cr2", "**"]);
	assert.deepEqual(lfsPatternsForSubdir(pats, ""), pats, "a vault at the root uses them as they are");
	const tracked = compileGlobs(lfsPatternsForSubdir(["/vaults/me/Assets/**", "vaults/other/*.zip"], "vaults/me"));
	assert.ok(tracked("Assets/a.png"));
	assert.ok(!tracked("x.zip"), "another vault's pattern doesn't apply");
});

// ---------------- 11. free up space keeps `sync: false` notes ----------------

test("free up space: notes marked sync: false are never removed", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("Work/w.md", "w\n");
	a.fs.put("Other/plain.md", "p\n");
	a.fs.put("Other/secret.md", "---\nsync: false\n---\nkept here\n");
	await a.sync();
	assert.ok(gh.headFiles().has("Other/secret.md"), "uploaded before it was flagged");
	a.host.deviceScope = () => ({ include: ["/Work/"], exclude: [], maxDownloadMB: 0 });
	a.host.frontmatterScope = () => ({ out: new Set(["Other/secret.md"]), unknown: new Set() });
	const plan = await a.engine.freeUpSpace(async () => true);
	assert.deepEqual(plan.files, ["Other/plain.md"]);
	assert.ok(a.fs.files.has("Other/secret.md"), "the flagged note stays on this device");
	assert.ok(!a.fs.files.has("Other/plain.md"));
});
