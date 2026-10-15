// End-to-end encryption layer (WebCrypto only: works on desktop and mobile).
//
// - Key: PBKDF2-SHA256 (600k iterations) from a passphrase and a random salt; HKDF splits it into
//   separate keys for content, content nonces, names and name nonces.
// - Content, format 2 (repositories encrypted since 1.8): "VSG2" ‖ nonce(12) ‖ AES-256-GCM(ciphertext ‖
//   tag), with the file's vault path as additional authenticated data and nonce = HMAC(path ‖ content).
//   A file only decrypts under its own path, so nobody with write access can swap two files' contents
//   unnoticed; equal content at one path still gives equal ciphertext (change detection, git dedupe).
// - Content, format 1 (older repositories): "VSG1" ‖ nonce ‖ AES-GCM, nonce = HMAC(content), not bound
//   to the path. Always readable (history), written only to repositories still on format 1.
// - Names: every path becomes e/<base64url(nonce ‖ AES-GCM(path))>, split into ≤180-char segments,
//   with nonce = HMAC(path). Deterministic, so all devices compute the same repository path.
// - A small marker file (MARKER_PATH, not encrypted) stores the salt, iterations and a check value
//   so devices can verify the passphrase. It never contains key material.

import type { Layer } from "./codec.ts";
import { t as tr } from "./i18n.ts";
import { SyncError } from "./errors.ts";

export const MARKER_PATH = ".vault-sync/encryption.json";

/**
 * Where a vault's encryption marker lives: inside its folder of the repository when it has one, so
 * several vaults sharing a repository each have their own (encrypting one never affects the others).
 */
export function markerPathFor(repoSubdir: string): string {
	const sub = repoSubdir.replace(/^\/+|\/+$/g, "");
	return sub ? `${sub}/${MARKER_PATH}` : MARKER_PATH;
}

/**
 * The marker that applies to a vault, from a repository listing. A vault in a folder uses its own copy;
 * without one, the root copy written by older versions is used for migration only, and only when this
 * vault is encrypted (this device holds its key, or its folder holds encrypted names): a root marker
 * left by another vault in the same repository never locks this one. `legacy` = the root copy was used.
 */
export function pickMarker(entries: Iterable<{ path: string; sha: string }>, repoSubdir: string, keyHere: boolean): { sha: string | null; legacy: boolean } {
	const own = markerPathFor(repoSubdir);
	const sub = repoSubdir.replace(/^\/+|\/+$/g, "");
	let mine: string | null = null;
	let root: string | null = null;
	let encryptedNames = false;
	for (const e of entries) {
		if (e.path === own) mine = e.sha;
		else if (sub && e.path === MARKER_PATH) root = e.sha;
		else if (sub && e.path.startsWith(`${sub}/e/`)) encryptedNames = true;
	}
	if (mine || !sub) return { sha: mine, legacy: false };
	if (root && (keyHere || encryptedNames)) return { sha: root, legacy: true };
	return { sha: null, legacy: false };
}
const MAGIC = new Uint8Array([0x56, 0x53, 0x47, 0x31]); // "VSG1"
const MAGIC2 = new Uint8Array([0x56, 0x53, 0x47, 0x32]); // "VSG2"
/** Content format of new encryption (see the header). */
export const CONTENT_FORMAT = 2;
const ITERATIONS = 600_000;
const CHECK_TEXT = "vault-sync-check";
const SEG = 180;

const te = new TextEncoder();
const td = new TextDecoder();

export interface EncryptionMeta {
	/** Content format: 1 = not bound to the path (older repositories), 2 = bound to the path. */
	v: 1 | 2;
	kdf: "PBKDF2-SHA256";
	iterations: number;
	salt: string;
	check: string;
}

/**
 * True when this device's key belongs to the repository: same salt and check as the repository's
 * marker, or no marker yet (this device publishes it on its next sync). False without a key.
 */
export function keyMatches(local: EncryptionMeta | null, remote: EncryptionMeta | null): boolean {
	if (!local) return false;
	if (!remote) return true;
	return local.salt === remote.salt && local.check === remote.check;
}

export function b64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}
export function unb64(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
const ab = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export async function deriveMaster(passphrase: string, salt: Uint8Array, iterations = ITERATIONS): Promise<Uint8Array> {
	const base = await crypto.subtle.importKey("raw", te.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: ab(salt), iterations }, base, 256);
	return new Uint8Array(bits);
}

export class EncryptionLayer implements Layer {
	readonly id: string;
	/** Content format this layer writes (it reads both). */
	readonly format: 1 | 2;
	readonly transformsContent = true;
	readonly transformsPaths = true;
	private kContent: CryptoKey;
	private kNonce: CryptoKey;
	private kName: CryptoKey;
	private kNameNonce: CryptoKey;
	private constructor(id: string, format: 1 | 2, kContent: CryptoKey, kNonce: CryptoKey, kName: CryptoKey, kNameNonce: CryptoKey) {
		this.format = format;
		// The format is part of the identity (codec fingerprint): switching it starts a fresh comparison.
		this.id = format === 1 ? id : `${id}:v${format}`;
		this.kContent = kContent;
		this.kNonce = kNonce;
		this.kName = kName;
		this.kNameNonce = kNameNonce;
	}

