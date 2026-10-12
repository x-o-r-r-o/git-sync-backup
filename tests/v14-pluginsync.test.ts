import { test } from "node:test";
import assert from "node:assert/strict";
import { findPluginNeeds, installPlugin, fetchRegistry, parseRegistry, REGISTRY_URL, MARKER_FILE } from "../src/pluginsync.ts";
import type { FetchResponse, PluginNeed, RegistryEntry } from "../src/pluginsync.ts";

const C = ".obsidian";
const enc = (s: string) => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

function memIO(files: Record<string, string>) {
	return {
		files,
		exists: (p: string) => Promise.resolve(p in files),
		read: (p: string) => (p in files ? Promise.resolve(files[p]) : Promise.reject(new Error("ENOENT " + p))),
	};
}

function fakeTransport(routes: Record<string, string>) {
	const calls: string[] = [];
	const transport = (url: string): Promise<FetchResponse> => {
		calls.push(url);
		const body = routes[url];
		if (body === undefined) return Promise.resolve({ status: 404, arrayBuffer: enc("Not Found"), text: "Not Found" });
		return Promise.resolve({ status: 200, arrayBuffer: enc(body), text: body });
	};
	return { transport, calls };
}

function sink() {
	const written: Record<string, string> = {};
	const dirs: string[] = [];
	return {
		written,
		dirs,
		write: (p: string, d: ArrayBuffer) => {
			written[p] = dec(d);
			return Promise.resolve();
		},
		mkdir: (p: string) => {
			dirs.push(p);
			return Promise.resolve();
		},
	};
}

const registry: RegistryEntry[] = [
	{ id: "dataview", repo: "blacksmithgu/obsidian-dataview", name: "Dataview" },
	{ id: "calendar", repo: "liamcain/obsidian-calendar-plugin" },
	{ id: "templater-obsidian", repo: "SilentVoid13/Templater" },
];
const reg = () => Promise.resolve(registry);
const rel = (repo: string, v: string, f: string) => `https://github.com/${repo}/releases/download/${v}/${f}`;

test("missing, outdated, up to date, manually installed, unknown and self are classified", async () => {
	const io = memIO({
		[`${C}/community-plugins.json`]: JSON.stringify(["dataview", "calendar", "templater-obsidian", "mystery", "vault-sync-git", "../evil", "manual"]),
		[`${C}/plugins/dataview/manifest.json`]: JSON.stringify({ id: "dataview", name: "Dataview", version: "0.5.67" }),
		[`${C}/plugins/calendar/manifest.json`]: JSON.stringify({ id: "calendar", version: "1.5.10" }),
		[`${C}/plugins/calendar/main.js`]: "old",
		[`${C}/plugins/calendar/${MARKER_FILE}`]: JSON.stringify({ version: "1.5.9" }),
		[`${C}/plugins/templater-obsidian/manifest.json`]: JSON.stringify({ id: "templater-obsidian", version: "2.0.0" }),
		[`${C}/plugins/templater-obsidian/main.js`]: "ok",
		[`${C}/plugins/templater-obsidian/${MARKER_FILE}`]: JSON.stringify({ version: "2.0.0" }),
		[`${C}/plugins/mystery/manifest.json`]: JSON.stringify({ id: "mystery", version: "1.0.0" }),
		[`${C}/plugins/vault-sync-git/manifest.json`]: JSON.stringify({ id: "vault-sync-git", version: "9.9.9" }),
		[`${C}/plugins/manual/manifest.json`]: JSON.stringify({ id: "manual", version: "3.0.0" }),
		[`${C}/plugins/manual/main.js`]: "installed by Obsidian, no marker",
	});
	const { needs, unknown } = await findPluginNeeds(io, C, reg);
	assert.deepEqual(needs, [
		{ id: "dataview", name: "Dataview", version: "0.5.67", repo: "blacksmithgu/obsidian-dataview", reason: "missing" },
		{ id: "calendar", name: "calendar", version: "1.5.10", repo: "liamcain/obsidian-calendar-plugin", reason: "outdated" },
	]);
	assert.deepEqual(unknown.sort(), ["../evil", "mystery"], "invalid and unregistered ids are never installed");
});

test("no registry fetch when nothing is needed; bad manifest versions are skipped", async () => {
	let fetched = 0;
	const io = memIO({
		[`${C}/community-plugins.json`]: JSON.stringify(["dataview"]),
		[`${C}/plugins/dataview/manifest.json`]: JSON.stringify({ id: "dataview", version: "../../x" }),
	});
	const r = await findPluginNeeds(io, C, () => {
		fetched++;
		return reg();
	});
	assert.deepEqual(r, { needs: [], unknown: [] });
	assert.equal(fetched, 0);
	assert.deepEqual(await findPluginNeeds(memIO({}), C, reg), { needs: [], unknown: [] });
});

test("registry: fetch from the official URL, junk entries dropped", async () => {
	const body = JSON.stringify([
		{ id: "dataview", repo: "blacksmithgu/obsidian-dataview", name: "Dataview" },
		{ id: "Bad ID", repo: "a/b" },
		{ id: "evil", repo: "a/../b" },
		{ id: "evil2", repo: "../b" },
		{ id: "evil3", repo: "a/b?x=1" },
	]);
	const { transport, calls } = fakeTransport({ [REGISTRY_URL]: body });
	assert.deepEqual(await fetchRegistry(transport), [{ id: "dataview", repo: "blacksmithgu/obsidian-dataview", name: "Dataview" }]);
	assert.deepEqual(calls, [REGISTRY_URL]);
	await assert.rejects(fetchRegistry(fakeTransport({}).transport), /HTTP 404/);
	assert.throws(() => parseRegistry("{}"), /not a list/);
});

