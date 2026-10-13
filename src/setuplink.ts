// Setup links for adding a device: obsidian://vault-sync-git?s=<payload>. The payload carries the
// connection and the vault-wide sync settings; the access token is optional and always encrypted with
// a random one-time code that is shown next to the link (never put in it). Pure module.

import { b64, deriveMaster, unb64 } from "./crypto.ts";
import { normalizeConfigSync } from "./scope-config.ts";
import type { ConfigSync } from "./scope-config.ts";
import { PROVIDERS } from "./removed-hosts.ts";
import type { Provider } from "./types.ts";

export const SETUP_ACTION = "vault-sync-git";

export interface SetupPayload {
	v: 1;
	provider: Provider;
	/** API URL, only when it isn't the host's default (self-hosted, GitHub Enterprise). */
	api?: string;
	owner: string;
	repo: string;
	branch: string;
	syncConfigDir?: boolean;
	configSync?: ConfigSync;
	syncHidden?: boolean;
	useGitignore?: boolean;
	/** The exclude patterns, only when they differ from the defaults. */
	exclude?: string;
	/** Access token encrypted with the one-time code (AES-GCM, key from PBKDF2-SHA256). */
	token?: { salt: string; iv: string; ct: string };
}

const te = new TextEncoder();
const td = new TextDecoder();
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const toUrl = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromUrl = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);

/** Random one-time code, e.g. "K7QD-2MXP-9TRA" (60 bits; no 0/O/1/I to avoid typos). */
export function newSetupCode(): string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
	return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const normCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

async function key(code: string, salt: Uint8Array): Promise<CryptoKey> {
	const raw = await deriveMaster(normCode(code), salt);
	return crypto.subtle.importKey("raw", ab(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(token: string, code: string): Promise<NonNullable<SetupPayload["token"]>> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, await key(code, salt), ab(te.encode(token))));
	return { salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Throws when the code is wrong (AES-GCM authentication fails). */
export async function decryptToken(t: NonNullable<SetupPayload["token"]>, code: string): Promise<string> {
	const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(unb64(t.iv)) }, await key(code, unb64(t.salt)), ab(unb64(t.ct)));
	return td.decode(pt);
}

export function buildSetupLink(p: SetupPayload): string {
	return `obsidian://${SETUP_ACTION}?s=${toUrl(b64(te.encode(JSON.stringify(p))))}`;
}

const str = (v: unknown, max = 200): string | null => (typeof v === "string" && v.length <= max ? v : null);

/** Validates everything: the link may come from anywhere, so nothing in it is trusted blindly. */
export function parseSetupPayload(s: string | undefined): SetupPayload | null {
	if (!s || s.length > 20000) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(td.decode(unb64(fromUrl(s)))) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (raw.v !== 1 || !PROVIDERS.includes(raw.provider as Provider)) return null;
	const owner = str(raw.owner);
	const repo = str(raw.repo);
	const branch = str(raw.branch);
	if (!owner || !repo || !branch || /[\s?#]/.test(owner + repo)) return null;
	// "." / ".." / empty segments would change the API URL path (owner may be "group/subgroup").
	if ([...owner.split("/"), ...repo.split("/")].some((seg) => seg === "" || seg === "." || seg === "..")) return null;
	const out: SetupPayload = { v: 1, provider: raw.provider as Provider, owner, repo, branch };
	const api = str(raw.api, 500);
	if (api) {
		// Only https (or http to localhost for testing), never anything that could run code.
		if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(api) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/[^\s?#]*)?$/i.test(api)) return null;
		out.api = api;
	}
	if (typeof raw.syncConfigDir === "boolean") out.syncConfigDir = raw.syncConfigDir;
	if (typeof raw.syncHidden === "boolean") out.syncHidden = raw.syncHidden;
	if (typeof raw.useGitignore === "boolean") out.useGitignore = raw.useGitignore;
	if (raw.configSync && typeof raw.configSync === "object") out.configSync = normalizeConfigSync(raw.configSync);
	const exclude = str(raw.exclude, 10000);
	if (exclude !== null) out.exclude = exclude;
	const t = raw.token as Record<string, unknown> | undefined;
	if (t && str(t.salt) && str(t.iv) && str(t.ct, 4000)) out.token = { salt: t.salt as string, iv: t.iv as string, ct: t.ct as string };
	return out;
}
