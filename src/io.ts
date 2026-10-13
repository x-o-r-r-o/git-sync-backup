// Vault file access that behaves the same on desktop and mobile.
// Indexed files go through the Vault API (so the editor and caches stay in sync);
// hidden files (config dir) go through the adapter, since the vault does not index them.

import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
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

	/**
	 * Hidden entries inside normal vault folders (e.g. Notes/.assets/, Project/.gitignore), which Obsidian
	 * doesn't index: lists every indexed folder on disk, then walks the hidden folders found. With
	 * `onlyNames`, only files with those names are returned (no hidden folders are walked).
	 */
	async listNestedHidden(inScope: (path: string) => boolean, onlyNames?: Set<string>): Promise<LocalFileInfo[]> {
		const out: LocalFileInfo[] = [];
		const strip = (p: string) => p.replace(/^\/+/, "");
		const name = (p: string) => p.split("/").pop() ?? p;
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
		const all = (this.app.vault as { getAllLoadedFiles?: () => TAbstractFile[] }).getAllLoadedFiles?.() ?? [];
		for (const folder of all) {
			if (!(folder instanceof TFolder) || !folder.path || folder.path === "/" || isHiddenPath(folder.path)) continue;
			// Listing errors propagate (a partial list would make the missing files look deleted).
			const listing = await this.adapter.list(folder.path);
			for (const f of listing.files.map(strip)) {
				if (!name(f).startsWith(".")) continue;
				if (onlyNames && !onlyNames.has(name(f))) continue;
				await addFile(f);
			}
			if (onlyNames) continue;
			for (const d of listing.folders.map(strip)) if (name(d).startsWith(".") && inScope(d)) await walk(d);
		}
		return out;
	}

	/** Empty folders in the vault (indexed by Obsidian), in scope. */
	listEmptyFolders(inScope: (path: string) => boolean): string[] {
		const out: string[] = [];
		const all = (this.app.vault as { getAllLoadedFiles?: () => TAbstractFile[] }).getAllLoadedFiles?.() ?? [];
		for (const f of all) if (f instanceof TFolder && f.path && f.path !== "/" && f.children.length === 0 && !isHiddenPath(f.path) && inScope(f.path)) out.push(f.path);
		return out;
	}
	/** True if a folder exists and holds files or folders. */
	async folderHasChildren(path: string): Promise<boolean> {
		try {
			const l = await this.adapter.list(path);
			// System clutter (.DS_Store, ._ files, Thumbs.db, desktop.ini) doesn't count. Other hidden files
			// do: they may be synced (hidden files, .gitignore), and removing the folder would delete them.
			const visible = (p: string) => !/^(\.DS_Store|\._.*|Thumbs\.db|desktop\.ini)$/i.test(p.split("/").pop() ?? "");
			return l.files.some(visible) || l.folders.some(visible);
		} catch {
			// Couldn't list it: assume it holds something, so it is never removed blindly.
			return true;
		}
	}
	async makeFolder(path: string): Promise<void> {
		if (await this.adapter.exists(path)) return;
		try {
			await this.app.vault.createFolder(path);
		} catch {
			if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
		}
	}
	/** Removes a folder only while it is empty (a folder that gained files here is kept). */
	async removeEmptyFolder(path: string): Promise<void> {
		if (!(await this.adapter.exists(path)) || (await this.folderHasChildren(path))) return;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFolder) await this.app.fileManager.trashFile(f);
		else await this.adapter.rmdir(path, false);
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
		if (from !== to && from.normalize("NFC").toLowerCase() === to.normalize("NFC").toLowerCase()) {
			// Only letter case (or Unicode form) changes: on case-insensitive disks (macOS, Windows, iOS)
			// the target "exists" already, so go through a temporary name.
			// A different file already at the target (case-sensitive disk): never overwrite or strand it.
			const both = await this.adapter.list(parentDir(to) || "/").catch(() => null);
			if (both?.files.some((f) => f.replace(/^\/+/, "") === to)) throw new Error(`${to} already exists`);
			const tmp = `${to}.${Date.now().toString(36)}.renaming`;
			await this.renameFile(from, tmp);
			try {
				await this.renameFile(tmp, to);
			} catch (e) {
				await this.renameFile(tmp, from); // put it back under its old name
				throw e;
			}
		} else await this.renameFile(from, to);
		await this.pruneLater(parentDir(from));
	}

	private async renameFile(from: string, to: string): Promise<void> {
		const f = this.tfile(from);
		if (f) await this.app.vault.rename(f, to);
		else await this.adapter.rename(from, to);
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
		await this.pruneLater(parentDir(path));
	}

	/**
	 * Removes local content that exists nowhere else (it is about to be replaced by the repository's
	 * version): always to the system trash, else the vault's .trash folder, even when the user's
	 * preference is to delete files permanently.
	 */
	async removeRecoverable(path: string): Promise<void> {
		if (await this.adapter.exists(path)) {
			let trashed = false;
			try {
				trashed = await this.adapter.trashSystem(path);
			} catch {
				trashed = false;
			}
			if (!trashed) await this.adapter.trashLocal(path);
		}
		await this.pruneLater(parentDir(path));
	}

	/** Folders whose pruning waits until a batch of parallel writes is done (null = prune right away). */
	private pruneQueue: Set<string> | null = null;

	/**
	 * Runs `fn` with empty-folder pruning held back until it finishes, so parallel work inside it (a
	 * download pool) can never have a folder trashed just as another task writes a file into it.
	 */
	async deferPruning<T>(fn: () => Promise<T>): Promise<T> {
		if (this.pruneQueue) return fn();
		const queue = new Set<string>();
		this.pruneQueue = queue;
		try {
			return await fn();
		} finally {
			this.pruneQueue = null;
			// Deepest first, so a parent emptied by pruning its child is pruned too.
			for (const dir of [...queue].sort((a, b) => b.length - a.length)) await this.pruneEmptyDirs(dir);
		}
	}

	private async pruneLater(dir: string): Promise<void> {
		if (this.pruneQueue) this.pruneQueue.add(dir);
		else await this.pruneEmptyDirs(dir);
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
