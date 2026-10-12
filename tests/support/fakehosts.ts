// In-memory fake Gitea and GitLab servers speaking (the subset of) their REST APIs that the
// providers use. Lets the full sync engine run end-to-end against each provider in tests.
import { gitBlobSha } from "../../src/util.ts";
import type { HttpRequest, HttpResponse } from "../../src/http.ts";

const te = new TextEncoder();
const toAB = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export class FakeRepo {
	blobs = new Map<string, Uint8Array>();
	commits = new Map<string, { files: Map<string, string>; parents: string[]; message: string; date: string }>();
	branches = new Map<string, string>();
	tags = new Map<string, string>();
	n = 0;
	interject: (() => void) | null = null;

	async blob(data: Uint8Array) {
		const sha = await gitBlobSha(toAB(data));
		this.blobs.set(sha, data);
		return sha;
	}
	commit(files: Map<string, string>, parents: string[], message: string) {
		const sha = `c${String(++this.n).padStart(39, "0")}`;
		this.commits.set(sha, { files, parents, message, date: new Date(Date.now() + this.n * 1000).toISOString() });
		return sha;
	}
	head(branch = "main") {
		return this.branches.get(branch);
	}
	files(branch = "main"): Map<string, string> {
		const c = this.commits.get(this.head(branch)!)!;
		return new Map([...c.files].map(([p, s]) => [p, new TextDecoder().decode(this.blobs.get(s)!)]));
	}
	history(sha: string): string[] {
		const out: string[] = [];
		const stack = [sha];
		while (stack.length) {
			const c = stack.shift()!;
			if (!this.commits.has(c) || out.includes(c)) continue;
			out.push(c);
			stack.push(...this.commits.get(c)!.parents);
		}
		return out;
	}
	/** Apply create/update/delete ops onto the branch head; returns new commit sha. */
	async apply(branch: string, message: string, ops: { op: string; path: string; content?: string }[]) {
		const parent = this.head(branch);
		const files = new Map(parent ? this.commits.get(parent)!.files : []);
		for (const o of ops) {
			if (o.op === "delete") {
				if (!files.has(o.path)) throw new Error("delete missing " + o.path);
				files.delete(o.path);
			} else {
				if (o.op === "create" && files.has(o.path)) throw new Error("create existing " + o.path);
				if (o.op === "update" && !files.has(o.path)) throw new Error("update missing " + o.path);
				files.set(o.path, await this.blob(unb64(o.content!)));
			}
		}
		const sha = this.commit(files, parent ? [parent] : [], message);
		this.branches.set(branch, sha);
		return sha;
	}
}

const ok = (json: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status: 200, json, arrayBuffer: toAB(te.encode(JSON.stringify(json))), headers });
const raw = (data: Uint8Array): HttpResponse => ({ status: 200, json: null, arrayBuffer: toAB(data), headers: {} });
const err = (status: number, message = "error"): HttpResponse => ({ status, json: { message }, arrayBuffer: new ArrayBuffer(0), headers: {} });

