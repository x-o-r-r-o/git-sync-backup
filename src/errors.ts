// Typed errors that can be shown in the interface language. Their `message` stays English (for the
// log and "Copy diagnostics", which are for bug reports); `localizeError` gives the translated text.

import { t, tEn } from "./i18n.ts";
import type { Key } from "./i18n.ts";
import { errMsg } from "./util.ts";

export type ErrParams = Record<string, string | number>;

/** Error codes: the catalog keys "err.<code>". */
export type ErrCode = { [K in Key]: K extends `err.${infer C}` ? C : never }[Key];
/** Reasons a path was skipped: the catalog keys "skip.<code>". */
export type SkipCode = { [K in Key]: K extends `skip.${infer C}` ? C : never }[Key];

const errKey = (code: ErrCode) => `err.${code}` as Key;
const skipKey = (code: SkipCode) => `skip.${code}` as Key;

/** An error with a translatable code. `message` is the English text of that code. */
export class SyncError extends Error {
	code: ErrCode;
	params: ErrParams;
	constructor(code: ErrCode, params: ErrParams = {}) {
		super(tEn(errKey(code), params));
		this.code = code;
		this.params = params;
	}
}

export interface RemoteErrorInfo {
	/** Host label ("GitHub", "GitLab"…) for the translated message. */
	host?: string;
	/** A specific translatable reason (otherwise the HTTP status decides). */
	code?: ErrCode;
	params?: ErrParams;
}

/** A failed request to a git host, with its HTTP status (0: network failure). */
export class RemoteError extends Error {
	status: number;
	host?: string;
	code?: ErrCode;
	params: ErrParams;
	constructor(message: string, status: number, info: RemoteErrorInfo = {}) {
		super(message);
		this.status = status;
		this.host = info.host;
		this.code = info.code;
		this.params = info.params ?? {};
	}
}

/** A RemoteError whose English message comes from `code` (params get `host` added). */
export function codedRemoteError<T extends RemoteError>(
	make: (message: string, status: number, info: RemoteErrorInfo) => T,
	code: ErrCode,
	status: number,
	host: string,
	params: ErrParams = {},
): T {
	const all = { host, ...params };
	return make(tEn(errKey(code), all), status, { host, code, params: all });
}

/** Network failures thrown by fetch/requestUrl/Node (not HTTP errors). */
export function looksLikeNetworkError(msg: string): boolean {
	const m = msg.toLowerCase();
	return (
		m.includes("network") ||
		m.includes("failed to fetch") ||
		m.includes("err_") ||
		m.includes("offline") ||
		m.includes("timed out") ||
		m.includes("timeout") ||
		/\b(enotfound|econnrefused|econnreset|eai_again|etimedout|ehostunreach|enetunreach)\b/.test(m)
	);
}

/** Translatable code for a host's HTTP status, or null when the status says nothing useful. */
export function statusCode(status: number): ErrCode | null {
	if (status === 0) return "network";
	if (status === 401) return "badToken";
	if (status === 403) return "forbidden";
	if (status === 404) return "notFound";
	if (status === 409 || status === 412) return "conflict";
	if (status === 413) return "tooLarge";
	if (status === 429) return "rateLimit";
	if (status >= 500) return "server";
	return null;
}

/** The text to show the user for an error, in the interface language. */
export function localizeError(e: unknown, host?: string): string {
	if (e instanceof SyncError) return t(errKey(e.code), e.params);
	const where = (e instanceof RemoteError && e.host) || host || t("err.someHost");
	if (e instanceof RemoteError) {
		if (e.code) return t(errKey(e.code), { host: where, ...e.params });
		const code = statusCode(e.status);
		if (code) return t(errKey(code), { host: where, status: e.status });
		return errMsg(e);
	}
	const msg = errMsg(e);
	if (looksLikeNetworkError(msg)) return t("err.network", { host: where });
	return msg;
}

// ---- skipped paths ----

/** Why a path was skipped in a sync, for display in the interface language. */
export interface SkipNote {
	path: string;
	code: SkipCode;
	params: ErrParams;
}

/** Where skipped paths are collected: English lines (log, tests) plus their translatable notes. */
export interface SkipSink {
	skipped: string[];
	skipNotes?: SkipNote[];
}

/**
 * Records a skipped path. `params` is used for display; `enParams` (default: the same) for the English
 * line, e.g. when a parameter is an error message that is shown translated.
 */
export function addSkip(sink: SkipSink, path: string, code: SkipCode, params: ErrParams = {}, enParams: ErrParams = params): void {
	sink.skipped.push(`${path} (${tEn(skipKey(code), enParams)})`);
	(sink.skipNotes ??= []).push({ path, code, params });
}

/** The skipped list to show: translated when the notes match the English lines, else the English lines. */
export function skippedLines(skipped: string[], notes?: SkipNote[]): string[] {
	if (!notes || notes.length !== skipped.length) return skipped;
	return notes.map((n) => `${n.path} (${t(skipKey(n.code), n.params)})`);
}

// ---- status panel advice ----

export interface FriendlyError {
	title: string;
	hint: string;
	action: "settings" | "retry" | "none" | "encryption";
}

