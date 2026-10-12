// What parts of the settings folder ({config}, usually .obsidian) are synced. Turned into exclude
// patterns that run before the user's own patterns, so the user's excludes always win. Pure module.

export type PluginSyncMode = "all" | "code" | "settings" | "none";

export interface ConfigSync {
	/** appearance.json and themes/ */
	appearance: boolean;
	/** CSS snippets (snippets/) */
	snippets: boolean;
	/** hotkeys.json */
	hotkeys: boolean;
	/** Other top-level settings: app.json, core-plugins.json, graph.json, … */
	core: boolean;
	/** community-plugins.json: which community plugins are turned on */
	pluginList: boolean;
	/** Plugin code: main.js, manifest.json, styles.css */
	pluginCode: boolean;
	/** Plugin settings: data.json */
	pluginSettings: boolean;
	/** Per-plugin overrides by plugin id (folder name). */
	plugins: Record<string, PluginSyncMode>;
}

export const DEFAULT_CONFIG_SYNC: ConfigSync = {
	appearance: true,
	snippets: true,
	hotkeys: true,
	core: true,
	pluginList: true,
	pluginCode: true,
	pluginSettings: true,
	plugins: {},
};

const CODE = ["main.js", "manifest.json", "styles.css"];

/** Fills in missing fields (older data.json, or a partial object from another version). */
export function normalizeConfigSync(c: Partial<ConfigSync> | undefined): ConfigSync {
	const out: ConfigSync = { ...DEFAULT_CONFIG_SYNC, ...(c ?? {}), plugins: {} };
	for (const [id, mode] of Object.entries(c?.plugins ?? {})) {
		if (/^[\w.-]+$/.test(id) && (mode === "all" || mode === "code" || mode === "settings" || mode === "none")) out.plugins[id] = mode;
	}
	return out;
}

/** Exclude patterns ({config} placeholder, anchored) for the parts of the settings folder that stay local. */
export function configPatterns(input: Partial<ConfigSync> | undefined): string[] {
	const c = normalizeConfigSync(input);
	const out: string[] = [];
	const cfg = (p: string) => `/{config}/${p}`;
	if (!c.core) {
		// Every top-level settings file, then bring back the ones that have their own switch.
		out.push(cfg("*.json"));
		if (c.appearance) out.push("!" + cfg("appearance.json"));
		if (c.hotkeys) out.push("!" + cfg("hotkeys.json"));
		if (c.pluginList) out.push("!" + cfg("community-plugins.json"));
	}
	if (!c.appearance) out.push(cfg("appearance.json"), cfg("themes/"));
	if (!c.snippets) out.push(cfg("snippets/"));
	if (!c.hotkeys) out.push(cfg("hotkeys.json"));
	if (!c.pluginList) out.push(cfg("community-plugins.json"));
	if (!c.pluginCode) out.push(...CODE.map((f) => cfg(`plugins/*/${f}`)));
	if (!c.pluginSettings) out.push(cfg("plugins/*/data.json"));
	// Per-plugin choices come last among these, so they override the switches above.
	for (const [id, mode] of Object.entries(c.plugins).sort(([a], [b]) => a.localeCompare(b))) {
		const p = (f: string) => cfg(`plugins/${id}/${f}`);
		if (mode === "none") out.push(cfg(`plugins/${id}/`));
		else {
			const code = mode === "all" || mode === "code";
			const settings = mode === "all" || mode === "settings";
			out.push(...CODE.map((f) => (code ? "!" : "") + p(f)));
			out.push((settings ? "!" : "") + p("data.json"));
		}
	}
	return out;
}
