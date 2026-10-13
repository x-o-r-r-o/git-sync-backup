// Opt-in "GitHub-friendly formatting": Markdown notes are rewritten on the way into the repository so
// they read well on GitHub (wikilinks → links, ==highlights== → <mark>, callouts → alerts), and every
// rewritten span carries its exact original in an invisible HTML comment so Obsidian gets it back
// byte for byte on the way out.
//
// Stored form of a converted span:  CONVERTED<!--vsg:BASE64-->
//   BASE64 = standard base64 (no padding) of the original's UTF-8 bytes. Standard base64 never contains
//   "-", so the comment is valid for GitHub's parser (no "--" inside, no trailing "-").
// A literal "<!--vsg" in the original is escaped as "<!--vsg-->", so the decoder never mistakes vault
// text for a marker. Decoding restores a span only when the text right before its marker is exactly the
// conversion of the stored original; a marker whose span was edited on GitHub is dropped (the edit
// wins), and anything that does not parse as a marker is left as text.

import type { Layer } from "./codec.ts";

const MARK = "<!--vsg";
const ESC = "<!--vsg-->";
const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const WIKI_SRC = String.raw`(!?)\[\[([^\[\]\r\n]+)\]\]`;
const HL_INNER = String.raw`[^\s=](?:(?:[^=\r\n]|=(?!=))*?[^\s=])?`;
const INLINE_SRC = String.raw`(!?)\[\[([^\[\]\r\n]+)\]\]|==(${HL_INNER})==`;
const WIKI_ONE = new RegExp(`^${WIKI_SRC}$`);
const HL_ONE = new RegExp(`^==(${HL_INNER})==$`);
const CALLOUT = /^( {0,3})>[ \t]?\[!([A-Za-z]+)\]([+-]?)(.*)$/;
const MARKER_AT = /<!--vsg:([A-Za-z0-9+/]{2,})-->/y;

const ALERTS: Record<string, string> = {
	note: "NOTE",
	info: "NOTE",
	tip: "TIP",
	hint: "TIP",
	important: "IMPORTANT",
	warning: "WARNING",
	attention: "WARNING",
	caution: "CAUTION",
	danger: "CAUTION",
	error: "CAUTION",
};
const IMAGE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
const KNOWN_EXT = /\.(md|markdown|canvas|base|pdf|png|jpe?g|gif|svg|webp|bmp|avif|ico|mp3|mp4|m4a|wav|ogg|webm|mov|mkv|flac|txt|csv|json|html?|xml|ya?ml|zip)$/i;

// ---------- pure conversions (a function of the original text only, so the decoder can verify) ----------

function slug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
		.replace(/ /g, "-");
}

