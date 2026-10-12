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
	| { kind: "move-local"; path: string; from: string; sha: string; upload?: string; replace?: boolean }
	// Renamed here, edited on GitHub: bring GitHub's edit into the new name and drop the old path.
	| { kind: "adopt-remote-edit"; path: string; from: string; sha: string }
	// Renamed (and edited) on one side while the other side edited the old file: merge both edits under
	// the new name. `side` says where the rename happened. Shas: base of the old path, the renamed side's
	// version at `path` (or at `from` for side "remote"), and the other side's edited old file.
	| { kind: "rename-merge"; path: string; from: string; side: "local" | "remote"; base: string; local: string; remote: string };

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

export interface SimilarityInput {
	/** Text of each candidate file, or null if unknown/binary/too big. */
	text: (side: "base" | "local" | "remote", path: string, sha: string) => Promise<string | null>;
	similarity: (a: string, b: string) => number;
	threshold?: number;
	maxCandidates?: number;
}

const ext = (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".")).toLowerCase() : "");

/**
 * Second pass after detectRenames: pairs the remaining delete + add decisions whose contents are
 * similar (renamed AND edited). Only same-extension text files are compared.
 */
export async function detectSimilarRenames(
	decisions: Decision[],
	base: Record<string, string>,
	local: Map<string, string>,
	remote: Map<string, string>,
	io: SimilarityInput,
): Promise<Decision[]> {
	const threshold = io.threshold ?? 0.5;
	const max = io.maxCandidates ?? 30;
	// Renamed on GitHub: old path gone remotely, a new path appeared remotely.
	const remoteOld = decisions.filter((d) => (d.kind === "delete-local" || d.kind === "upload") && base[d.path] && !remote.has(d.path) && !("renamedFrom" in d && d.renamedFrom));
	const remoteNew = decisions.filter((d) => d.kind === "download" && !base[d.path] && !local.has(d.path));
	// Renamed here: old path gone locally, a new path appeared locally.
	const localOld = decisions.filter((d) => (d.kind === "delete-remote" || d.kind === "download") && base[d.path] && !local.has(d.path) && !("renamedTo" in d && d.renamedTo));
	const localNew = decisions.filter((d) => d.kind === "upload" && !base[d.path] && !remote.has(d.path) && !d.renamedFrom);

	const replace = new Map<string, Decision | null>(); // path -> replacement (null = drop)
	const pair = async (olds: Decision[], news: Decision[], newSide: "local" | "remote") => {
		if (!olds.length || !news.length || olds.length > max || news.length > max) return;
		const used = new Set<string>();
		for (const o of olds) {
			const baseText = await io.text("base", o.path, base[o.path]);
			if (baseText === null) continue;
			let best: { d: Decision; score: number } | null = null;
			for (const n of news) {
				if (used.has(n.path) || ext(n.path) !== ext(o.path)) continue;
				const sha = newSide === "remote" ? remote.get(n.path)! : local.get(n.path)!;
				const t = await io.text(newSide, n.path, sha);
				if (t === null) continue;
				const score = io.similarity(baseText, t);
				if (score >= threshold && (!best || score > best.score)) best = { d: n, score };
			}
			if (!best) continue;
			used.add(best.d.path);
			const to = best.d.path;
			const from = o.path;
			if (newSide === "remote") {
				const lOld = local.get(from)!;
				const rNew = remote.get(to)!;
				if (lOld === base[from]) {
					// Renamed + edited on GitHub, untouched here: rename locally, then take the new content.
					replace.set(to, { kind: "move-local", path: to, from, sha: rNew, replace: true });
				} else {
					replace.set(to, { kind: "rename-merge", path: to, from, side: "remote", base: base[from], local: lOld, remote: rNew });
				}
			} else {
				const lNew = local.get(to)!;
				const rOld = remote.get(from)!;
				if (rOld === base[from]) {
					// Renamed + edited here, untouched on GitHub: a plain upload + delete, labelled as a rename.
					replace.set(from, { kind: "delete-remote", path: from, renamedTo: to });
					replace.set(to, { kind: "upload", path: to, sha: lNew, renamedFrom: from });
					continue;
				}
				replace.set(to, { kind: "rename-merge", path: to, from, side: "local", base: base[from], local: lNew, remote: rOld });
			}
			replace.set(from, null);
		}
	};
	await pair(remoteOld, remoteNew, "remote");
	await pair(localOld, localNew, "local");
	if (!replace.size) return decisions;
	const out: Decision[] = [];
	for (const d of decisions) {
		if (!replace.has(d.path)) out.push(d);
		else {
			const r = replace.get(d.path);
			if (r) out.push(r);
		}
	}
	return out;
}