	static async fromMaster(master: Uint8Array, format: 1 | 2 = 1): Promise<EncryptionLayer> {
		const base = await crypto.subtle.importKey("raw", ab(master), "HKDF", false, ["deriveBits"]);
		const bits = (info: string) => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) }, base, 256);
		const aes = async (info: string) => crypto.subtle.importKey("raw", await bits(info), "AES-GCM", false, ["encrypt", "decrypt"]);
		const hmac = async (info: string) => crypto.subtle.importKey("raw", await bits(info), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const fp = new Uint8Array(await crypto.subtle.digest("SHA-256", await bits("vsg fingerprint"))).slice(0, 4);
		const id = "enc:" + Array.from(fp, (x) => x.toString(16).padStart(2, "0")).join("");
		return new EncryptionLayer(id, format, await aes("vsg content"), await hmac("vsg content nonce"), await aes("vsg name"), await hmac("vsg name nonce"));
	}

	private async nonce(key: CryptoKey, data: BufferSource): Promise<Uint8Array> {
		return new Uint8Array(await crypto.subtle.sign("HMAC", key, data)).slice(0, 12);
	}

	/** Format-2 additional data: the vault path the content belongs to. */
	private static aad(path: string): ArrayBuffer {
		return ab(te.encode(`vsg2\0${path}`));
	}

	async encode(path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		const bound = this.format === 2;
		// Format 2: the nonce covers the path too, so the same content at two paths never shares a nonce
		// (sharing one under different additional data would leak the authentication key).
		const nonceInput = bound ? ab(new Uint8Array([...te.encode(path), 0, ...new Uint8Array(data)])) : data;
		const iv = await this.nonce(this.kNonce, nonceInput);
		const params: AesGcmParams = bound ? { name: "AES-GCM", iv: ab(iv), additionalData: EncryptionLayer.aad(path) } : { name: "AES-GCM", iv: ab(iv) };
		const ct = new Uint8Array(await crypto.subtle.encrypt(params, this.kContent, data));
		const out = new Uint8Array(4 + 12 + ct.length);
		out.set(bound ? MAGIC2 : MAGIC, 0);
		out.set(iv, 4);
		out.set(ct, 16);
		return ab(out);
	}

	async decode(path: string, blob: ArrayBuffer): Promise<ArrayBuffer> {
		const u = new Uint8Array(blob);
		const v1 = u.length >= 32 && MAGIC.every((b, i) => u[i] === b);
		const v2 = u.length >= 32 && MAGIC2.every((b, i) => u[i] === b);
		if (!v1 && !v2) throw new SyncError("notEncrypted", { path });
		try {
			// Format 2 only decrypts under the path it was written for: a file moved or swapped in the
			// repository by someone else fails here instead of showing another file's content.
			const params: AesGcmParams = v2 ? { name: "AES-GCM", iv: ab(u.slice(4, 16)), additionalData: EncryptionLayer.aad(path) } : { name: "AES-GCM", iv: ab(u.slice(4, 16)) };
			return await crypto.subtle.decrypt(params, this.kContent, ab(u.slice(16)));
		} catch {
			throw new SyncError("decryptFailed", { path });
		}
	}

	async encodePath(path: string): Promise<string> {
		const pt = te.encode(path);
		const iv = await this.nonce(this.kNameNonce, pt);
		const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, this.kName, pt));
		const all = new Uint8Array(12 + ct.length);
		all.set(iv, 0);
		all.set(ct, 12);
		const s = b64url(all);
		const segs: string[] = [];
		for (let i = 0; i < s.length; i += SEG) segs.push(s.slice(i, i + SEG));
		return "e/" + segs.join("/");
	}

	async decodePath(raw: string): Promise<string | null> {
		if (!raw.startsWith("e/")) return null;
		try {
			const all = unb64url(raw.slice(2).split("/").join(""));
			const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(all.slice(0, 12)) }, this.kName, ab(all.slice(12)));
			return td.decode(pt);
		} catch {
			return null;
		}
	}

	async checkValue(): Promise<string> {
		return b64(new Uint8Array(await this.encode("check", ab(te.encode(CHECK_TEXT)))));
	}

	async verify(meta: EncryptionMeta): Promise<boolean> {
		try {
			return td.decode(await this.decode("check", ab(unb64(meta.check)))) === CHECK_TEXT;
		} catch {
			return false;
		}
	}
}

/** New encryption for a repository: random salt, derived key, and the marker to publish. */
export async function createEncryption(passphrase: string): Promise<{ meta: EncryptionMeta; master: Uint8Array; layer: EncryptionLayer }> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const master = await deriveMaster(passphrase, salt);
	const layer = await EncryptionLayer.fromMaster(master, CONTENT_FORMAT);
	const meta: EncryptionMeta = { v: CONTENT_FORMAT, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt), check: await layer.checkValue() };
	return { meta, master, layer };
}

/** Unlock an existing encrypted repository. Throws on a wrong passphrase. */
export async function unlockEncryption(passphrase: string, meta: EncryptionMeta): Promise<{ master: Uint8Array; layer: EncryptionLayer }> {
	if ((meta.v !== 1 && meta.v !== 2) || meta.kdf !== "PBKDF2-SHA256") throw new SyncError("newerFormat");
	const master = await deriveMaster(passphrase, unb64(meta.salt), meta.iterations);
	const layer = await EncryptionLayer.fromMaster(master, meta.v);
	if (!(await layer.verify(meta))) throw new SyncError("wrongPass");
	return { master, layer };
}

export function passphraseStrength(p: string): { ok: boolean; hint: string } {
	if (p.length < 12) return { ok: false, hint: tr("e.passShort") };
	const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
	if (p.length < 16 && kinds < 3) return { ok: true, hint: tr("e.passOk") };
	return { ok: true, hint: tr("e.passStrong") };
}
