// Live tests for ANY supported host (GitHub, GitLab, Gitea/Forgejo/Codeberg, Bitbucket).
// Two simulated devices (in-memory vaults) sync through a real repository over the host's REST API.
//
//   VSG_LIVE_KIND=gitlab VSG_LIVE_TOKEN=… VSG_LIVE_REPO=me/test \
//     node --import ./tests/support/register.mjs --test --test-concurrency=1 tests/live/hosts.live.test.ts
//
// Env vars:
//   VSG_LIVE_KIND    github | gitlab | gitea | bitbucket
//   VSG_LIVE_TOKEN   access token for that host
//   VSG_LIVE_REPO    "owner/repo" (GitLab groups: "group/sub/project")
//   VSG_LIVE_API     optional API base (default: the host's public API)
//   VSG_LIVE_BRANCH  optional branch to run on (default: a fresh throwaway branch "vsg-live-<run>"
//                    created from the default branch head; an empty repo is initialised first)
//   VSG_LIVE_PR=1    also open a pull/merge request from a second throwaway branch (left open)
//
// Safety: nothing on the default branch is changed or deleted (except initialising an EMPTY repository
// with a .gitattributes file). Every test works in its own folder on the throwaway branch, and the
// branches are printed at the end so you can delete them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { HOSTS, makeRemote } from "../../src/hosts.ts";
import type { HostKind } from "../../src/hosts.ts";
import { NotFastForward } from "../../src/remote.ts";
import type { CommitRequest, Remote } from "../../src/remote.ts";
import { FOLDERS_PATH } from "../../src/sync.ts";
import { device } from "../support/fakes.ts";

const kind = (process.env.VSG_LIVE_KIND ?? "") as HostKind;
const token = process.env.VSG_LIVE_TOKEN ?? "";
const parts = (process.env.VSG_LIVE_REPO ?? "").split("/").filter(Boolean);
const repo = parts.length >= 2 ? parts[parts.length - 1] : "";
const owner = parts.length >= 2 ? parts.slice(0, -1).join("/") : "";
const validKind = Object.prototype.hasOwnProperty.call(HOSTS, kind);
const live = validKind && !!token && !!owner && !!repo;
const apiBase = process.env.VSG_LIVE_API || (validKind ? HOSTS[kind].defaultApi : "");
const run = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}-${randomBytes(2).toString("hex")}`;
const T = { timeout: 10 * 60_000 };

const remote: Remote | null = live ? makeRemote(kind, () => ({ token, apiBase, owner, repo })) : null;
const R = () => remote!;
let branch = process.env.VSG_LIVE_BRANCH ?? "";
let defaultBranch = "";
const created: string[] = [];
const notes: string[] = [];

const dec = new TextDecoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (b: ArrayBuffer | null) => (b === null ? null : dec.decode(b));

/** Retries a direct API call on transient failures (rate limits, 5xx, network errors). */
async function retry<X>(fn: () => Promise<X>, tries = 5): Promise<X> {
	for (let i = 0; ; i++) {
		try {
			return await fn();
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			const status = (e as { status?: number }).status ?? 0;
			const transient = status === 429 || status >= 500 || /HTTP (429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|socket|rate limit|timed out/i.test(msg);
			if (!transient || i >= tries - 1) throw e;
			await sleep(2000 * (i + 1));
		}
	}
}

/** Polls until `ok` accepts the value (hosts can take a moment to reflect a new commit). */
async function eventually<X>(fn: () => Promise<X>, ok: (x: X) => boolean, what: string, ms = 60_000): Promise<X> {
	const end = Date.now() + ms;
	let last: X;
	for (;;) {
		last = await retry(fn);
		if (ok(last)) return last;
		if (Date.now() > end) throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(last)?.slice(0, 500)}`);
		await sleep(2000);
	}
}

function pair(extra = {}) {
	const a = device("Mac", R() as any, { owner, repo, branch, ...extra });
	const b = device("iPhone", R() as any, { owner, repo, branch, ...extra });
	return { a, b };
}

/** Repository files (path → blob sha) at the head of a branch. */
async function remoteFiles(br = branch): Promise<Map<string, string>> {
	const head = await retry(() => R().getRef(br));
	assert.ok(head, `branch ${br} has no head`);
	const tree = await retry(async () => R().listTree(await R().getCommitTree(head)));
	return new Map(tree.filter((e) => e.type === "blob").map((e) => [e.path, e.sha]));
}

