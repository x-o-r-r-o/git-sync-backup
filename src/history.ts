// Pure logic behind the history sidebar and "Use the repository version": commit parsing, changed-file
// lists decoded to vault paths (encrypted names shown decrypted), filtering, and replacing a local file
// with the repository's version while keeping the old one recoverable. No Obsidian UI here (testable).

import type { CommitInfo } from "./remote.ts";
import { parentDir, stamp } from "./util.ts";

/** Commits fetched per "Load more" page in the history sidebar. */
export const HISTORY_PAGE = 30;

export interface HistoryCommit {
	sha: string;
	/** First line of the message. */
	title: string;
	date: string;
	author: string;
	/** Device that made the sync (the "Device:" trailer, or an older "Name: …" title), if known. */
	device: string | null;
	/** Plugin version from the "Plugin:" trailer, if any. */
	plugin: string | null;
}

/** Device name of a sync commit: the "Device:" trailer, else the "Name:" prefix older versions wrote. */
export function deviceOf(message: string): string | null {
	const trailer = /^Device: (.+)$/m.exec(message)?.[1]?.trim();
	if (trailer) return trailer;
	return /^([^:\n]{1,40}):/.exec(message)?.[1]?.trim() || null;
}

export function parseCommit(c: CommitInfo): HistoryCommit {
	return {
		sha: c.sha,
		title: c.message.split("\n")[0].trim() || c.sha.slice(0, 7),
		date: c.date,
		author: c.author,
		device: deviceOf(c.message),
		plugin: /^Plugin: (.+)$/m.exec(c.message)?.[1]?.trim() ?? null,
	};
}

/**
 * Appends a newly loaded page to the list, dropping commits already shown (the branch may have moved
 * between pages, which shifts later pages by the number of new commits).
 */
export function appendPage(shown: HistoryCommit[], page: CommitInfo[]): HistoryCommit[] {
	const seen = new Set(shown.map((c) => c.sha));
	return [...shown, ...page.filter((c) => !seen.has(c.sha)).map(parseCommit)];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface HistoryFile {
	/** Vault path (after the codec: decrypted, folder mapping undone). */
	path: string;
	/** Vault path before a rename. */
	previous?: string;
	status: FileStatus;
}

/** Hosts say "removed", "deleted", "changed", "copied"…: map them to the four kinds the UI shows. */
export function normalizeStatus(s: string): FileStatus {
	switch (s.toLowerCase()) {
		case "added":
		case "new":
		case "copied":
			return "added";
		case "removed":
		case "deleted":
			return "deleted";
		case "renamed":
			return "renamed";
		default:
			return "modified";
	}
}

/**
 * Changed files of a commit as vault paths. `decode` maps a repository path to its vault path (null:
 * not a file this vault manages, such as the encryption marker or a path outside a mapped folder);
 * those are left out. A rename whose old name isn't ours is shown as an addition.
 */
export async function decodeCommitFiles(
	files: { filename: string; status: string; previous?: string }[],
	decode: (raw: string) => Promise<string | null>,
): Promise<HistoryFile[]> {
	const out: HistoryFile[] = [];
	for (const f of files) {
		const path = await decode(f.filename).catch(() => null);
		if (!path) continue;
		let status = normalizeStatus(f.status);
		let previous: string | undefined;
		if (status === "renamed") {
			previous = f.previous ? ((await decode(f.previous).catch(() => null)) ?? undefined) : undefined;
			if (!previous && f.previous) status = "added";
		}
		out.push(previous ? { path, previous, status } : { path, status });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Files whose path (or old path) contains `query`, ignoring case; everything for an empty query. */
export function filterFiles(files: HistoryFile[], query: string): HistoryFile[] {
	const q = query.trim().toLowerCase();
	if (!q) return files;
	return files.filter((f) => f.path.toLowerCase().includes(q) || !!f.previous?.toLowerCase().includes(q));
}

/** Repository path of a file's previous version for a diff: the old name for a rename. */
export function parentPathOf(f: HistoryFile): string {
	return f.previous ?? f.path;
}

// ---------------- Use the repository version ----------------

/** What the vault needs for a recoverable replace (VaultIO provides it). */
export interface ReplaceIO {
	read(path: string): Promise<ArrayBuffer>;
	stat(path: string): Promise<{ mtime: number; size: number } | null>;
	write(path: string, data: ArrayBuffer): Promise<void>;
	/** To the system trash, else the vault's .trash folder, whatever the "deleted files" preference. */
	removeRecoverable(path: string): Promise<void>;
}

/** Name the replaced local version gets in the trash: "Note (this device 2026-10-13 1200).md". */
export function replacedCopyPath(path: string, d = new Date(), n = 1): string {
	const dir = parentDir(path);
	const file = dir ? path.slice(dir.length + 1) : path;
	const dot = file.lastIndexOf(".");
	const name = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	const out = `${name} (this device ${stamp(d)}${n > 1 ? `-${n}` : ""})${ext}`;
	return dir ? `${dir}/${out}` : out;
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const x = new Uint8Array(a);
	const y = new Uint8Array(b);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

export type ReplaceResult =
	/** The local file now has the repository's content; the old content is in the trash as `trashedAs`. */
	| { kind: "replaced"; trashedAs: string }
	/** There was no local file: the repository's version was written. */
	| { kind: "restored" }
	/** Already identical: nothing changed. */
	| { kind: "same" }
	/** The repository has no such file: nothing changed. */
	| { kind: "missing" };

/**
 * Replaces a local file with `remote` (the repository's decoded content). The local version is first
 * copied under a dated name and that copy moved to the recoverable trash, so nothing is ever lost; the
 * file itself is then modified in place (open editors keep the note, links and history stay intact).
 * The next sync finds the file equal to the repository and uploads nothing for it.
 */
export async function replaceWithRepositoryVersion(io: ReplaceIO, path: string, remote: ArrayBuffer | null, now = new Date()): Promise<ReplaceResult> {
	if (!remote) return { kind: "missing" };
	if (!(await io.stat(path))) {
		await io.write(path, remote);
		return { kind: "restored" };
	}
	const local = await io.read(path);
	if (sameBytes(local, remote)) return { kind: "same" };
	let copy = replacedCopyPath(path, now);
	for (let n = 2; (await io.stat(copy)) && n < 100; n++) copy = replacedCopyPath(path, now, n);
	if (await io.stat(copy)) throw new Error(`${copy} already exists`);
	await io.write(copy, local);
	// Throws if the copy can't be trashed: the copy then simply stays in the vault, the file is untouched.
	await io.removeRecoverable(copy);
	await io.write(path, remote);
	return { kind: "replaced", trashedAs: copy };
}
