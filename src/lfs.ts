// Git LFS for large files: the repository stores a small pointer; the bytes go to the host's LFS
// storage through the standard batch API (GitHub, GitLab and Gitea all support it).
//
// Every device keeps this layer for *reading*, even with uploads off, so a pointer is never written
// into the vault as if it were the file. The layer has no codec id: turning LFS on or off doesn't reset
// the baseline. Large files are simply re-stored in the new form on their next upload.

import type { Layer } from "./codec.ts";
import { httpRequest, obsidianTransport } from "./http.ts";
import type { Transport } from "./http.ts";
import type { Remote } from "./remote.ts";
import { encodeText } from "./util.ts";

const SPEC = "version https://git-lfs.github.com/spec/v1";
const te = new TextEncoder();
const td = new TextDecoder();
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

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
		return this.threshold > 0 ? `lfs:${this.threshold}` : "";
	}
	private remote: Remote;
	private threshold: number;
	private transport: Transport;

	constructor(remote: Remote, thresholdBytes: number, transport: Transport = obsidianTransport) {
		this.remote = remote;
		this.threshold = thresholdBytes;
		this.transport = transport;
	}

	private big(data: ArrayBuffer) {
		return this.threshold > 0 && data.byteLength >= this.threshold;
	}

	async storedForm(_path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.big(data)) return data;
		return encodeText(pointerFor(hex(await crypto.subtle.digest("SHA-256", data)), data.byteLength));
	}

	async encode(path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!this.big(data)) return data;
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

	private async batch(operation: "upload" | "download", oid: string, size: number): Promise<any> {
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
		const obj = res.json?.objects?.[0];
		if (obj?.error) throw new Error(`Large-file storage: ${obj.error.message ?? obj.error.code}`);
		return obj;
	}

	private async upload(path: string, oid: string, data: ArrayBuffer) {
		const obj = await this.batch("upload", oid, data.byteLength);
		const up = obj?.actions?.upload;
		if (!up) return; // the host already has this object
		await httpRequest(this.transport, { url: up.href, method: "PUT", headers: { ...(up.header ?? {}), "Content-Type": "application/octet-stream" }, body: data }, { hostLabel: "LFS upload" });
		const verify = obj.actions.verify;
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
