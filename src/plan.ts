// Three-way sync decision logic. Pure module.
// base   = blob sha of each path at the last successful sync
// local  = blob sha of each path on this device now
// remote = blob sha of each path on GitHub now

export type SyncMode = "sync" | "push" | "pull";

export type Decision =
	| { kind: "download"; path: string; sha: string }
	| { kind: "delete-local"; path: string }
	| { kind: "upload"; path: string; sha: string }
	| { kind: "delete-remote"; path: string }
	| { kind: "conflict"; path: string; base: string | null; local: string; remote: string };

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
