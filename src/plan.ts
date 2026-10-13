// Three-way sync decision logic. Pure module.
// base   = blob sha of each path at the last successful sync
// local  = blob sha of each path on this device now
// remote = blob sha of each path on GitHub now

export type SyncMode = "sync" | "push" | "pull";

export type Decision =
	| { kind: "download"; path: string; sha: string }
	| { kind: "delete-local"; path: string }
	// `keepRemote` (push mode, both sides changed): first save the repository's version (this blob sha)
	// as a conflict copy here, so its edit isn't only left in history.
	| { kind: "upload"; path: string; sha: string; renamedFrom?: string; keepRemote?: string }
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
	opts: { pushKeepsRemote?: boolean } = {},
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
			// This device's version wins in the repository; with `pushKeepsRemote` the repository's edit is
			// also kept here as a conflict copy. The local file itself is never touched in push mode.
			if (l) decisions.push(r && opts.pushKeepsRemote ? { kind: "upload", path, sha: l, keepRemote: r } : { kind: "upload", path, sha: l });
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
	similarity?: (a: string, b: string) => number;
	/** Minimum similarity to pair a delete with an add when the other side left the old file alone. */
	threshold?: number;
	/**
	 * Minimum similarity when the other side EDITED the old file: pairing then merges those edits into
	 * the new file and removes the old path, so it needs strong evidence. Below it, nothing is paired and
	 * the edited old file is kept (an edit beats a deletion), so nothing can end up in the wrong note.
	 */
	strictThreshold?: number;
	maxCandidates?: number;
	/**
	 * Texts of a few other files next to `path` (same folder and extension), none of them in `exclude`.
	 * Lines that also appear in those are template lines (shared by notes made from the same template):
	 * they say nothing about whether two files are one renamed note.
	 */
	siblings?: (path: string, exclude: Set<string>) => Promise<string[]>;
}

const ext = (p: string) => (p.includes(".") ? p.slice(p.lastIndexOf(".")).toLowerCase() : "");

/** Fewer distinct shared lines than this is never evidence of a rename (tiny notes, bare templates). */
export const MIN_SHARED_LINES = 3;

