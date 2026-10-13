import { test } from "node:test";
import assert from "node:assert/strict";
import { MirrorHost } from "../src/mirror.ts";
import { Codec } from "../src/codec.ts";
import { LfsLayer } from "../src/lfs.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

/** A main device plus a mirror host sharing its vault, with a stand-in for the plugin. */
function setup() {
	const main = new FakeGitHub();
	const mirrorRepo = new FakeGitHub();
	const a = device("A", main);
	const lfsPatterns: string[] = [];
	const fm = { out: new Set<string>(), unknown: new Set<string>() };
	const plugin = {
		frontmatterScope: () => fm,
		commitContext: () => ({ trigger: "manual", message: null }),
		app: a.host.app,
		settings: a.host.settings,
		stateFilePath: a.host.stateFilePath,
		pluginVersion: "1.4.0",
		deviceName: () => "A",
		log: () => {},
		progress: () => {},
		deviceId: () => "dev-a",
		deviceScope: () => ({ include: [], exclude: [], maxDownloadMB: 0 }),
		extraExcludes: () => [],
		gitignorePatterns: () => [],
		isUnloaded: () => false,
		encryptionLayer: () => null,
		encryptionRecord: () => null,
		mirrorToken: () => "",
		getToken: () => "",
		getApiBaseFor: () => "https://api.github.com",
		blobCacheStore: () => null,
		codec: () => new Codec([new LfsLayer(main as never, 0, undefined, lfsPatterns)]),
	};
	const mirror = new MirrorHost(plugin as never, { enabled: true, provider: "github", owner: "me", repo: "backup", branch: "main" }, mirrorRepo as never);
	return { main, mirrorRepo, a, mirror, lfsPatterns, fm };
}

test("mirror: uploads the vault push-only and follows deletions", async () => {
	const { mirrorRepo, a, mirror } = setup();
	a.fs.put("one.md", "1\n");
	a.fs.put("two.md", "2\n");
	a.fs.dirs.add("Empty");
	await a.sync();
	await mirror.engine.run("push");
	assert.deepEqual([...mirrorRepo.headFiles().keys()].filter((p) => !p.startsWith(".git")).sort(), ["one.md", "two.md"], "no folder list on the mirror");
	a.fs.files.delete("two.md");
	a.fs.put("one.md", "1 changed\n");
	await a.sync();
	await mirror.engine.run("push");
	assert.equal(mirrorRepo.headFiles().get("one.md"), "1 changed\n");
	assert.ok(!mirrorRepo.headFiles().has("two.md"), "deletion followed");
	// Someone edits the mirror directly: the mirror never writes back into the vault.
	await mirrorRepo.commit({ branch: "main", parent: mirrorRepo.refs.get("main")!, parentTree: mirrorRepo.commits.get(mirrorRepo.refs.get("main")!)!.tree, message: "edit", upserts: [{ path: "one.md", mode: "100644", load: async () => new TextEncoder().encode("mirror edit\n").buffer as ArrayBuffer }], deletes: [] });
	await mirror.engine.run("push");
	assert.equal(a.fs.text("one.md"), "1 changed\n", "vault untouched by the mirror");
});

test("mirror: deletions held back at the delete guard are held back on the mirror too", async () => {
	const { mirrorRepo, a, mirror } = setup();
	for (let i = 0; i < 20; i++) a.fs.put(`n${i}.md`, `${i}\n`);
	await a.sync();
	await mirror.engine.run("push");
	for (let i = 0; i < 20; i++) a.fs.files.delete(`n${i}.md`);
	a.host.deleteChoice = "skip";
	const r = await a.sync();
	assert.equal(r.guardKept?.length, 20);
	await mirror.engine.run("push", { defer: new Set(r.guardKept) });
	assert.equal([...mirrorRepo.headFiles().keys()].filter((p) => p.endsWith(".md")).length, 20, "nothing deleted on the mirror");
});

test("mirror: its large-file layer uses the same .gitattributes patterns as the main codec", () => {
	const { mirror, lfsPatterns } = setup();
	lfsPatterns.push("*.psd", "Assets/**");
	const lfs = mirror.codec().layers.find((l): l is LfsLayer => l instanceof LfsLayer);
	assert.ok(lfs);
	assert.deepEqual(lfs.trackedPatterns, ["*.psd", "Assets/**"]);
	assert.match(lfs.fingerprint, /attr:\*\.psd\|Assets/);
});

test("mirror: a `sync: false` note is never uploaded to the backup mirror", async () => {
	const { mirrorRepo, a, mirror, fm } = setup();
	a.fs.put("public.md", "ok\n");
	a.fs.put("secret.md", "---\nsync: false\n---\nprivate\n");
	a.fs.put("pending.md", "not read yet\n");
	fm.out.add("secret.md");
	fm.unknown.add("pending.md");
	await mirror.engine.run("push");
	const files = mirrorRepo.headFiles();
	assert.ok(files.has("public.md"));
	assert.ok(!files.has("secret.md"), "flagged note stays off the mirror");
	assert.ok(!files.has("pending.md"), "a note whose frontmatter isn't read yet waits");
	// Edited later while still flagged: still never uploaded.
	a.fs.put("secret.md", "---\nsync: false\n---\nprivate, edited\n");
	a.fs.put("public.md", "ok 2\n");
	await mirror.engine.run("push");
	assert.ok(!mirrorRepo.headFiles().has("secret.md"));
	assert.equal(mirrorRepo.headFiles().get("public.md"), "ok 2\n");
});
