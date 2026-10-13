import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec } from "../src/codec.ts";
import { GitHubFormatLayer, convertConstruct, decodeMarkdown, encodeMarkdown } from "../src/ghformat.ts";

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { ignoreBOM: true });
const buf = (s: string) => te.encode(s).buffer as ArrayBuffer;
const str = (b: ArrayBuffer) => td.decode(b);
const enc = encodeMarkdown;
const dec = decodeMarkdown;
/** The GitHub-visible text: markers stripped (what a reader sees, minus rendering). */
const visible = (s: string) => s.replace(/<!--vsg:[A-Za-z0-9+/]+-->/g, "");

function roundTrip(x: string) {
	const y = enc(x);
	assert.equal(dec(y), x, `decode(encode(x)) !== x for ${JSON.stringify(x)}\nencoded: ${JSON.stringify(y)}`);
	assert.equal(enc(x), y, "encode is deterministic");
	assert.equal(enc(dec(y)), y, "no churn on resync");
	return y;
}

test("wikilinks become standard Markdown links", () => {
	assert.equal(visible(roundTrip("See [[Note]].")), "See [Note](Note.md).");
	assert.equal(visible(roundTrip("[[Note|the alias]]")), "[the alias](Note.md)");
	assert.equal(visible(roundTrip("[[My Note#Some Heading!]]")), "[My Note > Some Heading!](My%20Note.md#some-heading)");
	assert.equal(visible(roundTrip("[[Folder/Sub Note]]")), "[Folder/Sub Note](Folder/Sub%20Note.md)");
	assert.equal(visible(roundTrip("[[#Local Part]]")), "[Local Part](#local-part)");
	assert.equal(visible(roundTrip("[[doc.pdf]]")), "[doc.pdf](doc.pdf)");
	assert.equal(visible(roundTrip("[[a (b)]]")), "[a (b)](a%20%28b%29.md)");
	assert.equal(visible(roundTrip("| [[Note\\|alias]] |")), "| [alias](Note.md) |", "table-escaped pipe");
	assert.equal(visible(roundTrip("[[Note#^block1]]")), "[Note > ^block1](Note.md)");
	assert.equal(visible(roundTrip("[[Café ünï]]")), "[Café ünï](Caf%C3%A9%20%C3%BCn%C3%AF.md)");
	// Not converted.
	for (const s of ["[[]]", "[[ ]]", "[[|x]]", "[[#^b]]", "\\[[Note]]", "[[a\nb]]"]) assert.equal(roundTrip(s), s);
});

test("embeds become images (or links for non-images)", () => {
	assert.equal(visible(roundTrip("![[image.png]]")), "![image.png](image.png)");
	assert.equal(visible(roundTrip("![[img/a b.JPG|300]]")), "![img/a b.JPG](img/a%20b.JPG)");
	assert.equal(visible(roundTrip("![[a.png|A caption]]")), "![A caption](a.png)");
	assert.equal(visible(roundTrip("![[Other Note]]")), "[Other Note](Other%20Note.md)");
});

test("highlights become <mark>, with wikilinks inside converted", () => {
	assert.equal(visible(roundTrip("a ==hot== b")), "a <mark>hot</mark> b");
	assert.equal(visible(roundTrip("==see [[X]]==")), "<mark>see [X](X.md)</mark>");
	for (const s of ["a == b == c", "====", "=====", "Title\n===", "==x\ny==", "== x=="]) assert.equal(roundTrip(s), s);
});

test("callouts become GitHub alerts with a bold title; unsupported types stay", () => {
	assert.equal(visible(roundTrip("> [!info]+ Read this\n> body\n")), "> [!NOTE]\n> **Read this**\n> body\n");
	assert.equal(visible(roundTrip("> [!hint] T\n")), "> [!TIP]\n> **T**\n");
	assert.equal(visible(roundTrip("> [!IMPORTANT]\n> x")), "> [!IMPORTANT]\n>\n> x");
	assert.equal(visible(roundTrip("> [!warning]- W [[L]]\n")), "> [!WARNING]\n> **W [L](L.md)**\n");
	assert.equal(visible(roundTrip("> [!error] E\r\n> x\r\n")), "> [!CAUTION]\r\n> **E**\r\n> x\r\n", "CRLF kept");
	assert.equal(visible(roundTrip("> [!danger]")), "> [!CAUTION]\n>");
	assert.equal(visible(roundTrip("> [!caution] c\n")), "> [!CAUTION]\n> **c**\n");
	for (const s of ["> [!quote] q\n> x\n", "> [!todo] t\n", "> a\n> [!note] mid-quote\n", "> > [!note] nested\n"]) assert.equal(roundTrip(s), s);
});

