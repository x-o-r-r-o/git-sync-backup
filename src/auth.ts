// "Sign in with GitHub" using the OAuth device flow. Works on desktop and mobile because requestUrl
// is not subject to CORS. Needs a GitHub OAuth App client ID with device flow enabled.

import { requestUrl } from "obsidian";
import { sleep } from "./util.ts";

export interface DeviceCode {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

/** github.com for the public API, or the Enterprise host for https://HOST/api/v3. */
export function webBase(apiBase: string): string {
	const u = (apiBase || "https://api.github.com").replace(/\/+$/, "");
	if (/^https:\/\/api\.github\.com$/i.test(u)) return "https://github.com";
	return u.replace(/\/api\/v3$/i, "");
}

async function post(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
	const res = await requestUrl({
		url,
		method: "POST",
		headers: { Accept: "application/json" },
		contentType: "application/json",
		body: JSON.stringify(body),
		throw: false,
	});
	let data: Record<string, unknown> = {};
	try {
		data = res.json;
	} catch {
		/* non-JSON */
	}
	if (res.status >= 400 && !data.error) throw new Error(`GitHub sign-in failed (HTTP ${res.status}).`);
	return data;
}

export async function startDeviceFlow(apiBase: string, clientId: string): Promise<DeviceCode> {
	const data = await post(`${webBase(apiBase)}/login/device/code`, { client_id: clientId, scope: "repo" });
	if (data.error) throw new Error(String(data.error_description ?? data.error));
	return data as unknown as DeviceCode;
}

/** Polls until the user approves in the browser. Resolves to an access token. */
export async function pollDeviceFlow(apiBase: string, clientId: string, code: DeviceCode, cancelled: () => boolean): Promise<string> {
	let interval = Math.max(5, code.interval) * 1000;
	const deadline = Date.now() + code.expires_in * 1000;
	while (Date.now() < deadline) {
		await sleep(interval);
		if (cancelled()) throw new Error("Sign-in cancelled.");
		const data = await post(`${webBase(apiBase)}/login/oauth/access_token`, {
			client_id: clientId,
			device_code: code.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (typeof data.access_token === "string") return data.access_token;
		if (data.error === "authorization_pending") continue;
		if (data.error === "slow_down") {
			interval += 5000;
			continue;
		}
		if (data.error === "expired_token") throw new Error("The sign-in code expired. Please try again.");
		if (data.error === "access_denied") throw new Error("Sign-in was cancelled on GitHub.");
		throw new Error(String(data.error_description ?? data.error ?? "Unknown sign-in error"));
	}
	throw new Error("The sign-in code expired. Please try again.");
}
