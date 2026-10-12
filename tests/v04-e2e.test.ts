import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec } from "../src/codec.ts";
import { createEncryption, EncryptionLayer, MARKER_PATH, b64, unb64 } from "../src/crypto.ts";
import type { EncryptionMeta } from "../src/crypto.ts";
import { encryptionGuard } from "../src/encryption.ts";
import type { EncryptionRecord } from "../src/encryption.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const dec = new TextDecoder();

async function encrypted(name: string, gh: FakeGitHub, rec: EncryptionRecord | null) {
	const d = device(name, gh);
	let record = rec;
	const layer = record ? await EncryptionLayer.fromMaster(unb64(record.master)) : null;
	d.host.codec = () => new Codec(layer ? [layer] : []);
	d.host.checkEncryption = encryptionGuard(
		() => record,
		(r) => (record = r),
		async (sha) => JSON.parse(dec.decode(await gh.getBlob(sha))) as EncryptionMeta,
	);
	return d;
}

async function newRecord(pass = "a long test passphrase"): Promise<EncryptionRecord> {
	const { meta, master } = await createEncryption(pass);
	return { meta, master: b64(master) };
}

test("encrypted sync: two devices round-trip; GitHub sees only ciphertext", async () => {
	const gh = new FakeGitHub();
	const rec = await newRecord();
	const a = await encrypted("A", gh, rec);
	const b = await encrypted("B", gh, { ...rec });
	a.fs.put("Private/Diary.md", "my secret diary\n");
	a.fs.put("img/photo.png", "\u0000binary");
	await a.sync();
	const raw = gh.rawFiles();
	assert.ok(raw.has(MARKER_PATH), "marker published");
	for (const [p, data] of raw) {
		assert.ok(!p.includes("Diary") && !p.includes("photo"), `name leaked: ${p}`);
		assert.ok(!dec.decode(data).includes("secret diary"), "content leaked");
	}
	await b.sync();
	assert.equal(b.fs.text("Private/Diary.md"), "my secret diary\n");
	assert.equal(b.fs.text("img/photo.png"), "\u0000binary");
	assert.equal((await b.sync()).upToDate, true);

	// Edits, merges and renames still work on ciphertext.
	a.fs.put("Private/Diary.md", "my secret diary\n\nmore from A\n");
	b.fs.put("Private/Diary.md", "B was here\n\nmy secret diary\n");
	await a.sync();
	const rb = await b.sync();
	assert.deepEqual(rb.merged, ["Private/Diary.md"]);
	await a.sync(); // A picks up the merge before B renames
	b.fs.files.set("Archive/Diary.md", b.fs.files.get("Private/Diary.md")!);
	b.fs.files.delete("Private/Diary.md");
	assert.equal((await b.sync()).renamed.length, 1);
	const ra = await a.sync();
	assert.deepEqual(ra.renamed, ["Private/Diary.md → Archive/Diary.md"]);
	assert.equal(a.fs.text("Archive/Diary.md"), "B was here\n\nmy secret diary\n\nmore from A\n");
});

test("encrypted repo refuses devices without the key, and devices with another key", async () => {
	const gh = new FakeGitHub();
	const a = await encrypted("A", gh, await newRecord());
	a.fs.put("n.md", "x\n");
	await a.sync();
	const plain = await encrypted("Plain", gh, null);
	await assert.rejects(() => plain.sync(), /end-to-end encrypted/);
	assert.equal(plain.fs.files.size, 0, "nothing written");
	const other = await encrypted("Other", gh, await newRecord("a different passphrase!!"));
	await assert.rejects(() => other.sync(), /different passphrase/);
	assert.equal(other.fs.files.size, 0);
});

test("history helpers and restore work through encryption", async () => {
	const gh = new FakeGitHub();
	const a = await encrypted("A", gh, await newRecord());
	a.fs.put("n.md", "v1\n");
	await a.sync();
	const point = gh.refs.get("main")!;
	a.fs.put("n.md", "v2\n");
	await a.sync();
	assert.equal(dec.decode((await a.engine.readRemoteFile("n.md", point))!), "v1\n");
	assert.match(await a.engine.remotePathOf("n.md"), /^e\//);
	await a.engine.restoreTo(point, "", async () => true);
	assert.equal(a.fs.text("n.md"), "v1\n");
});

test("migrating a plain repo: encrypted copies uploaded, plain copies removed on request", async () => {
	const gh = new FakeGitHub();
	const p = device("P", gh);
	p.fs.put("note.md", "was plain\n");
	await p.sync();
	assert.ok(gh.rawFiles().has("note.md"));
	const a = await encrypted("A", gh, await newRecord());
	a.fs.put("note.md", "was plain\n");
	await a.sync();
	assert.ok([...gh.rawFiles().keys()].some((k) => k.startsWith("e/")));
	const removed = await a.engine.removeUnencryptedFiles(async () => true);
	assert.deepEqual(removed, ["note.md"]);
	assert.ok(!gh.rawFiles().has("note.md"));
	assert.ok(gh.rawFiles().has(MARKER_PATH) && gh.rawFiles().has(".gitattributes"));
	assert.equal((await a.sync()).deletedLocal.length, 0, "local note untouched");
	assert.equal(a.fs.text("note.md"), "was plain\n");
});