/** Fake Gitea at https://gitea.test/api/v1, repo me/vault. */
export function giteaTransport(repo: FakeRepo) {
	return async (req: HttpRequest): Promise<HttpResponse> => {
		const u = new URL(req.url);
		const path = decodeURIComponent(u.pathname.replace(/^\/api\/v1/, ""));
		const q = u.searchParams;
		const body = req.body ? JSON.parse(req.body) : undefined;
		const R = "/repos/me/vault";
		if (path === "/user") return ok({ login: "me" });
		if (path === R && req.method === "GET") return ok({ private: true, default_branch: "main", html_url: "https://gitea.test/me/vault", size: 0 });
		let m: RegExpExecArray | null;
		if ((m = /^\/repos\/me\/vault\/branches\/(.+)$/.exec(path))) {
			const h = repo.head(m[1]);
			return h ? ok({ name: m[1], commit: { id: h } }) : err(404);
		}
		if (path === `${R}/tags` && req.method === "POST") {
			repo.tags.set(body.tag_name, body.target);
			return ok({});
		}
		if (path === `${R}/tags`) return ok([...repo.tags].map(([name, sha]) => ({ name, commit: { sha } })));
		if ((m = /^\/repos\/me\/vault\/git\/commits\/(\w+)$/.exec(path))) {
			const c = repo.commits.get(m[1]);
			if (!c) return err(404);
			const parent = c.parents[0] ? repo.commits.get(c.parents[0])!.files : new Map<string, string>();
			const files = [...c.files].filter(([p, s]) => parent.get(p) !== s).map(([p]) => ({ filename: p, status: parent.has(p) ? "modified" : "added" }));
			for (const p of parent.keys()) if (!c.files.has(p)) files.push({ filename: p, status: "removed" });
			return ok({ sha: m[1], commit: { tree: { sha: `t${m[1]}` } }, parents: c.parents.map((sha) => ({ sha })), files });
		}
		if ((m = /^\/repos\/me\/vault\/git\/trees\/t(\w+)$/.exec(path))) {
			const c = repo.commits.get(m[1])!;
			const all = [...c.files].map(([p, sha]) => ({ path: p, mode: "100644", type: "blob", sha, size: repo.blobs.get(sha)!.length }));
			const per = 2; // tiny pages to exercise pagination
			const page = Number(q.get("page") ?? 1);
			const slice = all.slice((page - 1) * per, page * per);
			return ok({ tree: slice, truncated: page * per < all.length, page, total_count: all.length });
		}
		if ((m = /^\/repos\/me\/vault\/git\/blobs\/(\w+)$/.exec(path))) return ok({ content: b64(repo.blobs.get(m[1])!), encoding: "base64" });
		if ((m = /^\/repos\/me\/vault\/contents\/(.+)$/.exec(path)) && req.method === "POST") {
			await repo.apply(body.branch, body.message, [{ op: "create", path: m[1], content: body.content }]);
			return ok({});
		}
		if (path === `${R}/contents` && req.method === "POST") {
			repo.interject?.();
			repo.interject = null;
			const headFiles = repo.commits.get(repo.head(body.branch)!)!.files;
			for (const f of body.files) if (f.operation !== "create" && headFiles.get(f.path) !== f.sha) return err(409, "sha mismatch");
			const parent = repo.head(body.branch)!;
			const sha = await repo.apply(body.branch, body.message, body.files.map((f: any) => ({ op: f.operation, path: f.path, content: f.content })));
			return ok({ commit: { sha, parents: [{ sha: parent }] } });
		}
		if (path === `${R}/commits`) {
			const all = repo.history(repo.head(q.get("sha")!) ?? q.get("sha")!);
			const filePath = q.get("path");
			const filtered = filePath ? all.filter((s) => { const c = repo.commits.get(s)!; const p = c.parents[0] ? repo.commits.get(c.parents[0])!.files.get(filePath) : undefined; return c.files.get(filePath) !== p; }) : all;
			const limit = Number(q.get("limit") ?? 30);
			const page = Number(q.get("page") ?? 1);
			return ok(filtered.slice((page - 1) * limit, page * limit).map((s) => ({ sha: s, commit: { message: repo.commits.get(s)!.message, author: { name: "me", date: repo.commits.get(s)!.date } } })));
		}
		if ((m = /^\/repos\/me\/vault\/raw\/(.+)$/.exec(path))) {
			const c = repo.commits.get(q.get("ref")!);
			const sha = c?.files.get(m[1]);
			return sha ? raw(repo.blobs.get(sha)!) : err(404);
		}
		return err(404, `fake gitea: no route ${req.method} ${path}`);
	};
}

