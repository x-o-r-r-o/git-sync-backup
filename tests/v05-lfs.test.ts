import { test } from "node:test";
import assert from "node:assert/strict";
import { Codec } from "../src/codec.ts";
import type { HttpRequest, HttpResponse } from "../src/http.ts";
import { LfsLayer, parsePointer } from "../src/lfs.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

function fakeLfs() {
	const store = new Map<string, Uint8Array>();
	const calls = { uploads: 0, downloads: 0 };
	const ok = (json: unknown): HttpResponse => ({ status: 200, json, arrayBuffer: new ArrayBuffer(0), headers: {} });
	const transport = async (req: HttpRequest): Promise<HttpResponse> => {
		if (req.url.endsWith("/info/lfs/objects/batch")) {
			assert.match(req.headers.Authorization, /^Basic /);
			const body = JSON.parse(req.body as string);
			const { oid, size } = body.objects[0];
			if (body.operation === "upload") {
				return ok({ objects: [{ oid, size, actions: store.has(oid) ? undefined : { upload: { href: `https://lfs.test/${oid}`, header: { "X-Up": "1" } } } }] });
			}
			return ok({ objects: [{ oid, size, actions: store.has(oid) ? { download: { href: `https://lfs.test/${oid}` } } : undefined }] });
		}
		const oid = req.url.split("/").pop()!;
		if (req.method === "PUT") {
			calls.uploads++;
			store.set(oid, new Uint8Array(req.body as ArrayBuffer));
			return ok({});
		}
		calls.downloads++;
		const data = store.get(oid)!;
		return { status: 200, json: null, arrayBuffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer, headers: {} };
	};
	return { store, calls, transport };
}

test("LFS: large files stored as pointers; other devices get the real bytes", async () => {
	const gh = new FakeGitHub() as any;
	gh.gitUrl = () => "https://github.test/me/vault.git";
	gh.authHeader = () => "Basic dGVzdA==";
	gh.label = "GitHub";
	const lfs = fakeLfs();
	const a = device("A", gh);
	const b = device("B", gh);
	a.host.codec = () => new Codec([new LfsLayer(gh, 100, lfs.transport)]);
	b.host.codec = () => new Codec([new LfsLayer(gh, 0, lfs.transport)]); // B doesn't upload via LFS, but reads pointers

	const big = "V".repeat(5000);
	a.fs.put("video/clip.mp4", big);
	a.fs.put("small.md", "tiny\n");
	await a.sync();
	const stored = gh.rawFiles();
	assert.ok(parsePointer(stored.get("video/clip.mp4").buffer), "repo holds a pointer");
	assert.equal(new TextDecoder().decode(stored.get("small.md")), "tiny\n", "small files unchanged");
	assert.equal(lfs.calls.uploads, 1);
	assert.equal((await a.sync()).upToDate, true, "pointer sha matches on rescan");

	await b.sync();
	assert.equal(b.fs.text("video/clip.mp4"), big, "real bytes, not the pointer");
	assert.equal(lfs.calls.downloads, 1);
	assert.equal((await b.sync()).upToDate, true);

	// Same content again elsewhere: the host already has the object, nothing re-uploaded.
	a.fs.put("copy/clip.mp4", big);
	await a.sync();
	assert.equal(lfs.calls.uploads, 1);
});

test("LFS: turning it on later converts big files on upload without conflicts", async () => {
	const gh = new FakeGitHub() as any;
	gh.gitUrl = () => "https://github.test/me/vault.git";
	gh.authHeader = () => "Basic dGVzdA==";
	gh.label = "GitHub";
	const lfs = fakeLfs();
	const a = device("A", gh);
	a.fs.put("img.png", "P".repeat(3000));
	await a.sync();
	assert.ok(!parsePointer(gh.rawFiles().get("img.png").buffer));
	a.host.codec = () => new Codec([new LfsLayer(gh, 1000, lfs.transport)]);
	const r = await a.sync();
	assert.equal(r.conflictCopies.length, 0);
	assert.ok(parsePointer(gh.rawFiles().get("img.png").buffer), "converted to LFS");
	assert.equal(a.fs.text("img.png"), "P".repeat(3000));
});
