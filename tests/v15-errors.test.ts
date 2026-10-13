// Translated sync errors: coded errors keep an English message (log, diagnostics) and are shown in the
// interface language; host errors are explained by HTTP status; the status panel picks advice by code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addSkip, codedRemoteError, friendlyError, localizeError, RemoteError, skippedLines, SyncError } from "../src/errors.ts";
import type { SkipSink } from "../src/errors.ts";
import { NotFastForward } from "../src/remote.ts";
import { GitHubError } from "../src/github.ts";
import { IncompleteDownload } from "../src/bitbucket.ts";
import { EncryptionLocked, EncryptionMismatch } from "../src/encryption.ts";
import { SyncCancelled } from "../src/sync.ts";
import { t } from "../src/i18n.ts";
import { FakeGitHub, device } from "./support/fakes.ts";

/** Runs `fn` with Obsidian's interface language set to `lang`. */
function inLanguage<T>(lang: string, fn: () => T): T {
	const g = globalThis as any;
	const saved = g.window;
	g.window = { ...(saved ?? {}), localStorage: { getItem: (k: string) => (k === "language" ? lang : null) } };
	try {
		return fn();
	} finally {
		g.window = saved;
	}
}

test("SyncError: English message, translated text with its parameters", () => {
	const e = new SyncError("repoNotFound", { repo: "me/vault" });
	assert.equal(e.message, "Repository me/vault not found or the token cannot access it.");
	assert.equal(e.code, "repoNotFound");
	assert.equal(inLanguage("en", () => localizeError(e)), e.message);
	const zh = inLanguage("zh", () => localizeError(e));
	assert.equal(zh, "找不到仓库 me/vault，或令牌无法访问它。");
	// The message stays English whatever the interface language (logs and bug reports).
	const de = inLanguage("de", () => new SyncError("branchMissing", { branch: "main", repo: "me/vault" }));
	assert.match(de.message, /^The branch "main" was not found in me\/vault\./);
	assert.match(inLanguage("de", () => localizeError(de)), /^Der Branch „main“ wurde in me\/vault nicht gefunden\./);
});

test("SyncError subclasses keep their English messages and types", () => {
	const inc = new IncompleteDownload("dir/b.md", 9, 18);
	assert.ok(inc instanceof SyncError && inc instanceof IncompleteDownload);
	assert.equal(inc.message, '"dir/b.md" couldn\'t be downloaded completely from Bitbucket (got 9 of 18 bytes). Try syncing again.');
	assert.match(inLanguage("ja", () => localizeError(inc)), /「dir\/b\.md」を Bitbucket から完全にダウンロードできませんでした（18 バイト中 9 バイトを受信）/);
	assert.match(new EncryptionLocked().message, /end-to-end encrypted/);
	assert.match(new EncryptionMismatch().message, /different passphrase/);
	assert.equal(new NotFastForward().message, "The branch moved while syncing (another device pushed).");
	const c = new SyncCancelled("guardCancelled");
	assert.ok(c instanceof SyncCancelled && c instanceof SyncError);
	assert.equal(c.message, "Sync cancelled by delete guard.");
	assert.equal(new SyncCancelled().message, "Cancelled.");
	assert.equal(inLanguage("fr", () => localizeError(new SyncCancelled("resetCancelled"))), "Réinitialisation annulée.");
});

