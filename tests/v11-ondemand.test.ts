import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, device } from "./support/fakes.ts";

test("on demand: big files are listed but not downloaded; pinning downloads and keeps them synced", async () => {
	const gh = new FakeGitHub();
	const a = device("Mac", gh);
	const phone = device("Phone", gh);
	a.fs.put("img/huge.png", "x".repeat(4000));
	a.fs.put("note.md", "n\n");
	await a.sync();

	let pinned: string[] = [];
	phone.host.deviceScope = () => ({ include: [], exclude: [], maxDownloadMB: 0.001, pinned });
	await phone.sync();
	assert.ok(!phone.fs.files.has("img/huge.png"));
	assert.deepEqual(Object.keys(phone.host.state.remoteOnly), ["img/huge.png"]);
	assert.equal(phone.host.state.remoteOnly["img/huge.png"].size, 4000);

	pinned = ["img/huge.png"];
	await phone.sync();
	assert.equal(phone.fs.text("img/huge.png"), "x".repeat(4000), "downloaded on demand");
	assert.deepEqual(phone.host.state.remoteOnly, {});

	// Kept in sync afterwards, and Free up space leaves it alone.
	a.fs.put("img/huge.png", "y".repeat(4000));
	await a.sync();
	await phone.sync();
	assert.equal(phone.fs.text("img/huge.png"), "y".repeat(4000));
	const plan = await phone.engine.freeUpSpace(async () => true);
	assert.deepEqual(plan.files, []);
});

test("changing this device's scope triggers a full comparison even when nothing else changed", async () => {
	const gh = new FakeGitHub();
	const a = device("Mac", gh);
	a.fs.put("Work/w.md", "w\n");
	a.fs.put("Personal/p.md", "p\n");
	await a.sync();
	const phone = device("Phone", gh);
	let include = ["/Work/"];
	phone.host.deviceScope = () => ({ include, exclude: [], maxDownloadMB: 0 });
	await phone.sync();
	assert.ok(!phone.fs.files.has("Personal/p.md"));
	assert.equal((await phone.sync()).upToDate, true);
	include = ["/Work/", "/Personal/"];
	const r = await phone.sync();
	assert.equal(r.upToDate, false);
	assert.equal(phone.fs.text("Personal/p.md"), "p\n");
});

test("deleting a big file on a size-limited device reaches the repository", async () => {
	const gh = new FakeGitHub();
	const a = device("Mac", gh);
	const phone = device("Phone", gh);
	a.fs.put("big.pdf", "x".repeat(4000));
	await a.sync();
	// The phone had it (pinned), then the limit applies again and the user deletes it.
	let pinned = ["big.pdf"];
	phone.host.deviceScope = () => ({ include: [], exclude: [], maxDownloadMB: 0.001, pinned });
	await phone.sync();
	assert.ok(phone.fs.files.has("big.pdf"));
	pinned = [];
	phone.fs.files.delete("big.pdf");
	await phone.sync();
	assert.ok(!gh.headFiles().has("big.pdf"), "deletion uploaded, not mistaken for 'available on demand'");
	assert.deepEqual(phone.host.state.remoteOnly, {});
});
