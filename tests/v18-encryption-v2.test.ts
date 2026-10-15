import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec } from "../src/codec.ts";
import { createEncryption, EncryptionLayer, b64, unb64, MARKER_PATH } from "../src/crypto.ts";
import type { EncryptionMeta } from "../src/crypto.ts";
import { encryptionGuard, EncryptionUpgraded, EncryptionMismatch } from "../src/encryption.ts";
import type { EncryptionRecord } from "../src/encryption.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const ab = (s: string) => enc.encode(s).buffer as ArrayBuffer;

/** A device whose encryption follows its record, like the plugin (record → layer in the record's format). */
async function encrypted(name: string, gh: FakeGitHub, start: EncryptionRecord) {
	const d = device(name, gh);
	let record: EncryptionRecord = start;
	const layers = new Map<string, EncryptionLayer>();
	const layer = async () => {
		const key = `${record.master}|${record.meta.v}`;
		if (!layers.has(key)) layers.set(key, await EncryptionLayer.fromMaster(unb64(record.master), record.meta.v));
		return layers.get(key)!;
	};
	let current = await layer();
	d.host.codec = () => new Codec([current]);
	d.host.checkEncryption = encryptionGuard(
		() => record,
		(r) => (record = r),
		async (sha) => JSON.parse(dec.decode(await gh.getBlob(sha))) as EncryptionMeta,
	);
	const sync = async () => {
		current = await layer();
		return d.sync();
	};
	return { ...d, sync, record: () => record, setRecord: async (r: EncryptionRecord) => ((record = r), (current = await layer())) };
}

test("format 2: content only decrypts under its own path; equal content at two paths differs", async () => {
	const { master } = await createEncryption("a long test passphrase");
	const v2 = await EncryptionLayer.fromMaster(master, 2);
	const v1 = await EncryptionLayer.fromMaster(master, 1);
	const a = await v2.encode("Notes/a.md", ab("same text\n"));
	assert.equal(dec.decode(new Uint8Array(a).slice(0, 4)), "VSG2");
	assert.equal(dec.decode(await v2.decode("Notes/a.md", a)), "same text\n");
	await assert.rejects(v2.decode("Notes/b.md", a), /decrypt|could not be decrypted|decryptFailed/i, "a file moved to another name doesn't open");
	const b = await v2.encode("Notes/b.md", ab("same text\n"));
	assert.notDeepEqual(new Uint8Array(a), new Uint8Array(b), "no shared nonce across paths");
	assert.deepEqual(new Uint8Array(await v2.encode("Notes/a.md", ab("same text\n"))), new Uint8Array(a), "deterministic per path");
	// Older files keep opening (history), with either layer.
	const old = await v1.encode("x.md", ab("old\n"));
	assert.equal(dec.decode(new Uint8Array(old).slice(0, 4)), "VSG1");
	assert.equal(dec.decode(await v2.decode("whatever.md", old)), "old\n");
	assert.equal(v1.id.startsWith("enc:") && v2.id.startsWith("enc:"), true);
	assert.notEqual(v1.id, v2.id, "the format is part of the codec identity");
});

test("new encryption is format 2: two devices sync; a swapped file is refused, not shown as the other", async () => {
	const gh = new FakeGitHub();
	const { meta, master } = await createEncryption("a long test passphrase");
	assert.equal(meta.v, 2);
	const rec = { meta, master: b64(master) };
	const a = await encrypted("A", gh, rec);
	const b = await encrypted("B", gh, { ...rec });
	a.fs.put("Private/plan.md", "the plan\n");
	a.fs.put("Private/other.md", "something else\n");
	await a.sync();
	await b.sync();
	assert.equal(b.fs.text("Private/plan.md"), "the plan\n");
	// Rename still works.
	a.fs.files.set("Archive/plan.md", a.fs.files.get("Private/plan.md")!);
	a.fs.files.delete("Private/plan.md");
	await a.sync();
	await b.sync();
	assert.equal(b.fs.text("Archive/plan.md"), "the plan\n");
	assert.ok(!b.fs.files.has("Private/plan.md"));

	// Someone with write access swaps two encrypted files in the repository.
	const head = gh.refs.get("main")!;
	const tree = new Map(gh.trees.get(gh.commits.get(head)!.tree)!);
	const files = [...tree].filter(([p]) => p.startsWith("e/"));
	const [p1, e1] = files[0];
	const [p2, e2] = files[1];
	tree.set(p1, e2);
	tree.set(p2, e1);
	const t = "t" + gh.n++;
	gh.trees.set(t, tree);
	const c = "c" + gh.n++;
	gh.commits.set(c, { tree: t, parents: [head], message: "swap" });
	gh.refs.set("main", c);
	const before = new Map([...b.fs.files].map(([p, f]) => [p, dec.decode(f.data)]));
	const r = await b.sync().catch((e: unknown) => ({ failed: String(e) }));
	// Whatever the run reports, no note ends up with the other note's text.
	for (const [p, text] of before) if (b.fs.files.has(p)) assert.equal(b.fs.text(p), text, `${p} kept its own content`);
	assert.ok("failed" in r || (r as { errors: unknown[] }).errors.length > 0, "the swap is reported");
});