const dv: PluginNeed = { id: "dataview", name: "Dataview", version: "0.5.67", repo: "blacksmithgu/obsidian-dataview", reason: "missing" };

test("install writes main.js, manifest.json, styles.css and the marker; then nothing is needed", async () => {
	const manifest = JSON.stringify({ id: "dataview", version: "0.5.67" });
	const { transport, calls } = fakeTransport({
		[rel(dv.repo, dv.version, "main.js")]: "MAIN",
		[rel(dv.repo, dv.version, "manifest.json")]: manifest,
		[rel(dv.repo, dv.version, "styles.css")]: ".x{}",
	});
	const s = sink();
	await installPlugin(dv, { transport, write: s.write, mkdir: s.mkdir }, C);
	assert.ok(calls.every((u) => u.startsWith("https://github.com/blacksmithgu/obsidian-dataview/releases/download/0.5.67/")));
	assert.deepEqual(s.dirs, [`${C}/plugins/dataview`]);
	assert.deepEqual(s.written, {
		[`${C}/plugins/dataview/main.js`]: "MAIN",
		[`${C}/plugins/dataview/manifest.json`]: manifest,
		[`${C}/plugins/dataview/styles.css`]: ".x{}",
		[`${C}/plugins/dataview/${MARKER_FILE}`]: JSON.stringify({ version: "0.5.67" }),
	});
	const io = memIO({ [`${C}/community-plugins.json`]: JSON.stringify(["dataview"]), ...s.written });
	assert.deepEqual((await findPluginNeeds(io, C, reg)).needs, [], "installed version is now tracked");
});

test("styles.css is optional (404 ok); missing main.js is fatal", async () => {
	const manifest = JSON.stringify({ id: "dataview", version: "0.5.67" });
	const s = sink();
	await installPlugin(dv, { transport: fakeTransport({ [rel(dv.repo, dv.version, "main.js")]: "MAIN", [rel(dv.repo, dv.version, "manifest.json")]: manifest }).transport, write: s.write }, C);
	assert.deepEqual(Object.keys(s.written).sort(), [`${C}/plugins/dataview/${MARKER_FILE}`, `${C}/plugins/dataview/main.js`, `${C}/plugins/dataview/manifest.json`]);

	const s2 = sink();
	await assert.rejects(installPlugin(dv, { transport: fakeTransport({ [rel(dv.repo, dv.version, "manifest.json")]: manifest }).transport, write: s2.write }, C), /main\.js.*HTTP 404/);
	assert.deepEqual(s2.written, {}, "nothing written on failure");
});

test("release manifest id or version mismatch is refused and nothing is written", async () => {
	for (const m of [{ id: "other", version: "0.5.67" }, { id: "dataview", version: "0.5.66" }, "not json"]) {
		const s = sink();
		const routes = { [rel(dv.repo, dv.version, "main.js")]: "MAIN", [rel(dv.repo, dv.version, "manifest.json")]: typeof m === "string" ? m : JSON.stringify(m) };
		await assert.rejects(installPlugin(dv, { transport: fakeTransport(routes).transport, write: s.write }, C), /does not match|not valid JSON/);
		assert.deepEqual(s.written, {});
	}
});

test("traversal and injection attempts are rejected before any request; self is never installed", async () => {
	const bad: PluginNeed[] = [
		{ ...dv, id: "../dataview" },
		{ ...dv, id: "data/view" },
		{ ...dv, id: "Dataview" },
		{ ...dv, repo: "../../etc" },
		{ ...dv, repo: "a/.." },
		{ ...dv, repo: "evil.com/x/y" },
		{ ...dv, repo: "a/b?c" },
		{ ...dv, repo: "a/b#x" },
		{ ...dv, version: "../../main" },
		{ ...dv, version: "1.0/../../x" },
		{ ...dv, version: ".." },
		{ ...dv, version: "1.0?x" },
		{ ...dv, version: "" },
		{ ...dv, id: "vault-sync-git" },
	];
	for (const need of bad) {
		const { transport, calls } = fakeTransport({});
		const s = sink();
		await assert.rejects(installPlugin(need, { transport, write: s.write }, C), /Invalid|Refusing/, JSON.stringify(need));
		assert.deepEqual(calls, [], "no network request");
		assert.deepEqual(s.written, {});
	}
});

test("a plugin installed by Obsidian counts as outdated when its manifest was updated on another device", async () => {
	const { findPluginNeeds } = await import("../src/pluginsync.ts");
	const files: Record<string, string> = {
		".obsidian/community-plugins.json": JSON.stringify(["dataview"]),
		".obsidian/plugins/dataview/manifest.json": JSON.stringify({ id: "dataview", name: "Dataview", version: "2.0.0" }),
		".obsidian/plugins/dataview/main.js": "old code",
	};
	const io = { exists: async (p: string) => p in files, read: async (p: string) => files[p] };
	const registry = async () => [{ id: "dataview", repo: "blacksmithgu/obsidian-dataview" }];
	assert.deepEqual((await findPluginNeeds(io, ".obsidian", registry)).needs, [], "no marker, nothing known: left alone");
	const { needs } = await findPluginNeeds(io, ".obsidian", registry, new Set(["dataview"]));
	assert.equal(needs[0]?.reason, "outdated");
	assert.equal(needs[0]?.version, "2.0.0");
});
