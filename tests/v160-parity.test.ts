import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec, normalizeSubdir, RepoSubdirLayer } from "../src/codec.ts";
import { filesList, formatDate, isAutomaticTrigger, previewCommitMessage, renderCommitTemplate, templateFor } from "../src/commit-template.ts";
import { addExclusion, exactPattern, excludedByPatterns, removeExclusion } from "../src/scope-edit.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

// ---------------- 7. commit messages ----------------

const vars = (over: Partial<Parameters<typeof renderCommitTemplate>[1]> = {}) => ({
	device: "Mac",
	summary: "1 added",
	count: 1,
	files: ["a.md"],
	trigger: "manual",
	date: new Date(2026, 9, 13, 9, 5, 7),
	...over,
});

test("commit template: variables, date formats and file lists", () => {
	assert.equal(renderCommitTemplate("{{device}}: {{summary}} ({{count}})", vars(), null), "Mac: 1 added (1)");
	assert.equal(renderCommitTemplate("{{date}}", vars(), null), vars().date.toISOString(), "plain {{date}} stays ISO");
	assert.equal(renderCommitTemplate("{{date:YYYY-MM-DD HH:mm}}", vars(), null), "2026-10-13 09:05", "built-in formatter without moment");
	assert.equal(renderCommitTemplate("{{date:D/M/YY [at] H:mm:ss}}", vars(), null), "13/10/26 at 9:05:07");
	const fakeMoment = (d: Date) => ({ format: (f: string) => `moment(${f})@${d.getFullYear()}` });
	assert.equal(renderCommitTemplate("{{date:LLL}}", vars(), fakeMoment), "moment(LLL)@2026", "moment is used when present");
	assert.equal(renderCommitTemplate("{{trigger}} sync", vars({ trigger: "interval" }), null), "interval sync");
	assert.equal(renderCommitTemplate("{{unknown}} {{device}}", vars(), null), "{{unknown}} Mac", "unknown variables are kept");
	const many = Array.from({ length: 13 }, (_, i) => `n${i}.md`);
	assert.equal(filesList(many), "n0.md, n1.md, n2.md, n3.md, n4.md, n5.md, n6.md, n7.md, n8.md, n9.md and 3 more");
	assert.equal(renderCommitTemplate("Changed {{files}}", vars({ files: ["a.md", "b.md"] }), null), "Changed a.md, b.md");
	assert.equal(formatDate(new Date(2026, 0, 2, 3, 4, 5), "YYYYMMDD-HHmmss"), "20260102-030405");
	assert.match(previewCommitMessage("{{device}} via {{trigger}}: {{files}}", "Phone", "manual", null), /^Phone via manual: Notes\/Idea\.md, /);
});

test("commit template: automatic syncs use their own template when set", () => {
	assert.equal(isAutomaticTrigger("manual"), false);
	assert.equal(isAutomaticTrigger("close"), false, "Sync and close is started by the user");
	assert.equal(isAutomaticTrigger("interval"), true);
	assert.equal(templateFor("{{device}}: {{summary}}", "", "interval"), "{{device}}: {{summary}}", "empty = same template");
	assert.equal(templateFor("{{device}}: {{summary}}", "auto: {{summary}}", "interval"), "auto: {{summary}}");
	assert.equal(templateFor("{{device}}: {{summary}}", "auto: {{summary}}", "manual"), "{{device}}: {{summary}}");
	assert.equal(templateFor("  ", "", "manual"), "{{device}}: {{summary}}", "blank falls back to the default");
});

test("sync: the commit message follows the template, trigger and a typed message", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh, { commitTemplate: "{{device}} {{trigger}}: {{files}}", commitTemplateAuto: "auto {{count}}" });
	let ctx: { trigger?: string; message?: string | null } = { trigger: "manual" };
	a.host.commitContext = () => ctx;
	a.fs.put("one.md", "1\n");
	a.fs.put("two.md", "2\n");
	await a.sync();
	const subject = () => gh.commits.get(gh.refs.get("main")!)!.message.split("\n")[0];
	assert.equal(subject(), "A manual: one.md, two.md");
	ctx = { trigger: "interval" };
	a.fs.put("one.md", "1b\n");
	await a.sync();
	assert.equal(subject(), "auto 1", "automatic template");
	ctx = { trigger: "manual", message: "Weekly review\nline two" };
	a.fs.put("two.md", "2b\n");
	await a.sync();
	assert.equal(subject(), "Weekly review line two", "the typed message replaces the template (one line)");
	assert.match(gh.commits.get(gh.refs.get("main")!)!.message, /- two\.md/, "the file list is still there");
});