/** Error codes that point at the same advice in the status panel. */
const ADVICE: Partial<Record<ErrCode, "notConnected" | "badToken" | "repoMissing" | "rateLimit" | "busy" | "offline" | "encrypted" | "otherKey" | "pullOnly" | "branchMissing">> = {
	noToken: "notConnected",
	badToken: "badToken",
	repoNotFound: "repoMissing",
	notFound: "repoMissing",
	rateLimit: "rateLimit",
	rateLimitMin: "rateLimit",
	secondaryRateLimit: "rateLimit",
	branchMoved: "busy",
	restoreRaced: "busy",
	conflict: "busy",
	network: "offline",
	encLocked: "encrypted",
	encMismatch: "otherKey",
	overwritePullOnly: "pullOnly",
	restorePullOnly: "pullOnly",
	branchMissing: "branchMissing",
};

function advice(kind: NonNullable<(typeof ADVICE)[ErrCode]>, host: string, hint: string): FriendlyError {
	switch (kind) {
		case "notConnected":
			return { title: t("h.notConnected"), hint: t("h.notConnectedHint", { host }), action: "settings" };
		case "badToken":
			return { title: t("h.badToken", { host }), hint: t("h.badTokenHint"), action: "settings" };
		case "repoMissing":
			return { title: t("h.repoMissing"), hint: t("h.repoMissingHint"), action: "settings" };
		case "rateLimit":
			return { title: t("h.rateLimit", { host }), hint: t("h.rateLimitHint", { host }), action: "none" };
		case "busy":
			return { title: t("h.busy", { host }), hint: t("h.busyHint"), action: "retry" };
		case "offline":
			return { title: t("h.offline", { host }), hint: t("h.offlineHint"), action: "retry" };
		case "encrypted":
			return { title: t("h.encrypted"), hint: t("h.encryptedHint"), action: "encryption" };
		case "otherKey":
			return { title: t("h.otherKey"), hint: t("h.otherKeyHint"), action: "encryption" };
		case "pullOnly":
			return { title: t("h.pullOnly"), hint: t("h.pullOnlyHint"), action: "settings" };
		case "branchMissing":
			return { title: t("h.branchMissing"), hint, action: "settings" };
	}
}

/**
 * Turns an error (or, from older callers, its message) into plain language with a suggested fix.
 * Coded errors (SyncError, RemoteError with a code or HTTP status) are matched by code; anything else
 * falls back to matching the English message.
 */
export function friendlyError(err: unknown, host = t("err.someHost")): FriendlyError {
	const shown = localizeError(err, host);
	const code = err instanceof SyncError ? err.code : err instanceof RemoteError ? (err.code ?? statusCode(err.status)) : null;
	if (err instanceof RemoteError && err.host) host = err.host;
	if (code) {
		const kind = ADVICE[code];
		if (kind) return advice(kind, host, shown);
		return { title: t("h.failed"), hint: shown, action: "retry" };
	}
	const msg = typeof err === "string" ? err : errMsg(err);
	const m = msg.toLowerCase();
	if (/no (\w+ )?token/.test(m)) return advice("notConnected", host, shown);
	if (m.includes("invalid or expired") || m.includes("401")) return advice("badToken", host, shown);
	if (m.includes("not found or the token cannot access") || (m.includes("not found") && m.includes("repos"))) return advice("repoMissing", host, shown);
	if (m.includes("rate limit")) return advice("rateLimit", host, shown);
	if (m.includes("outdated branch state") || m.includes("another device pushed")) return advice("busy", host, shown);
	if (looksLikeNetworkError(m)) return advice("offline", host, shown);
	if (m.includes("end-to-end encrypted")) return advice("encrypted", host, shown);
	if (m.includes("different passphrase")) return advice("otherKey", host, shown);
	if (m.includes("pull-only")) return advice("pullOnly", host, shown);
	if (m.includes("was not found in")) return advice("branchMissing", host, shown);
	return { title: t("h.failed"), hint: shown, action: "retry" };
}


/** How the last sync ended as a whole: the main repository, shared folders and the backup mirror. */
export interface SyncOutcome {
	/** Increases with every finished sync, so a caller can tell its own sync from an earlier one. */
	seq: number;
	ok: boolean;
	/** Translated reasons when not everything synced. */
	problems: string[];
}

/** Why a finished sync didn't fully succeed (translated); empty when everything synced. */
export function syncProblems(o: { errors: string[]; sharedErrors: string[]; mirrorError: string | null }): string[] {
	const out: string[] = [];
	if (o.errors.length) out.push(t("m.syncFileErrors", { count: o.errors.length, first: o.errors[0] ?? "" }));
	if (o.sharedErrors.length) out.push(`${t("m.sharedFailed")} ${o.sharedErrors.join("; ")}`);
	if (o.mirrorError) out.push(t("m.mirrorFailed", { error: o.mirrorError }));
	return out;
}

/**
 * "Sync and close": quit only when the sync started after `beforeSeq` finished and everything synced
 * (main repository, shared folders, backup mirror, every file). Otherwise the message to show.
 */
export function closeVerdict(beforeSeq: number, outcome: SyncOutcome | null, lastError: string | null): { quit: true } | { quit: false; message: string } {
	if (!outcome || outcome.seq <= beforeSeq) return { quit: false, message: lastError ? t("m.closeFailed", { error: lastError }) : t("m.closeNotSynced") };
	if (!outcome.ok) return { quit: false, message: outcome.problems.length ? t("m.closeIncomplete", { reasons: outcome.problems.join("\n") }) : t("m.closeNotSynced") };
	return { quit: true };
}
