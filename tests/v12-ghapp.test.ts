import { test } from "node:test";
import assert from "node:assert/strict";
import { DeviceFlowError, installUrl, needsRefresh, parseTokens, pollDeviceFlow, refreshAppToken, startDeviceFlow } from "../src/ghapp.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/http.ts";
import { GitHub } from "../src/github.ts";

const WEB = "https://github.com";

/** Fake GitHub OAuth endpoints: replies are consumed in order per URL path. */
function fakeOAuth(replies: Record<string, (Record<string, unknown> | Error)[]>) {
	const calls: { path: string; params: URLSearchParams }[] = [];
	const transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
		const path = new URL(req.url).pathname;
		const params = new URLSearchParams(String(req.body ?? ""));
		calls.push({ path, params });
		assert.equal(req.method, "POST");
		assert.equal(req.contentType, "application/x-www-form-urlencoded");
		assert.equal(params.get("client_secret"), null, "never sends a client secret");
		const next = replies[path]?.shift();
		if (!next) throw new Error(`unexpected call to ${path}`);
		if (next instanceof Error) throw next;
		return { status: 200, json: next, arrayBuffer: new ArrayBuffer(0), headers: {} };
	};
	return { transport, calls };
}

test("device flow: code, pending, slow_down, then tokens with expiry", async () => {
	let clock = 1_000_000;
	const now = () => clock;
	const { transport, calls } = fakeOAuth({
		"/login/device/code": [{ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }],
		"/login/oauth/access_token": [
			{ error: "authorization_pending" },
			{ error: "slow_down", interval: 10 },
			new Error("network down"),
			{ access_token: "ghu_1", expires_in: 28800, refresh_token: "ghr_1", refresh_token_expires_in: 15897600, token_type: "bearer" },
		],
	});
	const code = await startDeviceFlow(WEB, "Iv1.x", transport, now);
	assert.equal(code.userCode, "ABCD-1234");
	assert.equal(code.expiresAt, clock + 900_000);
	assert.equal(calls[0].params.get("client_id"), "Iv1.x");

	const waits: number[] = [];
	const tokens = await pollDeviceFlow(WEB, "Iv1.x", code, { transport, now, wait: async (ms) => void (waits.push(ms), (clock += ms)) });
	assert.deepEqual(waits, [5000, 5000, 10000, 10000], "respects interval and slow_down");
	assert.equal(tokens.access, "ghu_1");
	assert.equal(tokens.refresh, "ghr_1");
	assert.equal(tokens.expiresAt, clock + 28_800_000);
	const poll = calls.at(-1)!.params;
	assert.equal(poll.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
	assert.equal(poll.get("device_code"), "dev");
});

test("device flow: denied, expired and cancelled end the wait", async () => {
	const code = { deviceCode: "d", userCode: "U", verificationUri: "", expiresAt: 10_000, interval: 1 };
	const denied = fakeOAuth({ "/login/oauth/access_token": [{ error: "access_denied", error_description: "The user has denied your application access." }] });
	await assert.rejects(pollDeviceFlow(WEB, "c", code, { transport: denied.transport, now: () => 0, wait: async () => {} }), (e) => e instanceof DeviceFlowError && e.code === "access_denied");

	const pending = fakeOAuth({ "/login/oauth/access_token": [{ error: "authorization_pending" }] });
	let clock = 0;
	await assert.rejects(
		pollDeviceFlow(WEB, "c", code, { transport: pending.transport, now: () => clock, wait: async (ms) => void (clock += ms * 10) }),
		(e) => e instanceof DeviceFlowError && e.code === "expired_token",
	);

	let cancelled = false;
	const never = fakeOAuth({ "/login/oauth/access_token": [{ error: "authorization_pending" }] });
	await assert.rejects(
		pollDeviceFlow(WEB, "c", code, { transport: never.transport, now: () => 0, isCancelled: () => cancelled, wait: async () => void (cancelled = true) }),
		(e) => e instanceof DeviceFlowError && e.code === "cancelled",
	);
});

test("refresh: rotates tokens without a client secret; bad refresh token is reported", async () => {
	const { transport, calls } = fakeOAuth({
		"/login/oauth/access_token": [{ access_token: "ghu_2", expires_in: 28800, refresh_token: "ghr_2" }, { error: "bad_refresh_token" }],
	});
	const t = await refreshAppToken(WEB, "c", "ghr_1", transport, () => 0);
	assert.deepEqual(t, { access: "ghu_2", expiresAt: 28_800_000, refresh: "ghr_2", refreshExpiresAt: 0 });
	assert.equal(calls[0].params.get("grant_type"), "refresh_token");
	assert.equal(calls[0].params.get("refresh_token"), "ghr_1");
	await assert.rejects(refreshAppToken(WEB, "c", "ghr_2", transport), (e) => e instanceof DeviceFlowError && e.code === "bad_refresh_token");
});

test("token helpers: expiry margin, parsing, install URL", () => {
	assert.equal(needsRefresh({ access: "a", expiresAt: 0, refresh: "", refreshExpiresAt: 0 }, 5), false, "non-expiring tokens");
	assert.equal(needsRefresh({ access: "a", expiresAt: 1_000_000, refresh: "r", refreshExpiresAt: 0 }, 1_000_000 - 60_000), true);
	assert.equal(needsRefresh({ access: "a", expiresAt: 1_000_000, refresh: "r", refreshExpiresAt: 0 }, 0), false);
	assert.equal(parseTokens(""), null);
	assert.equal(parseTokens('{"access":""}'), null);
	assert.equal(parseTokens('{"access":"x","expiresAt":5}')?.expiresAt, 5);
	assert.equal(installUrl(WEB, "vault-sync"), "https://github.com/apps/vault-sync/installations/new");
});

test("GitHub client: a 401 refreshes the token once and retries", async () => {
	const saved = globalThis.fetch;
	let token = "old";
	const seen: string[] = [];
	globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
		seen.push(init.headers.Authorization);
		const ok = init.headers.Authorization === "Bearer new";
		return new Response(JSON.stringify(ok ? { login: "me" } : { message: "Bad credentials" }), { status: ok ? 200 : 401 });
	}) as typeof fetch;
	try {
		let refreshes = 0;
		const gh = new GitHub(() => ({
			token,
			apiBase: "https://api.github.com",
			owner: "o",
			repo: "r",
			onUnauthorized: async () => {
				refreshes++;
				token = "new";
				return true;
			},
		}));
		assert.equal((await gh.getUser()).login, "me");
		assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
		assert.equal(refreshes, 1);

		// Refresh that doesn't help: one retry only, then the 401 surfaces.
		token = "old";
		seen.length = 0;
		const stuck = new GitHub(() => ({ token: "old", apiBase: "https://api.github.com", owner: "o", repo: "r", onUnauthorized: async () => true }));
		await assert.rejects(stuck.getUser(), /invalid or expired/);
		assert.equal(seen.length, 2);
	} finally {
		globalThis.fetch = saved;
	}
});

test("token expiry header: GitHub's formats, parsed without Date.parse", async () => {
	const { parseTokenExpiry } = await import("../src/github.ts");
	assert.equal(parseTokenExpiry("2026-11-01 12:00:00 -0700"), Date.UTC(2026, 10, 1, 19, 0, 0));
	assert.equal(parseTokenExpiry("2026-11-01 12:00:00 +0530"), Date.UTC(2026, 10, 1, 6, 30, 0));
	assert.equal(parseTokenExpiry("2026-11-01 12:00:00 UTC"), Date.UTC(2026, 10, 1, 12, 0, 0));
	assert.equal(parseTokenExpiry(undefined), null);
	assert.equal(parseTokenExpiry("soon"), null);
});
