import { TFile, TFolder } from "obsidian";
import { gitBlobSha } from "../../src/util.ts";
import { NotFastForward } from "../../src/remote.ts";
import { SyncEngine } from "../../src/sync.ts";
import type { SyncHost } from "../../src/sync.ts";
import { DEFAULT_SETTINGS, emptyState } from "../../src/types.ts";
import type { VaultSyncSettings, ConflictChoice, DeleteGuardChoice } from "../../src/types.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();
const toAB = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const hidden = (p: string) => p.split("/").some((s) => s.startsWith("."));
let clock = 1000;

export class FakeFS {
	files = new Map<string, { data: Uint8Array; mtime: number }>();
	dirs = new Set<string>();
	trash: string[] = [];
	configDir = ".obsidian";
	/** Like Obsidian on macOS/Windows/iOS: a rename whose target differs only by letter case "already exists". */
	caseInsensitive = false;

	put(path: string, text: string) {
		this.files.set(path, { data: enc.encode(text), mtime: ++clock });
	}
	text(path: string): string | undefined {
		const f = this.files.get(path);
		return f ? dec.decode(f.data) : undefined;
	}
	private tfile(path: string): TFile {
		const t = new TFile(path);
		const f = this.files.get(path)!;
		t.stat = { mtime: f.mtime, size: f.data.byteLength, ctime: 0 };
		return t;
	}
	private isDir(p: string) {
		return this.dirs.has(p) || [...this.files.keys()].some((f) => f.startsWith(p + "/"));
	}
	app(): any {
		const fs = this;
		const write = async (path: string, data: ArrayBuffer) => {
			fs.files.set(path, { data: new Uint8Array(data.slice(0)), mtime: ++clock });
		};
		const adapter = {
			exists: async (p: string) => fs.files.has(p) || fs.isDir(p),
			stat: async (p: string) => {
				const f = fs.files.get(p);
				if (f) return { type: "file", mtime: f.mtime, size: f.data.byteLength, ctime: 0 };
				return fs.isDir(p) ? { type: "folder", mtime: 0, size: 0, ctime: 0 } : null;
			},
			list: async (rawDir: string) => {
				const dir = rawDir.replace(/^\/+|\/+$/g, "");
				const files = new Set<string>();
				const folders = new Set<string>();
				const all = [...fs.files.keys(), ...[...fs.dirs].map((d) => d + "/")];
				const pre = dir ? dir + "/" : "";
				for (const p of all) {
					if (!p.startsWith(pre)) continue;
					const rest = p.slice(pre.length);
					const i = rest.indexOf("/");
					if (i < 0) {
						if (rest) files.add(p);
					} else folders.add(pre + rest.slice(0, i));
				}
				return { files: [...files], folders: [...folders] };
			},
			readBinary: async (p: string) => toAB(fs.files.get(p)!.data),
			writeBinary: write,
			mkdir: async (p: string) => void fs.dirs.add(p),
			rmdir: async (p: string) => void fs.dirs.delete(p),
			rename: async (from: string, to: string) => {
				const f = fs.files.get(from);
				if (!f) throw new Error("no such file " + from);
				if (fs.files.has(to)) throw new Error("exists " + to);
				if (fs.caseInsensitive && [...fs.files.keys()].some((k) => k.toLowerCase() === to.toLowerCase())) throw new Error("exists " + to);
				fs.files.set(to, { data: f.data, mtime: ++clock });
				fs.files.delete(from);
			},
			trashLocal: async (p: string) => {
				fs.files.delete(p);
				fs.dirs.delete(p);
				fs.trash.push(p);
			},
			read: async (p: string) => {
				const f = fs.files.get(p);
				if (!f) throw new Error("no state");
				return dec.decode(f.data);
			},
			write: async () => {},
		};
		return {
			vault: {
				configDir: fs.configDir,
				adapter,
				getName: () => "Test",
				getFiles: () => [...fs.files.keys()].filter((p) => !hidden(p)).map((p) => fs.tfile(p)),
				// Folders (explicit ones and those implied by files), each with its direct children.
				getAllLoadedFiles: () => {
					const dirs = new Set<string>(fs.dirs);
					for (const f of fs.files.keys()) {
						const parts = f.split("/");
						for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
					}
					return [...dirs].filter((d) => !hidden(d)).map((d) => {
						const folder = new TFolder(d) as TFolder & { children: unknown[] };
						folder.children = [...fs.files.keys(), ...dirs].filter((p) => p !== d && p.startsWith(d + "/") && !p.slice(d.length + 1).includes("/"));
						return folder;
					});
				},
				getAbstractFileByPath: (p: string) => {
					if (hidden(p)) return null;
					if (fs.files.has(p)) return fs.tfile(p);
					if (fs.isDir(p)) return new TFolder(p);
					return null;
				},
				readBinary: async (f: TFile) => toAB(fs.files.get(f.path)!.data),
				modifyBinary: async (f: TFile, d: ArrayBuffer) => write(f.path, d),
				createBinary: async (p: string, d: ArrayBuffer) => {
					if (fs.files.has(p)) throw new Error("exists");
					await write(p, d);
				},
				createFolder: async (p: string) => void fs.dirs.add(p),
				rename: async (f: TFile, to: string) => adapter.rename(f.path, to),
				delete: async (f: TFolder) => void fs.dirs.delete(f.path),
				trash: async (f: TFile) => adapter.trashLocal(f.path),
			},
			fileManager: { trashFile: async (f: TFile) => adapter.trashLocal(f.path) },
		};
	}
}

