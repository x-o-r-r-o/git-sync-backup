import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/types.ts";
import type { MirrorTarget, SharedFolder, VaultSyncSettings } from "../src/types.ts";
import { dropRemovedHosts, isKnownProvider, mainSyncBlocked, removedHostNotice, removedHostPending, syncableMirror, syncableSharedFolders } from "../src/removed-hosts.ts";
import { HOSTS, makeRemote } from "../src/hosts.ts";
import { buildSetupLink, parseSetupPayload } from "../src/setuplink.ts";
import { SharedFolderHost } from "../src/shared.ts";

// data.json as 1.3.0 saved it, with hosts that 1.4.0 no longer supports.
function loaded(saved: Record<string, unknown>): VaultSyncSettings {
	return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(JSON.stringify(saved))) as VaultSyncSettings;
}
const shared = (provider: string, folder = "Team"): SharedFolder => ({ id: folder.toLowerCase(), folder, provider: provider as never, owner: "team", repo: "notes", branch: "main", enabled: true });
const cfg = () => ({ token: "t", apiBase: "https://example.invalid", owner: "o", repo: "r" });

test("removed hosts: only GitHub, GitLab, Gitea and Bitbucket remain", () => {
	assert.deepEqual(Object.keys(HOSTS).sort(), ["bitbucket", "gitea", "github", "gitlab"]);
	for (const k of ["github", "gitlab", "gitea", "bitbucket"]) assert.ok(isKnownProvider(k));
	for (const k of ["gitee", "azure", "", undefined, null, 3, "GITHUB"]) assert.ok(!isKnownProvider(k), String(k));
});

test("removed hosts: makeRemote never falls back to another host", () => {
	for (const k of ["gitee", "azure", "nope"]) assert.throws(() => makeRemote(k as never, cfg), /Unsupported Git host/);
	assert.equal(makeRemote("github", cfg).kind, "github");
	assert.equal(makeRemote("gitea", cfg).kind, "gitea");
});

test("removed hosts: main repository on Gitee pauses sync instead of switching to GitHub", () => {
	const s = loaded({ provider: "gitee", owner: "me", repo: "vault", branch: "master", intervalMin: 5, excludePatterns: "secret/" });
	const r = dropRemovedHosts(s);
	assert.deepEqual(r.main, { provider: "gitee", owner: "me", repo: "vault", branch: "master" });
	assert.equal(r.mirror, null);
	assert.deepEqual(r.shared, []);
	// No repository to push to: whatever host the picker shows, nothing can sync to me/vault elsewhere.
	assert.equal(s.provider, "github");
	assert.equal(s.owner, "");
	assert.equal(s.repo, "");
	assert.deepEqual(s.removedHost, r.main, "what it pointed at is kept for the user");
	assert.ok(removedHostPending(s));
	assert.ok(mainSyncBlocked(s));
	assert.equal(removedHostNotice(r, s), "main");
	// Everything else is kept.
	assert.equal(s.branch, "master");
	assert.equal(s.intervalMin, 5);
	assert.equal(s.excludePatterns, "secret/");
});

test("removed hosts: the pause survives a save and reload until a repository is entered", () => {
	const s = loaded({ provider: "azure", owner: "org/project", repo: "vault" });
	dropRemovedHosts(s);
	// Saved (e.g. after another setting changed) and loaded again, maybe on another device.
	const again = loaded(s as unknown as Record<string, unknown>);
	const r = dropRemovedHosts(again);
	assert.equal(r.main, null, "nothing left to migrate");
	assert.ok(mainSyncBlocked(again), "still paused");
	assert.equal(removedHostNotice(r, again), "main", "a device that hasn't seen it yet gets the notice");
	// Only the user choosing a repository ends the pause.
	again.owner = "me";
	assert.ok(mainSyncBlocked(again), "owner alone is not enough");
	again.repo = "vault-on-github";
	assert.ok(!mainSyncBlocked(again));
});

test("removed hosts: an unknown provider blocks sync even without the migration", () => {
	const s = loaded({ provider: "azure", owner: "o", repo: "r" });
	assert.ok(mainSyncBlocked(s));
});

test("removed hosts: supported settings are left exactly as they are", () => {
	const saved = { provider: "gitlab", owner: "me", repo: "vault", mirror: { enabled: true, provider: "gitea", owner: "me", repo: "backup", branch: "main" }, sharedFolders: [shared("bitbucket")] };
	const s = loaded(saved);
	const before = JSON.stringify(s);
	const r = dropRemovedHosts(s);
	assert.deepEqual(r, { main: null, mirror: null, shared: [] });
	assert.equal(JSON.stringify(s), before);
	assert.ok(!mainSyncBlocked(s));
	assert.equal(removedHostNotice(r, s), null);
	assert.equal(syncableMirror(s.mirror)?.repo, "backup");
	assert.equal(syncableSharedFolders(s.sharedFolders).length, 1);
});

test("removed hosts: a mirror on Azure DevOps is turned off, not redirected", () => {
	const mirror: MirrorTarget = { enabled: true, provider: "azure" as never, owner: "org/project", repo: "backup", branch: "main" };
	const s = loaded({ provider: "github", owner: "me", repo: "vault", mirror });
	const r = dropRemovedHosts(s);
	assert.deepEqual(r.mirror, { provider: "azure", owner: "org/project", repo: "backup", branch: "main" });
	assert.equal(s.mirror?.enabled, false);
	assert.equal(s.mirror?.owner, "");
	assert.equal(s.mirror?.repo, "");
	assert.equal(syncableMirror(s.mirror), null);
	assert.ok(!mainSyncBlocked(s), "the main repository keeps syncing");
	assert.equal(removedHostNotice(r, s), "other");
	// Even unmigrated (e.g. settings changed while running), the mirror is skipped.
	assert.equal(syncableMirror(mirror), null);
});

test("removed hosts: a shared folder on Gitee is skipped and stays out of the main repository", () => {
	const s = loaded({ provider: "github", owner: "me", repo: "vault", sharedFolders: [shared("gitee", "Team"), shared("github", "Family")] });
	const r = dropRemovedHosts(s);
	assert.deepEqual(r.shared, ["Team"]);
	assert.equal(s.sharedFolders[0].provider as string, "gitee", "left untouched (still excluded from the main repository)");
	assert.ok(s.sharedFolders[0].enabled);
	assert.deepEqual(syncableSharedFolders(s.sharedFolders).map((f) => f.folder), ["Family"]);
	assert.equal(removedHostNotice(r, s), "other");
	// A host is never built for it: constructing one fails loudly instead of syncing somewhere else.
	const plugin = { blobCacheStore: () => null, sharedToken: () => "", borrowedAuth: () => ({}), getApiBaseFor: () => "" };
	assert.throws(() => new SharedFolderHost(plugin as never, s.sharedFolders[0]), /Unsupported Git host/);
});

test("removed hosts: setup links naming Gitee or Azure DevOps are refused", () => {
	for (const provider of ["gitee", "azure"]) {
		const link = buildSetupLink({ v: 1, provider: provider as never, owner: "me", repo: "vault", branch: "main" });
		assert.equal(parseSetupPayload(new URL(link).searchParams.get("s") ?? ""), null, provider);
	}
	const ok = buildSetupLink({ v: 1, provider: "bitbucket", owner: "me", repo: "vault", branch: "main" });
	assert.equal(parseSetupPayload(new URL(ok).searchParams.get("s") ?? "")?.provider, "bitbucket");
});
