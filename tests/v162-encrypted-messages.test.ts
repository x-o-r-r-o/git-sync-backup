import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec } from "../src/codec.ts";
import { createEncryption, EncryptionLayer, b64, unb64 } from "../src/crypto.ts";
import type { EncryptionMeta } from "../src/crypto.ts";
import { encryptionGuard } from "../src/encryption.ts";
import type { EncryptionRecord } from "../src/encryption.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const dec = new TextDecoder();

test("encrypted sync: commit messages never name files (body, {{files}}, renames, deletes)", async () => {
	const gh = new FakeGitHub();
	const { meta, master } = await createEncryption("a long test passphrase");
	let record: EncryptionRecord | null = { meta, master: b64(master) };
	const a = device("A", gh, { commitTemplate: "{{device}}: {{summary}} {{files}}" });
	const layer = await EncryptionLayer.fromMaster(unb64(record.master));
	a.host.codec = () => new Codec([layer]);
	a.host.checkEncryption = encryptionGuard(
		() => record,
		(r) => (record = r),
		async (sha) => JSON.parse(dec.decode(await gh.getBlob(sha))) as EncryptionMeta,
	);
	a.fs.put("Private/Diary.md", "secret\n");
	a.fs.put("Clients/Acme deal.md", "x\n");
	await a.sync();
	a.fs.put("Private/Diary.md", "secret 2\n");
	a.fs.files.set("Clients/Acme renamed.md", a.fs.files.get("Clients/Acme deal.md")!);
	a.fs.files.delete("Clients/Acme deal.md");
	await a.sync();
	assert.ok(gh.commits.size >= 2);
	for (const { message } of gh.commits.values()) {
		assert.ok(!/Diary|Acme|Private|Clients/.test(message), `name leaked in commit message:\n${message}`);
	}
	const head = gh.commits.get(gh.refs.get("main")!)!.message;
	assert.match(head, /^A: .*updated/);
	assert.match(head, /Device: A/, "trailers kept");
});