test("code, frontmatter and HTML comments are never transformed", () => {
	const untouched = [
		"---\ntitle: [[x]]\ntags: ==a==\n---\nbody\n",
		"```\n[[no]] ==no==\n> [!note] no\n```\n",
		"~~~~md\n[[no]]\n~~~\n~~~~\n",
		"```js\nunclosed [[no]]\n",
		"> ```\n> [[no]]\n> ```\n",
		"- item\n  ```\n  [[no]]\n  ```\n",
		"inline `[[no]]` and ``a ` [[no]] `` too",
		"`multi\n[[no]] line` span",
		"<!-- [[no]] ==no== -->",
		"<!--\n[[no]]\n-->",
		"<!-- unclosed [[no]]",
	];
	for (const s of untouched) assert.equal(roundTrip(s), s, JSON.stringify(s));
	// Converts outside, not inside.
	assert.equal(visible(roundTrip("`[[a]]` [[b]]")), "`[[a]]` [b](b.md)");
	assert.equal(visible(roundTrip("```\n[[a]]\n```\n[[b]]")), "```\n[[a]]\n```\n[b](b.md)");
	assert.equal(visible(roundTrip("---\nx: [[a]]\n---\n[[b]]")), "---\nx: [[a]]\n---\n[b](b.md)");
	// Unclosed frontmatter is not frontmatter.
	assert.equal(visible(roundTrip("---\n[[a]]")), "---\n[a](a.md)");
});

test("marker format: valid, invisible GitHub comments placed right after the converted span", () => {
	const y = enc("[[Ünïcödé 🎉|ok]] ==x== > no\n> [!tip] t\n");
	const markers = y.match(/<!--vsg:[^>]*-->/g) ?? [];
	assert.equal(markers.length, 3);
	for (const m of markers) {
		const body = m.slice(4, -3);
		assert.ok(!body.includes("--") && !body.endsWith("-") && !body.startsWith(">"), `cmark-gfm comment rules: ${m}`);
	}
	assert.match(y, /^\[ok\]\(%C3%9C.*?\.md\)<!--vsg:/);
});

test("literal marker text in the vault is escaped and restored exactly", () => {
	for (const s of [
		"<!--vsg:W1tOb3RlXV0-->",
		"[Note](Note.md)<!--vsg:W1tOb3RlXV0-->",
		"<!--vsg-->",
		"<!--vsg",
		"<!--<!--vsg:-->",
		"```\n<!--vsg:abc-->\n```",
		"x <!--vsg--><!--vsg:QQ-->",
	])
		roundTrip(s);
	assert.equal(enc("<!--vsg"), "<!--vsg-->");
});

test("decode: collaborator text without markers is left alone; malformed markers stay text; stale markers drop", () => {
	const plain = "Written on GitHub: [a](a.md) <mark>x</mark>\n> [!NOTE]\n> y\n";
	assert.equal(dec(plain), plain);
	for (const bad of ["<!--vsg:", "<!--vsg:!!-->", "<!--vsg:A-->", "<!--vsg:QUJD-->", "<!--vsg:/w-->", "<!--vsg:W1tO", "x<!--vsgz-->"]) {
		assert.equal(dec(bad), bad, `malformed left as text: ${bad}`);
	}
	const y = enc("see [[Note]] now");
	assert.equal(dec(y.replace("[Note](Note.md)", "[Renamed](Other.md)")), "see [Renamed](Other.md) now", "edit wins, marker dropped");
	assert.equal(dec(y.replace("see ", "well, see ")), "well, see [[Note]] now", "edits elsewhere keep the restore");
	// Copying a converted span with its marker restores both copies.
	const one = enc("[[N]]");
	assert.equal(dec(one + " and " + one), "[[N]] and [[N]]");
});

test("layer: id, fingerprint, only .md transformed, non-UTF-8 and other files byte-for-byte", async () => {
	const layer = new GitHubFormatLayer();
	assert.equal(layer.id, "ghformat");
	assert.equal(layer.transformsContent, true);
	const codec = new Codec([layer]);
	assert.equal(codec.id, "ghformat");
	assert.equal(codec.fingerprint, "ghformat:1");

	const note = "a [[b]] ==c==\r\n";
	const stored = await codec.encode("Folder/n.md", buf(note));
	assert.equal(visible(str(stored)), "a [b](b.md) <mark>c</mark>\r\n");
	assert.equal(str(await codec.decode("Folder/n.md", stored)), note);
	assert.equal(await codec.storedSha("Folder/n.md", buf(note)), await new Codec().storedSha("x", stored));

	const other = buf("a [[b]] ==c==");
	assert.equal(await layer.encode("x.txt", other), other, "same buffer for non-Markdown");
	assert.equal(await layer.decode("x.canvas", other), other);
	const plain = buf("no constructs here\n");
	assert.equal(await layer.encode("p.md", plain), plain, "unchanged notes keep their exact bytes");
	const latin1 = new Uint8Array([0x5b, 0x5b, 0x41, 0x5d, 0x5d, 0xe9, 0xff]).buffer;
	assert.equal(await layer.encode("l.md", latin1), latin1, "invalid UTF-8 passes through");
	assert.equal(await layer.decode("l.md", latin1), latin1);
	const bom = buf("﻿[[x]]");
	const bomStored = await layer.encode("b.md", bom);
	assert.ok(str(bomStored).startsWith("﻿[x](x.md)"), "BOM preserved");
	assert.deepEqual(new Uint8Array(await layer.decode("b.md", bomStored)), new Uint8Array(bom));
});

