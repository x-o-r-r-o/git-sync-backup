import { test } from "node:test";
import assert from "node:assert/strict";
import { configPatterns, normalizeConfigSync } from "../src/scope-config.ts";
import { compileGlobs } from "../src/glob.ts";
import { DEFAULT_CONFIG_SYNC } from "../src/scope-config.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

const matcher = (c: Parameters<typeof configPatterns>[0], user: string[] = []) =>
	compileGlobs([...configPatterns(c).map((l) => l.split("{config}").join(".obsidian")), ...user]);

test("settings-folder categories become exclude patterns", () => {
	const all = matcher(DEFAULT_CONFIG_SYNC);
	assert.equal(all(".obsidian/app.json"), false, "everything syncs by default");

	const m = matcher({ ...DEFAULT_CONFIG_SYNC, core: false, appearance: false, pluginCode: false });
	assert.equal(m(".obsidian/app.json"), true, "core settings stay local");
	assert.equal(m(".obsidian/graph.json"), true);
	assert.equal(m(".obsidian/hotkeys.json"), false, "hotkeys still sync (own switch)");
	assert.equal(m(".obsidian/community-plugins.json"), false, "plugin list still syncs");
	assert.equal(m(".obsidian/appearance.json"), true);
	assert.equal(m(".obsidian/themes/Minimal/theme.css"), true);
	assert.equal(m(".obsidian/plugins/dataview/main.js"), true, "plugin code stays local");
	assert.equal(m(".obsidian/plugins/dataview/data.json"), false, "plugin settings sync");
	assert.equal(m(".obsidian/plugins/dataview/sub/x.json"), false, "not top-level settings");
});

test("per-plugin choices override the plugin switches; the user's patterns still win", () => {
	const c = { ...DEFAULT_CONFIG_SYNC, pluginCode: false, plugins: { calendar: "all" as const, dataview: "none" as const, templater: "settings" as const, excalidraw: "code" as const } };
	const m = matcher(c, ["/.obsidian/plugins/calendar/data.json"]);
	assert.equal(m(".obsidian/plugins/calendar/main.js"), false, "'all' brings code back");
	assert.equal(m(".obsidian/plugins/calendar/data.json"), true, "but the user's own exclude wins");
	assert.equal(m(".obsidian/plugins/dataview/main.js"), true);
	assert.equal(m(".obsidian/plugins/dataview/data.json"), true, "'none' keeps the whole plugin local");
	assert.equal(m(".obsidian/plugins/templater/main.js"), true);
	assert.equal(m(".obsidian/plugins/templater/data.json"), false, "'settings' syncs data.json only");
	assert.equal(m(".obsidian/plugins/excalidraw/main.js"), false, "'code' syncs code");
	assert.equal(m(".obsidian/plugins/excalidraw/data.json"), true, "but not settings");
	assert.deepEqual(normalizeConfigSync({ plugins: { "bad id/..": "all", ok: "nope" } as never }).plugins, {}, "junk is dropped");
});

test("sync: settings-folder categories, hidden files and .gitignore", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { syncConfigDir: true, syncHidden: true, useGitignore: true, configSync: { ...DEFAULT_CONFIG_SYNC, core: false } });
	a.host.gitignorePatterns = () => ["build/", "*.secret"];
	a.fs.put("note.md", "n\n");
	a.fs.put(".obsidian/app.json", "{}");
	a.fs.put(".obsidian/hotkeys.json", "{}");
	a.fs.put(".github/workflows/ci.yml", "on: push\n");
	a.fs.put(".editorconfig", "root = true\n");
	a.fs.put(".gitignore", "build/\n*.secret\n");
	a.fs.put(".git/HEAD", "ref\n");
	a.fs.put(".trash/old.md", "x\n");
	a.fs.put("build/out.md", "generated\n");
	a.fs.put("keys.secret", "s\n");
	await a.sync();
	const remote = [...gh.headFiles().keys()].sort();
	assert.deepEqual(remote, [".editorconfig", ".gitattributes", ".github/workflows/ci.yml", ".gitignore", ".obsidian/hotkeys.json", "note.md"]);
	assert.equal(a.fs.text(".gitattributes") !== undefined, true, "the repository's own hidden files come down too");

	// Hidden files off (default): they are neither uploaded nor deleted.
	const b = device("B", gh, { syncConfigDir: true });
	b.fs.put(".editorconfig", "mine\n");
	await b.sync();
	assert.equal(b.fs.text(".editorconfig"), "mine\n", "untouched");
	assert.ok(!b.fs.files.has(".github/workflows/ci.yml"));
	assert.equal(gh.headFiles().get(".editorconfig"), "root = true\n", "not overwritten");
});