test("upgrading an older repository: one commit re-encrypts everything; other devices switch, nothing conflicts", async () => {
	const gh = new FakeGitHub();
	const { master } = await createEncryption("a long test passphrase");
	const v1 = await EncryptionLayer.fromMaster(master, 1);
	const meta1: EncryptionMeta = { v: 1, kdf: "PBKDF2-SHA256", iterations: 600_000, salt: "c2FsdA==", check: await v1.checkValue() };
	const rec1 = { meta: meta1, master: b64(master) };
	const a = await encrypted("A", gh, rec1);
	const b = await encrypted("B", gh, { ...rec1 });
	a.fs.put("n1.md", "one\n");
	a.fs.put("img/p.png", "\u0000bin");
	await a.sync();
	await b.sync();
	for (const [p, data] of gh.rawFiles()) if (p.startsWith("e/")) assert.equal(dec.decode(data.slice(0, 4)), "VSG1");

	// A upgrades (what the plugin's action does after a sync).
	const v2 = await EncryptionLayer.fromMaster(master, 2);
	const meta2: EncryptionMeta = { ...meta1, v: 2, check: await v2.checkValue() };
	const n = await a.engine.upgradeEncryption(new Codec([v2]), JSON.stringify(meta2));
	assert.equal(n, 2);
	await a.setRecord({ meta: meta2, master: b64(master) });
	const headAfterUpgrade = gh.refs.get("main");
	for (const [p, data] of gh.rawFiles()) if (p.startsWith("e/")) assert.equal(dec.decode(data.slice(0, 4)), "VSG2", `${p} re-encrypted`);
	assert.equal(JSON.parse(dec.decode(gh.rawFiles().get(MARKER_PATH)!)).v, 2);
	const ra = await a.sync();
	assert.deepEqual(ra.conflictCopies, []);
	assert.equal(gh.refs.get("main"), headAfterUpgrade, "nothing to upload after the upgrade");

	// B: the first run sees the upgrade, switches and stops; the next one finds everything equal.
	await assert.rejects(b.sync(), (e) => e instanceof EncryptionUpgraded);
	assert.equal(b.record().meta.v, 2);
	const rb = await b.sync();
	assert.deepEqual(rb.conflictCopies, []);
	assert.deepEqual(rb.downloaded, []);
	assert.equal(b.fs.text("n1.md"), "one\n");
	b.fs.put("n1.md", "one\ntwo\n");
	await b.sync();
	await a.sync();
	assert.equal(a.fs.text("n1.md"), "one\ntwo\n");
	for (const [p, data] of gh.rawFiles()) if (p.startsWith("e/")) assert.equal(dec.decode(data.slice(0, 4)), "VSG2");
});

test("guard: an upgraded device publishes its newer marker over an older one (mirror); a different key is still refused", async () => {
	const { master } = await createEncryption("a long test passphrase");
	const v1 = await EncryptionLayer.fromMaster(master, 1);
	const v2 = await EncryptionLayer.fromMaster(master, 2);
	const meta1: EncryptionMeta = { v: 1, kdf: "PBKDF2-SHA256", iterations: 600_000, salt: "c2FsdA==", check: await v1.checkValue() };
	const meta2: EncryptionMeta = { ...meta1, v: 2, check: await v2.checkValue() };
	const markers: Record<string, EncryptionMeta> = { old: meta1, new: meta2 };
	const guard = (rec: EncryptionRecord) => encryptionGuard(() => rec, () => undefined, async (sha) => markers[sha]);
	const published = await guard({ meta: meta2, master: b64(master) })("old");
	assert.equal(JSON.parse(published!).v, 2, "the older marker is replaced");
	const { master: other } = await createEncryption("another passphrase!!");
	const otherV2 = await EncryptionLayer.fromMaster(other, 2);
	await assert.rejects(guard({ meta: { ...meta2, check: await otherV2.checkValue() }, master: b64(other) })("old"), (e) => e instanceof EncryptionMismatch);
});
