// Install plugins from their official releases instead of syncing plugin code.
//
// When settings-folder sync carries community-plugins.json and each plugin's manifest.json but
// not main.js/styles.css, a device can see that a plugin is enabled elsewhere while its code is
// missing (or at another version) locally. This module works out what to install and downloads
// it from the plugin's GitHub release. The GitHub repository is resolved ONLY from the official
// Obsidian community registry; anything not listed there is reported as "unknown" and never
// installed. Every id, repo and version is validated before it touches a path or a URL.
//
// Installed-version tracking: after a successful install we write a small marker file
// `${configDir}/plugins/<id>/.vsg-installed` containing {"version": "<version>"}. A plugin is
//   - "missing"  when main.js does not exist;
//   - "outdated" when main.js exists, a marker exists, and the marker's version differs from the
//                (synced) manifest.json version.
// A plugin with main.js but no marker was installed some other way (Obsidian itself, by hand) and
// is left alone. The marker should stay device-local (not synced): it describes this device's code.

import { requestUrl } from "obsidian";

export interface PluginNeed {
	id: string;
	name: string;
	version: string;
	repo: string;
	reason: "missing" | "outdated";
}

export interface RegistryEntry {
	id: string;
	repo: string;
	name?: string;
}

export interface FetchResponse {
	status: number;
	arrayBuffer: ArrayBuffer;
	text: string;
}

export type FetchTransport = (url: string) => Promise<FetchResponse>;

export interface PluginReadIO {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
}

export interface InstallDeps {
	transport: FetchTransport;
	write(path: string, data: ArrayBuffer): Promise<void>;
	mkdir?(path: string): Promise<void>;
}

export const REGISTRY_URL = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/community-plugins.json";
export const SELF_ID = "vault-sync-git";
export const MARKER_FILE = ".vsg-installed";