test("localizeError: RemoteError is explained by its HTTP status, with the host's name", () => {
	const at = (status: number, lang = "en") => inLanguage(lang, () => localizeError(new RemoteError(`raw ${status} (GET /x)`, status, { host: "GitLab" })));
	assert.equal(at(401), "GitLab token is invalid or expired.");
	assert.match(at(403), /^GitLab refused access \(HTTP 403\)/);
	assert.match(at(404), /^GitLab couldn't find the repository, branch or file \(HTTP 404\)/);
	assert.match(at(409), /^GitLab reported a conflict \(HTTP 409\)/);
	assert.match(at(412), /^GitLab reported a conflict \(HTTP 412\)/);
	assert.match(at(413), /^GitLab refused a file because it is too large/);
	assert.equal(at(429), "GitLab rate limit hit. Try again in a minute.");
	assert.match(at(500), /^GitLab is having problems \(HTTP 500\)/);
	assert.match(at(503), /\(HTTP 503\)/);
	assert.equal(at(0), "Network error talking to GitLab");
	assert.equal(at(401, "ko"), "GitLab 토큰이 잘못되었거나 만료되었습니다.");
	assert.match(at(500, "es"), /^GitLab tiene problemas \(HTTP 500\)/);
	// A status that says nothing specific keeps the host's own message.
	assert.equal(at(422), "raw 422 (GET /x)");
	// Without a host on the error, the caller's host (or a generic name) is used.
	const bare = new RemoteError("x", 401);
	assert.equal(inLanguage("en", () => localizeError(bare, "Gitea")), "Gitea token is invalid or expired.");
	assert.equal(inLanguage("en", () => localizeError(bare)), "the repository host token is invalid or expired.");
});

test("localizeError: coded host errors, network failures and unknown errors", () => {
	const rl = codedRemoteError((m, s, i) => new GitHubError(m, s, i), "rateLimitMin", 403, "GitHub", { min: 7 });
	assert.ok(rl instanceof GitHubError && rl instanceof RemoteError);
	assert.equal(rl.status, 403);
	assert.equal(rl.message, "GitHub rate limit hit. Try again in 7 min.");
	assert.equal(inLanguage("pt", () => localizeError(rl)), "Limite de requisições do GitHub atingido. Tente novamente em 7 min.");
	const noTok = codedRemoteError((m, s, i) => new GitHubError(m, s, i), "noToken", 401, "GitHub");
	assert.equal(noTok.message, "No GitHub token set. Add one in the plugin settings.");
	// Transport failures (no HTTP status) read as network errors.
	assert.equal(inLanguage("en", () => localizeError(new TypeError("Failed to fetch"), "GitHub")), "Network error talking to GitHub");
	assert.equal(inLanguage("en", () => localizeError(new Error("net::ERR_INTERNET_DISCONNECTED"), "GitHub")), "Network error talking to GitHub");
	// Anything else is shown as it is.
	assert.equal(localizeError(new Error("something odd")), "something odd");
	assert.equal(localizeError("plain text"), "plain text");
	assert.equal(localizeError(42), "42");
});

test("friendlyError: coded errors pick the right title, hint and action", () => {
	inLanguage("en", () => {
		const enc = friendlyError(new EncryptionLocked(), "GitHub");
		assert.equal(enc.title, t("h.encrypted"));
		assert.equal(enc.hint, t("h.encryptedHint"));
		assert.equal(enc.action, "encryption");
		assert.equal(friendlyError(new EncryptionMismatch()).title, t("h.otherKey"));
		const bad = friendlyError(new RemoteError("Bad credentials (GET /user)", 401, { host: "GitLab" }), "GitHub");
		assert.equal(bad.title, t("h.badToken", { host: "GitLab" }), "the host named on the error wins");
		assert.equal(bad.action, "settings");
		assert.equal(friendlyError(new RemoteError("Not Found (GET /repos/a/b)", 404), "GitHub").title, t("h.repoMissing"));
		assert.equal(friendlyError(new SyncError("repoNotFound", { repo: "a/b" })).title, t("h.repoMissing"));
		assert.equal(friendlyError(new NotFastForward(), "GitHub").title, t("h.busy", { host: "GitHub" }));
		assert.equal(friendlyError(new RemoteError("x", 0, { host: "Gitea" })).title, t("h.offline", { host: "Gitea" }));
		const rl = friendlyError(codedRemoteError((m, s, i) => new GitHubError(m, s, i), "secondaryRateLimit", 403, "GitHub"));
		assert.equal(rl.title, t("h.rateLimit", { host: "GitHub" }));
		assert.equal(rl.action, "none");
		const noTok = friendlyError(new SyncError("noToken", { host: "Bitbucket" }), "Bitbucket");
		assert.equal(noTok.title, t("h.notConnected"));
		const branch = friendlyError(new SyncError("branchMissing", { branch: "main", repo: "a/b" }));
		assert.equal(branch.title, t("h.branchMissing"));
		assert.match(branch.hint, /The branch "main" was not found in a\/b/);
		assert.equal(friendlyError(new SyncError("restorePullOnly")).title, t("h.pullOnly"));
		// A coded error without specific advice: generic title, translated hint, retry.
		const other = friendlyError(new SyncError("lfsMissing", { path: "v.mp4" }));
		assert.equal(other.title, t("h.failed"));
		assert.equal(other.hint, "v.mp4: large file is missing from the host's LFS storage");
		assert.equal(other.action, "retry");
		const server = friendlyError(new RemoteError("oops", 502, { host: "GitLab" }));
		assert.equal(server.title, t("h.failed"));
		assert.match(server.hint, /GitLab is having problems \(HTTP 502\)/);
	});
	// Translated.
	inLanguage("zh", () => {
		const f = friendlyError(new SyncError("lfsCorrupt", { path: "a.bin" }));
		assert.equal(f.title, t("h.failed"));
		assert.equal(f.hint, "a.bin：大文件下载已损坏");
		assert.equal(friendlyError(new EncryptionLocked()).title, t("h.encrypted"));
	});
});

test("friendlyError: messages without a code still match by substring (older errors, strings)", () => {
	inLanguage("en", () => {
		assert.equal(friendlyError("GitHub rate limit hit. Try again in 3 min.", "GitHub").title, t("h.rateLimit", { host: "GitHub" }));
		assert.equal(friendlyError("No token set. Add one in the plugin settings.").title, t("h.notConnected"));
		assert.equal(friendlyError(new Error("request timed out"), "GitHub").title, t("h.offline", { host: "GitHub" }));
		assert.equal(friendlyError(new Error("This repository is end-to-end encrypted.")).action, "encryption");
		const unknown = friendlyError(new Error("Plugin registry is not a list"));
		assert.equal(unknown.title, t("h.failed"));
		assert.equal(unknown.hint, "Plugin registry is not a list");
	});
});

test("skipped paths: English lines for the log, translated lines for display", () => {
	const sink: SkipSink = { skipped: [] };
	addSkip(sink, "big.bin", "remoteTooLarge", { mb: 5 });
	addSkip(sink, "a.md", "conflictKept", { error: "übersetzt" }, { error: "English error" });
	assert.deepEqual(sink.skipped, ["big.bin (remote file larger than 5 MB)", "a.md (conflict kept for the next sync: English error)"]);
	assert.deepEqual(inLanguage("en", () => skippedLines(sink.skipped, sink.skipNotes)), ["big.bin (remote file larger than 5 MB)", "a.md (conflict kept for the next sync: übersetzt)"]);
	assert.deepEqual(inLanguage("de", () => skippedLines(sink.skipped, sink.skipNotes)), ["big.bin (Datei im Repository größer als 5 MB)", "a.md (Konflikt für die nächste Synchronisation behalten: übersetzt)"]);
	// Reports without notes (or out of step with them) show the English lines unchanged.
	assert.deepEqual(skippedLines(["x (y)"]), ["x (y)"]);
	assert.deepEqual(skippedLines(["x (y)", "z (w)"], sink.skipNotes!.slice(0, 1)), ["x (y)", "z (w)"]);
});

test("sync report: skipped entries carry translatable notes that match the English lines", async () => {
	const gh = new FakeGitHub();
	const a = device("A", gh);
	const b = device("B", gh);
	a.fs.put("ok.md", "ok\n");
	await a.sync();
	const tr = gh.trees.get(gh.commits.get(gh.refs.get("main")!)!.tree)!;
	const x = await gh.createBlob(Buffer.from("x").toString("base64"));
	tr.set("notes//double.md", { sha: x, mode: "100644" });
	const r = await b.sync();
	assert.ok(r.skipped.includes("notes//double.md (unsafe path)"));
	assert.equal(r.skipNotes?.length, r.skipped.length);
	assert.deepEqual(r.skipNotes?.find((n) => n.path === "notes//double.md"), { path: "notes//double.md", code: "unsafePath", params: {} });
	assert.ok(inLanguage("fr", () => skippedLines(r.skipped, r.skipNotes)).includes("notes//double.md (chemin non sûr)"));
});
