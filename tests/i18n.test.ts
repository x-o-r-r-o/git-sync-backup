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
