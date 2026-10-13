import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DeviceFlowError,
	GITLAB_APP,
	GITLAB_APP_REGISTRATION,
	GITLAB_SCOPE,
	needsRefresh,
	parseTokens,
	pollDeviceFlow,
	refreshAppToken,
	startDeviceFlow,
	webBaseFromApi,
} from "../src/gitlabapp.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/http.ts";

const WEB = "https://gitlab.com";

/** Fake GitLab OAuth endpoints: replies are consumed in order per URL path. */
function fakeOAuth(replies: Record<string, (Record<string, unknown> | Error | { status: number; json: unknown })[]>) {
	const calls: { url: string; path: string; params: URLSearchParams; headers: Record<string, string> }[] = [];
	const transport: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
		const path = new URL(req.url).pathname;
		const params = new URLSearchParams(String(req.body ?? ""));
		calls.push({ url: req.url, path, params, headers: req.headers });
		assert.equal(req.method, "POST");
		assert.equal(req.contentType, "application/x-www-form-urlencoded");
		assert.equal(params.get("client_secret"), null, "never sends a client secret");
		assert.ok(!Object.keys(req.headers).some((h) => h.toLowerCase() === "authorization"), "no Basic auth either");
		const next = replies[path]?.shift();
		if (!next) throw new Error(`unexpected call to ${path}`);
		if (next instanceof Error) throw next;
		if ("status" in next && typeof next.status === "number") return { status: next.status, json: next.json, arrayBuffer: new ArrayBuffer(0), headers: {} };
		return { status: 200, json: next, arrayBuffer: new ArrayBuffer(0), headers: {} };
	};
	return { transport, calls };
}

