// Per-device sync state on disk: atomic writes, and a device stamp so state that arrives from another
// device (vault also synced by iCloud or another tool) is never trusted as this device's baseline.

import type { DataAdapter } from "obsidian";
import { emptyState } from "./types.ts";
import type { SyncState } from "./types.ts";

export async function readState(adapter: DataAdapter, path: string, deviceId: string, log: (m: string) => void): Promise<SyncState> {
	for (const p of [path, `${path}.tmp`]) {
		try {
			const parsed = JSON.parse(await adapter.read(p)) as SyncState;
			if (parsed.version !== 1) continue;
			if (parsed.deviceId && parsed.deviceId !== deviceId) {
				log("The saved sync state belongs to another device (is this vault also synced by another tool?). Starting from a fresh baseline; nothing will be deleted.");
				return { ...emptyState(), deviceId };
			}
			return { ...emptyState(), ...parsed, deviceId };
		} catch {
			/* missing or unreadable: try the next candidate */
		}
	}
	return { ...emptyState(), deviceId };
}

export async function writeState(adapter: DataAdapter, path: string, state: SyncState, deviceId: string): Promise<void> {
	state.deviceId = deviceId;
	const tmp = `${path}.tmp`;
	await adapter.write(tmp, JSON.stringify(state));
	if (await adapter.exists(path)) await adapter.remove(path);
	await adapter.rename(tmp, path);
}
