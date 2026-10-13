// Gitee and Azure DevOps shipped in 1.3.0 and were removed in 1.4.0. Settings saved with them must never
// be redirected to another host (that could push the vault to an unrelated repository), so they are
// turned into "not configured" instead, and the user picks a new host themselves. Pure module.

import type { MirrorTarget, Provider, SharedFolder, VaultSyncSettings } from "./types.ts";

export const PROVIDERS: readonly Provider[] = ["github", "gitlab", "gitea", "bitbucket"];

export function isKnownProvider(p: unknown): p is Provider {
	return typeof p === "string" && (PROVIDERS as readonly string[]).includes(p);
}

/** What a removed host was used for, kept so the user can see what to set up again. */
export interface RemovedHostRecord {
	provider: string;
	owner: string;
	repo: string;
	branch: string;
}

export interface RemovedHostsResult {
	/** The main repository used a removed host: sync is paused until a new host and repository are set. */
	main: RemovedHostRecord | null;
	/** The backup mirror used a removed host: it is turned off. */
	mirror: RemovedHostRecord | null;
	/** Shared folders on a removed host (left as they are; they are skipped at runtime). */
	shared: string[];
}

/**
 * Normalizes settings loaded from data.json in place. The main repository on a removed host keeps its
 * other settings, but loses its owner and repository (recorded in `removedHost`), so no sync can run until
 * the user enters a repository again; the host is shown as GitHub only because a picker needs a value.
 * A mirror on a removed host is turned off the same way. Shared folders stay untouched: their folder stays
 * out of the main repository, and the plugin skips them (see `isKnownProvider`).
 */
export function dropRemovedHosts(s: VaultSyncSettings): RemovedHostsResult {
	const out: RemovedHostsResult = { main: null, mirror: null, shared: [] };
	if (!isKnownProvider(s.provider)) {
		out.main = { provider: String(s.provider), owner: s.owner ?? "", repo: s.repo ?? "", branch: s.branch ?? "" };
		s.removedHost = out.main;
		s.provider = "github";
		s.owner = "";
		s.repo = "";
	}
	const m = s.mirror;
	if (m && !isKnownProvider(m.provider)) {
		out.mirror = { provider: String(m.provider), owner: m.owner ?? "", repo: m.repo ?? "", branch: m.branch ?? "" };
		const off: MirrorTarget = { ...m, enabled: false, provider: "github", owner: "", repo: "" };
		s.mirror = off;
	}
	for (const f of s.sharedFolders ?? []) if (!isKnownProvider(f.provider)) out.shared.push(f.folder);
	return out;
}

/** True while the main repository still points at a removed host (set by dropRemovedHosts). */
export function removedHostPending(s: VaultSyncSettings): boolean {
	return !!s.removedHost && (!s.owner || !s.repo);
}

/** The main repository must not sync: it is (or was, until a new repository is entered) on a removed host. */
export function mainSyncBlocked(s: VaultSyncSettings): boolean {
	return removedHostPending(s) || !isKnownProvider(s.provider);
}

/** The mirror to upload to, or null (off, incomplete, or on a removed host). */
export function syncableMirror(m: MirrorTarget | null | undefined): MirrorTarget | null {
	return m?.enabled && m.owner && m.repo && isKnownProvider(m.provider) ? m : null;
}

/** Shared folders that can sync (on, complete, and on a supported host). */
export function syncableSharedFolders(list: SharedFolder[] | null | undefined): SharedFolder[] {
	return (list ?? []).filter((f) => f.enabled && f.folder && f.owner && f.repo && isKnownProvider(f.provider));
}

/** Which notice to show after loading settings: "main" (sync paused), "other" (mirror or shared folders), or none. */
export function removedHostNotice(r: RemovedHostsResult, s: VaultSyncSettings): "main" | "other" | null {
	if (r.main || removedHostPending(s)) return "main";
	return r.mirror || r.shared.length ? "other" : null;
}
