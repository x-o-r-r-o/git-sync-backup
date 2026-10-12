import type { SyncMode } from "./plan.ts";

export type ConflictStrategy = "auto" | "markers" | "keep-both" | "ask" | "local" | "remote";
export type NoticeLevel = "all" | "errors" | "silent";

// Stored in data.json. Safe to sync between devices: no secrets in here.
// The token, API base URL and device name live in device-local storage instead, so a
// synced data.json can never redirect a device's token to another server.
export interface VaultSyncSettings {
	provider: "github" | "gitlab" | "gitea";
	owner: string;
	repo: string;
	branch: string;

	mode: SyncMode;
	syncOnStartup: boolean;
	syncOnChange: boolean;
	changeDebounceSec: number;
	intervalMin: number;
	syncOnResume: boolean;
	syncOnBackground: boolean;

	syncConfigDir: boolean;
	excludePatterns: string;
	maxFileSizeMB: number;

	conflictStrategy: ConflictStrategy;
	reviewBeforeManualSync: boolean;
	ignoreLineEndingChanges: boolean;
	fullScanMinutes: number;

	deleteGuardEnabled: boolean;
	deleteGuardMin: number;
	deleteGuardPercent: number;

	dailySnapshot: boolean;

	commitTemplate: string;
	noticeLevel: NoticeLevel;
	wizardShown: boolean;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
	provider: "github",
	owner: "",
	repo: "",
	branch: "main",

	mode: "sync",
	syncOnStartup: true,
	syncOnChange: true,
	changeDebounceSec: 30,
	intervalMin: 10,
	syncOnResume: true,
	syncOnBackground: true,

	syncConfigDir: false,
	excludePatterns: [
		"# One pattern per line, gitignore style",
		".trash/",
		".DS_Store",
		"Thumbs.db",
		"{config}/workspace.json",
		"{config}/workspace-mobile.json",
		"{config}/workspaces.json",
		"{config}/cache",
		"{config}/plugins/*/node_modules/",
	].join("\n"),
	maxFileSizeMB: 50,

	conflictStrategy: "auto",
	reviewBeforeManualSync: false,
	ignoreLineEndingChanges: true,
	fullScanMinutes: 30,

	deleteGuardEnabled: true,
	deleteGuardMin: 10,
	deleteGuardPercent: 20,

	dailySnapshot: false,

	commitTemplate: "{{device}}: {{summary}}",
	noticeLevel: "errors",
	wizardShown: false,
};

// Per-device sync state, kept in the plugin folder and never synced.
export interface SyncState {
	version: 1;
	repoKey: string;
	head: string | null;
	base: Record<string, string>;
	// h = git blob sha; n = sha of the LF-normalised text (text files with CRLF only).
	cache: Record<string, { m: number; s: number; h: string; n?: string }>;
	// Normalised-text hash of each base version, to recognise line-ending-only edits.
	baseNorm: Record<string, string>;
	lastFullScan: number;
	lastConfigScan: number;
	lastSync: number;
	lastSnapshot: number;
	dirty: boolean;
}

export const emptyState = (repoKey = ""): SyncState => ({
	version: 1,
	repoKey,
	head: null,
	base: {},
	cache: {},
	baseNorm: {},
	lastFullScan: 0,
	lastConfigScan: 0,
	lastSync: 0,
	lastSnapshot: 0,
	dirty: false,
});

export type ConflictChoice = "local" | "remote" | "keep-both" | "markers" | { custom: string };

export interface ConflictInfo {
	path: string;
	localText: string | null;
	remoteText: string | null;
	localSize: number;
	remoteSize: number;
}

export type DeleteGuardChoice = "proceed" | "skip" | "cancel";

/** Paths edited since the last sync, as reported by vault events. */
export interface LocalChanges {
	full: boolean;
	paths: Set<string>;
}

export interface SyncOptions {
	/** Paths left out of this sync (unchecked in review). They keep their old baseline. */
	defer?: Set<string>;
	/** First sync only (no baseline): which side wins when a file differs. Default: keep both. */
	firstSyncPrefer?: "local" | "remote";
}