// ---------- property-style tests ----------

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FRAGMENTS = [
	"[[", "]]", "[[Note]]", "[[My Note|alias]]", "[[A#H 1]]", "![[img.png|300]]", "![[x]]", "|", "#", "^", "!", "\\",
	"==", "==hi==", "==a [[b]] c==", "=", "`", "``", "```", "~~~", "```js", "> ", ">", "> [!note] T", "> [!tip]-", "> [!warning]+ W ==x==",
	"> [!danger]", "> [!quote] q", "[!", "---", "...", "<!--", "-->", "<!-- c -->", "<!--vsg", "<!--vsg:", "<!--vsg-->", "<!--vsg:W1tOb3RlXV0-->",
	"[N](N.md)", "<mark>", "</mark>", "**", " ", "  ", "    ", "\t", "\n", "\n", "\r\n", "\r", "word", "Ünï", "中文", "🎉", " ", "﻿",
	"%20", "(", ")", "-", "- ", "1. ", "x",
];

function generate(r: () => number): string {
	const n = Math.floor(r() * 40);
	let s = "";
	if (r() < 0.15) s += "---\nk: [[v]]\n---\n";
	for (let i = 0; i < n; i++) {
		const f = FRAGMENTS[Math.floor(r() * FRAGMENTS.length)];
		s += r() < 0.1 ? "\n" + f : f;
	}
	return s;
}

test("property: decode(encode(x)) === x, deterministic, no churn — over many generated notes", () => {
	const r = rng(0x5eed);
	let converted = 0;
	for (let i = 0; i < 20000; i++) {
		const x = generate(r);
		const y = roundTrip(x);
		if (y !== x) converted++;
		// Every marker the encoder writes is a well-formed one, and all literal marker text is escaped.
		const stripped = y.replace(/<!--vsg:[A-Za-z0-9+/]{2,}-->/g, "").replace(/<!--vsg-->/g, "");
		assert.ok(!stripped.includes("<!--vsg"), `stray marker text in ${JSON.stringify(y)}`);
	}
	assert.ok(converted > 5000, `generator exercises conversions (${converted})`);
});

test("property: random strings and random bytes never throw and round-trip", async () => {
	const r = rng(42);
	const alphabet = "[]=!|#`~>-<\\:/+ \n\r\taZ09é🎉vsg";
	const layer = new GitHubFormatLayer();
	for (let i = 0; i < 5000; i++) {
		let s = "";
		const n = Math.floor(r() * 60);
		for (let j = 0; j < n; j++) s += [...alphabet][Math.floor(r() * [...alphabet].length)];
		roundTrip(s);
		assert.doesNotThrow(() => dec(s));
		const bytes = new Uint8Array(Math.floor(r() * 40));
		for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(r() * 256);
		const b = bytes.buffer;
		const out = await layer.decode("r.md", await layer.encode("r.md", b));
		assert.deepEqual(new Uint8Array(out), bytes);
		await layer.decode("r.md", b);
	}
});

test("property: decode of arbitrary repository text never throws and is idempotent on unmarked text", () => {
	const r = rng(7);
	for (let i = 0; i < 5000; i++) {
		const y = generate(r);
		const once = dec(y);
		if (!y.includes("<!--vsg")) assert.equal(once, y);
	}
});

test("pure converter matches what the encoder writes", () => {
	assert.equal(convertConstruct("[[a]]", "\n"), "[a](a.md)");
	assert.equal(convertConstruct("> [!note]", "\r\n"), "> [!NOTE]\r\n>");
	assert.equal(convertConstruct("[[a<!--b]]", "\n"), null);
	assert.equal(convertConstruct("plain", "\n"), null);
});

test("large and pathological inputs stay fast", () => {
	const big = ("Line with [[Link]] and ==mark== and `code` ".repeat(20) + "\n").repeat(2000);
	let t0 = Date.now();
	roundTrip(big);
	const ticks = "`a ``b ```c ".repeat(20000);
	roundTrip(ticks);
	roundTrip("<!--vsg".repeat(20000));
	roundTrip("[[".repeat(20000) + "==".repeat(20000));
	assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms`);
	t0 = Date.now();
});
