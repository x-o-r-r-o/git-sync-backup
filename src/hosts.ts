// Supported git hosts: defaults, token instructions, and the factory.

import { classicTokenUrl, fineGrainedTokenUrl, webBase } from "./auth.ts";
import { GitHub } from "./github.ts";
import { Gitea } from "./gitea.ts";
import type { HostConfig } from "./gitea.ts";
import { GitLab } from "./gitlab.ts";
import type { Remote } from "./remote.ts";

export type HostKind = "github" | "gitlab" | "gitea";

export interface HostInfo {
	label: string;
	defaultApi: string;
	apiHint: string;
	beta: boolean;
	tokenSteps(apiBase: string, vault: string): { text: string; link?: { label: string; href: string } }[];
}

const webOf = (api: string, suffix: RegExp) => api.replace(/\/+$/, "").replace(suffix, "");

export const HOSTS: Record<HostKind, HostInfo> = {
	github: {
		label: "GitHub",
		defaultApi: "https://api.github.com",
		apiHint: "Change only for GitHub Enterprise Server, e.g. https://github.example.com/api/v3",
		beta: false,
		tokenSteps: (api, vault) => [
			{ text: "Open GitHub's token page; name, expiry and \"Contents: read and write\" are prefilled.", link: { label: "Create a fine-grained token", href: fineGrainedTokenUrl(api, vault) } },
			{ text: "Under Repository access choose \"Only select repositories\" and pick your vault repository (add Administration: read and write if you want the plugin to create the repository)." },
			{ text: "Generate, copy, and paste it here." },
			{ text: "Simpler alternative (access to all repositories):", link: { label: "classic token with the repo scope", href: classicTokenUrl(api) } },
		],
	},
	gitlab: {
		label: "GitLab",
		defaultApi: "https://gitlab.com/api/v4",
		apiHint: "gitlab.com, or your server, e.g. https://gitlab.example.com/api/v4",
		beta: true,
		tokenSteps: (api) => [
			{ text: "Create a personal access token with the api scope (needed to write commits).", link: { label: "Open GitLab's token page", href: `${webOf(api, /\/api\/v4$/i)}/-/user_settings/personal_access_tokens?name=${encodeURIComponent("Obsidian Vault Sync")}&scopes=api` } },
			{ text: "Tip: a project access token (Settings → Access tokens in your vault project, role Developer, scope api) limits access to that one project." },
			{ text: "Copy and paste it here." },
		],
	},
	gitea: {
		label: "Gitea / Forgejo / Codeberg",
		defaultApi: "https://codeberg.org/api/v1",
		apiHint: "Your server's API, e.g. https://codeberg.org/api/v1 or https://git.example.com/api/v1",
		beta: true,
		tokenSteps: (api) => [
			{ text: "Open Settings → Applications and generate a token with \"repository: Read and Write\" and \"user: Read\".", link: { label: "Open the applications page", href: `${webOf(api, /\/api\/v1$/i)}/user/settings/applications` } },
			{ text: "Requires Gitea 1.20+ or Forgejo 1.20+ (multi-file commit API)." },
			{ text: "Copy and paste it here." },
		],
	},
};

export function makeRemote(kind: HostKind, cfg: () => HostConfig): Remote {
	if (kind === "gitlab") return new GitLab(cfg);
	if (kind === "gitea") return new Gitea(cfg);
	return new GitHub(cfg);
}

export { webBase };
