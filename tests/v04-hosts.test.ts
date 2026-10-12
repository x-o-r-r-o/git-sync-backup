import { test } from "node:test";
import assert from "node:assert/strict";
import { Gitea } from "../src/gitea.ts";
import { GitLab } from "../src/gitlab.ts";
import { FakeRepo, giteaTransport, gitlabTransport } from "./support/fakehosts.ts";
import { device } from "./support/fakes.ts";

const hosts = [
	{ name: "Gitea", make: (repo: FakeRepo) => new Gitea(() => ({ token: "t", apiBase: "https://gitea.test/api/v1", owner: "me", repo: "vault" }), giteaTransport(repo)) },
	{ name: "GitLab", make: (repo: FakeRepo) => new GitLab(() => ({ token: "t", apiBase: "https://gitlab.test/api/v4", owner: "me", repo: "vault" }), gitlabTransport(repo)) },
];

for (const h of hosts) {
	test(`${h.name}: two devices sync, merge, rename, delete`, async () => {
		const repo = new FakeRepo();
		const remote = h.make(repo);
		const a = device("A", remote as any);
		const b = device("B", remote as any);
		a.fs.put("Notes/one.md", "hello\n\nworld\n");
		a.fs.put("Notes/two.md", "two\n");
		a.fs.put("img/x.png", "\u0000bin");
		a.fs.put("Old/gone.md", "bye\n");
		await a.sync();
		assert.ok(repo.files().has("Notes/one.md") && repo.files().has(".gitattributes"));
		await b.sync();
		assert.equal(b.fs.text("img/x.png"), "\u0000bin");
		assert.equal((await b.sync()).upToDate, true);

		a.fs.put("Notes/one.md", "hello from A\n\nworld\n");
		b.fs.put("Notes/one.md", "hello\n\nworld from B\n");
		b.fs.files.set("Archive/two.md", b.fs.files.get("Notes/two.md")!);
		b.fs.files.delete("Notes/two.md");
		b.fs.files.delete("Old/gone.md");
		await a.sync();
		const rb = await b.sync();
		assert.deepEqual(rb.merged, ["Notes/one.md"]);
		assert.equal(rb.renamed.length, 1);
		const ra = await a.sync();
		assert.deepEqual(ra.renamed, ["Notes/two.md → Archive/two.md"]);
		assert.deepEqual(ra.deletedLocal, ["Old/gone.md"]);
		assert.equal(a.fs.text("Notes/one.md"), "hello from A\n\nworld from B\n");
		assert.deepEqual([...repo.files().keys()].filter((p) => !p.startsWith(".vault-sync/")).sort(), [".gitattributes", "Archive/two.md", "Notes/one.md", "img/x.png"]);
	});

	test(`${h.name}: concurrent push is detected and retried`, async () => {
		const repo = new FakeRepo();
		const remote = h.make(repo);
		const a = device("A", remote as any);
		const b = device("B", remote as any);
		a.fs.put("seed.md", "s\n");
		await a.sync();
		await b.sync();
		a.fs.put("a.md", "A\n");
		b.fs.put("b.md", "B\n");
		let raced = false;
		const orig = remote.getRef.bind(remote);
		// After A has read the head (inside commit), B pushes first.
		(remote as any).getRef = async (br: string) => {
			const head = await orig(br);
			if (!raced && a.host.state.head && head === a.host.state.head && (new Error().stack ?? "").includes("commit")) {
				raced = true;
				await b.sync();
			}
			return head;
		};
		await a.sync();
		// Different files: the host stacks A's commit on top of B's (nothing lost, nothing overwritten).
		assert.ok(repo.files().has("a.md") && repo.files().has("b.md"));
		assert.equal(a.host.state.dirty, true, "baseline marked incomplete");
		const r = await a.sync();
		assert.equal(r.upToDate, false, "dirty forces a full comparison");
		assert.equal(a.fs.text("b.md"), "B\n");
		assert.equal((await a.sync()).upToDate, true);
	});

	test(`${h.name}: history, restore and snapshot APIs`, async () => {
		const repo = new FakeRepo();
		const remote = h.make(repo);
		const a = device("A", remote as any);
		a.fs.put("n.md", "v1\n");
		await a.sync();
		const point = repo.head()!;
		a.fs.put("n.md", "v2\n");
		await a.sync();
		const hist = await remote.listCommits("main", "n.md", 10);
		assert.ok(hist.length >= 2);
		assert.equal(new TextDecoder().decode((await remote.getFileAt("n.md", point))!), "v1\n");
		assert.equal(await remote.compare(point, repo.head()!), "ahead");
		assert.equal(await remote.compare(repo.head()!, point), "behind");
		await a.engine.restoreTo(point, "", async () => true);
		assert.equal(a.fs.text("n.md"), "v1\n");
		await remote.createRef("refs/tags/snap-1", repo.head()!);
		assert.ok((await remote.listTags()).some((t) => t.name === "snap-1"));
	});
}

for (const h of hosts) {
	test(`${h.name}: concurrent edits to the same file are never silently overwritten`, async () => {
		const repo = new FakeRepo();
		const remote = h.make(repo);
		const a = device("A", remote as any);
		const b = device("B", remote as any);
		a.fs.put("x.md", "line 1\n\nline 2\n");
		await a.sync();
		await b.sync();
		a.fs.put("x.md", "line 1 from A\n\nline 2\n");
		b.fs.put("x.md", "line 1\n\nline 2 from B\n");
		let raced = false;
		const orig = remote.getRef.bind(remote);
		(remote as any).getRef = async (br: string) => {
			const head = await orig(br);
			if (!raced && (new Error().stack ?? "").includes("commit")) {
				raced = true;
				await b.sync(); // B pushes its edit to x.md while A is committing
			}
			return head;
		};
		await a.sync();
		await a.sync();
		await b.sync();
		assert.equal(repo.files().get("x.md"), "line 1 from A\n\nline 2 from B\n", "both edits survive");
		assert.equal(a.fs.text("x.md"), "line 1 from A\n\nline 2 from B\n");
	});
}
