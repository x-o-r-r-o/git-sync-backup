import { test } from "node:test";
import assert from "node:assert/strict";
import { Bitbucket } from "../src/bitbucket.ts";
import type { BlobCache } from "../src/bitbucket.ts";
import { FakeRepo, bitbucketTransport } from "./support/fakehosts.ts";
import { device } from "./support/fakes.ts";

function make(repo: FakeRepo, store: { c: BlobCache | null }) {
	const bb = bitbucketTransport(repo);
	const remote = new Bitbucket(
		() => ({ token: "t", apiBase: "https://bb.test/2.0", owner: "me", repo: "vault" }),
		{ load: async () => store.c, save: async (c) => void (store.c = JSON.parse(JSON.stringify(c))) },
		bb.transport,
	);
	return { remote, calls: bb.calls };
}

test("Bitbucket: two devices sync, merge, rename, delete; hash cache avoids re-downloads", async () => {
	const repo = new FakeRepo();
	const sa = { c: null as BlobCache | null };
	const sb = { c: null as BlobCache | null };
	const A = make(repo, sa);
	const B = make(repo, sb);
	const a = device("A", A.remote as any);
	const b = device("B", B.remote as any);
	a.fs.put("Notes/one.md", "hello\n\nworld\n");
	a.fs.put("Notes/two.md", "two\n");
	a.fs.put("img/x.png", "\u0000bin");
	await a.sync();
	assert.ok(repo.files().has("Notes/one.md") && repo.files().has(".gitattributes"));
	await b.sync();
	assert.equal(b.fs.text("img/x.png"), "\u0000bin");
	assert.equal((await b.sync()).upToDate, true);

	const before = B.calls.raw;
	a.fs.put("Notes/one.md", "hello from A\n\nworld\n");
	b.fs.put("Notes/one.md", "hello\n\nworld from B\n");
	b.fs.files.set("Archive/two.md", b.fs.files.get("Notes/two.md")!);
	b.fs.files.delete("Notes/two.md");
	await a.sync();
	const rb = await b.sync();
	assert.deepEqual(rb.merged, ["Notes/one.md"]);
	assert.equal(rb.renamed.length, 1);
	assert.ok(B.calls.raw - before <= 4, `only changed files fetched (got ${B.calls.raw - before})`);
	const ra = await a.sync();
	assert.deepEqual(ra.renamed, ["Notes/two.md → Archive/two.md"]);
	assert.equal(a.fs.text("Notes/one.md"), "hello from A\n\nworld from B\n");
	assert.deepEqual([...repo.files().keys()].sort(), [".gitattributes", "Archive/two.md", "Notes/one.md", "img/x.png"]);
});

test("Bitbucket: concurrent edits to the same file are merged, never overwritten", async () => {
	const repo = new FakeRepo();
	const A = make(repo, { c: null });
	const B = make(repo, { c: null });
	const a = device("A", A.remote as any);
	const b = device("B", B.remote as any);
	a.fs.put("x.md", "line 1\n\nline 2\n");
	await a.sync();
	await b.sync();
	a.fs.put("x.md", "line 1 from A\n\nline 2\n");
	b.fs.put("x.md", "line 1\n\nline 2 from B\n");
	let raced = false;
	const orig = A.remote.getRef.bind(A.remote);
	(A.remote as any).getRef = async (br: string) => {
		const head = await orig(br);
		if (!raced && (new Error().stack ?? "").includes("commit")) {
			raced = true;
			await b.sync();
		}
		return head;
	};
	await a.sync();
	await a.sync();
	await b.sync();
	assert.equal(repo.files().get("x.md"), "line 1 from A\n\nline 2 from B\n");
});

test("Bitbucket: history, file at version, restore, tags", async () => {
	const repo = new FakeRepo();
	const { remote } = make(repo, { c: null });
	const a = device("A", remote as any);
	a.fs.put("n.md", "v1\n");
	await a.sync();
	const point = repo.head()!;
	a.fs.put("n.md", "v2\n");
	await a.sync();
	assert.ok((await remote.listCommits("main", "n.md", 10)).length >= 2);
	assert.equal(new TextDecoder().decode((await remote.getFileAt("n.md", point))!), "v1\n");
	assert.equal(await remote.compare(point, repo.head()!), "ahead");
	await a.engine.restoreTo(point, "", async () => true);
	assert.equal(a.fs.text("n.md"), "v1\n");
	await remote.createRef("refs/tags/snap", repo.head()!);
	assert.ok((await remote.listTags()).some((t) => t.name === "snap"));
});
