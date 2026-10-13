// Editing the exclude patterns from the file explorer ("Git: Exclude this file", "Git: Include in sync").
// Pure module: works on the patterns text and returns the new text.

import { compileGlobs } from "./glob.ts";

/** Escapes characters the pattern syntax treats specially (brackets are literal already). */
function escapeGlob(path: string): string {
	return path.replace(/[*?\\]/g, (c) => "\\" + c);
}

/** A pattern matching exactly this vault path, anchored at the vault root ("/Notes/a.md", "/Archive/"). */
export function exactPattern(path: string, folder: boolean): string {
	const p = path.replace(/^\/+|\/+$/g, "");
	return "/" + escapeGlob(p) + (folder ? "/" : "");
}

const lines = (text: string) => text.split("\n");
const withConfig = (text: string, configDir: string) => lines(text).map((l) => l.split("{config}").join(configDir));

/** True when the user's own patterns leave this path out. */
export function excludedByPatterns(patterns: string, path: string, configDir: string): boolean {
	return compileGlobs(withConfig(patterns, configDir))(path);
}

/** Adds an exclusion for the path. Returns null when the patterns already leave it out. */
export function addExclusion(patterns: string, path: string, folder: boolean, configDir: string): string | null {
	if (excludedByPatterns(patterns, path, configDir)) return null;
	const line = exactPattern(path, folder);
	// A "!" line for this very path (added by "Include in sync") is replaced rather than contradicted.
	const kept = lines(patterns).filter((l) => l.trim() !== "!" + line);
	const out = `${kept.join("\n").trimEnd()}\n${line}`;
	return excludedByPatterns(out, path, configDir) ? out : null;
}

/**
 * Brings an excluded path back: removes its own exact pattern when that is enough, otherwise adds a
 * "!" re-include line after the pattern that excludes it. Returns null when the patterns don't
 * exclude it (nothing to do) or when it can't be brought back by them.
 */
export function removeExclusion(patterns: string, path: string, folder: boolean, configDir: string): string | null {
	if (!excludedByPatterns(patterns, path, configDir)) return null;
	const own = exactPattern(path, folder);
	// Only patterns anchored to exactly this path: an unanchored "a.md" also covers Sub/a.md, so it stays.
	const nested = path.replace(/^\/+|\/+$/g, "").includes("/");
	const variants = new Set([own, folder ? own.slice(0, -1) : own, nested ? own.slice(1) : own, nested && folder ? own.slice(1, -1) : own]);
	const removed = lines(patterns).filter((l) => !variants.has(l.trim()));
	let out = removed.join("\n");
	if (excludedByPatterns(out, path, configDir)) out = `${out.trimEnd()}\n!${own}`;
	return excludedByPatterns(out, path, configDir) ? null : out;
}