test("device flow: code with scope api, pending, slow_down, network blip, then tokens", async () => {
	let clock = 1_000_000;
	const now = () => clock;
	const { transport, calls } = fakeOAuth({
		"/oauth/authorize_device": [
			{
				device_code: "dev",
				user_code: "ABCD1234",
				verification_uri: "https://gitlab.com/oauth/device",
				verification_uri_complete: "https://gitlab.com/oauth/device?user_code=ABCD1234",
				expires_in: 300,
				interval: 5,
			},
		],
		"/oauth/token": [
			{ error: "authorization_pending" },
			{ error: "slow_down" },
			new Error("network down"),
			{ status: 400, json: { error: "authorization_pending" } },
			{ access_token: "glat_1", token_type: "Bearer", expires_in: 7200, refresh_token: "glrt_1", scope: "api", created_at: 1 },
		],
	});
	const code = await startDeviceFlow(WEB, "app-id", transport, now);
	assert.equal(code.userCode, "ABCD1234");
	assert.equal(code.verificationUri, "https://gitlab.com/oauth/device");
	assert.equal(code.verificationUriComplete, "https://gitlab.com/oauth/device?user_code=ABCD1234");
	assert.equal(code.expiresAt, clock + 300_000);
	assert.equal(code.interval, 5);
	assert.equal(calls[0].url, "https://gitlab.com/oauth/authorize_device");
	assert.equal(calls[0].params.get("client_id"), "app-id");
	assert.equal(calls[0].params.get("scope"), "api");
	assert.equal(GITLAB_SCOPE, "api");

	const waits: number[] = [];
	const tokens = await pollDeviceFlow(WEB, "app-id", code, { transport, now, wait: async (ms) => void (waits.push(ms), (clock += ms)) });
	assert.deepEqual(waits, [5000, 5000, 10000, 10000, 10000], "respects interval; slow_down adds 5 s");
	assert.deepEqual(tokens, { access: "glat_1", expiresAt: clock + 7_200_000, refresh: "glrt_1", refreshExpiresAt: 0 });
	const poll = calls.at(-1)!;
	assert.equal(poll.url, "https://gitlab.com/oauth/token");
	assert.equal(poll.params.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
	assert.equal(poll.params.get("device_code"), "dev");
	assert.equal(poll.params.get("client_id"), "app-id");
});

test("device flow: defaults when GitLab omits optional fields; errors on start are reported", async () => {
	const ok = fakeOAuth({ "/gl/oauth/authorize_device": [{ device_code: "d", user_code: "U" }] });
	const code = await startDeviceFlow("https://host.example/gl", "c", ok.transport, () => 0);
	assert.equal(code.verificationUri, "https://host.example/gl/oauth/device");
	assert.equal(code.verificationUriComplete, undefined);
	assert.equal(code.interval, 5);
	assert.equal(code.expiresAt, 300_000);

	const bad = fakeOAuth({ "/oauth/authorize_device": [{ status: 401, json: { error: "invalid_client", error_description: "Client authentication failed" } }] });
	await assert.rejects(startDeviceFlow(WEB, "c", bad.transport), (e) => e instanceof DeviceFlowError && e.code === "invalid_client");

	const old = fakeOAuth({ "/oauth/authorize_device": [{ status: 404, json: null }] });
	await assert.rejects(startDeviceFlow(WEB, "c", old.transport), (e) => e instanceof DeviceFlowError && e.code === "http_status");
});

test("device flow: denied, expired and cancelled end the wait", async () => {
	const code = { deviceCode: "d", userCode: "U", verificationUri: "", expiresAt: 10_000, interval: 1 };
	const denied = fakeOAuth({ "/oauth/token": [{ status: 400, json: { error: "access_denied", error_description: "The resource owner or authorization server denied the request." } }] });
	await assert.rejects(pollDeviceFlow(WEB, "c", code, { transport: denied.transport, now: () => 0, wait: async () => {} }), (e) => e instanceof DeviceFlowError && e.code === "access_denied");

	const serverExpired = fakeOAuth({ "/oauth/token": [{ error: "expired_token" }] });
	await assert.rejects(pollDeviceFlow(WEB, "c", code, { transport: serverExpired.transport, now: () => 0, wait: async () => {} }), (e) => e instanceof DeviceFlowError && e.code === "expired_token");

	const pending = fakeOAuth({ "/oauth/token": [{ error: "authorization_pending" }] });
	let clock = 0;
	await assert.rejects(
		pollDeviceFlow(WEB, "c", code, { transport: pending.transport, now: () => clock, wait: async (ms) => void (clock += ms * 10) }),
		(e) => e instanceof DeviceFlowError && e.code === "expired_token",
	);

	let cancelled = false;
	const never = fakeOAuth({ "/oauth/token": [] });
	await assert.rejects(
		pollDeviceFlow(WEB, "c", code, { transport: never.transport, now: () => 0, isCancelled: () => cancelled, wait: async () => void (cancelled = true) }),
		(e) => e instanceof DeviceFlowError && e.code === "cancelled",
	);
	assert.equal(never.calls.length, 0, "no request after cancel");
});

test("refresh: rotates tokens with client_id only; invalid_grant is reported", async () => {
	const { transport, calls } = fakeOAuth({
		"/oauth/token": [
			{ access_token: "glat_2", token_type: "Bearer", expires_in: 7200, refresh_token: "glrt_2", created_at: 1 },
			{ access_token: "glat_3", expires_in: 7200 },
			{ status: 400, json: { error: "invalid_grant", error_description: "The provided authorization grant is invalid, expired, revoked..." } },
		],
	});
	const t = await refreshAppToken(WEB, "c", "glrt_1", transport, () => 0);
	assert.deepEqual(t, { access: "glat_2", expiresAt: 7_200_000, refresh: "glrt_2", refreshExpiresAt: 0 });
	assert.equal(calls[0].url, "https://gitlab.com/oauth/token");
	assert.equal(calls[0].params.get("grant_type"), "refresh_token");
	assert.equal(calls[0].params.get("refresh_token"), "glrt_1");
	assert.equal(calls[0].params.get("client_id"), "c");
	assert.deepEqual([...calls[0].params.keys()].sort(), ["client_id", "grant_type", "refresh_token"]);

	const kept = await refreshAppToken(WEB, "c", "glrt_2", transport, () => 0);
	assert.equal(kept.refresh, "glrt_2", "keeps the old refresh token if none is returned");

	await assert.rejects(refreshAppToken(WEB, "c", "glrt_2", transport), (e) => e instanceof DeviceFlowError && e.code === "invalid_grant");
});

test("webBaseFromApi: gitlab.com, self-managed, subpath, trailing slashes", () => {
	assert.equal(webBaseFromApi("https://gitlab.com/api/v4"), "https://gitlab.com");
	assert.equal(webBaseFromApi("https://gitlab.com/api/v4/"), "https://gitlab.com");
	assert.equal(webBaseFromApi("https://git.example.org/api/v4"), "https://git.example.org");
	assert.equal(webBaseFromApi("https://example.org/gitlab/api/v4"), "https://example.org/gitlab");
	assert.equal(webBaseFromApi(" https://host:8443/API/V4 "), "https://host:8443");
	assert.equal(webBaseFromApi("https://gitlab.com"), "https://gitlab.com");
});

test("token helpers and app config", () => {
	assert.equal(needsRefresh({ access: "a", expiresAt: 0, refresh: "", refreshExpiresAt: 0 }, 5), false, "non-expiring tokens");
	assert.equal(needsRefresh({ access: "a", expiresAt: 1_000_000, refresh: "r", refreshExpiresAt: 0 }, 1_000_000 - 60_000), true);
	assert.equal(needsRefresh({ access: "a", expiresAt: 1_000_000, refresh: "r", refreshExpiresAt: 0 }, 0), false);
	assert.equal(parseTokens(""), null);
	assert.equal(parseTokens('{"access":""}'), null);
	assert.deepEqual(parseTokens('{"access":"x","expiresAt":5,"refresh":"r","web":"https://gitlab.com","clientId":"c"}'), {
		access: "x",
		expiresAt: 5,
		refresh: "r",
		refreshExpiresAt: 0,
		web: "https://gitlab.com",
		clientId: "c",
	});
	assert.equal(typeof GITLAB_APP.clientId, "string");
	assert.match(GITLAB_APP_REGISTRATION, /Confidential: UNCHECK/);
	assert.match(GITLAB_APP_REGISTRATION, /"api"/);
});

test("device flow: a server error keeps polling; another HTTP error without an OAuth error stops", async () => {
	const code = { deviceCode: "d", userCode: "U", verificationUri: "", expiresAt: 10_000_000, interval: 1 };
	const flaky = fakeOAuth({ "/oauth/token": [{ status: 503, json: null }, { access_token: "a", refresh_token: "r", expires_in: 7200 }] });
	const t = await pollDeviceFlow(WEB, "c", code, { transport: flaky.transport, now: () => 0, wait: async () => {} });
	assert.equal(t.access, "a");
	const gone = fakeOAuth({ "/oauth/token": [{ status: 404, json: null }] });
	await assert.rejects(pollDeviceFlow(WEB, "c", code, { transport: gone.transport, now: () => 0, wait: async () => {} }), (e) => e instanceof DeviceFlowError && e.code === "http_status");
});
