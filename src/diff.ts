// Line diff for display and per-hunk conflict resolution. Pure module (no Obsidian imports).

import { lcsMatch, splitLines } from "./merge.ts";

export type DiffOp = { t: "eq" | "del" | "add"; line: string };

/** Line-level diff from `a` to `b`. Falls back to "replace everything" for huge inputs. */
export function diffLines(a: string, b: string): DiffOp[] {
	const A = splitLines(a);
	const B = splitLines(b);
	const m = lcsMatch(A, B);
	const ops: DiffOp[] = [];
	if (!m) {
		for (const line of A) ops.push({ t: "del", line });
		for (const line of B) ops.push({ t: "add", line });
		return ops;
	}
	let j = 0;
	for (let i = 0; i < A.length; i++) {
		if (m[i] < 0) {
			ops.push({ t: "del", line: A[i] });
			continue;
		}
		while (j < m[i]) ops.push({ t: "add", line: B[j++] });
		ops.push({ t: "eq", line: A[i] });
		j++;
	}
	while (j < B.length) ops.push({ t: "add", line: B[j++] });
	return ops;
}

export type Segment = { kind: "same"; lines: string[] } | { kind: "change"; a: string[]; b: string[] };

/** Groups a diff into runs of unchanged lines and change blocks (a = old side, b = new side). */
export function segments(ops: DiffOp[]): Segment[] {
	const out: Segment[] = [];
	for (const op of ops) {
		const last = out[out.length - 1];
		if (op.t === "eq") {
			if (last?.kind === "same") last.lines.push(op.line);
			else out.push({ kind: "same", lines: [op.line] });
		} else {
			const block = last?.kind === "change" ? last : null;
			const target = block ?? { kind: "change" as const, a: [], b: [] };
			if (!block) out.push(target);
			(op.t === "del" ? target.a : target.b).push(op.line);
		}
	}
	return out;
}

export type HunkPick = "a" | "b" | "both";

/** Rebuilds a file from segments, taking side a, b or both (a then b) for each change block. */
export function assemble(segs: Segment[], picks: HunkPick[]): string {
	const out: string[] = [];
	let k = 0;
	const push = (lines: string[]) => {
		for (const l of lines) {
			const last = out[out.length - 1];
			if (last !== undefined && !last.endsWith("\n")) out[out.length - 1] = last + "\n";
			out.push(l);
		}
	};
	for (const s of segs) {
		if (s.kind === "same") push(s.lines);
		else {
			const p = picks[k++] ?? "b";
			if (p === "a" || p === "both") push(s.a);
			if (p === "b" || p === "both") push(s.b);
		}
	}
	return out.join("");
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const o of ops) {
		if (o.t === "add") added++;
		else if (o.t === "del") removed++;
	}
	return { added, removed };
}

/** True when two texts differ only in line endings (CRLF vs LF). */
export function sameIgnoringEol(a: string, b: string): boolean {
	return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}
