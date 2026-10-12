// Just enough of the Obsidian API for the sync engine to run under Node.
export class TAbstractFile {
	path: string;
	constructor(path: string) {
		this.path = path;
	}
}
export class TFile extends TAbstractFile {
	stat = { mtime: 0, size: 0, ctime: 0 };
}
export class TFolder extends TAbstractFile {}
export function normalizePath(p: string): string {
	return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}
export function getLanguage(): string {
	return (globalThis as any).window?.localStorage?.getItem("language") ?? "en";
}
export function arrayBufferToBase64(b: ArrayBuffer): string {
	return Buffer.from(new Uint8Array(b)).toString("base64");
}
// fetch-based stand-in for Obsidian's requestUrl (used by the live GitHub tests).
export async function requestUrl(req: {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
	throw?: boolean;
}) {
	const headers: Record<string, string> = { ...(req.headers ?? {}) };
	if (req.contentType) headers["Content-Type"] = req.contentType;
	const res = await fetch(req.url, { method: req.method ?? "GET", headers, body: req.body });
	const arrayBuffer = await res.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);
	const outHeaders: Record<string, string> = {};
	res.headers.forEach((v, k) => (outHeaders[k] = v));
	if (req.throw !== false && res.status >= 400) throw new Error(`HTTP ${res.status}`);
	return {
		status: res.status,
		headers: outHeaders,
		arrayBuffer,
		text,
		get json() {
			return JSON.parse(text);
		},
	};
}
