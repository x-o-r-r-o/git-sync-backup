import type { SyncMode } from "./plan.ts";
import { DEFAULT_CONFIG_SYNC } from "./scope-config.ts";
import type { ConfigSync } from "./scope-config.ts";

export type ConflictStrategy = "auto" | "markers" | "keep-both" | "ask" | "local" | "remote";
/**
 * "changes": a short notice when a sync changed files, plus errors. "auto" (default): "changes" on phones,
 * which have no status bar, and "errors" on desktop.
 */
export type NoticeLevel = "auto" | "all" | "changes" | "errors" | "silent";

// Stored in data.json. Safe to sync between devices: no secrets in here.
// The token, API base URL and device name live in device-local storage instead, so a
// synced data.json can never redirect a device's token to another server.
export type Provider = "github" | "gitlab" | "gitea" | "bitbucket" | "gitee" | "azure";

export interface VaultSyncSettings {
	provider: Provider;
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
	/** Which parts of the settings folder sync (when syncConfigDir is on). */
	configSync: ConfigSync;
	/** Sync hidden files and folders at the top of the vault (e.g. .github/, .editorconfig). */
	syncHidden: boolean;
	/** Also exclude what the vault's .gitignore lists (and sync the .gitignore itself). */
	useGitignore: boolean;
	excludePatterns: string;
	maxFileSizeMB: number;
	/** Files at least this large are stored with Git LFS (0 = off). */
	lfsThresholdMB: number;

	conflictStrategy: ConflictStrategy;
	reviewBeforeManualSync: boolean;
	ignoreLineEndingChanges: boolean;
	fullScanMinutes: number;

	deleteGuardEnabled: boolean;
	deleteGuardMin: number;
	deleteGuardPercent: number;

	dailySnapshot: boolean;

	commitTemplate: string;
	/** Commit author (empty = the host's default identity for the token). */
	authorName: string;
	authorEmail: string;
	/** Keep empty folders across devices (stored in .vault-sync/folders.json; off with encryption). */
	keepEmptyFolders: boolean;
	/** Backup mirror: every sync also uploads this vault to a second repository (push only). */
	mirror: MirrorTarget | null;
	noticeLevel: NoticeLevel;
	/** Sync when a note is opened (at most every 30 seconds), to fetch its latest version. */
	syncOnOpen: boolean;
	/** Mark files in the file explorer: edited since the last sync, conflict copies. */
	explorerBadges: boolean;
	wizardShown: boolean;
	/** Folders synced to their own repositories (e.g. a team folder). No secrets in here. */
	sharedFolders: SharedFolder[];
}

export interface MirrorTarget {
	enabled: boolean;
	provider: Provider;
	owner: string;
	repo: string;
	branch: string;
}

export interface SharedFolder {
	id: string;
	folder: string;
	/** Folder inside the repository the shared folder maps to ("" = the repository root). */
	subdir?: string;
	/** On a conflict: keep both versions (copy), or push this device's version to a branch and open a pull request. */
	conflicts?: "copy" | "pr";
	provider: Provider;
	owner: string;
	repo: string;
	branch: string;
	enabled: boolean;
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
	configSync: DEFAULT_CONFIG_SYNC,
	syncHidden: false,
	useGitignore: false,
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
	lfsThresholdMB: 0,

	conflictStrategy: "auto",
	reviewBeforeManualSync: false,
	ignoreLineEndingChanges: true,
	fullScanMinutes: 30,

	deleteGuardEnabled: true,
	deleteGuardMin: 10,
	deleteGuardPercent: 20,

	dailySnapshot: false,

	commitTemplate: "{{device}}: {{summary}}",
	authorName: "",
	authorEmail: "",
	keepEmptyFolders: true,
	mirror: null,
	noticeLevel: "auto",
	syncOnOpen: false,
	explorerBadges: true,
	wizardShown: false,
	sharedFolders: [],
};

// Per-device sync state, kept in the plugin folder and never synced.
export interface SyncState {
	version: 1;
	/** Device that wrote this state (guards against state copied in by another sync tool). */
	deviceId?: string;
	repoKey: string;
	head: string | null;
	base: Record<string, string>;
	// h = git blob sha; n = sha of the LF-normalised text (text files with CRLF only).
	cache: Record<string, { m: number; s: number; h: string; n?: string }>;
	// Normalised-text hash of each base version, to recognise line-ending-only edits.
	baseNorm: Record<string, string>;
	lastFullScan: number;
	lastConfigScan: number;
	/** Codec fingerprint the cached hashes were computed with. */
	codecFingerprint: string;
	/** What was in scope at the last sync; when it changes, the next sync compares everything. */
	scopeSig?: string;
	/**
	 * Files moved out of this device's scope (found elsewhere in the vault with the same content):
	 * path → blob sha. Their repository copy is kept, without rescanning on every sync.
	 */
	keptMoved?: Record<string, string>;
	/** Empty folders as of the last sync (three-way base for .vault-sync/folders.json). */
	baseFolders?: string[];
	/** Remote files this device chose not to download (over its size limit), available on demand. */
	remoteOnly: Record<string, { sha: string; size: number }>;
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
	codecFingerprint: "",
	remoteOnly: {},
	lastSync: 0,
	lastSnapshot: 0,
	dirty: false,
});

export type ConflictChoice = "local" | "remote" | "keep-both" | "markers" | { custom: string };

export interface ConflictInfo {
	path: string;
	/** Name of the remote side ("GitHub", "GitLab", …). */
	remoteLabel?: string;
	/** Name of the local side (default "This device"). */
	localLabel?: string;
	/** Title override, and whether to offer "merge with markers" (default true). */
	title?: string;
	markers?: boolean;
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
	/** Sync only these paths ("Sync current file"); everything else keeps its old baseline. */
	only?: Set<string>;
	/** First sync only (no baseline): which side wins when a file differs. Default: keep both. */
	firstSyncPrefer?: "local" | "remote";
}
