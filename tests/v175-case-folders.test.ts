import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeGitHub, device } from "./support/fakes.ts";

for (const caseInsensitive of [false, true]) {
	test(`a folder renamed by letter case elsewhere is renamed here in one sync (case-insensitive disk: ${caseInsensitive})`, async () => {
		const gh = new FakeGitHub();
		const a = device("A", gh);
		const b = device("B", gh);
		b.fs.caseInsensitive = caseInsensitive;
		a.fs.put("Notes/a.md", "a\n");
		a.fs.put("Notes/Sub/b.md", "b\n");
		await a.sync();
		await b.sync();
		for (const p of ["Notes/a.md", "Notes/Sub/b.md"]) {
			a.fs.files.set("notes" + p.slice(5), a.fs.files.get(p)!);
			a.fs.files.delete(p);
		}
		await a.sync();
		const rb = await b.sync();
		assert.deepEqual(rb.errors, []);
		assert.deepEqual([...b.fs.files.keys()].sort(), ["notes/Sub/b.md", "notes/a.md"]);
		assert.deepEqual(b.fs.trash, [], "nothing trashed, not even the old folder");
		assert.equal(rb.renamed.length, 2);
		assert.equal((await b.sync()).upToDate, true);
		assert.equal((await a.sync()).upToDate, true, "nothing renamed back");
	});
}

test("folder renamed by case while this device has another file in it: files renamed one by one, nothing lost", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("Notes/a.md", "a\n");
	await a.sync();
	await b.sync();
	b.fs.put("Notes/only-here.md", "new on B\n");
	a.fs.files.set("notes/a.md", a.fs.files.get("Notes/a.md")!);
	a.fs.files.delete("Notes/a.md");
	await a.sync();
	const rb = await b.sync();
	assert.deepEqual(rb.errors, []);
	assert.ok(b.fs.files.has("notes/a.md"));
	assert.equal(b.fs.text("Notes/only-here.md"), "new on B\n", "the folder isn't renamed under a file it doesn't know");
	assert.equal(gh.headFiles().get("Notes/only-here.md"), "new on B\n");
});
