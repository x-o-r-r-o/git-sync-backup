// Structure-aware three-way merges. Pure module (no Obsidian imports).
//  - JSON / .canvas: objects merged key by key, arrays of {id} objects merged by id (canvas nodes and
//    edges), string values merged line by line. Edits beat deletions.
//  - Markdown: YAML frontmatter merged entry by entry (list values such as tags/aliases as sets), body
//    merged with diff3.
// Every function returns null when it cannot merge safely, so callers fall back to the plain path.

import { merge3 } from "./merge.ts";
import type { MergeResult } from "./merge.ts";

type J = unknown;

const isObj = (v: J): v is Record<string, J> => typeof v === "object" && v !== null && !Array.isArray(v);

function eq(a: J, b: J): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a)) {
		const bb = b as J[];
		return a.length === bb.length && a.every((x, i) => eq(x, bb[i]));
	}
	const ak = Object.keys(a);
	const bk = Object.keys(b as object);
	return ak.length === bk.length && ak.every((k) => eq((a as Record<string, J>)[k], (b as Record<string, J>)[k]));
}

const hasIds = (arr: J[]) => arr.every((x) => isObj(x) && typeof x.id === "string");

interface Ctx {
	conflicts: number;
}

function mergeValue(b: J, l: J, r: J, ctx: Ctx): J {
	if (eq(l, r)) return l;
	if (eq(b, l)) return r;
	if (eq(b, r)) return l;
	// Both sides changed differently. An edit beats a deletion.
	if (l === undefined) return r;
	if (r === undefined) return l;
	if (isObj(l) && isObj(r) && (b === undefined || isObj(b))) return mergeObject((b as Record<string, J>) ?? {}, l, r, ctx);
	if (Array.isArray(l) && Array.isArray(r) && (b === undefined || Array.isArray(b)) && hasIds(l) && hasIds(r) && (!b || hasIds(b as J[]))) {
		return mergeById((b as Record<string, J>[]) ?? [], l as Record<string, J>[], r as Record<string, J>[], ctx);
	}
	if (isNameList(l) && isNameList(r) && (b === undefined || isNameList(b))) return mergeNameLists((b as string[]) ?? [], l, r);
	if (typeof l === "string" && typeof r === "string" && typeof b === "string") {
		const m = merge3(b, l, r, { local: "local", remote: "remote" });
		if (m?.clean) return m.text;
	}
	ctx.conflicts++;
	return l;
}

function mergeObject(b: Record<string, J>, l: Record<string, J>, r: Record<string, J>, ctx: Ctx): Record<string, J> {
	const keys = [...Object.keys(l), ...Object.keys(r).filter((k) => !(k in l)), ...Object.keys(b).filter((k) => !(k in l) && !(k in r))];
	const out: Record<string, J> = {};
	for (const k of keys) {
		const v = mergeValue(b[k], l[k], r[k], ctx);
		if (v !== undefined) out[k] = v;
	}
	return out;
}

/** A list of distinct strings, such as plugin ids in community-plugins.json. */
function isNameList(v: J): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string") && new Set(v).size === v.length;
}

/**
 * Three-way merge of name lists as sets: a name added on either side is kept, a name removed on
 * either side is removed. Order: this side's list, then names the other side added.
 */
function mergeNameLists(b: string[], l: string[], r: string[]): string[] {
	const B = new Set(b);
	const L = new Set(l);
	const R = new Set(r);
	const keep = (x: string) => (L.has(x) && R.has(x)) || (L.has(x) && !B.has(x)) || (R.has(x) && !B.has(x));
	return [...l.filter(keep), ...r.filter((x) => !L.has(x) && keep(x))];
}

function mergeById(b: Record<string, J>[], l: Record<string, J>[], r: Record<string, J>[], ctx: Ctx): Record<string, J>[] {
	const map = (a: Record<string, J>[]) => new Map(a.map((x) => [x.id as string, x]));
	const B = map(b);
	const L = map(l);
	const R = map(r);
	const order = [...L.keys(), ...[...R.keys()].filter((k) => !L.has(k)), ...[...B.keys()].filter((k) => !L.has(k) && !R.has(k))];
	const out: Record<string, J>[] = [];
	for (const id of order) {
		const v = mergeValue(B.get(id), L.get(id), R.get(id), ctx);
		if (v !== undefined) out.push(v as Record<string, J>);
	}
	return out;
}