function encodeHref(path: string): string {
	return path
		.split("/")
		.map((s) => encodeURIComponent(s).replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29")))
		.join("/");
}

function wikiToMarkdown(embed: boolean, inner: string): string | null {
	const bar = inner.indexOf("|");
	const target = (bar < 0 ? inner : inner.slice(0, bar)).replace(/\\$/, "").trim();
	const alias = bar < 0 ? "" : inner.slice(bar + 1).trim();
	if (!target) return null;
	const hash = target.indexOf("#");
	const file = (hash < 0 ? target : target.slice(0, hash)).trim();
	const parts = hash < 0 ? [] : target.slice(hash + 1).split("#").map((s) => s.trim()).filter(Boolean);
	const last = parts[parts.length - 1] ?? "";
	const anchor = last && !last.startsWith("^") ? "#" + encodeURIComponent(slug(last)) : "";
	if (!file && !anchor) return null;
	const href = (file ? encodeHref(KNOWN_EXT.test(file) ? file : file + ".md") : "") + anchor;
	const image = embed && IMAGE.test(file);
	let label: string;
	if (image) label = alias && !/^\d+(x\d+)?$/.test(alias) ? alias : file;
	else label = alias || [file, ...parts].filter(Boolean).join(" > ");
	return `${image ? "!" : ""}[${label}](${href})`;
}

/** Converts wikilinks (and highlights when allowed) inside a converted span, without markers. */
function convertInner(s: string, highlights: boolean): string {
	if (s.includes("`") || s.includes("<!--") || s.includes("\\")) return s;
	const re = new RegExp(highlights ? INLINE_SRC : WIKI_SRC, "g");
	return s.replace(re, (m: string, bang: string | undefined, inner: string | undefined, hl: string | undefined) => {
		if (inner !== undefined) return wikiToMarkdown(bang === "!", inner) ?? m;
		if (hl !== undefined) return `<mark>${convertInner(hl, false)}</mark>`;
		return m;
	});
}

/** The GitHub form of one original construct, or null if it is not one. `eol` only matters for callouts. */
export function convertConstruct(original: string, eol: string): string | null {
	if (original.includes("<!--")) return null;
	let out: string | null = null;
	let m = WIKI_ONE.exec(original);
	if (m) out = wikiToMarkdown(m[1] === "!", m[2]);
	else if ((m = HL_ONE.exec(original))) out = `<mark>${convertInner(m[1], false)}</mark>`;
	else if ((m = CALLOUT.exec(original))) {
		const type = ALERTS[m[2].toLowerCase()];
		if (!type) return null;
		const title = m[4].trim();
		out = `${m[1]}> [!${type}]${eol}${m[1]}>` + (title ? ` **${convertInner(title, true)}**` : "");
	}
	return out === null || out.includes(MARK) ? null : out;
}

// ---------- base64 of UTF-8 ----------

function toB64(s: string): string {
	const bytes = te.encode(s);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin).replace(/=+$/, "");
}

function fromB64(s: string): string | null {
	try {
		const bin = atob(s);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return td.decode(bytes);
	} catch {
		return null;
	}
}

// ---------- structure scanning (decides WHAT to convert; never affects reversibility) ----------

interface Line {
	start: number;
	end: number;
	next: number;
	eol: string;
}

function splitLines(t: string): Line[] {
	const out: Line[] = [];
	let s = 0;
	while (s < t.length) {
		const nl = t.indexOf("\n", s);
		if (nl < 0) {
			out.push({ start: s, end: t.length, next: t.length, eol: "" });
			break;
		}
		const end = nl > s && t[nl - 1] === "\r" ? nl - 1 : nl;
		out.push({ start: s, end, next: nl + 1, eol: t.slice(end, nl + 1) });
		s = nl + 1;
	}
	return out;
}

/** Strips blockquote and list-item prefixes so fences nested in callouts or lists are recognized. */
function stripContainers(s: string): string {
	return s.replace(/^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))[ \t]?)*[ \t]*/, "");
}

type Range = [number, number];

/** Inline code spans and HTML comments in a run of prose lines. */
function scanInline(t: string, s: number, e: number, blankStarts: number[], out: Range[]) {
	let p = s;
	let bi = 0;
	let paraEnd = -1;
	let failed = new Set<number>();
	while (p < e) {
		if (p >= paraEnd) {
			while (bi < blankStarts.length && blankStarts[bi] <= p) bi++;
			paraEnd = bi < blankStarts.length ? blankStarts[bi] : e;
			failed = new Set<number>();
		}
		const c = t.charCodeAt(p);
		if (c === 92) {
			p += 2;
		} else if (c === 96) {
			let q = p;
			while (q < e && t.charCodeAt(q) === 96) q++;
			const n = q - p;
			let close = -1;
			if (!failed.has(n)) {
				let k = q;
				while (k < paraEnd) {
					const b = t.indexOf("`", k);
					if (b < 0 || b >= paraEnd) break;
					let r = b;
					while (r < e && t.charCodeAt(r) === 96) r++;
					if (r - b === n) {
						close = b;
						break;
					}
					k = r;
				}
				if (close < 0) failed.add(n);
			}
			if (close >= 0) {
				out.push([p, close + n]);
				p = close + n;
			} else p = q;
		} else if (c === 60 && t.startsWith("<!--", p)) {
			const k = t.indexOf("-->", p + 2);
			const end = k < 0 || k + 3 > e ? e : k + 3;
			out.push([p, end]);
			p = end;
		} else p++;
	}
}

