import type { SyncMode } from "./plan.ts";

export type ConflictStrategy = "auto" | "markers" | "keep-both" | "ask" | "local" | "remote";
export type NoticeLevel = "all" | "errors" | "silent";

// Stored in data.json. Safe to sync between devices: no secrets in here.
// The token, API base URL and device name live in device-local storage instead, so a
// synced data.json can never redirect a device's token to another server.
export interface VaultSyncSettings {
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

	deleteGuardEnabled: boolean;
	deleteGuardMin: number;
	deleteGuardPercent: number;

	dailySnapshot: boolean;

	commitTemplate: string;
	noticeLevel: NoticeLevel;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
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

	deleteGuardEnabled: true,
	deleteGuardMin: 10,
	deleteGuardPercent: 20,

	dailySnapshot: false,

	commitTemplate: "{{device}}: {{summary}}",
	noticeLevel: "errors",
};

// Per-device sync state, kept in the plugin folder and never synced.
export interface SyncState {
	version: 1;
	repoKey: string;
	head: string | null;
	base: Record<string, string>;
	cache: Record<string, { m: number; s: number; h: string }>;
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
	lastSync: 0,
	lastSnapshot: 0,
	dirty: false,
});

export type ConflictChoice = "local" | "remote" | "keep-both" | "markers";

export interface ConflictInfo {
	path: string;
	localText: string | null;
	remoteText: string | null;
	localSize: number;
	remoteSize: number;
}

export type DeleteGuardChoice = "proceed" | "skip" | "cancel";
