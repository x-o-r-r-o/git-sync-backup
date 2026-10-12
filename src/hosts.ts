// Supported git hosts: defaults, token instructions, and the factory.

import { classicTokenUrl, fineGrainedTokenUrl, webBase } from "./auth.ts";
import { t } from "./i18n.ts";
import { GitHub } from "./github.ts";
import { Gitea } from "./gitea.ts";
import type { HostConfig } from "./gitea.ts";
import { GitLab } from "./gitlab.ts";
import { Bitbucket } from "./bitbucket.ts";
import type { BlobCacheStore } from "./bitbucket.ts";
import type { Remote } from "./remote.ts";

export type HostKind = "github" | "gitlab" | "gitea" | "bitbucket";

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
		get apiHint() {
			return t("hs.ghApi");
		},
		beta: false,
		tokenSteps: (api, vault) => [
			{ text: t("hs.gh1"), link: { label: t("hs.gh1Link"), href: fineGrainedTokenUrl(api, vault) } },
			{ text: t("hs.gh2") },
			{ text: t("hs.gh3") },
			{ text: t("hs.gh4"), link: { label: t("hs.gh4Link"), href: classicTokenUrl(api) } },
		],
	},
	gitlab: {
		label: "GitLab",
		defaultApi: "https://gitlab.com/api/v4",
		get apiHint() {
			return t("hs.glApi");
		},
		beta: true,
		tokenSteps: (api) => [
			{ text: t("hs.gl1"), link: { label: t("hs.gl1Link"), href: `${webOf(api, /\/api\/v4$/i)}/-/user_settings/personal_access_tokens?name=${encodeURIComponent("Obsidian Vault Sync")}&scopes=api` } },
			{ text: t("hs.gl2") },
			{ text: t("hs.paste") },
		],
	},
	gitea: {
		label: "Gitea / Forgejo / Codeberg",
		defaultApi: "https://codeberg.org/api/v1",
		get apiHint() {
			return t("hs.gtApi");
		},
		beta: true,
		tokenSteps: (api) => [
			{ text: t("hs.gt1"), link: { label: t("hs.gt1Link"), href: `${webOf(api, /\/api\/v1$/i)}/user/settings/applications` } },
			{ text: t("hs.gt2") },
			{ text: t("hs.paste") },
		],
	},
	bitbucket: {
		label: "Bitbucket",
		defaultApi: "https://api.bitbucket.org/2.0",
		get apiHint() {
			return t("hs.bbApi");
		},
		beta: true,
		tokenSteps: () => [
			{ text: t("hs.bb1"), link: { label: t("hs.bb1Link"), href: "https://support.atlassian.com/bitbucket-cloud/docs/repository-access-tokens/" } },
			{ text: t("hs.bb2"), link: { label: t("hs.bb2Link"), href: "https://id.atlassian.com/manage-profile/security/api-tokens" } },
			{ text: t("hs.bb3") },
		],
	},
};

export function makeRemote(kind: HostKind, cfg: () => HostConfig, cacheStore: BlobCacheStore | null = null): Remote {
	if (kind === "bitbucket") return new Bitbucket(cfg, cacheStore);
	if (kind === "gitlab") return new GitLab(cfg, undefined, cacheStore);
	if (kind === "gitea") return new Gitea(cfg);
	return new GitHub(cfg);
}

export { webBase };
