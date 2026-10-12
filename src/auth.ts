// Authentication helpers. The plugin uses personal access tokens (fine-grained recommended).
// See docs/AUTH.md for the OAuth research and the planned GitHub App sign-in.

/** github.com for the public API, or the Enterprise host for https://HOST/api/v3. */
export function webBase(apiBase: string): string {
	const u = (apiBase || "https://api.github.com").replace(/\/+$/, "");
	if (/^https:\/\/api\.github\.com$/i.test(u)) return "https://github.com";
	return u.replace(/\/api\/v3$/i, "");
}

/** Prefilled fine-grained token page (GitHub template URL: name, description, expiry, permissions). */
export function fineGrainedTokenUrl(apiBase: string, vaultName: string): string {
	const q = new URLSearchParams({
		name: `Obsidian Vault Sync (${vaultName})`.slice(0, 40),
		description: "Used by the Vault Sync for Git Obsidian plugin to sync this vault. Contents read & write on the vault repository only.",
		expires_in: "366",
		contents: "write",
	});
	return `${webBase(apiBase)}/settings/personal-access-tokens/new?${q.toString()}`;
}

export function classicTokenUrl(apiBase: string): string {
	return `${webBase(apiBase)}/settings/tokens/new?scopes=repo&description=${encodeURIComponent("Obsidian Vault Sync")}`;
}
