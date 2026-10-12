import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSetupLink, decryptToken, encryptToken, newSetupCode, parseSetupPayload } from "../src/setuplink.ts";
import type { SetupPayload } from "../src/setuplink.ts";
import { DEFAULT_CONFIG_SYNC } from "../src/scope-config.ts";
import { detectOtherSync } from "../src/othersync.ts";

const param = (link: string) => new URL(link.replace("obsidian://", "https://x/")).searchParams.get("s") ?? undefined;
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("setup link: round trip with an encrypted token; the code is never in the link", async () => {
	const code = newSetupCode();
	assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
	const payload: SetupPayload = {
		v: 1,
		provider: "gitea",
		api: "https://git.example.com/api/v1",
		owner: "me",
		repo: "vault",
		branch: "main",
		syncConfigDir: true,
		configSync: { ...DEFAULT_CONFIG_SYNC, pluginCode: false, plugins: { dataview: "none" } },
		token: await encryptToken("secret-token-123", code),
	};
	const link = buildSetupLink(payload);
	assert.ok(link.startsWith("obsidian://vault-sync-git?s="));
	assert.ok(!link.includes("secret-token") && !link.includes(code.replace(/-/g, "")), "no token or code in clear text");
	const back = parseSetupPayload(param(link));
	assert.deepEqual(back, payload);
	assert.equal(await decryptToken(back!.token!, code.toLowerCase()), "secret-token-123", "code is case- and dash-insensitive");
	await assert.rejects(decryptToken(back!.token!, newSetupCode()), "a wrong code fails");
});

test("setup link: anything malformed or dangerous is rejected", () => {
	const ok = { v: 1, provider: "github", owner: "me", repo: "vault", branch: "main" };
	assert.ok(parseSetupPayload(b64url(ok)));
	assert.equal(parseSetupPayload(undefined), null);
	assert.equal(parseSetupPayload("%%%"), null);
	assert.equal(parseSetupPayload(b64url({ ...ok, v: 2 })), null);
	assert.equal(parseSetupPayload(b64url({ ...ok, provider: "evil" })), null);
	assert.equal(parseSetupPayload(b64url({ ...ok, owner: "" })), null);
	assert.equal(parseSetupPayload(b64url({ ...ok, repo: "a b" })), null);
	assert.equal(parseSetupPayload(b64url({ ...ok, api: "javascript:alert(1)" })), null);
	assert.equal(parseSetupPayload(b64url({ ...ok, api: "http://evil.example.com" })), null, "plain http only for localhost");
	assert.ok(parseSetupPayload(b64url({ ...ok, api: "http://localhost:3000/api/v1" })));
	const junk = parseSetupPayload(b64url({ ...ok, syncConfigDir: "yes", configSync: { plugins: { "../x": "all" } }, extra: 1 }));
	assert.equal(junk?.syncConfigDir, undefined, "wrong types are dropped");
	assert.deepEqual(junk?.configSync?.plugins, {});
	assert.equal((junk as Record<string, unknown>).extra, undefined, "unknown fields are dropped");
});

test("other sync tools: Obsidian Sync, sync plugins, a .git folder and cloud folders", async () => {
	const files: Record<string, string> = {
		".obsidian/core-plugins.json": JSON.stringify({ sync: true, "file-explorer": true }),
		".obsidian/community-plugins.json": JSON.stringify(["dataview", "obsidian-git", "remotely-save", "vault-sync-git"]),
	};
	const dirs = new Set([".git"]);
	const app = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				exists: async (p: string) => p in files || dirs.has(p),
				read: async (p: string) => files[p],
				getBasePath: () => "/Users/me/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault",
			},
		},
	};
	assert.deepEqual(await detectOtherSync(app as never), ["Obsidian Sync", "Obsidian Git", "Remotely Save", ".git", "iCloud Drive"]);
	files[".obsidian/core-plugins.json"] = JSON.stringify(["file-explorer"]);
	files[".obsidian/community-plugins.json"] = "not json";
	dirs.clear();
	(app.vault.adapter as { getBasePath?: unknown }).getBasePath = undefined; // phone
	assert.deepEqual(await detectOtherSync(app as never), []);
});
