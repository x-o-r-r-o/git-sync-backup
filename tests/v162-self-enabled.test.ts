import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSelfEnabled, SELF_PLUGIN_ID } from "../src/io.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const enc = (s: string) => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer | null) => (b ? new TextDecoder().decode(b) : null);

test("keepSelfEnabled: adds this plugin to community-plugins.json only", () => {
	assert.deepEqual(JSON.parse(dec(keepSelfEnabled(".obsidian/community-plugins.json", ".obsidian", enc("[]")))!), [SELF_PLUGIN_ID]);
	assert.deepEqual(JSON.parse(dec(keepSelfEnabled(".obsidian/community-plugins.json", ".obsidian", enc('["dataview"]')))!), ["dataview", SELF_PLUGIN_ID]);
	assert.equal(keepSelfEnabled(".obsidian/community-plugins.json", ".obsidian", enc(`["${SELF_PLUGIN_ID}"]`)), null);
	assert.equal(keepSelfEnabled(".obsidian/app.json", ".obsidian", enc("[]")), null);
	assert.equal(keepSelfEnabled(".obsidian/community-plugins.json", ".obsidian", enc("{not json")), null);
});

test("a device that turned the plugin off can't turn it off on the others; the list heals itself", async () => {
	const gh = new FakeGitHub();
	const opts = { syncConfigDir: true };
	const a = device("A", gh, opts);
	const b = device("B", gh, opts);
	a.fs.put(".obsidian/community-plugins.json", JSON.stringify(["dataview", SELF_PLUGIN_ID]));
	await a.sync();
	await b.sync();
	// Device A uploads a list without this plugin (it was turned off there, or the file was stale).
	a.fs.put(".obsidian/community-plugins.json", JSON.stringify(["dataview"]));
	await a.sync();
	await b.sync();
	const onB = JSON.parse(b.fs.text(".obsidian/community-plugins.json")!) as string[];
	assert.ok(onB.includes(SELF_PLUGIN_ID), "B still runs the plugin");
	assert.ok(onB.includes("dataview"));
	// B's next sync uploads the repaired list, so A gets it back too.
	await b.sync();
	await a.sync();
	assert.ok((JSON.parse(a.fs.text(".obsidian/community-plugins.json")!) as string[]).includes(SELF_PLUGIN_ID));
});
