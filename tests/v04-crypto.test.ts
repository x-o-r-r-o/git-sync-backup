import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec, PrefixLayer } from "../src/codec.ts";
import { createEncryption, EncryptionLayer, unlockEncryption } from "../src/crypto.ts";
import { gitBlobSha } from "../src/util.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ab = (s: string) => enc.encode(s).buffer as ArrayBuffer;

test("encryption: create, unlock, wrong passphrase rejected", async () => {
	const { meta, layer } = await createEncryption("correct horse battery staple");
	assert.equal(meta.iterations, 600000);
	const again = await unlockEncryption("correct horse battery staple", meta);
	assert.equal(again.layer.id, layer.id);
	await assert.rejects(() => unlockEncryption("wrong passphrase!!", meta), /Wrong passphrase/);
});

test("encryption: content round trip, deterministic, opaque", async () => {
	const { master } = await createEncryption("pass phrase for tests");
	const L = await EncryptionLayer.fromMaster(master);
	const a = await L.encode("x", ab("secret note\n"));
	const b = await L.encode("y", ab("secret note\n"));
	assert.deepEqual(new Uint8Array(a), new Uint8Array(b), "same plaintext, same ciphertext (path-independent)");
	assert.ok(!dec.decode(a).includes("secret"));
	assert.equal(dec.decode(await L.decode("x", a)), "secret note\n");
	const c = await L.encode("x", ab("secret note!\n"));
	assert.notDeepEqual(new Uint8Array(a), new Uint8Array(c));
	const tampered = new Uint8Array(a);
	tampered[20] ^= 1;
	await assert.rejects(() => L.decode("x", tampered.buffer as ArrayBuffer), /decrypt/);
});

test("encryption: names are hidden, deterministic and reversible (long paths split)", async () => {
	const { master } = await createEncryption("pass phrase for tests");
	const L = await EncryptionLayer.fromMaster(master);
	const p = "Private/Journal/2026-10-12 Thoughts about café ☕.md";
	const e1 = await L.encodePath(p);
	assert.equal(await L.encodePath(p), e1);
	assert.ok(e1.startsWith("e/") && !e1.includes("Journal"));
	assert.equal(await L.decodePath(e1), p);
	const long = "A/".repeat(150) + "note.md";
	const el = await L.encodePath(long);
	assert.ok(el.split("/").every((s) => s.length <= 180));
	assert.equal(await L.decodePath(el), long);
	assert.equal(await L.decodePath("README.md"), null, "foreign files are ignored");
	assert.equal(await L.decodePath("e/garbage"), null);
});

test("codec: storedSha matches the stored blob; prefix + encryption compose", async () => {
	const { master } = await createEncryption("pass phrase for tests");
	const L = await EncryptionLayer.fromMaster(master);
	const codec = new Codec([new PrefixLayer("Work"), L]);
	const data = ab("hello\n");
	const stored = await codec.encode("Work/a.md", data);
	assert.equal(await codec.storedSha("Work/a.md", data), await gitBlobSha(stored));
	const raw = await codec.encodePath("Work/a.md");
	assert.equal(await codec.decodePath(raw), "Work/a.md");
	assert.equal(dec.decode(await codec.decode("Work/a.md", stored)), "hello\n");
	assert.ok(codec.id.startsWith("folder:Work/+enc:"));
	const plain = new Codec();
	assert.equal(await plain.storedSha("a", data), await gitBlobSha(data));
	assert.equal(await plain.encodePath("x/y.md"), "x/y.md");
});
