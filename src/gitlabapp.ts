// Sign in with GitLab: OAuth 2.0 device authorization grant (RFC 8628) against gitlab.com or a
// self-managed GitLab (17.9+, or 17.3+ with the default-on `oauth2_device_grant_flow` flag).
// Public (non-confidential) application: no client secret, no server and no redirect, so it works
// the same on desktop and mobile. Mirrors src/ghapp.ts.
// Docs: https://docs.gitlab.com/api/oauth2/#device-authorization-grant-flow

import { obsidianTransport } from "./http.ts";
import type { Transport } from "./http.ts";
import { sleep } from "./util.ts";

export interface GitLabAppConfig {
	/** Public Application ID of the GitLab OAuth application (safe to ship; no secret is used). */
	clientId: string;
}

/** Vault Sync for Git's OAuth application on gitlab.com. Sign-in is offered only when this is set. */
export const GITLAB_APP: GitLabAppConfig = { clientId: "4d7a0de58328956caa65bb4ddc9823959c5a5956aa053681a1f8f0535929a94f" };

/**
 * "api" is required: we create commits through the REST v4 Commits API (POST
 * /projects/:id/repository/commits). read_api is read-only, and write_repository only covers
 * Git-over-HTTP, not the REST API.
 */
export const GITLAB_SCOPE = "api";

/** How to register the application (shown to the user, e.g. for self-managed GitLab). */
export const GITLAB_APP_REGISTRATION = `Register a GitLab OAuth application for Vault Sync for Git:
1. On your GitLab (gitlab.com or self-managed 17.9+), open your avatar > Edit profile > Access > Applications
   (or /-/user_settings/applications). For a group- or instance-owned app use Group settings > Applications
   or Admin area > Applications instead.
2. Select "Add new application".
3. Name: Vault Sync for Git
4. Redirect URI: the form requires one, but the device flow never uses it. Enter the plugin homepage,
   e.g. https://github.com/x-o-r-r-o/git-sync-backup (any valid https URL works).
5. Confidential: UNCHECK it. The plugin runs on your devices and cannot keep a secret; it signs in with the
   Application ID only.
6. Tick "Device authorization grant" (without it GitLab answers access_denied).
   Scopes: tick "api" only (needed to create commits through the REST API).
7. Select "Save application" and copy the "Application ID" (the client ID). Ignore the Secret; it is not used.`;

export interface AppTokens {
	access: string;
	/** Epoch ms when the access token expires; 0 = never. GitLab: 2 hours by default. */
	expiresAt: number;
	refresh: string;
	/** Epoch ms when the refresh token expires; 0 = unknown or never (GitLab does not say). */
	refreshExpiresAt: number;
	/** Where the tokens came from: they are only ever sent back to that server and app. */
	web?: string;
	clientId?: string;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** verification_uri with the user code filled in, when GitLab provides it. */
	verificationUriComplete?: string;
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

/** https://gitlab.com/api/v4 -> https://gitlab.com; https://host/gitlab/api/v4/ -> https://host/gitlab. */
export function webBaseFromApi(apiBase: string): string {
	return apiBase
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/api\/v\d+$/i, "")
		.replace(/\/+$/, "");
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
	// "http" = temporary (server error or no connection: worth retrying); other statuses without an OAuth error are final.
	if (res.status >= 300 && typeof j.error !== "string") throw new DeviceFlowError(res.status >= 500 || res.status === 0 || res.status === 429 ? "http" : "http_status", `GitLab sign-in failed (HTTP ${res.status})`);
	return j;
}

function fail(j: Json): never {
	throw new DeviceFlowError(String(j.error), typeof j.error_description === "string" ? j.error_description : undefined);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export function tokensFrom(j: Json, now: number): AppTokens {
	if (typeof j.access_token !== "string" || !j.access_token) throw new DeviceFlowError("no_token", "GitLab did not return an access token");
	const exp = num(j.expires_in);
	return {
		access: j.access_token,
		expiresAt: exp ? now + exp * 1000 : 0,
		refresh: typeof j.refresh_token === "string" ? j.refresh_token : "",
		refreshExpiresAt: 0,
	};
}

/** Step 1: ask GitLab for a user code. `web` is the GitLab web root (see webBaseFromApi). */
export async function startDeviceFlow(
	web: string,
	clientId: string,
	transport: Transport = obsidianTransport,
	now = Date.now,
	scope = GITLAB_SCOPE,
): Promise<DeviceCode> {
	const j = await post(transport, `${web}/oauth/authorize_device`, { client_id: clientId, scope });
	if (typeof j.error === "string") fail(j);
	if (typeof j.device_code !== "string" || typeof j.user_code !== "string") throw new DeviceFlowError("http", "GitLab did not return a sign-in code");
	return {
		deviceCode: j.device_code,
		userCode: j.user_code,
		verificationUri: typeof j.verification_uri === "string" ? j.verification_uri : `${web}/oauth/device`,
		...(typeof j.verification_uri_complete === "string" ? { verificationUriComplete: j.verification_uri_complete } : {}),
		expiresAt: now() + (num(j.expires_in) || 300) * 1000,
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
			j = await post(transport, `${web}/oauth/token`, {
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
			// RFC 8628 3.5: add 5 seconds to the interval.
			interval = num(j.interval) || interval + 5;
			continue;
		}
		if (typeof j.error === "string") fail(j);
		return tokensFrom(j, now());
	}
}

/**
 * Exchange a refresh token for new tokens (public client: client_id only, no secret). GitLab
 * revokes the old access and refresh tokens, so always store the returned pair.
 */
export async function refreshAppToken(web: string, clientId: string, refresh: string, transport: Transport = obsidianTransport, now = Date.now): Promise<AppTokens> {
	const j = await post(transport, `${web}/oauth/token`, { client_id: clientId, grant_type: "refresh_token", refresh_token: refresh });
	if (typeof j.error === "string") fail(j);
	const t = tokensFrom(j, now());
	// Defensive: keep the old refresh token if the server did not rotate it.
	return t.refresh ? t : { ...t, refresh };
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