// Lines that carry no content of their own: blank, or only markup/punctuation ("---", "```", "-", "#").
const NOISE_LINE = /^[\s\-*_=`~#>|.:+[\]]*$/;

function contentLines(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.split("\n")) {
		const l = raw.replace(/\s+$/, "");
		if (!NOISE_LINE.test(l)) out.add(l);
	}
	return out;
}

/**
 * How much two texts share, 0..1: the Jaccard index of their distinct content lines (blank and
 * markup-only lines ignored). Returns 0 when fewer than MIN_SHARED_LINES distinct lines are shared, so
 * two notes made from the same short template never look like one renamed note.
 */
export function lineSimilarity(a: string, b: string): number {
	const A = contentLines(a);
	const B = contentLines(b);
	let shared = 0;
	for (const l of A) if (B.has(l)) shared++;
	if (shared < MIN_SHARED_LINES) return 0;
	return shared / (A.size + B.size - shared);
}

/**
 * Template lines among `texts` (other notes in the same folder): content lines found in at least two
 * of them and a third of them (with a single note: all its lines). Real notes rarely repeat each
 * other's lines; templates always do.
 */
export function templateLines(texts: string[]): Set<string> {
	const counts = new Map<string, number>();
	for (const t of texts) for (const l of contentLines(t)) counts.set(l, (counts.get(l) ?? 0) + 1);
	const need = texts.length < 2 ? 1 : Math.max(2, Math.ceil(texts.length / 3));
	const out = new Set<string>();
	for (const [l, n] of counts) if (n >= need) out.add(l);
	return out;
}

/** Like lineSimilarity, over the lines that are not template lines (no minimum shared count). */
export function coreSimilarity(a: string, b: string, template: Set<string>): { shared: number; score: number } {
	const A = [...contentLines(a)].filter((l) => !template.has(l));
	const B = new Set([...contentLines(b)].filter((l) => !template.has(l)));
	let shared = 0;
	for (const l of A) if (B.has(l)) shared++;
	const union = A.length + B.size - shared;
	return { shared, score: union ? shared / union : 0 };
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const stemOf = (p: string) => {
	const name = p.slice(p.lastIndexOf("/") + 1);
	return (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name).toLowerCase();
};

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
	const threshold = io.threshold ?? 0.4;
	const strict = Math.max(threshold, io.strictThreshold ?? 0.8);
	const similarity = io.similarity ?? lineSimilarity;
	const max = io.maxCandidates ?? 30;
	// Renamed on GitHub: old path gone remotely, a new path appeared remotely.
	const remoteOld = decisions.filter((d) => (d.kind === "delete-local" || d.kind === "upload") && base[d.path] && !remote.has(d.path) && !("renamedFrom" in d && d.renamedFrom));
	const remoteNew = decisions.filter((d) => d.kind === "download" && !base[d.path] && !local.has(d.path));
	// Renamed here: old path gone locally, a new path appeared locally.
	const localOld = decisions.filter((d) => (d.kind === "delete-remote" || d.kind === "download") && base[d.path] && !local.has(d.path) && !("renamedTo" in d && d.renamedTo));
	const localNew = decisions.filter((d) => d.kind === "upload" && !base[d.path] && !remote.has(d.path) && !d.renamedFrom);

	const replace = new Map<string, Decision | null>(); // path -> replacement (null = drop)
	// Template lines near each candidate, per folder (read once).
	const candidates = new Set([...remoteOld, ...remoteNew, ...localOld, ...localNew].map((d) => d.path));
	const nearby = new Map<string, Promise<string[]>>();
	const siblingTexts = (path: string): Promise<string[]> => {
		const key = `${dirOf(path)}|${ext(path)}`;
		let p = nearby.get(key);
		if (!p) nearby.set(key, (p = io.siblings ? io.siblings(path, candidates).catch(() => []) : Promise.resolve([])));
		return p;
	};
	const templateFor = async (a: string, b: string): Promise<Set<string>> => {
		const texts = [...(await siblingTexts(a))];
		if (dirOf(a) !== dirOf(b)) texts.push(...(await siblingTexts(b)));
		return templateLines(texts);
	};
	const pair = async (olds: Decision[], news: Decision[], newSide: "local" | "remote") => {
		if (!olds.length || !news.length || olds.length > max || news.length > max) return;
		const used = new Set<string>();
		for (const o of olds) {
			// Nothing to compare with: don't even read the old file.
			if (!news.some((n) => !used.has(n.path) && ext(n.path) === ext(o.path))) continue;
			const baseText = await io.text("base", o.path, base[o.path]);
			if (baseText === null) continue;
			let best: { d: Decision; score: number; core: number | null; rank: number } | null = null;
			for (const n of news) {
				if (used.has(n.path) || ext(n.path) !== ext(o.path)) continue;
				const sha = newSide === "remote" ? remote.get(n.path)! : local.get(n.path)!;
				const t = await io.text(newSide, n.path, sha);
				if (t === null) continue;
				const score = similarity(baseText, t);
				if (score < threshold) continue;
				// Notes made from a rich template share most of their lines without being the same note:
				// lines that other notes nearby also have are no evidence. The pair must share some others.
				const template = await templateFor(o.path, n.path);
				let core: number | null = null;
				if (template.size) {
					const c = coreSimilarity(baseText, t, template);
					if (!c.shared) continue;
					core = c.score;
				}
				// Same folder or same name: the likelier rename when two candidates are about as similar.
				const rank = score + (dirOf(n.path) === dirOf(o.path) ? 0.02 : 0) + (stemOf(n.path) === stemOf(o.path) ? 0.02 : 0);
				if (!best || rank > best.rank) best = { d: n, score, core, rank };
			}
			if (!best) continue;
			const from = o.path;
			// The side that did NOT rename still has the old path: did it edit it?
			const otherEdited = newSide === "remote" ? local.get(from) !== base[from] : remote.get(from) !== base[from];
			// Pairing would merge those edits into another file and remove the old one: only on strong
			// evidence, on the lines that aren't template lines too. Otherwise leave both alone (the edited
			// old file is kept, the new one synced as new).
			if (otherEdited && (best.score < strict || (best.core !== null && best.core < strict))) continue;
			used.add(best.d.path);
			const to = best.d.path;
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
