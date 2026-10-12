import { test } from "node:test";
import assert from "node:assert/strict";
import { t } from "../src/i18n.ts";

test("i18n: English default, placeholders, Chinese catalog, fallback", () => {
	const g = globalThis as any;
	const saved = g.window;
	g.window = { localStorage: { getItem: () => null } };
	assert.equal(t("cmd.sync"), "Sync now");
	assert.equal(t("health.editedN", { n: 3 }), "3 file(s) edited on this device since the last sync");
	g.window = { localStorage: { getItem: () => "zh" } };
	assert.equal(t("cmd.sync"), "立即同步");
	assert.equal(t("time.min", { n: 5 }), "5 分钟前");
	g.window = { localStorage: { getItem: () => "xx" } };
	assert.equal(t("cmd.sync"), "Sync now", "unknown language falls back to English");
	g.window = saved;
});

test("i18n: Simplified Chinese covers every English key, with the same placeholders", async () => {
	const { en } = await import("../src/locales/en.ts");
	const { zh } = await import("../src/locales/zh.ts");
	const missing = Object.keys(en).filter((k) => !(k in zh));
	assert.deepEqual(missing, [], `missing zh keys: ${missing.join(", ")}`);
	for (const [k, v] of Object.entries(en)) {
		const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
		assert.equal(ph((zh as Record<string, string>)[k]), ph(v), `placeholders differ for ${k}`);
	}
});

test("i18n: every catalog covers every English key, with the same placeholders", async () => {
	const { en } = await import("../src/locales/en.ts");
	const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
	for (const lang of ["de", "es", "fr", "ja", "ko", "pt"]) {
		const cat = (await import(`../src/locales/${lang}.ts`))[lang] as Record<string, string>;
		const missing = Object.keys(en).filter((k) => !(k in cat));
		const extra = Object.keys(cat).filter((k) => !(k in en));
		assert.deepEqual(missing, [], `${lang}: missing ${missing.join(", ")}`);
		assert.deepEqual(extra, [], `${lang}: unknown keys ${extra.join(", ")}`);
		for (const [k, v] of Object.entries(en)) assert.equal(ph(cat[k]), ph(v), `${lang}: placeholders differ for ${k}`);
	}
});