/** Fake GitLab at https://gitlab.test/api/v4, project me/vault. */
export function gitlabTransport(repo: FakeRepo) {
	return async (req: HttpRequest): Promise<HttpResponse> => {
		const u = new URL(req.url);
		const enc = u.pathname.replace(/^\/api\/v4/, "");
		const q = u.searchParams;
		const body = req.body ? JSON.parse(req.body) : undefined;
		const P = "/projects/me%2Fvault";
		if (enc === "/user") return ok({ username: "me" });
		if (enc === P) return ok({ visibility: "private", default_branch: "main", web_url: "https://gitlab.test/me/vault" });
		if (!enc.startsWith(P + "/repository/")) return err(404, `fake gitlab: no route ${enc}`);
		const rest = enc.slice((P + "/repository/").length);
		let m: RegExpExecArray | null;
		if ((m = /^branches\/(.+)$/.exec(rest))) {
			const h = repo.head(decodeURIComponent(m[1]));
			return h ? ok({ commit: { id: h } }) : err(404);
		}
		if (rest === "tags" && req.method === "POST") {
			repo.tags.set(q.get("tag_name")!, q.get("ref")!);
			return ok({});
		}
		if (rest === "tags") return ok([...repo.tags].map(([name, id]) => ({ name, commit: { id } })));
		if (rest === "tree") {
			const c = repo.commits.get(q.get("ref")!);
			if (!c) return err(404);
			const all = [...c.files].map(([p, id]) => ({ id, path: p, name: p.split("/").pop(), type: "blob", mode: "100644" }));
			const per = 2;
			const start = Number(q.get("page_token") ?? 0);
			const next = start + per < all.length ? `<https://gitlab.test/api/v4${P}/repository/tree?ref=${q.get("ref")}&recursive=true&per_page=100&pagination=keyset&page_token=${start + per}>; rel="next"` : "";
			return ok(all.slice(start, start + per), next ? { Link: next } : {});
		}
		if ((m = /^blobs\/(\w+)\/raw$/.exec(rest))) return raw(repo.blobs.get(m[1])!);
		if ((m = /^files\/([^/]+)$/.exec(rest)) && req.method === "HEAD") {
			const ref = q.get("ref")!;
			const p2 = decodeURIComponent(m[1]);
			const last = repo.history(ref).find((sha) => { const c = repo.commits.get(sha)!; const par = c.parents[0] ? repo.commits.get(c.parents[0])!.files.get(p2) : undefined; return c.files.get(p2) !== par; });
			return { status: last ? 200 : 404, json: null, arrayBuffer: new ArrayBuffer(0), headers: last ? { "X-Gitlab-Last-Commit-Id": last } : {} };
		}
		if ((m = /^files\/(.+)\/raw$/.exec(rest))) {
			const sha = repo.commits.get(q.get("ref")!)?.files.get(decodeURIComponent(m[1]));
			return sha ? raw(repo.blobs.get(sha)!) : err(404);
		}
		if ((m = /^files\/(.+)$/.exec(rest)) && req.method === "POST") {
			await repo.apply(body.branch, body.commit_message, [{ op: "create", path: decodeURIComponent(m[1]), content: body.content }]);
			return ok({});
		}
		if (rest === "commits" && req.method === "POST") {
			repo.interject?.();
			repo.interject = null;
			const parent = repo.head(body.branch)!;
			const head = repo.head(body.branch)!;
			for (const a of body.actions) {
				if (!a.last_commit_id) continue;
				const last = repo.history(head).find((sha) => { const c = repo.commits.get(sha)!; const par = c.parents[0] ? repo.commits.get(c.parents[0])!.files.get(a.file_path) : undefined; return c.files.get(a.file_path) !== par; });
				if (last !== a.last_commit_id) return err(400, "You are attempting to update a file that has changed since you started editing it.");
			}
			try {
				const id = await repo.apply(body.branch, body.commit_message, body.actions.map((a: any) => ({ op: a.action, path: a.file_path, content: a.content })));
				return ok({ id, parent_ids: [parent] });
			} catch (e) {
				return err(400, String(e));
			}
		}
		if (rest === "merge_base") {
			const [a, b] = q.getAll("refs[]");
			if (!repo.commits.has(a) || !repo.commits.has(b)) return err(404);
			const ha = repo.history(a);
			const mb = repo.history(b).find((x) => ha.includes(x));
			return mb ? ok({ id: mb }) : err(400);
		}
		if (rest === "commits") {
			const all = repo.history(repo.head(q.get("ref_name")!)!);
			return ok(all.slice(0, Number(q.get("per_page") ?? 30)).map((s) => ({ id: s, message: repo.commits.get(s)!.message, author_name: "me", authored_date: repo.commits.get(s)!.date })));
		}
		if ((m = /^commits\/(\w+)\/diff$/.exec(rest))) {
			const c = repo.commits.get(m[1])!;
			const parent = c.parents[0] ? repo.commits.get(c.parents[0])!.files : new Map<string, string>();
			const out: any[] = [];
			for (const [p, s] of c.files) if (parent.get(p) !== s) out.push({ new_path: p, old_path: p, new_file: !parent.has(p), deleted_file: false });
			for (const p of parent.keys()) if (!c.files.has(p)) out.push({ new_path: p, old_path: p, deleted_file: true });
			return ok(out);
		}
		if ((m = /^commits\/(\w+)$/.exec(rest))) return ok({ id: m[1], parent_ids: repo.commits.get(m[1])!.parents });
		return err(404, `fake gitlab: no route ${rest}`);
	};
}

