// Shared HTTP for non-GitHub hosts: requestUrl (no CORS, works on mobile), retries with backoff,
// rate-limit waits, readable errors. The transport is injectable for tests.

import { requestUrl } from "obsidian";
import { RemoteError } from "./remote.ts";
import { sleep } from "./util.ts";

export interface HttpResponse {
	status: number;
	json: unknown;
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
}

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}

export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export const obsidianTransport: Transport = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: req.contentType, throw: false });
	let json: unknown = null;
	try {
		json = res.json as unknown;
	} catch {
		/* not JSON */
	}
	return { status: res.status, json, arrayBuffer: res.arrayBuffer, headers: res.headers ?? {} };
};

/**
 * True when `url` has the same scheme, host and port as `base` (host compared case-insensitively;
 * default ports normalised). Used before sending credentials to a URL that a server returned.
 */
export function sameOrigin(url: string, base: string): boolean {
	try {
		const a = new URL(url);
		const b = new URL(base);
		return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase();
	} catch {
		return false;
	}
}

export function header(res: HttpResponse, name: string): string | undefined {
	const k = Object.keys(res.headers).find((x) => x.toLowerCase() === name.toLowerCase());
	return k ? res.headers[k] : undefined;
}

export async function httpRequest(
	transport: Transport,
	req: HttpRequest,
	opts: { okStatuses?: number[]; hostLabel: string; wait?: (ms: number) => Promise<void> },
): Promise<HttpResponse> {
	const wait = opts.wait ?? sleep;
	let lastErr: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		let res: HttpResponse;
		try {
			res = await transport({ ...req, headers: { "Cache-Control": "no-cache", Pragma: "no-cache", ...req.headers } });
		} catch (e) {
			lastErr = e;
			// No point waiting after the last attempt: report the failure right away.
			if (attempt < 3) await wait(1000 * 2 ** attempt);
			continue;
		}
		if (res.status < 300 || opts.okStatuses?.includes(res.status)) return res;
		const body = (res.json ?? {}) as { message?: unknown; error?: unknown };
		const msg = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
		if (res.status === 429 || (res.status === 403 && header(res, "retry-after"))) {
			const ms = Number(header(res, "retry-after") ?? 0) * 1000 || 2000 * (attempt + 1);
			if (ms <= 60_000 && attempt < 3) {
				await wait(ms);
				continue;
			}
			throw new RemoteError(`${opts.hostLabel} rate limit hit. Try again in a minute.`, res.status);
		}
		if (res.status >= 500 && attempt < 3) {
			lastErr = new RemoteError(String(msg), res.status);
			await wait(1000 * 2 ** attempt);
			continue;
		}
		if (res.status === 401) throw new RemoteError(`${opts.hostLabel} token is invalid or expired.`, 401);
		throw new RemoteError(`${typeof msg === "string" ? msg : JSON.stringify(msg)} (${req.method} ${req.url.replace(/\?.*$/, "")})`, res.status);
	}
	throw lastErr instanceof Error ? lastErr : new RemoteError(`Network error talking to ${opts.hostLabel}`, 0);
}

export function b64encode(buf: ArrayBuffer): string {
	const u = new Uint8Array(buf);
	let s = "";
	for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
	return btoa(s);
}

export function b64decode(s: string): ArrayBuffer {
	const bin = atob(s.replace(/\s/g, ""));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}

/**
 * Ancestry via commit lists, for hosts without a compare/merge-base endpoint. `list` may say whether
 * more pages follow (from a header or a `next` link); otherwise only an empty page ends the history,
 * because hosts clamp the page size (Gitea's MAX_RESPONSE_ITEMS) and a short page proves nothing.
 */
export async function compareByWalking(
	list: (sha: string, page: number) => Promise<string[] | { shas: string[]; more?: boolean }>,
	base: string,
	head: string,
): Promise<"ahead" | "behind" | "identical" | "diverged"> {
	if (base === head) return "identical";
	// Returns true (found), false (reached the root without finding it) or null (gave up: too deep).
	const walk = async (from: string, target: string): Promise<boolean | null> => {
		for (let page = 1; page <= 60; page++) {
			const got = await list(from, page);
			const shas = Array.isArray(got) ? got : got.shas;
			const more = Array.isArray(got) ? undefined : got.more;
			if (shas.includes(target)) return true;
			if (!shas.length || more === false) return false;
		}
		return null;
	};
	const fwd = await walk(head, base);
	if (fwd) return "ahead";
	const back = await walk(base, head);
	if (back) return "behind";
	// Only call it rewritten history when both walks reached the root. A very long history we could not
	// fully walk is almost certainly just "ahead" (e.g. a device that was offline for weeks).
	if (fwd === null || back === null) return "ahead";
	return "diverged";
}

/** multipart/form-data body (fields and files) as one ArrayBuffer, for APIs that require it. */
/**
 * multipart/form-data body. `attributes` goes into the part's Content-Disposition, as Bitbucket's
 * /src endpoint expects (`x-attributes:"executable"` keeps the executable bit).
 */
export function buildMultipart(parts: { name: string; value: string | ArrayBuffer; filename?: string; attributes?: string }[]): { body: ArrayBuffer; contentType: string } {
	const boundary = `----vaultsync${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
	const te = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const esc = (s: string) => s.replace(/"/g, "%22").replace(/\r|\n/g, " ");
	for (const p of parts) {
		const head =
			`--${boundary}\r\nContent-Disposition: form-data; name="${esc(p.name)}"` +
			(p.filename !== undefined ? `; filename="${esc(p.filename)}"` : "") +
			(p.attributes ? `; x-attributes:"${esc(p.attributes)}"` : "") +
			(p.filename !== undefined ? "\r\nContent-Type: application/octet-stream" : "") +
			"\r\n\r\n";
		chunks.push(te.encode(head));
		chunks.push(typeof p.value === "string" ? te.encode(p.value) : new Uint8Array(p.value));
		chunks.push(te.encode("\r\n"));
	}
	chunks.push(te.encode(`--${boundary}--\r\n`));
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) {
		out.set(c, o);
		o += c.length;
	}
	return { body: out.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}
