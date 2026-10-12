// Three-way sync decision logic. Pure module.
// base   = blob sha of each path at the last successful sync
// local  = blob sha of each path on this device now
// remote = blob sha of each path on GitHub now

export type SyncMode = "sync" | "push" | "pull";

export type Decision =
	| { kind: "download"; path: string; sha: string }
	| { kind: "delete-local"; path: string }
	| { kind: "upload"; path: string; sha: string; renamedFrom?: string }
	| { kind: "delete-remote"; path: string; renamedTo?: string }
	| { kind: "conflict"; path: string; base: string | null; local: string; remote: string }
	// Renamed on GitHub: rename the local file instead of delete + re-download. `upload` is set when the
	// local file was edited meanwhile, so the edit is pushed under the new name.
	| { kind: "move-local"; path: string; from: string; sha: string; upload?: string }
	// Renamed here, edited on GitHub: bring GitHub's edit into the new name and drop the old path.
	| { kind: "adopt-remote-edit"; path: string; from: string; sha: string };

export interface Plan {
	decisions: Decision[];
	// New base for every path that needs no action (unchanged, identical, or ignored by mode).
	settled: Record<string, string>;
}

export function decide(
	base: Record<string, string>,
	local: Map<string, string>,
	remote: Map<string, string>,
	mode: SyncMode,
	inScope: (path: string) => boolean = () => true,
): Plan {
	const decisions: Decision[] = [];
	const settled: Record<string, string> = {};
	const paths = new Set<string>([...Object.keys(base).filter(inScope), ...local.keys(), ...remote.keys()]);

	const keep = (path: string, b: string | null) => {
		if (b) settled[path] = b;
	};

	for (const path of [...paths].sort()) {
		const b = base[path] ?? null;
		const l = local.get(path) ?? null;
		const r = remote.get(path) ?? null;

		if (l === r) {
			if (l) settled[path] = l;
			continue;
		}

		if (l === b) {
			// Only remote changed.
			if (mode === "push") keep(path, b);
			else if (r) decisions.push({ kind: "download", path, sha: r });
			else decisions.push({ kind: "delete-local", path });
			continue;
		}

		if (r === b) {
			// Only local changed.
			if (mode === "pull") keep(path, b);
			else if (l) decisions.push({ kind: "upload", path, sha: l });
			else decisions.push({ kind: "delete-remote", path });
			continue;
		}

		// Both sides changed differently. An edit always beats a deletion.
		if (mode === "push") {
			if (l) decisions.push({ kind: "upload", path, sha: l });
			else keep(path, b);
		} else if (!l && r) {
			decisions.push({ kind: "download", path, sha: r });
		} else if (l && !r) {
			if (mode === "pull") keep(path, b);
			else decisions.push({ kind: "upload", path, sha: l });
		} else if (l && r) {
			decisions.push({ kind: "conflict", path, base: b, local: l, remote: r });
		}
	}
	return { decisions, settled };
}

/**
 * Turns delete + add pairs with identical content into renames. Exact content match only: renaming a
 * note in Obsidian never changes the note itself (link updates touch other files).
 */
export function detectRenames(
	decisions: Decision[],
	base: Record<string, string>,
	local: Map<string, string>,
	remote: Map<string, string>,
): Decision[] {
	const used = new Set<string>();
	const out = new Map<string, Decision>();

	// Candidate "new" paths, indexed by the content they carry.
	const remoteAdds = new Map<string, string[]>(); // sha -> new paths added on GitHub
	const localAdds = new Map<string, string[]>(); // sha -> new paths added here
	for (const d of decisions) {
		if (d.kind === "download" && !base[d.path] && !local.has(d.path)) push(remoteAdds, d.sha, d.path);
		if (d.kind === "upload" && !base[d.path] && !remote.has(d.path)) push(localAdds, d.sha, d.path);
	}
	const take = (m: Map<string, string[]>, sha: string): string | undefined => {
		const list = m.get(sha);
		while (list?.length) {
			const p = list.shift()!;
			if (!used.has(p)) return p;
		}
		return undefined;
	};

	for (const d of decisions) {
		if (used.has(d.path)) continue;
		const b = base[d.path];
		if (!b) continue;
		const l = local.get(d.path);
		const r = remote.get(d.path);

		// Renamed on GitHub (old path gone remotely, same content appeared at a new path).
		if (!r && (d.kind === "delete-local" || d.kind === "upload")) {
			const to = take(remoteAdds, b);
			if (to) {
				used.add(d.path).add(to);
				out.set(to, { kind: "move-local", path: to, from: d.path, sha: b, ...(l && l !== b ? { upload: l } : {}) });
				continue;
			}
		}
		// Renamed here (old path gone locally, same content at a new local path).
		if (!l && (d.kind === "delete-remote" || d.kind === "download")) {
			const to = take(localAdds, b);
			if (to) {
				used.add(d.path).add(to);
				if (d.kind === "delete-remote") {
					out.set(d.path, { kind: "delete-remote", path: d.path, renamedTo: to });
					out.set(to, { kind: "upload", path: to, sha: b, renamedFrom: d.path });
				} else {
					out.set(to, { kind: "adopt-remote-edit", path: to, from: d.path, sha: r! });
				}
			}
		}
	}

	const result: Decision[] = [];
	for (const d of decisions) {
		if (!used.has(d.path)) result.push(d);
		else if (out.has(d.path)) result.push(out.get(d.path)!);
	}
	return result;
}

function push(m: Map<string, string[]>, k: string, v: string) {
	const list = m.get(k);
	if (list) list.push(v);
	else m.set(k, [v]);
}