async function newBranch(name: string, from: string): Promise<void> {
	await retry(() => R().createRef(`refs/heads/${name}`, from));
	created.push(name);
	await eventually(() => R().getRef(name), (h) => h === from, `branch ${name}`);
}

const assertClean = (r: { errors: string[] }, what: string) => assert.deepEqual(r.errors, [], `${what}: ${JSON.stringify(r)}`);

before(async () => {
	if (!live) {
		console.log("Skipping live host tests: set VSG_LIVE_KIND (github|gitlab|gitea|bitbucket), VSG_LIVE_TOKEN and VSG_LIVE_REPO");
		return;
	}
	const info = await retry(() => R().getRepo());
	if (!info) throw new Error(`Repository ${owner}/${repo} not found on ${kind} (${apiBase}) or the token cannot access it.`);
	defaultBranch = info.default_branch || "main";
	let head = await retry(() => R().getRef(defaultBranch));
	if (!head) {
		// Empty repository: the only write ever made to the default branch.
		const b64 = Buffer.from("# Managed by Vault Sync for Git. Keeps git clients from rewriting line endings.\n* -text\n").toString("base64");
		await retry(() => R().putFile(".gitattributes", "Initialise vault repository (live test)", b64, defaultBranch));
		head = await eventually(() => R().getRef(defaultBranch), (h) => !!h, "initialised default branch");
		notes.push(`Initialised the empty repository on ${defaultBranch}.`);
	}
	if (!branch) {
		branch = `vsg-live-${run}`;
		await newBranch(branch, head!);
	} else if (branch === defaultBranch) {
		notes.push(`WARNING: VSG_LIVE_BRANCH is the default branch (${branch}); tests add folders t-${run}-* to it.`);
	}
	console.log(`[live ${kind}] ${owner}/${repo} via ${apiBase}, default branch ${defaultBranch}, testing on ${branch}`);
});

after(() => {
	if (!live) return;
	for (const n of notes) console.log(`[live ${kind}] ${n}`);
	if (created.length) console.log(`[live ${kind}] Throwaway branches to delete: ${created.join(", ")}`);
});

/** Folder used by one test, so tests sharing the branch never touch each other's files. */
const dir = (name: string) => `t-${run}-${name}`;

