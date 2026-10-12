// Small helpers that only rely on web platform APIs (available on desktop and mobile).

const encoder = new TextEncoder();

/** Git blob object id: sha1("blob <size>\0" + content). */
export async function gitBlobSha(data: ArrayBuffer): Promise<string> {
	const header = encoder.encode(`blob ${data.byteLength}\0`);
	const buf = new Uint8Array(header.length + data.byteLength);
	buf.set(header, 0);
	buf.set(new Uint8Array(data), header.length);
	const digest = await crypto.subtle.digest("SHA-1", buf);
	return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

const TEXT_EXT = new Set([
	"md", "markdown", "txt", "canvas", "base", "json", "css", "js", "mjs", "ts", "csv", "tsv",
	"html", "htm", "xml", "svg", "yml", "yaml", "toml", "ini", "tex", "bib", "org", "rst", "sh",
	"py", "excalidraw", "mermaid", "log",
]);

/** Decode as UTF-8 if this looks like a text file, otherwise null. BOM is preserved. */
export function asText(path: string, data: ArrayBuffer): string | null {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	if (!TEXT_EXT.has(ext)) return null;
	const bytes = new Uint8Array(data);
	if (bytes.includes(0)) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function encodeText(s: string): ArrayBuffer {
	const u = encoder.encode(s);
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

export function isHiddenPath(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

export function parentDir(path: string): string {
	const i = path.lastIndexOf("/");
	return i < 0 ? "" : path.slice(0, i);
}

export function stamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

export function conflictCopyPath(path: string, device: string, d = new Date()): string {
	const dir = parentDir(path);
	const file = dir ? path.slice(dir.length + 1) : path;
	const dot = file.lastIndexOf(".");
	const name = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	const safeDevice = device.replace(/[\\/:*?"<>|#^[\]]/g, "-");
	const out = `${name} (conflict ${safeDevice} ${stamp(d)})${ext}`;
	return dir ? `${dir}/${out}` : out;
}

const COPY_RE = /^(.*) \((?:conflict|restored) .+ \d{4}-\d{2}-\d{2} \d{4}\)(\.[^./]*)?$/;

/** If `path` is a conflict copy made by this plugin, the path of the original file; otherwise null. */
export function conflictCopyOriginal(path: string): string | null {
	const dir = parentDir(path);
	const file = dir ? path.slice(dir.length + 1) : path;
	if (!file.includes("(conflict ")) return null;
	const m = COPY_RE.exec(file);
	if (!m) return null;
	const orig = m[1] + (m[2] ?? "");
	return dir ? `${dir}/${orig}` : orig;
}

export function restoredCopyPath(path: string, sha: string, d = new Date()): string {
	const dir = parentDir(path);
	const file = dir ? path.slice(dir.length + 1) : path;
	const dot = file.lastIndexOf(".");
	const name = dot > 0 ? file.slice(0, dot) : file;
	const ext = dot > 0 ? file.slice(dot) : "";
	const out = `${name} (restored ${sha.slice(0, 7)} ${stamp(d)})${ext}`;
	return dir ? `${dir}/${out}` : out;
}

export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			await fn(item);
		}
	});
	await Promise.all(workers);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