function merge(ranges: Range[]): Range[] {
	ranges.sort((a, b) => a[0] - b[0]);
	const out: Range[] = [];
	for (const r of ranges) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	return out;
}

function overlaps(sorted: Range[], s: number, e: number): boolean {
	let lo = 0;
	let hi = sorted.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const r = sorted[mid];
		if (r[1] <= s) lo = mid + 1;
		else if (r[0] >= e) hi = mid - 1;
		else return true;
	}
	return false;
}

function escapedAt(t: string, at: number): boolean {
	let n = 0;
	for (let i = at - 1; i >= 0 && t.charCodeAt(i) === 92; i--) n++;
	return n % 2 === 1;
}

interface Construct {
	s: number;
	e: number;
	o: string;
	c: string;
}

function findConstructs(t: string): Construct[] {
	const lines = splitLines(t);
	const text = (i: number) => t.slice(lines[i].start, lines[i].end);
	const prose: boolean[] = lines.map(() => true);
	let i = 0;
	if (lines.length && /^\uFEFF?---[ \t]*$/.test(text(0))) {
		for (let j = 1; j < lines.length; j++) {
			if (/^(---|\.\.\.)[ \t]*$/.test(text(j))) {
				for (let k = 0; k <= j; k++) prose[k] = false;
				i = j + 1;
				break;
			}
		}
	}
	for (; i < lines.length; i++) {
		const m = /^(`{3,}|~{3,})(.*)$/.exec(stripContainers(text(i)));
		if (!m || (m[1][0] === "`" && m[2].includes("`"))) continue;
		const close = new RegExp(`^${m[1][0] === "`" ? "`" : "~"}{${m[1].length},}[ \\t]*$`);
		prose[i] = false;
		let j = i + 1;
		while (j < lines.length && !close.test(stripContainers(text(j)))) prose[j++] = false;
		if (j < lines.length) prose[j] = false;
		i = j;
	}

	// Runs of prose lines, with code spans / HTML comments inside them protected.
	const segments: Range[] = [];
	const guarded: Range[] = [];
	for (let a = 0; a < lines.length; a++) {
		if (!prose[a]) continue;
		let b = a;
		const blanks: number[] = [];
		while (b < lines.length && prose[b]) {
			if (/^[ \t]*$/.test(text(b))) blanks.push(lines[b].start);
			b++;
		}
		const seg: Range = [lines[a].start, lines[b - 1].next];
		segments.push(seg);
		scanInline(t, seg[0], seg[1], blanks, guarded);
		a = b - 1;
	}
	const blocked = merge(guarded.slice());

	const found: Construct[] = [];
	const calloutRanges: Range[] = [];
	for (let k = 0; k < lines.length; k++) {
		const ln = lines[k];
		if (!prose[k]) continue;
		const o = text(k);
		if (!o.includes("[!") || !CALLOUT.test(o)) continue;
		if (k > 0 && prose[k - 1] && /^ {0,3}>/.test(text(k - 1))) continue;
		if (overlaps(blocked, ln.start, ln.end) || escapedAt(t, ln.start)) continue;
		const eol = ln.eol || (k > 0 ? lines[k - 1].eol : "") || "\n";
		const c = convertConstruct(o, eol);
		if (c === null) continue;
		found.push({ s: ln.start, e: ln.end, o, c });
		calloutRanges.push([ln.start, ln.end]);
	}

	const skip = merge([...guarded, ...calloutRanges]);
	const re = new RegExp(INLINE_SRC, "g");
	let si = 0;
	for (const [ss, se] of segments) {
		let p = ss;
		while (p < se) {
			while (si < skip.length && skip[si][1] <= p) si++;
			const gapEnd = si < skip.length && skip[si][0] < se ? Math.max(p, skip[si][0]) : se;
			if (gapEnd > p) {
				const sub = t.slice(p, gapEnd);
				re.lastIndex = 0;
				let m: RegExpExecArray | null;
				while ((m = re.exec(sub))) {
					const at = p + m.index;
					const c = escapedAt(t, at) ? null : convertConstruct(m[0], "\n");
					if (c === null) {
						re.lastIndex = m.index + 1;
						continue;
					}
					found.push({ s: at, e: at + m[0].length, o: m[0], c });
				}
			}
			p = si < skip.length && skip[si][0] < se ? Math.max(gapEnd, skip[si][1]) : se;
		}
	}
	return found.sort((a, b) => a.s - b.s);
}

// ---------- public text transforms ----------

const escape = (s: string) => s.split(MARK).join(ESC);

/** Vault Markdown → GitHub-friendly Markdown (reversible). */
export function encodeMarkdown(t: string): string {
	if (!t.includes("[[") && !t.includes("==") && !t.includes("[!") && !t.includes(MARK)) return t;
	const parts: string[] = [];
	let pos = 0;
	for (const k of findConstructs(t)) {
		if (k.s < pos) continue;
		parts.push(escape(t.slice(pos, k.s)), k.c, `${MARK}:${toB64(k.o)}-->`);
		pos = k.e;
	}
	parts.push(escape(t.slice(pos)));
	return parts.join("");
}

/** GitHub-friendly Markdown → vault Markdown: restores originals where markers are intact. */
export function decodeMarkdown(t: string): string {
	if (!t.includes(MARK)) return t;
	const parts: string[] = [];
	let pos = 0;
	for (;;) {
		const i = t.indexOf(MARK, pos);
		if (i < 0) break;
		if (t.startsWith(ESC, i)) {
			parts.push(t.slice(pos, i), MARK);
			pos = i + ESC.length;
			continue;
		}
		MARKER_AT.lastIndex = i;
		const m = MARKER_AT.exec(t);
		const original = m ? fromB64(m[1]) : null;
		if (!m || original === null) {
			parts.push(t.slice(pos, i + MARK.length));
			pos = i + MARK.length;
			continue;
		}
		const seg = t.slice(pos, i);
		const forms = [convertConstruct(original, "\n"), convertConstruct(original, "\r\n")];
		if (forms[0] === null) {
			// Not one of our constructs: leave the whole thing as text.
			parts.push(t.slice(pos, i + MARK.length));
			pos = i + MARK.length;
			continue;
		}
		const c = forms.find((f) => f !== null && seg.endsWith(f));
		// Intact: restore the original. Edited on GitHub: keep the edit, drop the stale marker.
		parts.push(c ? seg.slice(0, seg.length - c.length) + original : seg);
		pos = i + m[0].length;
	}
	parts.push(t.slice(pos));
	return parts.join("");
}

function applyText(data: ArrayBuffer, fn: (t: string) => string): ArrayBuffer {
	let text: string;
	try {
		text = td.decode(data);
	} catch {
		return data; // not UTF-8: stored as is
	}
	let out: string;
	try {
		out = fn(text);
	} catch {
		return data;
	}
	if (out === text) return data;
	const u = te.encode(out);
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

export const isMarkdownPath = (path: string) => /\.md$/i.test(path);

/** Codec layer: GitHub-friendly Markdown in the repository, exact Obsidian text in the vault. */
export class GitHubFormatLayer implements Layer {
	readonly id = "ghformat";
	readonly fingerprint = "ghformat:1";
	readonly transformsContent = true;

	encode(path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		return Promise.resolve(isMarkdownPath(path) ? applyText(data, encodeMarkdown) : data);
	}

	decode(path: string, blob: ArrayBuffer): Promise<ArrayBuffer> {
		return Promise.resolve(isMarkdownPath(path) ? applyText(blob, decodeMarkdown) : blob);
	}
}