const ID_RE = /^[a-z0-9-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION_RE = /^[0-9A-Za-z.+-]+$/;

export function isValidId(id: unknown): id is string {
	return typeof id === "string" && id.length <= 128 && ID_RE.test(id);
}

export function isValidRepo(repo: unknown): repo is string {
	if (typeof repo !== "string" || repo.length > 200 || !REPO_RE.test(repo)) return false;
	// "." / ".." segments would change the URL path.
	return repo.split("/").every((seg) => seg !== "." && seg !== "..");
}

export function isValidVersion(v: unknown): v is string {
	return typeof v === "string" && v.length <= 64 && VERSION_RE.test(v) && v !== "." && v !== ".." && /[0-9A-Za-z]/.test(v);
}

function pluginDir(configDir: string, id: string): string {
	return `${configDir}/plugins/${id}`;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function asRecord(v: unknown): Record<string, unknown> | null {
	return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Parse the registry JSON, keeping only entries with a valid id and repo. */
export function parseRegistry(text: string): RegistryEntry[] {
	const data = parseJson(text);
	if (!Array.isArray(data)) throw new Error("Plugin registry is not a list");
	const out: RegistryEntry[] = [];
	for (const item of data) {
		const r = asRecord(item);
		if (!r || !isValidId(r.id) || !isValidRepo(r.repo)) continue;
		out.push({ id: r.id, repo: r.repo, name: typeof r.name === "string" ? r.name : undefined });
	}
	return out;
}

export async function fetchRegistry(transport: FetchTransport = obsidianFetch): Promise<RegistryEntry[]> {
	const res = await transport(REGISTRY_URL);
	if (res.status !== 200) throw new Error(`Could not load the plugin registry (HTTP ${res.status})`);
	return parseRegistry(res.text);
}

/** Work out which enabled plugins need their code installed or updated on this device. */
export async function findPluginNeeds(
	io: PluginReadIO,
	configDir: string,
	fetchRegistryFn: () => Promise<RegistryEntry[]>,
	/** Plugins whose manifest.json just arrived through sync (updated elsewhere): outdated even without a marker. */
	updatedElsewhere: Set<string> = new Set(),
): Promise<{ needs: PluginNeed[]; unknown: string[] }> {
	const listPath = `${configDir}/community-plugins.json`;
	if (!(await io.exists(listPath))) return { needs: [], unknown: [] };
	const list = parseJson(await io.read(listPath));
	if (!Array.isArray(list)) return { needs: [], unknown: [] };

	const candidates: { id: string; version: string; name: string; reason: PluginNeed["reason"] }[] = [];
	const unknown: string[] = [];
	const seen = new Set<string>();
	for (const raw of list) {
		if (typeof raw !== "string" || seen.has(raw)) continue;
		seen.add(raw);
		if (raw === SELF_ID) continue;
		if (!isValidId(raw)) {
			unknown.push(raw);
			continue;
		}
		const dir = pluginDir(configDir, raw);
		const manifestPath = `${dir}/manifest.json`;
		if (!(await io.exists(manifestPath))) continue; // nothing says which version to install
		const manifest = asRecord(parseJson(await io.read(manifestPath)));
		if (!manifest || !isValidVersion(manifest.version)) continue;
		const version = manifest.version;
		const name = typeof manifest.name === "string" ? manifest.name : raw;

		let reason: PluginNeed["reason"] | null = null;
		if (!(await io.exists(`${dir}/main.js`))) reason = "missing";
		else if (await io.exists(`${dir}/${MARKER_FILE}`)) {
			const marker = asRecord(parseJson(await io.read(`${dir}/${MARKER_FILE}`)));
			if (!marker || marker.version !== version) reason = "outdated";
		} else if (updatedElsewhere.has(raw)) reason = "outdated"; // installed by Obsidian, updated on another device
		if (reason) candidates.push({ id: raw, version, name, reason });
	}

	if (candidates.length === 0) return { needs: [], unknown };
	const registry = new Map<string, RegistryEntry>();
	for (const e of await fetchRegistryFn()) if (isValidId(e.id) && isValidRepo(e.repo)) registry.set(e.id, e);

	const needs: PluginNeed[] = [];
	for (const c of candidates) {
		const entry = registry.get(c.id);
		if (!entry) {
			unknown.push(c.id);
			continue;
		}
		needs.push({ id: c.id, name: entry.name ?? c.name, version: c.version, repo: entry.repo, reason: c.reason });
	}
	return { needs, unknown };
}

export function releaseUrl(repo: string, version: string, file: string): string {
	return `https://github.com/${repo}/releases/download/${version}/${file}`;
}

/**
 * Download main.js, manifest.json and (optionally) styles.css from the plugin's GitHub release and
 * write them into the plugin folder, then record the installed version in the marker file.
 * Throws (writing nothing) if anything fails validation.
 */
export async function installPlugin(need: PluginNeed, deps: InstallDeps, configDir: string): Promise<void> {
	if (need.id === SELF_ID) throw new Error("Refusing to install Git Sync & Backup over itself");
	if (!isValidId(need.id)) throw new Error(`Invalid plugin id: ${String(need.id)}`);
	if (!isValidRepo(need.repo)) throw new Error(`Invalid repository for ${need.id}: ${String(need.repo)}`);
	if (!isValidVersion(need.version)) throw new Error(`Invalid version for ${need.id}: ${String(need.version)}`);

	const fetchFile = async (file: string, optional: boolean): Promise<FetchResponse | null> => {
		const res = await deps.transport(releaseUrl(need.repo, need.version, file));
		if (res.status === 200) return res;
		if (optional && res.status === 404) return null;
		throw new Error(`Download of ${file} for ${need.id} ${need.version} failed (HTTP ${res.status})`);
	};
	const required = async (file: string): Promise<FetchResponse> => {
		const res = await fetchFile(file, false);
		if (!res) throw new Error(`Download of ${file} for ${need.id} failed`);
		return res;
	};

	// Download everything first; write only once all checks passed.
	const manifestRes = await required("manifest.json");
	const manifest = asRecord(parseJson(manifestRes.text));
	if (!manifest) throw new Error(`Release manifest of ${need.id} is not valid JSON`);
	if (manifest.id !== need.id) throw new Error(`Release manifest id "${String(manifest.id)}" does not match ${need.id}`);
	if (manifest.version !== need.version) throw new Error(`Release manifest version "${String(manifest.version)}" does not match ${need.version} for ${need.id}`);

	const mainRes = await required("main.js");
	if (mainRes.arrayBuffer.byteLength === 0) throw new Error(`main.js of ${need.id} is empty`);
	const stylesRes = await fetchFile("styles.css", true);

	const dir = pluginDir(configDir, need.id);
	if (deps.mkdir) await deps.mkdir(dir);
	await deps.write(`${dir}/main.js`, mainRes.arrayBuffer);
	await deps.write(`${dir}/manifest.json`, manifestRes.arrayBuffer);
	if (stylesRes) await deps.write(`${dir}/styles.css`, stylesRes.arrayBuffer);
	await deps.write(`${dir}/${MARKER_FILE}`, new TextEncoder().encode(JSON.stringify({ version: need.version })).buffer);
}

/** Default transport: Obsidian's requestUrl (no CORS, follows redirects, works on mobile). */
export const obsidianFetch: FetchTransport = async (url) => {
	const res = await requestUrl({ url, method: "GET", throw: false });
	const arrayBuffer = res.arrayBuffer;
	return { status: res.status, arrayBuffer, text: new TextDecoder().decode(arrayBuffer) };
};
