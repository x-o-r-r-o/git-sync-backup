import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.ts";
import { NotFastForward } from "../src/remote.ts";

const enc = new TextEncoder();
function client(ffOk = true) {
	const gh = new GitHub(() => ({ token: "t", apiBase: "https://api.github.com", owner: "o", repo: "r" }));
	const calls = { trees: [] as any[][], blobs: 0, commits: 0 };
	let n = 0;
	Object.assign(gh, {
		createTree: async (_base: string, entries: any[]) => (calls.trees.push(entries), `t${n++}`),
		createBlob: async () => (calls.blobs++, `b${n++}`),
		createCommit: async () => (calls.commits++, `c${n++}`),
		updateRef: async () => ffOk,
		getRef: async () => "p",
	});
	return { gh, calls };
}

test("GitHub.commit: inline text, blobs for binary, chained tree chunks, one commit", async () => {
	const { gh, calls } = client();
	const upserts = Array.from({ length: 900 }, (_, i) => ({
		path: `n${i}.md`,
		mode: "100644",
		load: async () => enc.encode(`note ${i}\n`).buffer as ArrayBuffer,
		text: (b: ArrayBuffer) => new TextDecoder().decode(b),
	}));
	upserts.push({ path: "img.png", mode: "100644", load: async () => new Uint8Array([0, 1, 2]).buffer as ArrayBuffer, text: () => null as unknown as string });
	const res = await gh.commit({ branch: "main", parent: "p", parentTree: "pt", message: "m", upserts, deletes: ["old.md"] });
	assert.equal(res.fastForward, true);
	assert.equal(calls.commits, 1);
	assert.equal(calls.blobs, 1, "only the binary needs a blob call");
	assert.ok(calls.trees.length >= 3, "chunked");
	const all = calls.trees.flat();
	assert.equal(all.filter((e) => e.content).length, 900);
	assert.ok(all.some((e) => e.path === "old.md" && e.sha === null));
});

test("GitHub.commit: reuses known blob shas and reports non-fast-forward", async () => {
	const { gh, calls } = client(false);
	await assert.rejects(
		() => gh.commit({ branch: "main", parent: "p", parentTree: "pt", message: "m", upserts: [{ path: "a", mode: "100644", sha: "abc", load: async () => { throw new Error("should not load"); } }], deletes: [] }),
		(e) => e instanceof NotFastForward,
	);
	assert.deepEqual(calls.trees[0], [{ path: "a", mode: "100644", type: "blob", sha: "abc" }]);
});
