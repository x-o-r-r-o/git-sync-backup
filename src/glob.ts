// gitignore-style pattern matching. Supports *, **, ?, trailing "/" for folders, leading "/" to anchor
// at the vault root, "!" to re-include (the last matching pattern wins), "\!" and "\#" for literal
// characters, and "#" comments. Brackets are literal (folder names like "Team [Acme]" are common), so
// there are no [abc] character classes. Pure module.

function toRegexBody(p: string): string {
	let out = "";
	for (let i = 0; i < p.length; i++) {
		const c = p[i];
		if (c === "*") {
			if (p[i + 1] === "*") {
				if (p[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (c === "?") {
			out += "[^/]";
		} else if (c === "\\" && i + 1 < p.length) {
			const next = p[++i];
			out += /[\\^$+.()|{}[\]*?]/.test(next) ? "\\" + next : next;
		} else if ("\\^$+.()|{}[]".includes(c)) {
			out += "\\" + c;
		} else {
			out += c;
		}
	}
	return out;
}

export function compileGlobs(lines: string[]): (path: string) => boolean {
	const rules: { re: RegExp; negate: boolean }[] = [];
	for (const raw of lines) {
		let p = raw.trim();
		if (!p || p.startsWith("#")) continue;
		const negate = p.startsWith("!");
		if (negate) p = p.slice(1);
		else if (p.startsWith("\\!") || p.startsWith("\\#")) p = p.slice(1);
		if (p.endsWith("/")) p = p.slice(0, -1);
		const anchored = p.startsWith("/") || p.includes("/");
		if (p.startsWith("/")) p = p.slice(1);
		if (!p) continue;
		const body = toRegexBody(p);
		rules.push({ re: new RegExp(anchored ? `^${body}(?:/.*)?$` : `(?:^|.*/)${body}(?:/.*)?$`), negate });
	}
	if (!rules.some((r) => r.negate)) return (path: string) => rules.some((r) => r.re.test(path));
	return (path: string) => {
		let hit = false;
		for (const r of rules) if (r.re.test(path)) hit = !r.negate;
		return hit;
	};
}

/**
 * Rewrites the lines of a .gitignore found in folder `dir` so they only apply inside it, as git does:
 * a pattern with a slash (other than a trailing one) is relative to that folder, one without matches
 * at any depth below it. Comments and blank lines are dropped; "!" re-includes are kept.
 */
export function scopeGitignore(dir: string, lines: string[]): string[] {
	const base = dir.replace(/^\/+|\/+$/g, "");
	if (!base) return lines;
	const out: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const neg = line.startsWith("!") ? "!" : "";
		let p = neg ? line.slice(1) : line;
		if (p.startsWith("\\!") || p.startsWith("\\#")) p = p.slice(1);
		const anchored = p.replace(/\/+$/, "").includes("/");
		out.push(anchored ? `${neg}/${base}/${p.replace(/^\/+/, "")}` : `${neg}/${base}/**/${p}`);
	}
	return out;
}
