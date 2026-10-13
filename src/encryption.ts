// Device-side encryption state and the safety check run on every sync.

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
		if (meta.salt !== rec.meta.salt || meta.check !== rec.meta.check) throw new EncryptionMismatch();
		saveRecord({ ...rec, markerSha });
		return null;
	};
}
