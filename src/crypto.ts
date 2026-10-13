// End-to-end encryption layer (WebCrypto only: works on desktop and mobile).
//
// - Key: PBKDF2-SHA256 (600k iterations) from a passphrase and a random salt; HKDF splits it into
//   separate keys for content, content nonces, names and name nonces.
// - Content: "VSG1" ‖ nonce(12) ‖ AES-256-GCM(ciphertext ‖ tag). The nonce is HMAC(content) so equal
//   plaintext gives equal ciphertext: change and rename detection keep working, and git dedupes. The
//   only leak is "these two files are identical".
// - Names: every path becomes e/<base64url(nonce ‖ AES-GCM(path))>, split into ≤180-char segments,
//   with nonce = HMAC(path). Deterministic, so all devices compute the same repository path.
// - A small marker file (MARKER_PATH, not encrypted) stores the salt, iterations and a check value
//   so devices can verify the passphrase. It never contains key material.

import type { Layer } from "./codec.ts";
import { t as tr } from "./i18n.ts";
import { SyncError } from "./errors.ts";

export const MARKER_PATH = ".vault-sync/encryption.json";
const MAGIC = new Uint8Array([0x56, 0x53, 0x47, 0x31]); // "VSG1"
const ITERATIONS = 600_000;
const CHECK_TEXT = "vault-sync-check";
const SEG = 180;

const te = new TextEncoder();
const td = new TextDecoder();

export interface EncryptionMeta {
	v: 1;
	kdf: "PBKDF2-SHA256";
	iterations: number;
	salt: string;
	check: string;
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
	readonly transformsContent = true;
	readonly transformsPaths = true;
	private kContent: CryptoKey;
	private kNonce: CryptoKey;
	private kName: CryptoKey;
	private kNameNonce: CryptoKey;
	private constructor(id: string, kContent: CryptoKey, kNonce: CryptoKey, kName: CryptoKey, kNameNonce: CryptoKey) {
		this.id = id;
		this.kContent = kContent;
		this.kNonce = kNonce;
		this.kName = kName;
		this.kNameNonce = kNameNonce;
	}

	static async fromMaster(master: Uint8Array): Promise<EncryptionLayer> {
		const base = await crypto.subtle.importKey("raw", ab(master), "HKDF", false, ["deriveBits"]);
		const bits = (info: string) => crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode(info) }, base, 256);
		const aes = async (info: string) => crypto.subtle.importKey("raw", await bits(info), "AES-GCM", false, ["encrypt", "decrypt"]);
		const hmac = async (info: string) => crypto.subtle.importKey("raw", await bits(info), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const fp = new Uint8Array(await crypto.subtle.digest("SHA-256", await bits("vsg fingerprint"))).slice(0, 4);
		const id = "enc:" + Array.from(fp, (x) => x.toString(16).padStart(2, "0")).join("");
		return new EncryptionLayer(id, await aes("vsg content"), await hmac("vsg content nonce"), await aes("vsg name"), await hmac("vsg name nonce"));
	}

	private async nonce(key: CryptoKey, data: BufferSource): Promise<Uint8Array> {
		return new Uint8Array(await crypto.subtle.sign("HMAC", key, data)).slice(0, 12);
	}

	async encode(_path: string, data: ArrayBuffer): Promise<ArrayBuffer> {
		const iv = await this.nonce(this.kNonce, data);
		const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, this.kContent, data));
		const out = new Uint8Array(4 + 12 + ct.length);
		out.set(MAGIC, 0);
		out.set(iv, 4);
		out.set(ct, 16);
		return ab(out);
	}

	async decode(path: string, blob: ArrayBuffer): Promise<ArrayBuffer> {
		const u = new Uint8Array(blob);
		if (u.length < 16 + 16 || !MAGIC.every((b, i) => u[i] === b)) throw new SyncError("notEncrypted", { path });
		try {
			return await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(u.slice(4, 16)) }, this.kContent, ab(u.slice(16)));
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
	const layer = await EncryptionLayer.fromMaster(master);
	const meta: EncryptionMeta = { v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: b64(salt), check: await layer.checkValue() };
	return { meta, master, layer };
}

/** Unlock an existing encrypted repository. Throws on a wrong passphrase. */
export async function unlockEncryption(passphrase: string, meta: EncryptionMeta): Promise<{ master: Uint8Array; layer: EncryptionLayer }> {
	if (meta.v !== 1 || meta.kdf !== "PBKDF2-SHA256") throw new SyncError("newerFormat");
	const master = await deriveMaster(passphrase, unb64(meta.salt), meta.iterations);
	const layer = await EncryptionLayer.fromMaster(master);
	if (!(await layer.verify(meta))) throw new SyncError("wrongPass");
	return { master, layer };
}

export function passphraseStrength(p: string): { ok: boolean; hint: string } {
	if (p.length < 12) return { ok: false, hint: tr("e.passShort") };
	const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
	if (p.length < 16 && kinds < 3) return { ok: true, hint: tr("e.passOk") };
	return { ok: true, hint: tr("e.passStrong") };
}
