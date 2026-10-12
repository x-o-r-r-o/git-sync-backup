// Vault file access that behaves the same on desktop and mobile.
// Indexed files go through the Vault API (so the editor and caches stay in sync);
// hidden files (config dir) go through the adapter, since the vault does not index them.

import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import { isHiddenPath, parentDir } from "./util.ts";

export interface LocalFileInfo {
	path: string;
	mtime: number;
	size: number;
}

export class VaultIO {
	private app: App;
	constructor(app: App) {
		this.app = app;
	}

	private get adapter() {
		return this.app.vault.adapter;
	}

	private tfile(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	/** Indexed vault files in scope. Uses cached stats only, so it is cheap even on mobile. */
	listVault(inScope: (path: string) => boolean): LocalFileInfo[] {
		const out: LocalFileInfo[] = [];
		for (const f of this.app.vault.getFiles()) {
			if (inScope(f.path)) out.push({ path: f.path, mtime: f.stat.mtime, size: f.stat.size });
		}
		return out;
	}

	/** Files in the config dir that are in scope. Walks the disk, so callers should not run it on every sync. */
	async listConfig(inScope: (path: string) => boolean): Promise<LocalFileInfo[]> {
		const out: LocalFileInfo[] = [];
		// A listing error must abort the sync: a partial list would make the missing files look deleted.
		const walk = async (dir: string) => {
			const listing = await this.adapter.list(dir);
			for (const file of listing.files) {
				if (!inScope(file)) continue;
				const st = await this.adapter.stat(file);
				if (st && st.type === "file") out.push({ path: file, mtime: st.mtime, size: st.size });
			}
			for (const sub of listing.folders) {
				// Prune whole excluded folders early (e.g. plugin node_modules).
				if (inScope(sub)) await walk(sub);
			}
		};
		await walk(this.app.vault.configDir);
		return out;
	}

	/** Hidden files and folders at the top of the vault (not indexed by Obsidian), outside the config dir. */
	async listHidden(inScope: (path: string) => boolean): Promise<LocalFileInfo[]> {
		const out: LocalFileInfo[] = [];
		const cfg = this.app.vault.configDir;
		// Listing errors propagate (a partial list would make the missing files look deleted).
		const root = await this.adapter.list("/");
		const strip = (p: string) => p.replace(/^\/+/, "");
		const addFile = async (file: string) => {
			if (!inScope(file)) return;
			const st = await this.adapter.stat(file);
			if (st && st.type === "file") out.push({ path: file, mtime: st.mtime, size: st.size });
		};
		const walk = async (dir: string) => {
			const listing = await this.adapter.list(dir);
			for (const f of listing.files) await addFile(strip(f));
			for (const sub of listing.folders) if (inScope(strip(sub))) await walk(strip(sub));
		};
		for (const f of root.files.map(strip)) if (f.startsWith(".")) await addFile(f);
		for (const d of root.folders.map(strip)) if (d.startsWith(".") && d !== cfg && inScope(d)) await walk(d);
		return out;
	}

	/** Every file in scope: indexed vault files, plus the config dir when requested. */
	async list(inScope: (path: string) => boolean, includeConfigDir: boolean): Promise<LocalFileInfo[]> {
		const out = this.listVault(inScope);
		if (includeConfigDir) out.push(...(await this.listConfig(inScope)));
		return out;
	}

	async read(path: string): Promise<ArrayBuffer> {
		const f = this.tfile(path);
		return f ? this.app.vault.readBinary(f) : this.adapter.readBinary(path);
	}

	async stat(path: string): Promise<{ mtime: number; size: number } | null> {
		const f = this.tfile(path);
		if (f) return { mtime: f.stat.mtime, size: f.stat.size };
		const st = await this.adapter.stat(path);
		return st && st.type === "file" ? { mtime: st.mtime, size: st.size } : null;
	}

	private async ensureDir(dir: string): Promise<void> {
		if (!dir || (await this.adapter.exists(dir))) return;
		await this.ensureDir(parentDir(dir));
		if (isHiddenPath(dir)) await this.adapter.mkdir(dir);
		else {
			try {
				await this.app.vault.createFolder(dir);
			} catch {
				if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
			}
		}
	}

	async write(path: string, data: ArrayBuffer): Promise<void> {
		await this.ensureDir(parentDir(path));
		const f = this.tfile(path);
		if (f) {
			await this.app.vault.modifyBinary(f, data);
		} else if (isHiddenPath(path)) {
			await this.adapter.writeBinary(path, data);
		} else {
			try {
				await this.app.vault.createBinary(path, data);
			} catch {
				// Exists on disk but not yet indexed.
				await this.adapter.writeBinary(path, data);
			}
		}
	}

	/**
	 * Renames a file without touching its content or rewriting links (the other device already synced
	 * any link updates). Open tabs and bookmarks follow the file.
	 */
	async rename(from: string, to: string): Promise<void> {
		await this.ensureDir(parentDir(to));
		const f = this.tfile(from);
		if (f) await this.app.vault.rename(f, to);
		else await this.adapter.rename(from, to);
		await this.pruneEmptyDirs(parentDir(from));
	}

	/** Moves to trash (recoverable), then removes now-empty parent folders. */
	async remove(path: string): Promise<void> {
		const f = this.tfile(path);
		if (f) {
			// Respects the user's "deleted files" preference (system trash, .trash, or permanent).
			await this.app.fileManager.trashFile(f);
		} else if (await this.adapter.exists(path)) {
			await this.adapter.trashLocal(path);
		}
		await this.pruneEmptyDirs(parentDir(path));
	}

	private async pruneEmptyDirs(dir: string): Promise<void> {
		while (dir && dir !== this.app.vault.configDir) {
			try {
				const listing = await this.adapter.list(dir);
				if (listing.files.length || listing.folders.length) return;
				const folder = this.app.vault.getAbstractFileByPath(dir);
				if (folder instanceof TFolder) await this.app.fileManager.trashFile(folder);
				else await this.adapter.rmdir(dir, false);
			} catch {
				return;
			}
			dir = parentDir(dir);
		}
	}
}
