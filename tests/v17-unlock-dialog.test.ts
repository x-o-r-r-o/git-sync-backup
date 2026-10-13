import { test } from "node:test";
import assert from "node:assert/strict";
import { keyMatches } from "../src/crypto.ts";
import type { EncryptionMeta } from "../src/crypto.ts";

const meta = (salt: string, check = "c"): EncryptionMeta => ({ v: 1, kdf: "PBKDF2-SHA256", iterations: 600_000, salt, check });

test("encryption dialog: a device with the repository's key isn't asked to unlock again", () => {
	assert.equal(keyMatches(meta("s"), meta("s")), true, "same key: shows 'on', not Unlock");
	assert.equal(keyMatches(meta("s"), null), true, "no marker yet: this device publishes it");
	assert.equal(keyMatches(null, meta("s")), false, "no key: Unlock");
	assert.equal(keyMatches(null, null), false, "no key, no marker: Turn on");
	assert.equal(keyMatches(meta("s"), meta("other")), false, "another passphrase in the repo: Unlock");
	assert.equal(keyMatches(meta("s", "a"), meta("s", "b")), false);
});
