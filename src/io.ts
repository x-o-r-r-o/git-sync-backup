// Vault file access that behaves the same on desktop and mobile.
// Indexed files go through the Vault API (so the editor and caches stay in sync);
// hidden files (config dir) go through the adapter, since the vault does not index them.

import { TFile, TFolder } from "obsidian";
import type { App, TAbstractFile } from "obsidian";
import { isHiddenPath, parentDir, pool } from "./util.ts";

/** This plugin's id: a sync must never turn it off on this device (see keepSelfEnabled). */
export const SELF_PLUGIN_ID = "vault-sync-git";

/**
 * The list of enabled community plugins with this plugin kept in it. A download of
 * community-plugins.json written while this plugin runs must never switch it off here: one device
 * turning it off (or a stale list) would otherwise spread and stop sync on every device.
 * Returns null when nothing needs to change (not that file, not a JSON list, or already listed).
 */
export function keepSelfEnabled(path: string, configDir: string, data: ArrayBuffer): ArrayBuffer | null {
	if (path !== `${configDir}/community-plugins.json`) return null;
	let list: unknown;
	try {
		list = JSON.parse(new TextDecoder().decode(data));
	} catch {
		return null;
	}
	if (!Array.isArray(list) || list.includes(SELF_PLUGIN_ID)) return null;
	const u = new TextEncoder().encode(JSON.stringify([...(list as unknown[]), SELF_PLUGIN_ID], null, 2));
	return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
}

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
	 * doesn't index. Finding them means listing every folder on disk, so that walk is shared and cached
	 * (see NestedHiddenIndex): it only runs again after folders were created or renamed, on a full scan
	 * (`full`), or every 30 minutes. In between, the known hidden files are re-read (stat) and the known
	 * hidden folders re-walked, which is cheap. With `onlyNames`, only files with those names are returned
	 * (no hidden folders are walked).
	 */
	async listNestedHidden(inScope: (path: string) => boolean, onlyNames?: Set<string>, opts: { full?: boolean } = {}): Promise<LocalFileInfo[]> {
		const found = await nestedHiddenIndex(this.app).get(this, opts.full ?? false);
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
		for (const f of found.files) {
			if (onlyNames && !onlyNames.has(name(f))) continue;
			await addFile(f);
		}
		if (onlyNames) return out;
		for (const d of found.dirs) {
			if (!inScope(d)) continue;
			// A known hidden folder removed since the last walk simply has nothing in it any more.
			const st = await this.adapter.stat(d);
			if (st?.type === "folder") await walk(d);
		}
		return out;
	}

	/**
	 * One walk of every indexed folder on disk: the hidden files directly inside each, and the hidden
	 * folders found there. Scope-free (callers filter), with up to 4 listings at a time.
	 */
	async walkNestedHidden(): Promise<NestedHidden> {
		const strip = (p: string) => p.replace(/^\/+/, "");
		const name = (p: string) => p.split("/").pop() ?? p;
		const files: string[] = [];
		const dirs: string[] = [];
		const all = (this.app.vault as { getAllLoadedFiles?: () => TAbstractFile[] }).getAllLoadedFiles?.() ?? [];
		const folders = all.filter((f): f is TFolder => f instanceof TFolder && !!f.path && f.path !== "/" && !isHiddenPath(f.path)).map((f) => f.path);
		// Listing errors propagate (a partial list would make the missing files look deleted).
		await pool(folders, 4, async (folder) => {
			const listing = await this.adapter.list(folder);
			for (const f of listing.files.map(strip)) if (name(f).startsWith(".")) files.push(f);
			for (const d of listing.folders.map(strip)) if (name(d).startsWith(".")) dirs.push(d);
		});
		return { files: files.sort(), dirs: dirs.sort() };
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

	/**
	 * A hidden file inside a normal folder (Notes/.gitignore, Notes/.assets/a.png) written by a sync
	 * raises no folder event, so the cached folder walk wouldn't list it and the next sync would read it
	 * as deleted here. Writing one makes the next scan walk the folders again.
	 */
	private noteNestedHidden(path: string) {
		const parts = path.split("/");
		if (parts.slice(1).some((p) => p.startsWith(".")) && parts[0] !== this.app.vault.configDir) nestedHiddenIndex(this.app).foldersChanged();
	}

	/** Set when a write kept this plugin enabled: the file then differs from the download and must be re-read. */
	selfRepaired = false;

	async write(path: string, data: ArrayBuffer): Promise<void> {
		const kept = keepSelfEnabled(path, this.app.vault.configDir, data);
		if (kept) {
			data = kept;
			this.selfRepaired = true;
		}
		await this.ensureDir(parentDir(path));
		this.noteNestedHidden(path);
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
		this.noteNestedHidden(to);
		if (from !== to && from.normalize("NFC").toLowerCase() === to.normalize("NFC").toLowerCase()) {
			// Only letter case (or Unicode form) changes: on case-insensitive disks (macOS, Windows, iOS)
			// the target "exists" already, so go through a temporary name.
			// A different file already at the target (case-sensitive disk): never overwrite or strand it.
			// When only a folder's letter case differs, both spellings may be the same folder on disk
			// (case-insensitive), where the file "exists" there because it is this very file.
			const name = (f: string) => f.replace(/^\/+/, "").split("/").pop() ?? "";
			const list = async (dir: string) => new Set(((await this.adapter.list(dir || "/").catch(() => null))?.files ?? []).map(name));
			const target = await list(parentDir(to));
			if (target.has(name(to))) {
				const source = parentDir(from) === parentDir(to) ? target : await list(parentDir(from));
				const sameFolder = source.size === target.size && [...source].every((n) => target.has(n));
				if (!(sameFolder && name(from) === name(to))) throw new Error(`${to} already exists`);
			}
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

	/**
	 * Renames a folder whose name changes only by letter case (renamed so on another device), through a
	 * temporary name so case-insensitive disks (macOS, Windows, iOS) really change it.
	 */
	async renameFolderCase(from: string, to: string): Promise<void> {
		const tmp = `${to}.${Date.now().toString(36)}.renaming`;
		const step = async (a: string, b: string) => {
			const f = this.app.vault.getAbstractFileByPath(a);
			if (f instanceof TFolder) await this.app.vault.rename(f, b);
			else await this.adapter.rename(a, b);
		};
		await step(from, tmp);
		try {
			await step(tmp, to);
		} catch (e) {
			await step(tmp, from); // put it back under its old name
			throw e;
		}
		nestedHiddenIndex(this.app).foldersChanged();
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

/** Hidden files directly inside normal folders, and hidden folders there (vault paths, sorted). */
export interface NestedHidden {
	files: string[];
	dirs: string[];
}

/** Without folder changes or full scans, the folder walk still runs this often (new files from outside Obsidian). */
export const NESTED_WALK_MS = 30 * 60_000;
/** A walk this recent counts as fresh for a full scan: the .gitignore check and the scan of one sync share it. */
const FRESH_MS = 60_000;

/**
 * Cache of the folder walk that finds hidden entries inside normal folders. Shared by everything that
 * reads the same vault (the .gitignore loader and every sync engine), so one sync walks at most once.
 */
export class NestedHiddenIndex {
	private found: NestedHidden | null = null;
	private walkedAt = 0;
	private stale = true;
	private running: Promise<NestedHidden> | null = null;
	/** Number of folder walks done (for tests and the debug log). */
	walks = 0;

	/** Folders were created, renamed or moved: the next request walks again. */
	foldersChanged() {
		this.stale = true;
	}

	/** True if the next request would walk the folders (`full`: a full scan asks). */
	due(full = false, now = Date.now()): boolean {
		if (!this.found || this.stale) return true;
		if (now - this.walkedAt > NESTED_WALK_MS) return true;
		return full && now - this.walkedAt > FRESH_MS;
	}

	async get(io: VaultIO, full = false): Promise<NestedHidden> {
		if (this.running) return this.running;
		if (!this.due(full) && this.found) return this.found;
		// Cleared before the walk: a folder created while it runs makes the next request walk again.
		this.stale = false;
		this.running = io.walkNestedHidden();
		try {
			const found = await this.running;
			this.found = found;
			this.walkedAt = Date.now();
			this.walks++;
			return found;
		} catch (e) {
			this.stale = true;
			throw e;
		} finally {
			this.running = null;
		}
	}
}

const indexes = new WeakMap<object, NestedHiddenIndex>();

/** The shared walk cache of the vault `app` shows. */
export function nestedHiddenIndex(app: App): NestedHiddenIndex {
	const key = app.vault;
	let idx = indexes.get(key);
	if (!idx) indexes.set(key, (idx = new NestedHiddenIndex()));
	return idx;
}
