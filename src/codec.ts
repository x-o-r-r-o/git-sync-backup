// The transform layer between vault paths/bytes and repository paths/blobs. Layers stack:
// folder→repo mapping (paths), end-to-end encryption (paths + content), Git LFS (content).
// With no layers it is the identity, and plain sync is unchanged.

import { gitBlobSha } from "./util.ts";

export interface Layer {
	/** Part of the sync baseline identity: changing layers starts a fresh (non-deleting) baseline. */
	readonly id: string;
	/** How stored forms are computed; when it changes, cached local hashes are recomputed. Defaults to id. */
	readonly fingerprint?: string;
	readonly transformsContent?: boolean;
	readonly transformsPaths?: boolean;
	encodePath?(path: string): Promise<string>;
	/** null = not a file this layer manages (ignored by sync). */
	decodePath?(raw: string): Promise<string | null>;
	/** Stored form, with side effects allowed (e.g. uploading an LFS object). */
	encode?(path: string, data: ArrayBuffer): Promise<ArrayBuffer>;
	/** Stored form without side effects, used for hashing. Defaults to encode. */
	storedForm?(path: string, data: ArrayBuffer): Promise<ArrayBuffer>;
	decode?(path: string, blob: ArrayBuffer): Promise<ArrayBuffer>;
}

export class Codec {
	readonly id: string;
	readonly fingerprint: string;
	readonly transformsContent: boolean;
	readonly transformsPaths: boolean;
	readonly layers: Layer[];
	constructor(layers: Layer[] = []) {
		this.layers = layers;
		this.id = layers.map((l) => l.id).filter(Boolean).join("+");
		this.fingerprint = layers.map((l) => l.fingerprint ?? l.id).filter(Boolean).join("+");
		this.transformsContent = layers.some((l) => l.transformsContent);
		this.transformsPaths = layers.some((l) => l.transformsPaths);
	}

	has(prefix: string): boolean {
		return this.layers.some((l) => l.id.startsWith(prefix));
	}

	async encodePath(path: string): Promise<string> {
		let p = path;
		for (const l of this.layers) if (l.encodePath) p = await l.encodePath(p);
		return p;
	}

	async decodePath(raw: string): Promise<string | null> {
		let p: string | null = raw;
		for (const l of [...this.layers].reverse()) {
			if (p === null) return null;
			if (l.decodePath) p = await l.decodePath(p);
		}
		return p;
	}

	private async run(path: string, data: ArrayBuffer, sideEffects: boolean): Promise<ArrayBuffer> {
		let d = data;
		for (const l of this.layers) {
			if (!l.transformsContent) continue;
			if (!sideEffects && l.storedForm) d = await l.storedForm(path, d);
			else if (l.encode) d = await l.encode(path, d);
		}
		return d;
	}

	/** Git blob sha of the file as it is (or would be) stored in the repository. */
	async storedSha(path: string, data: ArrayBuffer): Promise<string> {
		return gitBlobSha(this.transformsContent ? await this.run(path, data, false) : data);
	}

	encode(path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		return this.transformsContent ? this.run(path, data, true) : Promise.resolve(data);
	}

	async decode(path: string, blob: ArrayBuffer): Promise<ArrayBuffer> {
		let d = blob;
		for (const l of [...this.layers].reverse()) if (l.transformsContent && l.decode) d = await l.decode(path, d);
		return d;
	}
}

export const PLAIN = new Codec();

/** Maps a vault folder to the root of a repository (e.g. "Work/" ↔ repo root) for shared folders. */
export class PrefixLayer implements Layer {
	readonly id: string;
	readonly transformsPaths = true;
	private prefix: string;
	/** The vault folder this layer maps (with a trailing slash). */
	get folderPrefix(): string {
		return this.prefix;
	}
	/** Folder inside the repository ("" = its root), with a trailing slash when set. */
	private sub: string;
	constructor(folder: string, subdir = "") {
		this.prefix = folder.replace(/^\/+|\/+$/g, "") + "/";
		const sub = subdir.replace(/^\/+|\/+$/g, "");
		this.sub = sub ? sub + "/" : "";
		this.id = this.sub ? `folder:${this.prefix}=${this.sub}` : `folder:${this.prefix}`;
	}
	async encodePath(p: string) {
		// Defense in depth: a path outside the folder must never reach the shared repository.
		if (!p.startsWith(this.prefix)) throw new Error(`${p} is outside the shared folder ${this.prefix}`);
		return this.sub + p.slice(this.prefix.length);
	}
	/** Repository paths outside the mapped subfolder are not part of this shared folder (null: ignored). */
	async decodePath(raw: string): Promise<string | null> {
		if (this.sub && !raw.startsWith(this.sub)) return null;
		return this.prefix + raw.slice(this.sub.length);
	}
}