test("live host: connection (getUser, getRepo)", { ...T, skip: !live }, async () => {
	const user = await retry(() => R().getUser());
	assert.ok(user.login && typeof user.login === "string", JSON.stringify(user));
	const info = (await retry(() => R().getRepo()))!;
	assert.equal(typeof info.private, "boolean");
	assert.ok(info.default_branch, "default branch");
	assert.match(info.html_url, /^https?:\/\//);
	assert.equal(R().kind, kind);
});

test("live host: first upload of a small vault and byte-exact round trip on a second device", { ...T, skip: !live }, async () => {
	const d = dir("roundtrip");
	const { a, b } = pair();
	const bin = new Uint8Array(randomBytes(60_000));
	const files: Record<string, string> = {
		[`${d}/Hello.md`]: "# Hello\n\nFirst note.\n",
		[`${d}/Café ☕ ünïcode.md`]: "unicode name ✓ — 日本語\n",
		[`${d}/Folder With Spaces/my note.md`]: "spaces in names\n",
		[`${d}/Deep/a/b/c/nested.md`]: "deep\n",
		[`${d}/crlf.md`]: "windows\r\nline endings\r\n",
	};
	for (const [p, t] of Object.entries(files)) a.fs.put(p, t);
	a.fs.files.set(`${d}/img/photo.png`, { data: bin, mtime: 1 });
	const r1 = await a.sync();
	assertClean(r1, "upload");
	assert.equal(r1.uploaded.filter((p) => p.startsWith(d + "/")).length, 6, JSON.stringify(r1));
	assert.ok(r1.commit);

	// What the host stored must be exactly what we sent.
	for (const [p, f] of a.fs.files) {
		if (!p.startsWith(d + "/")) continue;
		const got = await retry(() => R().getFileAt(p, r1.commit!));
		assert.ok(got, `missing on host: ${p}`);
		assert.deepEqual(new Uint8Array(got), f.data, p);
	}
	assert.equal((await a.sync()).upToDate, true);

	const rb = await b.sync();
	assertClean(rb, "download");
	for (const [p, f] of a.fs.files) if (p.startsWith(d + "/")) assert.deepEqual(b.fs.files.get(p)?.data, f.data, p);
	assert.equal((await b.sync()).upToDate, true);
});

test("live host: non-overlapping edits merge across devices", { ...T, skip: !live }, async () => {
	const p = `${dir("merge")}/n.md`;
	const { a, b } = pair();
	const base = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") + "\n";
	a.fs.put(p, base);
	await a.sync();
	await b.sync();
	a.fs.put(p, base.replace("line 1\n", "line 1 (Mac)\n"));
	b.fs.put(p, base.replace("line 10\n", "line 10 (iPhone)\n"));
	assertClean(await a.sync(), "a");
	const rb = await b.sync();
	assertClean(rb, "b");
	assert.deepEqual(rb.merged, [p]);
	await a.sync();
	const want = base.replace("line 1\n", "line 1 (Mac)\n").replace("line 10\n", "line 10 (iPhone)\n");
	assert.equal(a.fs.text(p), want);
	assert.equal(b.fs.text(p), want);
});

test("live host: overlapping edits keep both versions (conflict copy)", { ...T, skip: !live }, async () => {
	const p = `${dir("conflict")}/c.md`;
	const { a, b } = pair();
	a.fs.put(p, "original\n");
	await a.sync();
	await b.sync();
	a.fs.put(p, "Mac version\n");
	b.fs.put(p, "iPhone version\n");
	await a.sync();
	const rb = await b.sync();
	assertClean(rb, "b");
	assert.equal(rb.conflictCopies.length, 1, JSON.stringify(rb));
	await a.sync();
	assert.equal(a.fs.text(p), "Mac version\n");
	assert.equal(a.fs.text(rb.conflictCopies[0]), "iPhone version\n");
	assert.equal(b.fs.text(rb.conflictCopies[0]), "iPhone version\n");
});

test("live host: deletes propagate", { ...T, skip: !live }, async () => {
	const d = dir("delete");
	const { a, b } = pair();
	for (let i = 0; i < 4; i++) a.fs.put(`${d}/${i}.md`, `${i}\n`);
	await a.sync();
	await b.sync();
	b.fs.files.delete(`${d}/0.md`);
	const rb = await b.sync();
	assertClean(rb, "b");
	assert.deepEqual(rb.deletedRemote, [`${d}/0.md`]);
	const ra = await a.sync();
	assert.deepEqual(ra.deletedLocal, [`${d}/0.md`]);
	assert.ok(!a.fs.files.has(`${d}/0.md`) && a.fs.files.has(`${d}/1.md`));
	const files = await remoteFiles();
	assert.ok(!files.has(`${d}/0.md`) && files.has(`${d}/3.md`));
});

test("live host: rename travels as a rename", { ...T, skip: !live }, async () => {
	const d = dir("rename");
	const { a, b } = pair();
	a.fs.put(`${d}/Inbox/idea.md`, "an idea worth keeping\n");
	await a.sync();
	await b.sync();
	a.fs.files.set(`${d}/Projects/idea renamed.md`, a.fs.files.get(`${d}/Inbox/idea.md`)!);
	a.fs.files.delete(`${d}/Inbox/idea.md`);
	const ra = await a.sync();
	assertClean(ra, "a");
	assert.deepEqual(ra.renamed, [`${d}/Inbox/idea.md → ${d}/Projects/idea renamed.md`]);
	const rb = await b.sync();
	assert.deepEqual(rb.renamed, [`${d}/Inbox/idea.md → ${d}/Projects/idea renamed.md`]);
	assert.equal(b.fs.text(`${d}/Projects/idea renamed.md`), "an idea worth keeping\n");
	assert.ok(!b.fs.files.has(`${d}/Inbox/idea.md`));
	const files = await remoteFiles();
	assert.ok(files.has(`${d}/Projects/idea renamed.md`) && !files.has(`${d}/Inbox/idea.md`));
});

test("live host: concurrent push is detected and retried", { ...T, skip: !live }, async () => {
	const d = dir("race");
	const { a, b } = pair();
	a.fs.put(`${d}/seed.md`, "s\n");
	await a.sync();
	await b.sync();
	a.fs.put(`${d}/from-mac.md`, "mac\n");
	b.fs.put(`${d}/from-iphone.md`, "iphone\n");
	// The iPhone pushes while the Mac is about to commit on top of the (now stale) head.
	const r = R() as Remote & { commit: (req: CommitRequest) => Promise<any> };
	const real = r.commit.bind(r);
	let detected = "";
	let raced = false;
	r.commit = async (req: CommitRequest) => {
		if (!raced) {
			raced = true;
			r.commit = async (q: CommitRequest) => {
				const res = await real(q);
				if (!detected && q.parent === req.parent && !res.fastForward) detected = "host merged onto newer head";
				return res;
			};
			assertClean(await b.sync(), "iPhone");
			try {
				const res = await real(req);
				if (!res.fastForward) detected = "host merged onto newer head";
				return res;
			} catch (e) {
				if (e instanceof NotFastForward) detected = "NotFastForward";
				throw e;
			}
		}
		return real(req);
	};
	try {
		assertClean(await a.sync(), "Mac");
	} finally {
		delete (r as any).commit; // back to the prototype method
	}
	assert.ok(detected, "the stale push was neither refused nor reported as non-fast-forward");
	notes.push(`Concurrent push detected as: ${detected}`);
	const files = await remoteFiles();
	assert.ok(files.has(`${d}/from-mac.md`) && files.has(`${d}/from-iphone.md`), [...files.keys()].join(", "));
	assert.equal(a.fs.text(`${d}/from-iphone.md`), "iphone\n");
	await b.sync();
	assert.equal(b.fs.text(`${d}/from-mac.md`), "mac\n");
});

test("live host: history APIs (listCommits path filter, getFileAt, getCommitFiles)", { ...T, skip: !live }, async () => {
	const p = `${dir("history")}/h.md`;
	const { a } = pair();
	a.fs.put(p, "version 1\n");
	const r1 = await a.sync();
	a.fs.put(p, "version 2\n");
	const r2 = await a.sync();
	assert.ok(r1.commit && r2.commit);
	const commits = await eventually(() => R().listCommits(branch, p), (c) => c.length >= 2, "two commits for path");
	assert.equal(commits.length, 2, JSON.stringify(commits));
	assert.equal(commits[0].sha, r2.commit);
	assert.equal(commits[1].sha, r1.commit);
	assert.match(commits[0].message, /^Mac: /);
	assert.ok(commits[0].date && !Number.isNaN(Date.parse(commits[0].date)), commits[0].date);
	assert.equal(text(await retry(() => R().getFileAt(p, commits[1].sha))), "version 1\n");
	assert.equal(text(await retry(() => R().getFileAt(p, commits[0].sha))), "version 2\n");

	a.fs.files.delete(p);
	const r3 = await a.sync();
	assert.ok(r3.commit);
	const detail = await retry(() => R().getCommitFiles(r3.commit!));
	assert.equal(detail.parent, r2.commit);
	assert.ok(detail.files.some((f) => f.filename === p && /removed|deleted/i.test(f.status)), JSON.stringify(detail));
	assert.equal(text(await retry(() => R().getFileAt(p, detail.parent!))), "version 2\n");
	assert.equal(await retry(() => R().getFileAt(p, r3.commit!)), null);
	const latest = await eventually(() => R().listCommits(branch, undefined, 5), (c) => c[0]?.sha === r3.commit, "latest commit on branch");
	assert.ok(latest.length >= 3);
});

test("live host: getFileAt returns binary versions byte-exact (no text transcoding)", { ...T, skip: !live }, async () => {
	// GitHub's contents endpoint returned these 60 bytes (an encrypted test note) as 90: it took them
	// for UTF-16 text and converted them to UTF-8.
	const p = `${dir("binary")}/blob.bin`;
	const bytes = new Uint8Array(Buffer.from("565347318b1fc156d504e4a183f53e35a9e7d0cd7bed6ae5dfa1607caf147ae9aac8eddc28bd7a1783d76422a0ce64fa4dfc19db6492f7d73fd3efee", "hex"));
	const { a } = pair();
	a.fs.files.set(p, { data: bytes, mtime: 1 });
	const r = await a.sync();
	assert.ok(r.commit);
	const got = await retry(() => R().getFileAt(p, r.commit!));
	assert.ok(got, "found");
	assert.deepEqual(new Uint8Array(got!), bytes);
});

test("live host: listBranches and webUrl return sane values", { ...T, skip: !live }, async () => {
	const head = (await retry(() => R().getRef(branch)))!;
	if (R().listBranches) {
		const list = await eventually(() => R().listBranches!(), (l) => l.some((x) => x.name === branch), `${branch} in listBranches`);
		assert.equal(list.find((x) => x.name === branch)!.sha, head);
		assert.ok(list.some((x) => x.name === defaultBranch), "default branch listed");
	} else notes.push("listBranches not implemented for this host");
	if (R().webUrl) {
		for (const k of ["repo", "file", "history"] as const) {
			const u = R().webUrl!(k, `${dir("roundtrip")}/Hello.md`, k === "file" ? head : branch);
			if (u !== null) {
				assert.match(u, /^https?:\/\/[^\s]+$/, `${k}: ${u}`);
				assert.doesNotThrow(() => new URL(u));
			}
			if (k === "repo") assert.ok(u, "repo web url");
		}
	} else notes.push("webUrl not implemented for this host");
});

test("live host: compare() reports ahead, behind, identical, diverged and missing", { ...T, skip: !live }, async () => {
	const d = dir("compare");
	const { a } = pair();
	a.fs.put(`${d}/x.md`, "1\n");
	const r1 = await a.sync();
	a.fs.put(`${d}/x.md`, "2\n");
	const r2 = await a.sync();
	const older = r1.commit!, newer = r2.commit!;
	assert.equal(await retry(() => R().compare(older, newer)), "ahead");
	assert.equal(await retry(() => R().compare(newer, older)), "behind");
	assert.equal(await retry(() => R().compare(newer, newer)), "identical");

	// A side branch from `older` with its own commit has diverged from `newer`.
	const side = `vsg-live-${run}-side`;
	await newBranch(side, older);
	const c = device("Side", R() as any, { owner, repo, branch: side });
	c.fs.put(`${d}/side.md`, "side\n");
	const rc = await c.sync();
	assertClean(rc, "side");
	assert.equal(await retry(() => R().compare(newer, rc.commit!)), "diverged");

	const bogus = "0123456789abcdef0123456789abcdef01234567";
	assert.equal(await retry(() => R().compare(bogus, newer)), "missing");
});

test("live host: empty folders list (.vault-sync/folders.json) round trip", { ...T, skip: !live }, async () => {
	const d = dir("folders");
	const { a, b } = pair({ keepEmptyFolders: true });
	a.fs.put(`${d}/keep.md`, "k\n");
	a.fs.dirs.add(`${d}/Empty`);
	a.fs.dirs.add(`${d}/Nested/Empty Too`);
	assertClean(await a.sync(), "a");
	const files = await remoteFiles();
	const sha = files.get(FOLDERS_PATH);
	assert.ok(sha, `${FOLDERS_PATH} missing`);
	const list = JSON.parse(dec.decode(await retry(() => R().getBlob(sha)))) as string[];
	assert.ok(list.includes(`${d}/Empty`) && list.includes(`${d}/Nested/Empty Too`), JSON.stringify(list));
	await b.sync();
	assert.ok(b.fs.dirs.has(`${d}/Empty`) && b.fs.dirs.has(`${d}/Nested/Empty Too`), [...b.fs.dirs].join(", "));

	// Removing an empty folder on one device removes it from the list and from the other device.
	b.fs.dirs.delete(`${d}/Empty`);
	assertClean(await b.sync(), "b");
	await a.sync();
	assert.ok(!a.fs.dirs.has(`${d}/Empty`) && a.fs.dirs.has(`${d}/Nested/Empty Too`), [...a.fs.dirs].join(", "));
});

test("live host: createPullRequest from a second throwaway branch (VSG_LIVE_PR=1)", { ...T, skip: !live ? true : process.env.VSG_LIVE_PR !== "1" ? "set VSG_LIVE_PR=1 to open a real pull request" : false }, async () => {
	assert.ok(R().createPullRequest, "createPullRequest not implemented for this host");
	const head = (await retry(() => R().getRef(branch)))!;
	const pr = `vsg-live-${run}-pr`;
	await newBranch(pr, head);
	const c = device("PR", R() as any, { owner, repo, branch: pr });
	c.fs.put(`${dir("pr")}/proposal.md`, "proposed change\n");
	assertClean(await c.sync(), "pr device");
	const res = await retry(() => R().createPullRequest!(pr, branch, `Vault Sync live test ${run}`, "Opened by the Vault Sync for Git live test suite. Safe to close."));
	assert.match(res.url, /^https?:\/\//);
	notes.push(`Opened pull request (please close it): ${res.url}`);
});
