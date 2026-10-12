// Line-based three-way merge (diff3). Pure, no Obsidian imports, so it is unit-testable.

export interface MergeResult {
	clean: boolean;
	conflicts: number;
	text: string;
}

export interface MergeLabels {
	local: string;
	remote: string;
}

// Upper bound on the LCS table after trimming common prefix/suffix (cells, 4 bytes each).
const MAX_CELLS = 2_500_000;

export function splitLines(s: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < s.length) {
		const j = s.indexOf("\n", i);
		if (j < 0) {
			out.push(s.slice(i));
			break;
		}
		out.push(s.slice(i, j + 1));
		i = j + 1;
	}
	return out;
}

// m[i] = index in b matched with a[i] by a longest common subsequence, or -1.
// Returns null when the changed region is too large to diff cheaply.
export function lcsMatch(a: string[], b: string[]): Int32Array | null {
	const m = new Int32Array(a.length).fill(-1);
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) {
		m[s] = s;
		s++;
	}
	let ea = a.length;
	let eb = b.length;
	while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
		ea--;
		eb--;
		m[ea] = eb;
	}
	const n = ea - s;
	const k = eb - s;
	if (n === 0 || k === 0) return m;
	if (n * k > MAX_CELLS) return null;

	const w = k + 1;
	const dp = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = k - 1; j >= 0; j--) {
			dp[i * w + j] =
				a[s + i] === b[s + j]
					? dp[(i + 1) * w + j + 1] + 1
					: Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < n && j < k) {
		if (a[s + i] === b[s + j]) {
			m[s + i] = s + j;
			i++;
			j++;
		} else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return m;
}

function sameLines(x: string[], y: string[]): boolean {
	if (x.length !== y.length) return false;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
}

function pushBlock(out: string[], lines: string[]) {
	for (const l of lines) out.push(l);
	const last = out[out.length - 1];
	if (lines.length && last !== undefined && !last.endsWith("\n")) out[out.length - 1] = last + "\n";
}

/**
 * Merge `local` and `remote`, both derived from `base`.
 * Returns null if the files are too large/different to merge in reasonable memory.
 */
export function merge3(base: string, local: string, remote: string, labels: MergeLabels): MergeResult | null {
	if (local === remote) return { clean: true, conflicts: 0, text: local };
	if (local === base) return { clean: true, conflicts: 0, text: remote };
	if (remote === base) return { clean: true, conflicts: 0, text: local };

	const O = splitLines(base);
	const A = splitLines(local);
	const B = splitLines(remote);
	const ma = lcsMatch(O, A);
	const mb = lcsMatch(O, B);
	if (!ma || !mb) return null;

	const out: string[] = [];
	let conflicts = 0;
	let i = 0;
	let a = 0;
	let b = 0;

	for (;;) {
		// Stable region: line present unchanged in all three.
		while (i < O.length && ma[i] === a && mb[i] === b) {
			out.push(O[i]);
			i++;
			a++;
			b++;
		}
		if (i >= O.length && a >= A.length && b >= B.length) break;

		// Next base line that both sides kept.
		let ni = i;
		while (ni < O.length && (ma[ni] < 0 || mb[ni] < 0)) ni++;
		const na = ni < O.length ? ma[ni] : A.length;
		const nb = ni < O.length ? mb[ni] : B.length;

		const oC = O.slice(i, ni);
		const aC = A.slice(a, na);
		const bC = B.slice(b, nb);

		if (sameLines(aC, oC)) out.push(...bC);
		else if (sameLines(bC, oC)) out.push(...aC);
		else if (sameLines(aC, bC)) out.push(...aC);
		else {
			conflicts++;
			const lastOut = out[out.length - 1];
			if (lastOut !== undefined && !lastOut.endsWith("\n")) out[out.length - 1] = lastOut + "\n";
			out.push(`<<<<<<< ${labels.local}\n`);
			pushBlock(out, aC);
			out.push("=======\n");
			pushBlock(out, bC);
			out.push(`>>>>>>> ${labels.remote}\n`);
		}
		i = ni;
		a = na;
		b = nb;
	}
	return { clean: conflicts === 0, conflicts, text: out.join("") };
}
