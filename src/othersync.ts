// Other tools that sync the same vault. Two tools writing the same files can overwrite each other's
// changes, so the wizard and the status panel warn about them. Read-only checks.

import type { App } from "obsidian";

/** Community plugins that sync a vault, by plugin id. */
const SYNC_PLUGINS: Record<string, string> = {
	"obsidian-git": "Obsidian Git",
	"remotely-save": "Remotely Save",
	"obsidian-livesync": "Self-hosted LiveSync",
	fit: "Fit",
	"github-gitless-sync": "GitHub Gitless Sync",
	"obsidian-github-sync": "GitHub Sync",
	"git-obsi-sync": "Git Obsi Sync",
	"syncthing-integration": "Syncthing Integration",
};

/** Folders of cloud-sync apps, matched against the vault's path on desktop. */
const CLOUD_FOLDERS: [RegExp, string][] = [
	[/Mobile Documents|iCloud|CloudDocs/i, "iCloud Drive"],
	[/Dropbox/i, "Dropbox"],
	[/OneDrive/i, "OneDrive"],
	[/Google ?Drive|GoogleDrive|My Drive/i, "Google Drive"],
	[/pCloud/i, "pCloud"],
	[/Nextcloud|ownCloud/i, "Nextcloud"],
	[/Syncthing/i, "Syncthing"],
];

async function readJson(app: App, path: string): Promise<unknown> {
	try {
		const a = app.vault.adapter;
		return (await a.exists(path)) ? (JSON.parse(await a.read(path)) as unknown) : null;
	} catch {
		return null;
	}
}

/** Names of other sync tools that look active for this vault. */
export async function detectOtherSync(app: App): Promise<string[]> {
	const found: string[] = [];
	const cfg = app.vault.configDir;

	// Obsidian Sync (core plugin): core-plugins.json is a list of enabled ids, or an { id: enabled } map.
	const core = await readJson(app, `${cfg}/core-plugins.json`);
	if ((Array.isArray(core) && core.includes("sync")) || (core && typeof core === "object" && (core as Record<string, unknown>).sync === true)) {
		found.push("Obsidian Sync");
	}

	const community = await readJson(app, `${cfg}/community-plugins.json`);
	if (Array.isArray(community)) {
		for (const id of community) if (typeof id === "string" && SYNC_PLUGINS[id]) found.push(SYNC_PLUGINS[id]);
	}

	try {
		if (await app.vault.adapter.exists(".git")) found.push(".git");
	} catch {
		/* ignore */
	}

	// Desktop only: the vault's folder on disk (mobile adapters have no base path).
	const base = (app.vault.adapter as { getBasePath?: () => string }).getBasePath?.();
	if (typeof base === "string") {
		for (const [re, name] of CLOUD_FOLDERS) {
			if (re.test(base)) {
				found.push(name);
				break;
			}
		}
	}
	return found;
}