function indentOf(text: string): string | number {
	const m = /\n([ \t]+)\S/.exec(text);
	if (!m) return "\t";
	return m[1].startsWith("\t") ? "\t" : m[1].length;
}

/** Number literals (outside strings) with more significant digits than a double keeps exactly. */
function hasLongNumber(text: string): boolean {
	const bare = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	for (const m of bare.matchAll(/-?(\d+)(?:\.(\d+))?(?:[eE][+-]?\d+)?/g)) {
		const digits = (m[1] + (m[2] ?? "").replace(/0+$/, "")).replace(/^0+/, "");
		if (digits.length > 15) return true;
	}
	return false;
}

/** True when a parsed value can't be written back as it was read (e.g. a "__proto__" key, Infinity). */
function lossy(v: J): boolean {
	const walk = (x: J): boolean => {
		if (Array.isArray(x)) return x.some(walk);
		if (!isObj(x)) return false;
		return Object.keys(x).some((k) => k === "__proto__" || walk(x[k]));
	};
	if (v === undefined) return false;
	if (walk(v)) return true;
	try {
		return !eq(JSON.parse(JSON.stringify(v)), v);
	} catch {
		return true;
	}
}

/** Three-way merge of JSON documents (including Obsidian .canvas files). */
export function mergeJson(base: string, local: string, remote: string): MergeResult | null {
	let B: J, L: J, R: J;
	try {
		B = base.trim() ? JSON.parse(base) : undefined;
		L = JSON.parse(local);
		R = JSON.parse(remote);
	} catch {
		return null;
	}
	// A JSON round trip would silently change these (big ids lose digits, "__proto__" keys vanish):
	// leave them to the line merge, which keeps the text as written.
	if ([base, local, remote].some(hasLongNumber) || [B, L, R].some(lossy)) return null;
	const ctx: Ctx = { conflicts: 0 };
	const merged = mergeValue(B, L, R, ctx);
	const text = JSON.stringify(merged, null, indentOf(local)) + (local.endsWith("\n") ? "\n" : "");
	return { clean: ctx.conflicts === 0, conflicts: ctx.conflicts, text };
}

// ---------------- Markdown frontmatter ----------------

interface Doc {
	fm: string | null;
	body: string;
}

function splitFrontmatter(t: string): Doc {
	const m = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(\r?\n|$)/.exec(t);
	if (!m) return { fm: null, body: t };
	return { fm: m[1] ?? "", body: t.slice(m[0].length) };
}

interface Entry {
	key: string;
	text: string;
}

