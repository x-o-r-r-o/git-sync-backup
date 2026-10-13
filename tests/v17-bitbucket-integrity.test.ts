import { test } from "node:test";
import assert from "node:assert/strict";
import { Bitbucket, IncompleteDownload } from "../src/bitbucket.ts";
import type { BlobCache } from "../src/bitbucket.ts";
import { FakeRepo, bitbucketTransport } from "./support/fakehosts.ts";
import { device } from "./support/fakes.ts";
import { gitBlobSha } from "../src/util.ts";

type Opts = Parameters<typeof bitbucketTransport>[1];

function make(repo: FakeRepo, store: { c: BlobCache | null }, opts: Opts = {}) {
	const bb = bitbucketTransport(repo, opts);
	const remote = new Bitbucket(
		() => ({ token: "t", apiBase: "https://bb.test/2.0", owner: "me", repo: "vault" }),
		{ load: async () => store.c, save: async (c) => void (store.c = JSON.parse(JSON.stringify(c))) },
		bb.transport,
	);
	return { remote, calls: bb.calls };
}

const te = new TextEncoder();

async function seed(repo: FakeRepo, files: Record<string, string>) {
	const m = new Map<string, string>();
	for (const [p, c] of Object.entries(files)) m.set(p, await repo.blob(te.encode(c)));
	repo.branches.set("main", repo.commit(m, [], "seed"));
	return repo.head()!;
}

test("Bitbucket: a cut-off download in a full listing throws and leaves the hash index unwritten", async () => {
	const repo = new FakeRepo();
	const head = await seed(repo, { "a.md": "alpha alpha alpha\n", "dir/b.md": "bravo bravo bravo\n" });
	const store = { c: null as BlobCache | null };
	let cut = true;
	const { remote } = make(repo, store, { truncate: (p) => cut && p === "dir/b.md" });
	await assert.rejects(remote.listTree(head), (e: unknown) => {
		assert.ok(e instanceof IncompleteDownload);
		assert.match((e as Error).message, /"dir\/b\.md" couldn't be downloaded completely from Bitbucket \(got 9 of 18 bytes\)/);
		return true;
	});
	assert.equal(store.c, null, "nothing saved");

	// The next attempt (download intact) indexes the real content.
	cut = false;
	const tree = await remote.listTree(head);
	const b = tree.find((e) => e.path === "dir/b.md")!;
	assert.equal(b.sha, await gitBlobSha(te.encode("bravo bravo bravo\n").buffer as ArrayBuffer));
	assert.equal(b.size, 18);
	assert.equal(store.c!.blobs[b.sha].size, 18);
});

test("Bitbucket: a cut-off download of a changed file stops the incremental update instead of indexing it", async () => {
	const repo = new FakeRepo();
	const first = await seed(repo, { "a.md": "one\n", "b.md": "two\n" });
	const store = { c: null as BlobCache | null };
	let cut = false;
	const A = make(repo, store, { truncate: (p) => cut && p === "b.md" });
	await A.remote.listTree(first);
	const saved = JSON.stringify(store.c);
	const files = new Map(repo.commits.get(first)!.files);
	files.set("b.md", await repo.blob(te.encode("two, now much longer\n")));
	const second = repo.commit(files, [first], "edit");
	repo.branches.set("main", second);
	cut = true;
	const before = A.calls.raw;
	await assert.rejects(A.remote.listTree(second), IncompleteDownload);
	assert.equal(A.calls.raw - before, 1, "no fallback to a full re-download");
	assert.equal(JSON.stringify(store.c), saved, "hash index unchanged");
	cut = false;
	const tree = await A.remote.listTree(second);
	assert.equal(tree.find((e) => e.path === "b.md")!.size, 21);
});

test("Bitbucket: getBlob rejects a cut-off body (listing size, Content-Length, or hash mismatch)", async () => {
	const repo = new FakeRepo();
	const head = await seed(repo, { "n.md": "the full note body\n" });
	const store = { c: null as BlobCache | null };
	let cut = false;
	const { remote } = make(repo, store, { truncate: (p) => cut && p === "n.md" });
	const [entry] = await remote.listTree(head);
	cut = true;
	await assert.rejects(remote.getBlob(entry.sha), /couldn't be downloaded completely from Bitbucket \(got 9 of 19 bytes\)/);

	// Older caches have no size with the blob: the file entry's size is used.
	delete store.c!.blobs[entry.sha].size;
	const old = make(repo, store, { truncate: () => true });
	await assert.rejects(old.remote.getBlob(entry.sha), /got 9 of 19 bytes/);

	// No size anywhere: Content-Length catches it.
	const bare: BlobCache = { commit: "x", files: {}, blobs: { [entry.sha]: { path: "n.md", commit: head } } };
	const cl = make(repo, { c: bare }, { truncate: () => true, contentLength: true });
	await assert.rejects(cl.remote.getBlob(entry.sha), /got 9 of 19 bytes/);

	// Nothing to compare the length with: the hash still doesn't match.
	const nothing = make(repo, { c: JSON.parse(JSON.stringify(bare)) as BlobCache }, { truncate: () => true });
	await assert.rejects(nothing.remote.getBlob(entry.sha), /couldn't be downloaded completely from Bitbucket \(the content doesn't match\)/);

	cut = false;
	assert.equal(new TextDecoder().decode(await remote.getBlob(entry.sha)), "the full note body\n");
});

test("Bitbucket: a sync with a cut-off download never stores the truncated note, and the next sync recovers", async () => {
	const repo = new FakeRepo();
	const A = make(repo, { c: null });
	const a = device("A", A.remote as any);
	a.fs.put("Notes/long.md", "a fairly long note that should arrive whole\n");
	a.fs.put("Notes/short.md", "short\n");
	await a.sync();

	let cut = true;
	const B = make(repo, { c: null }, { truncate: (p) => cut && p === "Notes/long.md" });
	const b = device("B", B.remote as any);
	await b.sync().catch(() => undefined);
	assert.ok(!b.fs.files.has("Notes/long.md") || b.fs.text("Notes/long.md") === "a fairly long note that should arrive whole\n");

	cut = false;
	await b.sync();
	assert.equal(b.fs.text("Notes/long.md"), "a fairly long note that should arrive whole\n");
	assert.equal(b.fs.text("Notes/short.md"), "short\n");
});