// ---------------- 9. exclude / include from the file explorer ----------------

test("exclude patterns: add and remove exact patterns", () => {
	const base = "# comment\n.trash/\n*.tmp";
	assert.equal(exactPattern("Notes/a*.md", false), "/Notes/a\\*.md", "glob characters are escaped");
	const ex = addExclusion(base, "Notes/Secret.md", false, ".obsidian");
	assert.equal(ex, `${base}\n/Notes/Secret.md`);
	assert.ok(excludedByPatterns(ex!, "Notes/Secret.md", ".obsidian"));
	assert.ok(!excludedByPatterns(ex!, "Other/Notes/Secret.md", ".obsidian"), "anchored at the vault root");
	assert.equal(addExclusion(ex!, "Notes/Secret.md", false, ".obsidian"), null, "already excluded");
	assert.equal(addExclusion(base, "x.tmp", false, ".obsidian"), null, "covered by *.tmp already");

	// Include again: the exact line goes away.
	assert.equal(removeExclusion(ex!, "Notes/Secret.md", false, ".obsidian"), base);
	// Excluded by a broader pattern: a "!" line brings it back, others stay excluded.
	const inc = removeExclusion(base, "keep.tmp", false, ".obsidian")!;
	assert.equal(inc, `${base}\n!/keep.tmp`);
	assert.ok(!excludedByPatterns(inc, "keep.tmp", ".obsidian"));
	assert.ok(excludedByPatterns(inc, "other.tmp", ".obsidian"));
	// Excluding it again replaces the "!" line instead of stacking contradictions.
	assert.equal(addExclusion(inc, "keep.tmp", false, ".obsidian"), `${base}\n/keep.tmp`);
	// Folders.
	const f = addExclusion(base, "Archive", true, ".obsidian")!;
	assert.ok(f.endsWith("\n/Archive/") && excludedByPatterns(f, "Archive/old.md", ".obsidian"));
	assert.equal(removeExclusion(f, "Archive", true, ".obsidian"), base);
	// A file inside an excluded folder.
	const inFolder = removeExclusion(f, "Archive/keep.md", false, ".obsidian")!;
	assert.ok(!excludedByPatterns(inFolder, "Archive/keep.md", ".obsidian") && excludedByPatterns(inFolder, "Archive/old.md", ".obsidian"));
	// Unanchored patterns that cover other paths too are never removed.
	assert.equal(removeExclusion("a.md", "a.md", false, ".obsidian"), "a.md\n!/a.md");
	assert.equal(removeExclusion(base, "free.md", false, ".obsidian"), null, "not excluded: nothing to do");
	// {config} patterns.
	assert.ok(excludedByPatterns("{config}/workspace.json", ".obsidian/workspace.json", ".obsidian"));
});

// ---------------- 10. vault in a folder of the repository ----------------

test("subfolder layer: paths map into the folder, everything else is ignored", async () => {
	assert.equal(normalizeSubdir(" /Vaults//Work/ "), "Vaults/Work");
	assert.equal(normalizeSubdir("../x/./y"), "x/y");
	const l = new RepoSubdirLayer("vaults/me/");
	assert.equal(await l.encodePath("a/b.md"), "vaults/me/a/b.md");
	assert.equal(await l.decodePath("vaults/me/a/b.md"), "a/b.md");
	assert.equal(await l.decodePath("vaults/other/a.md"), null);
	assert.equal(await l.decodePath("README.md"), null);
	assert.notEqual(new Codec([l]).id, new Codec([]).id, "changing the folder starts a fresh baseline");
});

