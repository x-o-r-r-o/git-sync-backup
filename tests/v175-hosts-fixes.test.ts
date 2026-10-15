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
	test(`${h.name}: a file over a path the vault leaves out (a symlink) is updated, not created`, async () => {
		const repo = new FakeRepo();
		const remote = h.make(repo);
		const a = device("A", remote as any);
		a.fs.put("note.md", "n\n");
		await a.sync();
		// Someone commits a symlink with git; the plugin doesn't sync symlinks.
		const head = repo.head()!;
		const files = new Map(repo.commits.get(head)!.files);
		files.set("link.md", await repo.blob(new TextEncoder().encode("note.md")));
		repo.modes.set("link.md", "120000");
		repo.branches.set("main", repo.commit(files, [head], "add symlink"));
		// This device then has a real note at that path.
		a.fs.put("link.md", "a real note\n");
		const r = await a.sync();
		assert.equal(r.errors?.length ?? 0, 0, JSON.stringify(r.errors));
		assert.equal(repo.files().get("link.md"), "a real note\n");
	});
}

test("HTTP: a request that changes the repository isn't repeated after a server or network error", async () => {
	const { httpRequest } = await import("../src/http.ts");
	const run = async (method: string, fail: "502" | "network", idempotent = false) => {
		let calls = 0;
		const transport = async () => {
			calls++;
			if (fail === "network") throw new Error("socket hang up");
			return { status: 502, json: { message: "Bad gateway" }, arrayBuffer: new ArrayBuffer(0), headers: {} };
		};
		await assert.rejects(httpRequest(transport, { url: "https://h.test/x", method, headers: {} }, { hostLabel: "Host", wait: async () => {}, idempotent }));
		return calls;
	};
	assert.equal(await run("POST", "502"), 1, "a commit is sent once");
	assert.equal(await run("POST", "network"), 1);
	assert.equal(await run("PUT", "502"), 1);
	assert.equal(await run("GET", "502"), 4, "reads are retried");
	assert.equal(await run("GET", "network"), 4);
	assert.equal(await run("POST", "502", true), 4, "safe writes (LFS) are retried");
});

test("history reads are checked: a cut-off body or wrong blob is refused, not restored", async () => {
	const { lengthMatches } = await import("../src/http.ts");
	const { gitBlobSha } = await import("../src/util.ts");
	const body = new TextEncoder().encode("full note text\n").buffer as ArrayBuffer;
	const res = (headers: Record<string, string>) => ({ status: 200, json: null, arrayBuffer: body, headers });
	assert.equal(lengthMatches(res({ "Content-Length": String(body.byteLength) })), true);
	assert.equal(lengthMatches(res({ "content-length": "999" })), false, "cut off");
	assert.equal(lengthMatches(res({ "Content-Length": "5", "Content-Encoding": "gzip" })), true, "compressed: length counts compressed bytes");
	assert.equal(lengthMatches(res({})), true, "unknown length passes");

	const sha = await gitBlobSha(body);
	const gl = (blobId: string) =>
		new GitLab(() => ({ token: "t", apiBase: "https://gitlab.test/api/v4", owner: "me", repo: "vault" }), async () => ({ status: 200, json: null, arrayBuffer: body, headers: { "X-Gitlab-Blob-Id": blobId } }));
	assert.equal(new TextDecoder().decode((await gl(sha).getFileAt("n.md", "main"))!), "full note text\n");
	await assert.rejects(gl("0".repeat(40)).getFileAt("n.md", "main"), /incompleteDownload|couldn't be downloaded completely/);
});