test("sync current file: only that file moves; other changes wait for the next sync", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("one.md", "1\n");
	a.fs.put("two.md", "2\n");
	await a.sync();
	await b.sync();
	a.fs.put("one.md", "1 from A\n");
	a.fs.put("two.md", "2 from A\n");
	await a.sync();
	b.fs.put("three.md", "3 from B\n");
	b.fs.put("one.md", "1\n"); // unchanged
	const r = await b.engine.run("sync", { only: new Set(["two.md"]) });
	assert.equal(b.fs.text("two.md"), "2 from A\n", "current file updated");
	assert.equal(b.fs.text("one.md"), "1\n", "other remote change not applied yet");
	assert.ok(!gh.headFiles().has("three.md"), "other local change not uploaded yet");
	assert.equal(r.skipped.length, 0, "no skip noise for the other files");
	await b.sync();
	assert.equal(b.fs.text("one.md"), "1 from A\n", "next full sync catches up");
	assert.equal(gh.headFiles().get("three.md"), "3 from B\n");
});

test("hidden files inside normal folders are never synced, so never deleted (Folder/.gitkeep)", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	a.fs.put("notes/a.md", "a\n");
	await a.sync();
	// Put a hidden file inside a normal folder straight into the repository (as git users do).
	const t = await gh.createTree(gh.commits.get(gh.refs.get("main")!)!.tree, [{ path: "notes/.gitkeep", mode: "100644", type: "blob", content: "" }]);
	gh.refs.set("main", await gh.createCommit("add .gitkeep", t, [gh.refs.get("main")!]));
	const b = device("B", gh, { syncHidden: true });
	await b.sync();
	await b.sync();
	b.host.localChanges = () => ({ full: true, paths: new Set() });
	await b.sync(); // a full scan that walks the disk
	assert.ok(!b.fs.files.has("notes/.gitkeep"), "not downloaded");
	assert.ok(gh.headFiles().has("notes/.gitkeep"), "and never deleted from the repository");
});

test("a failed disk listing aborts the sync instead of deleting hidden files", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { syncHidden: true });
	a.fs.put(".editorconfig", "root = true\n");
	await a.sync();
	assert.ok(gh.headFiles().has(".editorconfig"));
	a.host.localChanges = () => ({ full: true, paths: new Set() });
	const app = a.host.app as { vault: { adapter: { list: (d: string) => Promise<unknown> } } };
	const list = app.vault.adapter.list;
	app.vault.adapter.list = async () => {
		throw new Error("disk busy");
	};
	await assert.rejects(a.sync(), /disk busy/);
	app.vault.adapter.list = list;
	assert.ok(gh.headFiles().has(".editorconfig"), "nothing deleted");
});

test("nested .gitignore rules apply only inside their folder", async () => {
	const { scopeGitignore } = await import("../src/glob.ts");
	assert.deepEqual(scopeGitignore("Notes/sub", ["# c", "", "*.tmp", "build/", "/only-here.md", "a/b.md", "!keep.tmp"]), [
		"/Notes/sub/**/*.tmp",
		"/Notes/sub/**/build/",
		"/Notes/sub/only-here.md",
		"/Notes/sub/a/b.md",
		"!/Notes/sub/**/keep.tmp",
	]);
	const m = compileGlobs(scopeGitignore("Notes", ["*.tmp", "!keep.tmp"]));
	assert.equal(m("Notes/x.tmp"), true);
	assert.equal(m("Notes/deep/y.tmp"), true);
	assert.equal(m("Other/x.tmp"), false, "outside the folder");
	assert.equal(m("Notes/keep.tmp"), false);
});

test("hidden files inside normal folders sync only with the nested option; subfolder .gitignore files sync with .gitignore support", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { syncHidden: true, syncHiddenNested: true, useGitignore: true });
	a.fs.put("Notes/a.md", "a\n");
	a.fs.put("Notes/.assets/pic.txt", "p\n");
	a.fs.put("Project/.gitignore", "*.log\n");
	a.fs.put("Project/.git/HEAD", "ref\n");
	await a.sync();
	const remote = gh.headFiles();
	assert.ok(remote.has("Notes/.assets/pic.txt"), "nested hidden file synced");
	assert.ok(remote.has("Project/.gitignore"), "subfolder .gitignore synced");
	assert.ok(!remote.has("Project/.git/HEAD"), "never a .git folder");

	const b = device("B", gh, { syncHidden: true, useGitignore: true }); // nested option off
	await b.sync();
	assert.equal(b.fs.text("Project/.gitignore"), "*.log\n", ".gitignore files still come down");
	assert.ok(!b.fs.files.has("Notes/.assets/pic.txt"), "other nested hidden files don't");
	b.fs.files.delete("Notes/a.md");
	await b.sync();
	assert.ok(gh.headFiles().has("Notes/.assets/pic.txt"), "and B never deletes them");
});
