import { TFile, TFolder } from "obsidian";
import { gitBlobSha } from "../../src/util.ts";
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
			list: async (dir: string) => {
				const files = new Set<string>();
				const folders = new Set<string>();
				const all = [...fs.files.keys(), ...[...fs.dirs].map((d) => d + "/")];
				for (const p of all) {
					if (!p.startsWith(dir + "/")) continue;
					const rest = p.slice(dir.length + 1);
					const i = rest.indexOf("/");
					if (i < 0) {
						if (rest) files.add(p);
					} else folders.add(dir + "/" + rest.slice(0, i));
				}
				return { files: [...files], folders: [...folders] };
			},
			readBinary: async (p: string) => toAB(fs.files.get(p)!.data),
			writeBinary: write,
			mkdir: async (p: string) => void fs.dirs.add(p),
			rmdir: async (p: string) => void fs.dirs.delete(p),
			trashLocal: async (p: string) => {
				fs.files.delete(p);
				fs.trash.push(p);
			},
			read: async () => {
				throw new Error("no state");
			},
			write: async () => {},
		};
		return {
			vault: {
				configDir: fs.configDir,
				adapter,
				getName: () => "Test",
				getFiles: () => [...fs.files.keys()].filter((p) => !hidden(p)).map((p) => fs.tfile(p)),
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
				delete: async (f: TFolder) => void fs.dirs.delete(f.path),
				trash: async (f: TFile) => adapter.trashLocal(f.path),
			},
			fileManager: { trashFile: async (f: TFile) => adapter.trashLocal(f.path) },
		};
	}
}

export class FakeGitHub {
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
		stateFilePath: ".obsidian/plugins/vault-sync-github/sync-state.json",
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
