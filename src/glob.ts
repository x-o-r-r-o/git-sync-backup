// gitignore-style pattern matching. Supports *, **, ?, trailing "/" for folders,
// leading "/" to anchor at the vault root, and "#" comments. Pure module.

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
		} else if ("\\^$+.()|{}[]".includes(c)) {
			out += "\\" + c;
		} else {
			out += c;
		}
	}
	return out;
}

export function compileGlobs(lines: string[]): (path: string) => boolean {
	const res: RegExp[] = [];
	for (const raw of lines) {
		let p = raw.trim();
		if (!p || p.startsWith("#")) continue;
		if (p.endsWith("/")) p = p.slice(0, -1);
		const anchored = p.startsWith("/") || p.includes("/");
		if (p.startsWith("/")) p = p.slice(1);
		if (!p) continue;
		const body = toRegexBody(p);
		res.push(new RegExp(anchored ? `^${body}(?:/.*)?$` : `(?:^|.*/)${body}(?:/.*)?$`));
	}
	return (path: string) => res.some((r) => r.test(path));
}
