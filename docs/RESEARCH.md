# Research: existing GitHub sync plugins, gaps, and our design

## Plugins reviewed

| | GitHub Sync (kevinmkchin) | Git Sync (livan116) | Obsidian Git (Vinzent03) | GitHub Gitless Sync / Fit |
|---|---|---|---|---|
| Engine | system `git` binary via Node | isomorphic-git (JS git) | git binary (desktop), isomorphic-git (mobile) | GitHub REST API |
| Mobile | No | Yes | Yes, but slow / memory-heavy, marked unstable | Yes |
| External deps | git must be installed | OAuth app client ID to build | git on desktop | none |
| `.git` folder in vault | yes | yes (full object store on phone) | yes | no |
| Auth | token in remote URL (leaks into repo if not ignored) | device-flow OAuth, `repo` scope (all repos) | git credentials | PAT |
| Auto sync | on startup only | debounce on save, on open, on close | interval | interval / manual |
| Conflicts | opens unmerged files | Keep mine / Keep theirs / edit | git markers | keep both / overwrite |
| Branches | main only | default | yes | one |
| History / restore | no | no | yes (desktop) | no |

## Gaps found (and what this plugin does about each)

1. **Desktop-only or heavy mobile engine.** Runs on pure GitHub Git Data API via Obsidian's `requestUrl` + WebCrypto. No git binary, no isomorphic-git, no `.git` folder, no CORS problems, identical behaviour on all platforms.
2. **Token leakage.** Token is stored in device-local storage, never in `data.json`, so syncing `.obsidian` never pushes it to GitHub. Works with **fine-grained tokens limited to one repo**, not just the broad `repo` scope.
3. **No real merge.** True three-way (diff3) line merge using the last-synced version as the base. Non-overlapping edits on two devices merge silently. Overlaps fall back to a *keep both* conflict copy (default), git markers, or an interactive side-by-side dialog: user chooses.
4. **One commit per file / noisy history.** Every sync is **one atomic commit** (blobs → tree → commit → fast-forward ref). Concurrent pushes from another device are detected (non-fast-forward) and retried after re-pull.
5. **Accidental mass deletion.** Delete guard: if a sync would delete more than N files / X% of the vault, it stops and asks. Local deletions go to the trash, never permanently.
6. **Modification vs. deletion races.** Edit wins over delete, so a note deleted on one device but edited on another is never lost.
7. **No backup features.** Snapshot command (lightweight tag `snapshot-YYYYMMDD-HHMMSS`), optional daily auto-snapshot, per-file **history + restore**, and **recover deleted files** from recent commits.
8. **Only one sync style.** Modes: two-way *sync*, *backup only* (push, never touches local files), *pull only* (read-only mirror device).
9. **Wasted API calls / battery.** Hash cache keyed by mtime+size; if remote head and local files are unchanged the sync ends after one API call. Small text files are sent inline in the tree (no per-file blob call). Chunked tree builds for large first uploads.
10. **Config dir handling.** `.obsidian` sync is opt-in with sensible excludes (workspace layout, cache). Uses `vault.configDir`, not a hard-coded `.obsidian`.
11. **Files the plugin doesn't manage get destroyed.** Out-of-scope paths (e.g. `.github/`, excluded folders, too-large files) are never deleted remotely: trees are built on `base_tree`.
12. **Case-insensitive file systems.** Remote paths that differ only by case are skipped with a warning instead of overwriting each other on Windows / macOS / iOS.
13. **Visibility.** Status bar + ribbon, sync log, and a *preview (dry run)* that shows exactly what would happen before anything changes.
14. **Rate limits and flaky mobile networks.** Retries with backoff on 5xx/network errors, waits for short rate-limit resets, skips auto-sync while offline, syncs on app resume and when the app goes to background (mobile).
15. **Setup friction.** Test connection, create private repo, auto-initialise an empty repo, GitHub Enterprise API base URL support.

## Known limits

- GitHub hard limit 100 MB per file (default plugin limit 50 MB, configurable). Repos > ~1 GB get slow; keep big media out (exclude patterns).
- A file edited while a sync is writing it will be reloaded by Obsidian from disk.
- Git LFS is not supported.

## Audit (2026-10-12) — fixed

| Severity | Finding | Fix |
|---|---|---|
| High | Pending uploads held entirely in memory; a large first sync from a phone could crash | Uploads read lazily in batches of 8; trees built in chained chunks, so memory stays at about one chunk |
| High | `apiBase` in synced `data.json` let anyone with repo write access redirect tokens | API base is now device-local, like the token |
| Medium | Restoring a deleted file failed if its folder had been pruned; hidden paths failed | Restore goes through VaultIO (creates folders, handles hidden paths) |
| Medium | Edits made during a sync did not schedule a follow-up sync | Changes during a sync trigger a debounced follow-up |
| Medium | Empty-folder cleanup used force delete; folder pruning probe could misfire on some patterns | Non-force delete; prune by testing the folder path itself |
| Low | No defensive check on remote path segments | `safePath` rejects `..`, `.`, empty segments, absolute paths, backslashes, NUL |
| Low | Empty commits when merged content equals remote; parallel blob creation could trip GitHub's secondary rate limit; repeated failure notices every interval | Skip unchanged uploads; write concurrency 2; notify only on first failure in a row |

Regression tests were added for unsafe paths, chunked 1,200-file uploads, and no empty commits (28 tests total).

## Real-world testing (2026-10-12)

- **Live GitHub suite** (`npm run test:live`): 9 tests through a real private repo. Covers byte-exact round trips (binary, 450 KB text, Unicode names), SHAs matching GitHub, merge, keep-both, delete guard, edit beats delete, concurrent-push retry, config excludes, a 450-file chunked commit, history and restore, and snapshot tags. All pass.
- **Inside Obsidian 1.14.4 (macOS):**
  - plugin loads; ribbon, status bar, settings tab and sync log work
  - a missing or invalid token shows a clear message
  - first sync downloads and uploads correctly
  - an edit is auto-synced 30 s later
  - remote edits from a second device merge cleanly
  - overlapping edits produce a keep-both copy
- **Critical bug found and fixed:** GitHub API responses are cacheable for 60 s and Obsidian's HTTP layer honours that. A stale branch head was read as remote deletions, and 2 notes were deleted locally (they went to the system trash and were restored on the next sync).
  - Fix 1: no-cache request headers plus a cache-busting parameter on the branch lookup.
  - Fix 2: a stale-head guard. The compare API detects a head older than the last synced one and retries instead of acting; a rewritten history means a fresh baseline with no deletions.
  - Regression tests added (30 unit and e2e tests total).
- Note: hidden or background windows have their timers throttled by Chromium, so auto-sync after edits can run up to about 1 min late while Obsidian is in the background.
