// Device-side encryption state and the safety check run on every sync.

import { EncryptionLayer, unb64 } from "./crypto.ts";
import type { EncryptionMeta } from "./crypto.ts";
import { SyncError } from "./errors.ts";

/** What a device stores (in secret storage) once encryption is unlocked. */
export interface EncryptionRecord {
	meta: EncryptionMeta;
	/** base64 of the 32-byte master key. Secret. */
	master: string;
	/** Blob sha of the marker this device last verified. */
	markerSha?: string;
}

export class EncryptionLocked extends SyncError {
	constructor() {
		super("encLocked");
	}
}

export class EncryptionMismatch extends SyncError {
	constructor() {
		super("encMismatch");
	}
}

/**
 * Another device upgraded the repository's encryption (same key, newer content format). This device
 * switched to it; the running sync stops so nothing is written in the old format, and the next runs
 * with the new one.
 */
export class EncryptionUpgraded extends SyncError {
	constructor() {
		super("encUpgraded");
	}
}

/**
 * Builds SyncHost.checkEncryption. Throws when syncing would be unsafe; returns marker JSON when this
 * device is the first to encrypt the repository.
 */
export function encryptionGuard(
	getRecord: () => EncryptionRecord | null,
	saveRecord: (r: EncryptionRecord) => void,
	readMarker: (sha: string) => Promise<EncryptionMeta>,
): (markerSha: string | null) => Promise<string | null> {
	return async (markerSha) => {
		const rec = getRecord();
		if (!rec) {
			if (markerSha) throw new EncryptionLocked();
			return null;
		}
		if (!markerSha) return JSON.stringify(rec.meta, null, 2) + "\n";
		if (rec.markerSha === markerSha) return null;
		const meta = await readMarker(markerSha);
		if (meta.salt !== rec.meta.salt) throw new EncryptionMismatch();
		const mine = rec.meta.v ?? 1;
		const theirs = meta.v ?? 1;
		if (theirs === mine) {
			if (meta.check !== rec.meta.check) throw new EncryptionMismatch();
			saveRecord({ ...rec, markerSha });
			return null;
		}
		// Same salt, another content format: only accepted when this device's key opens its check value.
		const opens = async (m: EncryptionMeta) => (theirs === 1 || theirs === 2) && (await (await EncryptionLayer.fromMaster(unb64(rec.master), m.v)).verify(m));
		if (theirs < mine) {
			// This device upgraded (or a mirror still has the old marker): publish the newer marker.
			if (!(await opens(meta))) throw new EncryptionMismatch();
			return JSON.stringify(rec.meta, null, 2) + "\n";
		}
		// Another device upgraded the repository: switch, and stop this run.
		if (!(await opens(meta))) throw new EncryptionMismatch();
		saveRecord({ meta, master: rec.master, markerSha });
		throw new EncryptionUpgraded();
	};
}
