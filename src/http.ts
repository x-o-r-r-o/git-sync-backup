// Shared HTTP for non-GitHub hosts: requestUrl (no CORS, works on mobile), retries with backoff,
// rate-limit waits, readable errors. The transport is injectable for tests.

import { requestUrl } from "obsidian";
import { RemoteError } from "./remote.ts";
import { sleep } from "./util.ts";

export interface HttpResponse {
	status: number;
	json: any;
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
	let json: any = null;
	try {
		json = res.json;
	} catch {
		/* not JSON */
	}
	return { status: res.status, json, arrayBuffer: res.arrayBuffer, headers: res.headers ?? {} };
};

export function header(res: HttpResponse, name: string): string | undefined {
	const k = Object.keys(res.headers).find((x) => x.toLowerCase() === name.toLowerCase());
	return k ? res.headers[k] : undefined;
}

export async function httpRequest(
	transport: Transport,
	req: HttpRequest,
	opts: { okStatuses?: number[]; hostLabel: string },
): Promise<HttpResponse> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		let res: HttpResponse;
		try {
			res = await transport({ ...req, headers: { "Cache-Control": "no-cache", Pragma: "no-cache", ...req.headers } });
		} catch (e) {
			lastErr = e;
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		if (res.status < 300 || opts.okStatuses?.includes(res.status)) return res;
		const msg: string = res.json?.message ?? res.json?.error ?? `HTTP ${res.status}`;
		if (res.status === 429 || (res.status === 403 && header(res, "retry-after"))) {
			const wait = Number(header(res, "retry-after") ?? 0) * 1000 || 2000 * (attempt + 1);
			if (wait <= 60_000 && attempt < 3) {
				await sleep(wait);
				continue;
			}
			throw new RemoteError(`${opts.hostLabel} rate limit hit. Try again in a minute.`, res.status);
		}
		if (res.status >= 500 && attempt < 3) {
			lastErr = new RemoteError(String(msg), res.status);
			await sleep(1000 * 2 ** attempt);
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

/** Ancestry via commit lists, for hosts without a compare/merge-base endpoint. */
export async function compareByWalking(
	list: (sha: string, page: number) => Promise<string[]>,
	base: string,
	head: string,
): Promise<"ahead" | "behind" | "identical" | "diverged"> {
	if (base === head) return "identical";
	const walk = async (from: string, target: string) => {
		for (let page = 1; page <= 4; page++) {
			const shas = await list(from, page);
			if (shas.includes(target)) return true;
			if (shas.length < 50) return false;
		}
		return false;
	};
	if (await walk(head, base)) return "ahead";
	if (await walk(base, head)) return "behind";
	return "diverged";
}
