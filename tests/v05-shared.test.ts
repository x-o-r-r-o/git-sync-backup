import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec, PrefixLayer } from "../src/codec.ts";
import { SyncEngine } from "../src/sync.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

test("shared folder: Work/ syncs to its own repo root; main repo never sees it", async () => {
	const privateRepo = new FakeGitHub();
	const teamRepo = new FakeGitHub();

	// My laptop: main engine (private repo) excludes Work/; a second engine maps Work/ ↔ team repo.
	const me = device("Mac", privateRepo);
	me.host.extraExcludes = () => ["Work/"];
	const teamHost = { ...me.host, gh: teamRepo as any, state: { ...me.host.state, base: {}, cache: {} } } as any;
	teamHost.settings = { ...me.host.settings, repo: "team" };
	teamHost.stateFilePath = ".obsidian/plugins/vault-sync-git/sync-state-team.json";
	teamHost.deviceScope = () => ({ include: ["Work/"], exclude: [], maxDownloadMB: 0 });
	teamHost.codec = () => new Codec([new PrefixLayer("Work")]);
	teamHost.extraExcludes = undefined;
	const teamEngine = new SyncEngine(teamHost);

	me.fs.put("Diary.md", "private\n");
	me.fs.put("Work/plan.md", "team plan\n");
	me.fs.put("Work/sub/notes.md", "notes\n");
	await me.sync();
	await teamEngine.run("sync");

	assert.ok(privateRepo.headFiles().has("Diary.md"));
	assert.ok(![...privateRepo.headFiles().keys()].some((p) => p.startsWith("Work/")), "private repo has no Work files");
	assert.equal(teamRepo.headFiles().get("plan.md"), "team plan\n", "folder maps to repo root");
	assert.equal(teamRepo.headFiles().get("sub/notes.md"), "notes\n");
	assert.ok(!teamRepo.headFiles().has("Diary.md"), "team repo has no private files");

	// A collaborator uses the team repo as their whole vault.
	const colleague = device("Colleague", teamRepo);
	await colleague.sync();
	assert.equal(colleague.fs.text("plan.md"), "team plan\n");
	colleague.fs.put("plan.md", "team plan\nupdated by colleague\n");
	colleague.fs.put("new.md", "from colleague\n");
	await colleague.sync();

	const r = await teamEngine.run("sync");
	assert.deepEqual(r.downloaded.sort(), ["Work/new.md", "Work/plan.md"]);
	assert.equal(me.fs.text("Work/plan.md"), "team plan\nupdated by colleague\n");
	assert.equal(me.fs.text("Work/new.md"), "from colleague\n");
	assert.equal((await me.sync()).upToDate, true, "main engine unaffected by Work/ changes");
	assert.ok(![...privateRepo.headFiles().keys()].some((p) => p.startsWith("Work/")));
});

test("shared folder: a nested folder with the same name stays private", async () => {
	const { sharedFolderPattern } = await import("../src/shared.ts");
	assert.equal(sharedFolderPattern("Work"), "/Work/");
	const privateRepo = new FakeGitHub();
	const teamRepo = new FakeGitHub();
	const me = device("Mac", privateRepo);
	me.host.extraExcludes = () => [sharedFolderPattern("Work")];
	const teamHost = { ...me.host, gh: teamRepo as any, state: { ...me.host.state, base: {}, cache: {} } } as any;
	teamHost.stateFilePath = ".obsidian/plugins/vault-sync-git/sync-state-team.json";
	teamHost.deviceScope = () => ({ include: [sharedFolderPattern("Work")], exclude: [], maxDownloadMB: 0 });
	teamHost.codec = () => new Codec([new PrefixLayer("Work")]);
	teamHost.extraExcludes = undefined;
	const teamEngine = new SyncEngine(teamHost);

	me.fs.put("Work/shared.md", "team\n");
	me.fs.put("Projects/Work/private.md", "mine\n");
	await me.sync();
	await teamEngine.run("sync");
	assert.deepEqual([...teamRepo.headFiles().keys()].filter((p) => !p.startsWith(".")), ["shared.md"]);
	assert.ok(privateRepo.headFiles().has("Projects/Work/private.md"), "nested Work/ is backed up privately");
	assert.ok(!privateRepo.headFiles().has("Work/shared.md"));
	await teamEngine.run("sync");
	assert.equal(me.fs.text("Projects/Work/private.md"), "mine\n", "not moved into the shared folder");
});
