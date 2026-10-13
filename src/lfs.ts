// Git LFS for large files: the repository stores a small pointer; the bytes go to the host's LFS
// storage through the standard batch API (GitHub, GitLab and Gitea all support it).
//
// Every device keeps this layer for *reading*, even with uploads off, so a pointer is never written
// into the vault as if it were the file. The layer has no codec id: turning LFS on or off doesn't reset
// the baseline. Large files are simply re-stored in the new form on their next upload.

import type { Layer } from "./codec.ts";
import { compileGlobs } from "./glob.ts";
import { httpRequest, obsidianTransport } from "./http.ts";
import type { Transport } from "./http.ts";
import type { Remote } from "./remote.ts";
import { encodeText } from "./util.ts";

const SPEC = "version https://git-lfs.github.com/spec/v1";

interface LfsAction {
	href: string;
	header?: Record<string, string>;
}
interface LfsObject {
	oid: string;
	size: number;
	error?: { code?: number; message?: string };
	actions?: { upload?: LfsAction; download?: LfsAction; verify?: LfsAction };
}
interface LfsBatch {
	objects?: LfsObject[];
}
const te = new TextEncoder();
const td = new TextDecoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/** Patterns from .gitattributes lines that set `filter=lfs` (e.g. `*.psd filter=lfs diff=lfs merge=lfs -text`). */
export function lfsPatternsFrom(gitattributes: string): string[] {
	const out: string[] = [];
	for (const raw of gitattributes.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const [pattern, ...attrs] = line.split(/\s+/);
		if (attrs.includes("filter=lfs") && !pattern.startsWith("!")) out.push(pattern);
	}
	return out;
}

export function pointerFor(oid: string, size: number): string {
	return `${SPEC}\noid sha256:${oid}\nsize ${size}\n`;
}

export function parsePointer(blob: ArrayBuffer): { oid: string; size: number } | null {
	if (blob.byteLength > 512) return null;
	const t = td.decode(blob);
	if (!t.startsWith(SPEC)) return null;
	const oid = /\noid sha256:([0-9a-f]{64})\n/.exec(t)?.[1];
	const size = /\nsize (\d+)\n?/.exec(t)?.[1];
	return oid && size ? { oid, size: Number(size) } : null;
}

export class LfsLayer implements Layer {
	readonly id = "";
	readonly transformsContent = true;
	get fingerprint() {
		const parts = [this.threshold > 0 ? `lfs:${this.threshold}` : "", this.patterns.length ? `attr:${this.patterns.join("|")}` : ""].filter(Boolean);
		return parts.join(";");
	}
	private remote: Remote;
	private threshold: number;
	private transport: Transport;
	/** Patterns marked `filter=lfs` in .gitattributes (repos set up with `git lfs track`). */
	private patterns: string[];
	private tracked: (path: string) => boolean;
	/** The `filter=lfs` patterns this layer was built with (a mirror uses the same ones). */
	get trackedPatterns(): string[] {
		return [...this.patterns];
	}

	constructor(remote: Remote, thresholdBytes: number, transport: Transport = obsidianTransport, lfsPatterns: string[] = []) {
		this.remote = remote;
		this.threshold = thresholdBytes;
		this.transport = transport;
		this.patterns = lfsPatterns;
		this.tracked = lfsPatterns.length ? compileGlobs(lfsPatterns) : () => false;
	}

	private big(path: string, data: ArrayBuffer) {
		if (data.byteLength > 0 && this.tracked(path)) return true;
		return this.threshold > 0 && data.byteLength >= this.threshold;
	}

	async storedForm(path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.big(path, data)) return data;
		return encodeText(pointerFor(hex(await crypto.subtle.digest("SHA-256", data)), data.byteLength));
	}

	async encode(path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.big(path, data)) return data;
		const oid = hex(await crypto.subtle.digest("SHA-256", data));
		await this.upload(path, oid, data);
		return encodeText(pointerFor(oid, data.byteLength));
	}

	async decode(path: string, blob: ArrayBuffer): Promise<ArrayBuffer> {
		const ptr = parsePointer(blob);
		if (!ptr) return blob;
		const data = await this.download(path, ptr.oid, ptr.size);
		if (hex(await crypto.subtle.digest("SHA-256", data)) !== ptr.oid) throw new Error(`${path}: large-file download was corrupted`);
		return data;
	}

	private async batch(operation: "upload" | "download", oid: string, size: number): Promise<LfsObject | undefined> {
		const res = await httpRequest(
			this.transport,
			{
				url: `${this.remote.gitUrl()}/info/lfs/objects/batch`,
				method: "POST",
				headers: { Accept: "application/vnd.git-lfs+json", Authorization: this.remote.authHeader() },
				contentType: "application/vnd.git-lfs+json",
				body: JSON.stringify({ operation, transfers: ["basic"], objects: [{ oid, size }] }),
			},
			{ hostLabel: `${this.remote.label} LFS` },
		);
		const obj = (res.json as LfsBatch | null)?.objects?.[0];
		if (obj?.error) throw new Error(`Large-file storage: ${obj.error.message ?? String(obj.error.code)}`);
		return obj;
	}

	private async upload(path: string, oid: string, data: ArrayBuffer) {
		const obj = await this.batch("upload", oid, data.byteLength);
		const up = obj?.actions?.upload;
		if (!up) return; // the host already has this object
		await httpRequest(this.transport, { url: up.href, method: "PUT", headers: { ...(up.header ?? {}), "Content-Type": "application/octet-stream" }, body: data }, { hostLabel: "LFS upload" });
		const verify = obj?.actions?.verify;
		if (verify) {
			await httpRequest(
				this.transport,
				{ url: verify.href, method: "POST", headers: { ...(verify.header ?? {}), Accept: "application/vnd.git-lfs+json" }, contentType: "application/vnd.git-lfs+json", body: JSON.stringify({ oid, size: data.byteLength }) },
				{ hostLabel: "LFS verify" },
			);
		}
		void path;
	}

	private async download(path: string, oid: string, size: number): Promise<ArrayBuffer> {
		const obj = await this.batch("download", oid, size);
		const down = obj?.actions?.download;
		if (!down) throw new Error(`${path}: large file is missing from the host's LFS storage`);
		return (await httpRequest(this.transport, { url: down.href, method: "GET", headers: down.header ?? {} }, { hostLabel: "LFS download" })).arrayBuffer;
	}
}

export const LFS_SPEC = te.encode(SPEC);
