import { getLanguage } from "obsidian";

// Tiny translation layer. Follows Obsidian's interface language. English is the source of truth;
// missing keys fall back to English. See docs/TRANSLATING.md.


import { en } from "./locales/en.ts";
import { zh } from "./locales/zh.ts";
import { de } from "./locales/de.ts";
import { es } from "./locales/es.ts";
import { fr } from "./locales/fr.ts";
import { ja } from "./locales/ja.ts";
import { ko } from "./locales/ko.ts";
import { pt } from "./locales/pt.ts";

export type Key = keyof typeof en;


// Looked up by Obsidian's language code, then by its first part ("pt-BR" → "pt", "zh-TW" → "zh").
const catalogs: Record<string, Partial<Record<Key, string>>> = { zh, de, es, fr, ja, ko, pt };

function language(): string {
	try {
		return (getLanguage() || "en").toLowerCase();
	} catch {
		return "en";
	}
}

function fill(s: string, vars: Record<string, string | number>): string {
	return s.replace(/\{(\w+)\}/g, (_: string, k: string) => String(vars[k] ?? `{${k}}`));
}

/** Translate `key`, replacing {placeholders}. */
export function t(key: Key, vars: Record<string, string | number> = {}): string {
	const lang = language();
	const cat = catalogs[lang] ?? catalogs[lang.split("-")[0]];
	return fill(cat?.[key] ?? en[key], vars);
}

/** The English text of `key`, whatever the interface language (for logs and bug reports). */
export function tEn(key: Key, vars: Record<string, string | number> = {}): string {
	return fill(en[key], vars);
}

export const LANGUAGES = ["en", ...Object.keys(catalogs)];
