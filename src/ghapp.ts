// Sign in with GitHub: GitHub App user access tokens through the OAuth device flow. No client
// secret, no server and no redirect, so it works the same on desktop and mobile. See docs/AUTH.md.

import { obsidianTransport } from "./http.ts";
import type { Transport } from "./http.ts";
import { sleep } from "./util.ts";

export interface AppConfig {
	/** Public client ID of the GitHub App (safe to ship; device flow needs no secret). */
	clientId: string;
	/** The app's URL name, for github.com/apps/<slug>/installations/new. */
	slug: string;
}

/** Vault Sync for Git's GitHub App on github.com. Sign-in is offered only when this is set. */
export const GITHUB_APP: AppConfig = { clientId: "Iv23lilDQAJBENeFs5Ei", slug: "vault-sync-for-git" };

export interface AppTokens {
	access: string;
	/** Epoch ms when the access token expires; 0 = never. */
	expiresAt: number;
	refresh: string;
	/** Epoch ms when the refresh token expires; 0 = unknown or never. */
	refreshExpiresAt: number;
	/** Where the tokens came from: they are only ever sent back to that server and app. */
	web?: string;
	clientId?: string;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** Epoch ms when the user code stops working. */
	expiresAt: number;
	/** Minimum seconds between polls. */
	interval: number;
}

export class DeviceFlowError extends Error {
	code: string;
	constructor(code: string, message?: string) {
		super(message || code);
		this.code = code;
	}
}

type Json = Record<string, unknown>;

async function post(transport: Transport, url: string, params: Record<string, string>): Promise<Json> {
	const res = await transport({
		url,
		method: "POST",
		headers: { Accept: "application/json" },
		body: new URLSearchParams(params).toString(),
		contentType: "application/x-www-form-urlencoded",
	});
	const j = (res.json && typeof res.json === "object" ? res.json : {}) as Json;
	if (res.status >= 300 && typeof j.error !== "string") throw new DeviceFlowError("http", `GitHub sign-in failed (HTTP ${res.status})`);
	return j;
}

function fail(j: Json): never {
	throw new DeviceFlowError(String(j.error), typeof j.error_description === "string" ? j.error_description : undefined);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function tokensFrom(j: Json, now: number): AppTokens {
	if (typeof j.access_token !== "string" || !j.access_token) throw new DeviceFlowError("no_token", "GitHub did not return an access token");
	const exp = num(j.expires_in);
	const rexp = num(j.refresh_token_expires_in);
	return {
		access: j.access_token,
		expiresAt: exp ? now + exp * 1000 : 0,
		refresh: typeof j.refresh_token === "string" ? j.refresh_token : "",
		refreshExpiresAt: rexp ? now + rexp * 1000 : 0,
	};
}

/** Step 1: ask GitHub for a user code. */
export async function startDeviceFlow(web: string, clientId: string, transport: Transport = obsidianTransport, now = Date.now): Promise<DeviceCode> {
	const j = await post(transport, `${web}/login/device/code`, { client_id: clientId });
	if (typeof j.error === "string") fail(j);
	if (typeof j.device_code !== "string" || typeof j.user_code !== "string") throw new DeviceFlowError("http", "GitHub did not return a sign-in code");
	return {
		deviceCode: j.device_code,
		userCode: j.user_code,
		verificationUri: typeof j.verification_uri === "string" ? j.verification_uri : `${web}/login/device`,
		expiresAt: now() + (num(j.expires_in) || 900) * 1000,
		interval: num(j.interval) || 5,
	};
}

export interface PollOptions {
	transport?: Transport;
	isCancelled?: () => boolean;
	wait?: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Step 2: poll until the user approves (or denies, or the code expires). */
export async function pollDeviceFlow(web: string, clientId: string, code: DeviceCode, opts: PollOptions = {}): Promise<AppTokens> {
	const transport = opts.transport ?? obsidianTransport;
	const wait = opts.wait ?? sleep;
	const now = opts.now ?? Date.now;
	let interval = code.interval;
	for (;;) {
		await wait(interval * 1000);
		if (opts.isCancelled?.()) throw new DeviceFlowError("cancelled");
		if (now() > code.expiresAt) throw new DeviceFlowError("expired_token");
		let j: Json;
		try {
			j = await post(transport, `${web}/login/oauth/access_token`, {
				client_id: clientId,
				device_code: code.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			});
		} catch (e) {
			// Flaky phone networks: keep polling until the code expires.
			if (e instanceof DeviceFlowError && e.code !== "http") throw e;
			continue;
		}
		if (j.error === "authorization_pending") continue;
		if (j.error === "slow_down") {
			interval = num(j.interval) || interval + 5;
			continue;
		}
		if (typeof j.error === "string") fail(j);
		return tokensFrom(j, now());
	}
}

/** Exchange a refresh token for new tokens. GitHub rotates the refresh token every time. */
export async function refreshAppToken(web: string, clientId: string, refresh: string, transport: Transport = obsidianTransport, now = Date.now): Promise<AppTokens> {
	const j = await post(transport, `${web}/login/oauth/access_token`, { client_id: clientId, grant_type: "refresh_token", refresh_token: refresh });
	if (typeof j.error === "string") fail(j);
	return tokensFrom(j, now());
}

/** True when the access token expires within `marginMs`. Tokens without an expiry never need it. */
export function needsRefresh(t: AppTokens, now = Date.now(), marginMs = 10 * 60_000): boolean {
	return t.expiresAt > 0 && t.expiresAt - now < marginMs;
}

export function parseTokens(raw: string): AppTokens | null {
	try {
		const t = JSON.parse(raw) as Partial<AppTokens>;
		if (typeof t.access !== "string" || !t.access) return null;
		return {
			access: t.access,
			expiresAt: num(t.expiresAt),
			refresh: typeof t.refresh === "string" ? t.refresh : "",
			refreshExpiresAt: num(t.refreshExpiresAt),
			...(typeof t.web === "string" ? { web: t.web } : {}),
			...(typeof t.clientId === "string" ? { clientId: t.clientId } : {}),
		};
	} catch {
		return null;
	}
}

export function installUrl(web: string, slug: string): string {
	return `${web}/apps/${encodeURIComponent(slug)}/installations/new`;
}