export class FakeGitHub {
	label = "GitHub";
	kind = "github";
	blobs = new Map<string, Uint8Array>();
	trees = new Map<string, Map<string, { sha: string; mode: string }>>();
	commits = new Map<string, { tree: string; parents: string[]; message: string }>();
	refs = new Map<string, string>();
	interject: (() => Promise<void>) | null = null;
	n = 0;

	private async addBlob(data: Uint8Array) {
		const sha = await gitBlobSha(toAB(data));
		this.blobs.set(sha, data);
		return sha;
	}
	staleRef: string | null = null; // simulate a cached, outdated branch head
	async getRef(b: string) {
		if (this.staleRef) return this.staleRef;
		return this.refs.get(b) ?? null;
	}
	private ancestors(sha: string): Set<string> {
		const seen = new Set<string>();
		const stack = [sha];
		while (stack.length) {
			const c = stack.pop()!;
			if (seen.has(c) || !this.commits.has(c)) continue;
			seen.add(c);
			stack.push(...this.commits.get(c)!.parents);
		}
		return seen;
	}
	async compare(base: string, head: string) {
		if (!this.commits.has(base)) return "missing";
		if (base === head) return "identical";
		if (this.ancestors(head).has(base)) return "ahead";
		if (this.ancestors(base).has(head)) return "behind";
		return "diverged";
	}
	async getRepo() {
		return { private: true, default_branch: "main", html_url: "", size: 0 };
	}
	async createRef(ref: string, sha: string) {
		this.refs.set(ref.replace("refs/heads/", ""), sha);
	}
	async putFile(path: string, message: string, b64: string, branch: string) {
		const sha = await this.addBlob(new Uint8Array(Buffer.from(b64, "base64")));
		const t = "t" + this.n++;
		this.trees.set(t, new Map([[path, { sha, mode: "100644" }]]));
		const c = "c" + this.n++;
		this.commits.set(c, { tree: t, parents: [], message });
		this.refs.set(branch, c);
	}
	async getCommitTree(sha: string) {
		return this.commits.get(sha)!.tree;
	}
	async listTree(t: string) {
		return [...this.trees.get(t)!].map(([path, e]) => ({
			path, mode: e.mode, type: "blob" as const, sha: e.sha, size: this.blobs.get(e.sha)!.byteLength,
		}));
	}
	async getBlob(sha: string) {
		const b = this.blobs.get(sha);
		if (!b) throw new Error("no blob " + sha);
		return toAB(b);
	}
	async createBlob(b64: string) {
		return this.addBlob(new Uint8Array(Buffer.from(b64, "base64")));
	}
	async createTree(base: string | null, entries: any[]) {
		const m = new Map(base ? this.trees.get(base)! : []);
		for (const e of entries) {
			if (e.sha === null) {
				if (!m.has(e.path)) throw new Error("delete of missing path " + e.path);
				m.delete(e.path);
			} else if (e.content !== undefined) m.set(e.path, { sha: await this.addBlob(enc.encode(e.content)), mode: e.mode });
			else m.set(e.path, { sha: e.sha, mode: e.mode });
		}
		const t = "t" + this.n++;
		this.trees.set(t, m);
		return t;
	}
	async createCommit(message: string, tree: string, parents: string[]) {
		const c = "c" + this.n++;
		this.commits.set(c, { tree, parents, message });
		return c;
	}
	async updateRef(b: string, sha: string) {
		if (this.interject) {
			const f = this.interject;
			this.interject = null;
			await f();
		}
		if (!this.commits.get(sha)!.parents.includes(this.refs.get(b)!)) return false;
		this.refs.set(b, sha);
		return true;
	}
	async commit(req: any) {
		const entries: any[] = [];
		for (const u of req.upserts) {
			if (u.sha) entries.push({ path: u.path, mode: u.mode, sha: u.sha });
			else {
				const data = await u.load();
				const t = u.text?.(data);
				if (t !== null && t !== undefined) entries.push({ path: u.path, mode: u.mode, content: t });
				else entries.push({ path: u.path, mode: u.mode, sha: await this.addBlob(new Uint8Array(data)) });
			}
		}
		for (const d of req.deletes) entries.push({ path: d, mode: "100644", sha: null });
		const tree = await this.createTree(req.parentTree, entries);
		const c = await this.createCommit(req.message, tree, [req.parent]);
		if (!(await this.updateRef(req.branch, c))) throw new NotFastForward();
		return { sha: c, fastForward: true };
	}
	async getFileAt(path: string, ref: string) {
		const e = this.trees.get(this.commits.get(ref)!.tree)!.get(path);
		return e ? toAB(this.blobs.get(e.sha)!) : null;
	}
	rawFiles(): Map<string, Uint8Array> {
		const t = this.trees.get(this.commits.get(this.refs.get("main")!)!.tree)!;
		return new Map([...t].map(([p, e]) => [p, this.blobs.get(e.sha)!]));
	}
	headFiles(): Map<string, string> {
		const t = this.trees.get(this.commits.get(this.refs.get("main")!)!.tree)!;
		return new Map([...t].map(([p, e]) => [p, dec.decode(this.blobs.get(e.sha)!)]));
	}
}

export function device(name: string, gh: FakeGitHub, overrides: Partial<VaultSyncSettings> = {}) {
	const fs = new FakeFS();
	const settings: VaultSyncSettings = { ...DEFAULT_SETTINGS, owner: "me", repo: "vault", ...overrides };
	const calls = { deletes: 0, conflicts: 0 };
	const host: SyncHost & { deleteChoice: DeleteGuardChoice; conflictChoice: ConflictChoice } = {
		app: fs.app(),
		settings,
		state: emptyState(),
		gh: gh as any,
		stateFilePath: ".obsidian/plugins/vault-sync-git/sync-state.json",
		deviceName: () => name,
		log: () => {},
		saveState: async () => {},
		deleteChoice: "proceed",
		conflictChoice: "keep-both",
		askConflict: async () => {
			calls.conflicts++;
			return host.conflictChoice;
		},
		confirmDeletes: async () => {
			calls.deletes++;
			return host.deleteChoice;
		},
	};
	const engine = new SyncEngine(host);
	return { fs, host, engine, calls, sync: (mode: "sync" | "push" | "pull" = "sync") => engine.run(mode) };
}
