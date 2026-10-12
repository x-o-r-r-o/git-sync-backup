import { getLanguage } from "obsidian";

// Tiny translation layer. Follows Obsidian's interface language. English is the source of truth;
// missing keys fall back to English. See docs/TRANSLATING.md.


import { en } from "./locales/en.ts";
import { zh } from "./locales/zh.ts";

export type Key = keyof typeof en;


const catalogs: Record<string, Partial<Record<Key, string>>> = { zh };

function language(): string {
	try {
		return (getLanguage() || "en").toLowerCase();
	} catch {
		return "en";
	}
}

/** Translate `key`, replacing {placeholders}. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
	const lang = language();
	const cat = catalogs[lang] ?? catalogs[lang.split("-")[0]];
	const s = cat?.[key] ?? en[key];
	return s.replace(/\{(\w+)\}/g, (_: string, k: string) => String(vars[k] ?? `{${k}}`));
}

export const LANGUAGES = ["en", ...Object.keys(catalogs)];