/** Top-level YAML entries: a "key:" line plus the indented/list lines that follow it. */
function entries(fm: string): Entry[] | null {
	const out: Entry[] = [];
	// Split into lines keeping the newline (no regex lookbehind: unsupported on iOS < 16.4).
	for (const line of fm.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		if (!line.trim()) {
			if (out.length) out[out.length - 1].text += line;
			continue;
		}
		const top = /^([^\s#-][^:]*):(\s|$)/.exec(line);
		if (top) out.push({ key: top[1].trim(), text: line });
		else if (out.length && (/^\s/.test(line) || line.startsWith("- "))) out[out.length - 1].text += line;
		else if (line.startsWith("#")) out.push({ key: `#${out.length}`, text: line });
		else return null; // something we don't understand: don't risk it
	}
	return out;
}

interface ListValue {
	items: string[];
	style: "block" | "inline";
	indent: string;
}

function listOf(e: Entry): ListValue | null {
	const lines = e.text.replace(/\s+$/, "").split(/\r?\n/);
	const head = lines[0].slice(lines[0].indexOf(":") + 1).trim();
	if (lines.length === 1) {
		const inl = /^\[(.*)\]$/.exec(head);
		if (!inl) return null;
		const items = inl[1].split(",").map((x) => x.trim()).filter(Boolean);
		return { items, style: "inline", indent: "  " };
	}
	if (head) return null;
	const items: string[] = [];
	let indent = "  ";
	for (const l of lines.slice(1)) {
		const m = /^(\s*)- (.*)$/.exec(l);
		if (!m) return null;
		indent = m[1];
		items.push(m[2].trim());
	}
	return { items, style: "block", indent };
}

function renderList(key: string, v: ListValue, eol: string): string {
	if (v.style === "inline") return `${key}: [${v.items.join(", ")}]${eol}`;
	return `${key}:${eol}${v.items.map((i) => `${v.indent}- ${i}${eol}`).join("")}`;
}

function mergeSets(b: string[], l: string[], r: string[]): string[] {
	const removed = new Set([...b.filter((x) => !l.includes(x)), ...b.filter((x) => !r.includes(x))]);
	const out: string[] = [];
	for (const x of [...l, ...r]) if (!removed.has(x) && !out.includes(x)) out.push(x);
	return out;
}

function mergeFrontmatter(b: string, l: string, r: string): string | null {
	const B = entries(b);
	const L = entries(l);
	const R = entries(r);
	if (!B || !L || !R) return null;
	const eol = l.includes("\r\n") ? "\r\n" : "\n";
	const get = (es: Entry[], k: string) => es.find((e) => e.key === k);
	const keys = [...L.map((e) => e.key), ...R.map((e) => e.key).filter((k) => !get(L, k)), ...B.map((e) => e.key).filter((k) => !get(L, k) && !get(R, k))];
	let out = "";
	for (const k of keys) {
		const be = get(B, k);
		const le = get(L, k);
		const re = get(R, k);
		const bt = be?.text.replace(/\s+$/, "");
		const lt = le?.text.replace(/\s+$/, "");
		const rt = re?.text.replace(/\s+$/, "");
		let chosen: Entry | undefined;
		if (lt === rt || bt === rt) chosen = le;
		else if (bt === lt) chosen = re;
		else if (!le) chosen = re; // edit beats delete
		else if (!re) chosen = le;
		else {
			const ll = listOf(le);
			const rl = listOf(re);
			const bl = be ? listOf(be) : { items: [], style: ll?.style ?? "block", indent: "  " };
			if (!ll || !rl || !bl) return null;
			out += renderList(k, { ...ll, items: mergeSets(bl.items, ll.items, rl.items) }, eol);
			continue;
		}
		if (chosen) out += chosen.text.endsWith("\n") ? chosen.text : chosen.text + eol;
	}
	return out;
}

/** Markdown merge with key-aware frontmatter. Returns null when no side has frontmatter or it can't merge. */
export function mergeMarkdown(base: string, local: string, remote: string, labels = { local: "local", remote: "remote" }): MergeResult | null {
	const B = splitFrontmatter(base);
	const L = splitFrontmatter(local);
	const R = splitFrontmatter(remote);
	if (L.fm === null && R.fm === null) return null;
	const fm = mergeFrontmatter(B.fm ?? "", L.fm ?? "", R.fm ?? "");
	if (fm === null) return null;
	const body = merge3(B.body, L.body, R.body, labels);
	if (!body) return null;
	const eol = local.includes("\r\n") ? "\r\n" : "\n";
	const text = fm.trim() ? `---${eol}${fm}---${eol}${body.text}` : body.text;
	return { clean: body.clean, conflicts: body.conflicts, text };
}

/** Picks the structure-aware merge for a path, or null to use the plain line merge. */
export function smartMerge(path: string, base: string, local: string, remote: string, labels?: { local: string; remote: string }): (MergeResult & { kind: string }) | null {
	const ext = path.split(".").pop()?.toLowerCase();
	if (ext === "json" || ext === "canvas") {
		const m = mergeJson(base, local, remote);
		return m ? { ...m, kind: ext === "canvas" ? "canvas" : "JSON" } : null;
	}
	if (ext === "md" || ext === "markdown") {
		const m = mergeMarkdown(base, local, remote, labels);
		return m ? { ...m, kind: "frontmatter" } : null;
	}
	return null;
}