test("sync: a vault in a repository subfolder leaves the rest of the repository alone, both ways", async () => {
	const gh = new FakeGitHub();
	const other = device("Other", gh);
	other.fs.put("README.md", "repo readme\n");
	other.fs.put("code/app.ts", "code\n");
	other.fs.put("vault/existing.md", "from repo\n");
	await other.sync();

	const a = device("A", gh, { repoSubdir: "vault" });
	a.host.codec = () => new Codec([new RepoSubdirLayer("vault")]);
	a.fs.put("mine.md", "mine\n");
	await a.sync();
	assert.equal(a.fs.text("existing.md"), "from repo\n", "vault/ is the vault");
	assert.ok(!a.fs.files.has("README.md") && !a.fs.files.has("code/app.ts") && !a.fs.files.has("vault/existing.md"), "nothing outside vault/ is downloaded");
	let remote = gh.headFiles();
	assert.equal(remote.get("vault/mine.md"), "mine\n");
	assert.ok(!remote.has("mine.md"));

	// Deleting in the vault deletes inside vault/ only; files outside stay.
	a.fs.files.delete("existing.md");
	await a.sync();
	remote = gh.headFiles();
	assert.ok(!remote.has("vault/existing.md"));
	assert.equal(remote.get("README.md"), "repo readme\n");
	assert.equal(remote.get("code/app.ts"), "code\n");

	// Changes outside vault/ made elsewhere never reach the vault, and never get deleted by it.
	other.fs.put("code/app.ts", "code v2\n");
	other.fs.put("README.md", "readme v2\n");
	await other.sync();
	await a.sync();
	assert.ok(!a.fs.files.has("app.ts") && !a.fs.files.has("code/app.ts"));
	remote = gh.headFiles();
	assert.equal(remote.get("code/app.ts"), "code v2\n");
	assert.equal(remote.get("vault/mine.md"), "mine\n");

	// Moving the vault to another folder: fresh baseline, uploads there, deletes nothing.
	a.host.settings.repoSubdir = "notes";
	a.host.codec = () => new Codec([new RepoSubdirLayer("notes")]);
	await a.sync();
	remote = gh.headFiles();
	assert.equal(remote.get("notes/mine.md"), "mine\n");
	assert.equal(remote.get("vault/mine.md"), "mine\n", "the old folder is left as it was");
	assert.equal(remote.get("README.md"), "readme v2\n");
});

// ---------------- 13b. sync: false in frontmatter ----------------

test("sync: notes with sync: false are never uploaded, and their repository copy stays", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	const out = new Set<string>();
	const unknown = new Set<string>();
	a.host.frontmatterScope = () => ({ out, unknown });
	a.fs.put("public.md", "p\n");
	a.fs.put("private.md", "---\nsync: false\n---\nsecret\n");
	out.add("private.md");
	await a.sync();
	assert.ok(gh.headFiles().has("public.md"));
	assert.ok(!gh.headFiles().has("private.md"), "never uploaded");

	// Already in the repository (synced before it was marked): it stays there, and local edits stay local.
	a.fs.put("diary.md", "v1\n");
	await a.sync();
	assert.equal(gh.headFiles().get("diary.md"), "v1\n");
	await b.sync();
	out.add("diary.md");
	a.fs.put("diary.md", "---\nsync: false\n---\nv2 private\n");
	await a.sync();
	assert.equal(gh.headFiles().get("diary.md"), "v1\n", "not uploaded");
	a.fs.files.delete("diary.md");
	await a.sync();
	assert.equal(gh.headFiles().get("diary.md"), "v1\n", "not deleted from the repository");
	// Other devices that don't mark it keep syncing it normally.
	b.fs.put("diary.md", "v1 edited on B\n");
	await b.sync();
	assert.equal(gh.headFiles().get("diary.md"), "v1 edited on B\n");
	assert.equal(a.fs.text("diary.md"), undefined, "not downloaded to A while marked");

	// Frontmatter not read yet: the note waits instead of being uploaded.
	a.fs.put("new.md", "---\nsync: false\n---\nnot indexed yet\n");
	unknown.add("new.md");
	await a.sync();
	assert.ok(!gh.headFiles().has("new.md"), "waits for the frontmatter");
	unknown.delete("new.md");
	out.add("new.md");
	await a.sync();
	assert.ok(!gh.headFiles().has("new.md"), "then left out for good");
});