/** Parse our multipart body (the format produced by buildMultipart). */
function parseMultipart(body: ArrayBuffer, contentType: string): { name: string; value: Uint8Array; isFile: boolean }[] {
	const boundary = /boundary=(.+)$/.exec(contentType)![1];
	const bytes = new Uint8Array(body);
	const text = new TextDecoder("latin1").decode(bytes);
	const out: { name: string; value: Uint8Array; isFile: boolean }[] = [];
	let pos = text.indexOf(`--${boundary}`);
	while (pos >= 0) {
		const headStart = pos + boundary.length + 4;
		if (text.startsWith("--", pos + boundary.length + 2)) break;
		const headEnd = text.indexOf("\r\n\r\n", headStart);
		const head = new TextDecoder().decode(bytes.slice(headStart, headEnd));
		const next = text.indexOf(`\r\n--${boundary}`, headEnd + 4);
		out.push({ name: /name="([^"]*)"/.exec(head)![1], value: bytes.slice(headEnd + 4, next), isFile: head.includes("filename=") });
		pos = next + 2;
	}
	return out;
}

/** Fake Bitbucket Cloud at https://bb.test/2.0, repo me/vault. No blob hashes exposed, like the real API. */
export function bitbucketTransport(repo: FakeRepo) {
	const calls = { raw: 0 };
	const transport = async (req: HttpRequest): Promise<HttpResponse> => {
		const u = new URL(req.url);
		const path = u.pathname.replace(/^\/2\.0/, "");
		const q = u.searchParams;
		const R = "/repositories/me/vault";
		let m: RegExpExecArray | null;
		if (path === "/user") return ok({ username: "me" });
		if (path === R && req.method === "GET") return ok({ is_private: true, mainbranch: { name: "main" }, links: { html: { href: "https://bitbucket.test/me/vault" } } });
		if ((m = /^\/repositories\/me\/vault\/refs\/branches\/(.+)$/.exec(path))) {
			const h = repo.head(decodeURIComponent(m[1]));
			return h ? ok({ target: { hash: h } }) : err(404);
		}
		if (path === `${R}/refs/tags` && req.method === "POST") {
			const b = JSON.parse(req.body as string);
			repo.tags.set(b.name, b.target.hash);
			return ok({});
		}
		if (path === `${R}/refs/tags`) return ok({ values: [...repo.tags].map(([name, hash]) => ({ name, target: { hash } })) });
		if (path === `${R}/src` && req.method === "POST") {
			repo.interject?.();
			repo.interject = null;
			const parts = parseMultipart(req.body as ArrayBuffer, req.contentType!);
			const field = (n: string) => new TextDecoder().decode(parts.find((p) => p.name === n)?.value ?? new Uint8Array());
			const branch = field("branch");
			const parents = field("parents");
			const head = repo.head(branch);
			if (parents && head && parents !== head) return err(409, "parent is not the branch tip");
			const ops: { op: string; path: string; content?: string }[] = [];
			const files = head ? repo.commits.get(head)!.files : new Map<string, string>();
			for (const p of parts) {
				if (p.name === "files") ops.push({ op: "delete", path: new TextDecoder().decode(p.value) });
				else if (p.isFile) {
					const fp = p.name.replace(/^\//, "");
					ops.push({ op: files.has(fp) ? "update" : "create", path: fp, content: Buffer.from(p.value).toString("base64") });
				}
			}
			await repo.apply(branch, field("message"), ops);
			return { status: 201, json: null, arrayBuffer: new ArrayBuffer(0), headers: {} };
		}
		if ((m = /^\/repositories\/me\/vault\/src\/(\w+)\/(.*)$/.exec(path))) {
			const c = repo.commits.get(m[1]);
			if (!c) return err(404);
			const sub = decodeURIComponent(m[2]);
			const sha = c.files.get(sub);
			if (sha) {
				calls.raw++;
				return raw(repo.blobs.get(sha)!);
			}
			const dir = sub.replace(/\/$/, "");
			const prefix = dir ? dir + "/" : "";
			const entries = new Map<string, { type: string; path: string; size?: number }>();
			for (const [p, s] of c.files) {
				if (!p.startsWith(prefix)) continue;
				const rest = p.slice(prefix.length);
				const i = rest.indexOf("/");
				if (i < 0) entries.set(p, { type: "commit_file", path: p, size: repo.blobs.get(s)!.length });
				else entries.set(prefix + rest.slice(0, i), { type: "commit_directory", path: prefix + rest.slice(0, i) });
			}
			if (!entries.size && dir) return err(404);
			return ok({ values: [...entries.values()] });
		}
		if ((m = /^\/repositories\/me\/vault\/diffstat\/(\w+)\.\.(\w+)$/.exec(path))) {
			const a = repo.commits.get(m[1])!.files;
			const b = repo.commits.get(m[2])!.files;
			const values: unknown[] = [];
			for (const p of new Set([...a.keys(), ...b.keys()])) if (a.get(p) !== b.get(p)) values.push({ status: "modified", old: b.has(p) ? { path: p } : null, new: a.has(p) ? { path: p } : null });
			return ok({ values });
		}
		if ((m = /^\/repositories\/me\/vault\/diffstat\/(\w+)$/.exec(path))) {
			const c = repo.commits.get(m[1])!;
			const par = c.parents[0] ? repo.commits.get(c.parents[0])!.files : new Map<string, string>();
			const values: unknown[] = [];
			for (const p of new Set([...c.files.keys(), ...par.keys()])) {
				if (c.files.get(p) === par.get(p)) continue;
				values.push({ status: !c.files.has(p) ? "removed" : !par.has(p) ? "added" : "modified", old: par.has(p) ? { path: p } : null, new: c.files.has(p) ? { path: p } : null });
			}
			return ok({ values });
		}
		if ((m = /^\/repositories\/me\/vault\/commit\/(\w+)$/.exec(path))) {
			const c = repo.commits.get(m[1]);
			return c ? ok({ hash: m[1], message: c.message, date: c.date, parents: c.parents.map((hash) => ({ hash })) }) : err(404);
		}
		if ((m = /^\/repositories\/me\/vault\/merge-base\/(\w+)\.\.(\w+)$/.exec(path))) {
			if (!repo.commits.has(m[1]) || !repo.commits.has(m[2])) return err(404);
			const ha = repo.history(m[1]);
			const mb = repo.history(m[2]).find((x) => ha.includes(x));
			return mb ? ok({ hash: mb }) : err(404);
		}
		if ((m = /^\/repositories\/me\/vault\/commits\/(.+)$/.exec(path))) {
			const head = repo.head(decodeURIComponent(m[1])) ?? m[1];
			const all = repo.history(head);
			const fp = q.get("path");
			const list = fp ? all.filter((sha) => { const c = repo.commits.get(sha)!; const par = c.parents[0] ? repo.commits.get(c.parents[0])!.files.get(fp) : undefined; return c.files.get(fp) !== par; }) : all;
			return ok({ values: list.slice(0, Number(q.get("pagelen") ?? 30)).map((sha) => ({ hash: sha, message: repo.commits.get(sha)!.message, date: repo.commits.get(sha)!.date, author: { raw: "me" } })) });
		}
		return err(404, `fake bitbucket: no route ${req.method} ${path}`);
	};
	return { transport, calls };
}
