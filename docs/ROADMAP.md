# Roadmap: making Vault Sync for Git the best git-based sync plugin

Based on competitor research (2026-10-12): the community plugin list and download stats, plus the most-upvoted GitHub issues of Obsidian Git (3.28M downloads), Remotely Save (2.30M), Self-hosted LiveSync (1.00M), Fit (65k), GitHub Sync (53k), GitHub Gitless Sync (20k), Git Sync (12k), Git Vault Sync (4.8k) and Version History Diff (54k).

## Where we already lead

The only competitors that are reliable on mobile without git are the REST-API plugins Fit and Gitless Sync. Both are thin on safety, merging and backup. We already have:

- line-level three-way merge
- one atomic commit per sync
- delete guard, edit beats delete, a stale-cache guard
- snapshots, history and restore, recovery of deleted files
- dry run
- three modes (sync, backup only, pull only)

## What users keep asking for elsewhere

1. Reliable mobile without freezes. Obsidian Git #57 has 86👍 and 100 comments.
2. Conflicts that never lose data and work on a phone. Obsidian Git #558 and #340; Gitless #10 and #31.
3. Sync on save, open and close. Obsidian Git #13 has 80👍.
4. Easier setup: token scopes, repo picker, first-sync errors.
5. Scope control: selective folders, per-device config, workspace.json conflicts.
6. GitLab, Gitea and self-hosted servers.
7. Renames and moves handled correctly.
8. Large files and LFS.
9. Multiple repos, or sharing part of a vault.
10. Encryption.

We cover 1–3. The plan below targets 4–10 and adds features no git-based plugin has.

## Ranked plan

| # | Feature | Why (evidence) | Effort | Mobile |
|---|---|---|---|---|
| 1 | **Visual diff viewer**: split view on desktop, unified on mobile, in History, Preview and the conflict dialog, with per-hunk "take this side" | Version History Diff has 54k downloads just for diffs; Gitless conflict view breaks on mobile | M | ✓ |
| 2 | **Sync health panel**: pending changes, unresolved conflict copies, skipped files with reasons, the last error in plain language with a fix button, rate-limit budget, next sync time, last-seen time per device | Fit #22 and #406 ("coming soon"); Fit #69, Gitless #44 | S–M | ✓ |
| 3 | **Review before sync**: Preview with checkboxes; unchecked files are deferred | ObsSync differentiator; Fit #26 (accidental phone edits) | S | ✓ |
| 4 | **Rename and move detection**: a delete plus an add with the same or similar content is applied as a move; a device that edits a file the other device renamed merges into the new path | Gitless #9 and #33, ObsSync #34 | M | ✓ |
| 5 | **Structure-aware merge** for `.canvas`, JSON config and YAML frontmatter | Fit's canvas merge; Gitless #18; Obsidian Git #114 | M | ✓ |
| 6 | **Per-device selective scope**: device-local include/exclude lists, attachments optionally on demand | Gitless #19 and #39; phone storage | M | ✓ |
| 7 | **Restore vault or folder to a point in time**, plus a "reset to GitHub" option. Timeline of commits and snapshots; always restores as a new forward commit | Obsidian Git #702 | S–M | ✓ |
| 8 | **Incremental change tracking** from vault events; full rescan only at startup or occasionally; yield to the UI between batches | Fit #400; mobile freeze complaints | S | ✓ |
| 9 | **Guided setup**: wizard, repo picker and new/existing vault step ✅ v0.3. **Sign in with GitHub** via a *GitHub App + device flow* is planned, not built (see [AUTH.md](AUTH.md)); prefilled fine-grained tokens and SecretStorage shipped in v0.4 | Fit #42, #44, #49; Gitless #42 | S–M | ✓ |
| 10 | **End-to-end encryption**: AES-GCM per file, encrypted file names and manifest, key from a passphrase; merging happens after decryption | Obsidian Git #690 and git-crypt requests; would be **unique among git plugins** | L | ✓ |
| 11 | **More hosts**: Gitea/Forgejo (same API shape), GitLab (atomic commits API), later Bitbucket, behind a `RemoteProvider` interface | Fit #2 and #4, Git Sync #1 | M–L | ✓ |
| 12 | **Large attachments**: Git LFS over HTTPS or a release-assets mode; large attachments remote-only on mobile | Obsidian Git #14 | L | ✓ |
| 13 | **Folder → repo mapping**: several repos per vault, enabling a shared team folder | Obsidian Git #773 and #15, Fit #105 | L | ✓ |
| 14 | **Line-ending safety**: optional CRLF normalisation; a change that's only line endings counts as unchanged | ObsSync #31 and #32 | S | ✓ |
| 15 | **Localisation** | Obsidian Git #1071; large Chinese-speaking user base | S–M | ✓ |

## Suggested releases

- **v0.2 "Trust & visibility":** 1, 2, 3, 7, 8, 14 ✅ shipped 2026-10-12
- **v0.3 "Correctness":** 4, 5, 6, 9 ✅ shipped 2026-10-12
- **v0.4 "Unique":** 10 (E2E encryption) and 11 (Gitea and GitLab) ✅ shipped 2026-10-12 (GitLab/Gitea beta)
- **v0.5 "Grows with you":** 12 (Git LFS), 13 (shared folders → own repos), 15 (i18n framework + zh-CN) ✅ shipped 2026-10-12
- **Next:** Sign in with GitHub via GitHub App device flow ([AUTH.md](AUTH.md)), more translations

## Sources

- https://github.com/Vinzent03/obsidian-git/issues
- https://github.com/joshuakto/fit/issues
- https://github.com/silvanocerza/github-gitless-sync/issues
- https://github.com/kevinmkchin/Obsidian-GitHub-Sync/issues
- https://github.com/livan116/github-valut-sync/issues
- https://github.com/heeeyman/ObsSync/issues
- https://github.com/remotely-save/remotely-save/issues
- https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json

## Status after 1.2.0 (2026-10-12)

All roadmap items have shipped:

| Item | Status |
|---|---|
| 9: Sign in with GitHub (GitHub App + device flow) | ✅ 1.2 (see [AUTH.md](AUTH.md)) |
| 15: More languages | ✅ 1.2: German, Spanish, French, Japanese, Korean, Portuguese |
| 15: Full translations | ✅ 1.1: every screen, English and Simplified Chinese |
| 6 / 12: Attachments on demand | ✅ 1.1 |
| 4: Rename + edit detection | ✅ 1.1 (content similarity, merge across rename) |
| 11: Bitbucket | ✅ 1.1 (beta) |
| Settings search (Obsidian 1.13+) | ✅ 1.1 |

Still to verify: real phones, and real GitLab, Gitea and Bitbucket servers (so far they are tested against simulated servers only).

## Status after 1.3.0 (2026-10-12)

From the 1.2 review list, shipped in 1.3: granular settings-folder sync (1), setup link / QR code and other-sync-tool warning (2), `.gitignore` and hidden files (3), file-explorer status and phone notices (4), sync current file / on open (5), folded settings (6).

Also in 1.3, from researching 29 other plugins: Azure DevOps and Gitee hosts, backup mirror, conflicts as pull requests (shared folders), shared folder to a repository subfolder, plugin installs from official releases, make repository match this device, branch picker, .gitattributes LFS rules, empty folders, pause and battery saver, remote-change indicator, open/copy on host, folder menu actions, diagnostics, commit author, plugin-version warning, Windows-name checks, review filters.

## Status after 1.4.0 (released 2026-10-13)

Shipped in 1.4: inline conflict resolution in the editor (3), GitHub-friendly Markdown for shared folders (4), hidden files inside folders and nested `.gitignore` files (5), Sign in with GitLab (6).

Also in 1.4:
- **Repository picking:** after Sign in with GitHub the wizard lists the repositories the app can use first and refreshes by itself when you come back from GitHub; settings gained a repository picker for every host.
- **Live testing on real servers:** the suite `tests/live/hosts.live.test.ts` passes against github.com, gitlab.com, codeberg.org and bitbucket.org (12 tests each, plus 13 GitHub-specific tests including encryption).
- **Full audit (about 40 fixes):** template notes no longer mistaken for renames, force-push safety for skipped files, no large downloads during rename detection, LFS size limits, recoverable trash for replaced local content, a Bitbucket commit-adoption race, GitLab paging behind proxies, Gitea files over the blob limit, settings edits lost after an external change, accurate status bar count and paused state, confirmations for reset and restore.
- Windows rename-plus-edit protection, a proofreading pass over the translations, and conflict blocks styled in the editor.

Removed in 1.4: the Gitee and Azure DevOps hosts added in 1.3. They could not be verified against real servers; settings that use them pause sync with a notice until another host is chosen, and files are left untouched.

## Status after 1.5.0 (2026-10-13)

Shipped in 1.5 from the 1.4 list: translated sync errors (4), lighter `.gitignore` and hidden-file scanning (5), push-only mode keeps both (6), smarter rename detection for template notes (7), Bitbucket download checks (8), and the small polish items (9).

## Next

1. **Real phones.** Test on iOS and Android through BRAT: first sync, attachments on demand, background sync, battery saver, sign-in, conflict buttons with touch.
2. **Drop "beta"** for GitLab, Gitea / Forgejo and Bitbucket once real-world reports confirm the live-suite results.
3. **Native-speaker review** of the seven translations (including the new error messages).

### From comparing with Obsidian Git (see docs/RESEARCH.md)

4. **Change markers in the editor** for lines changed since the last sync, with "revert this change" and next/previous change (works on mobile; Obsidian Git's is desktop-only).
5. **History sidebar:** every sync as a commit with its changed files and diffs, device and author, with restore from there.
6. **Per-file "use the repository version"** in Compare and the status panel (today only the whole vault can be reset).
7. **Commit message upgrades:** date format, `{{files}}`, `{{trigger}}` (automatic or manual), a "Sync with message…" command and a preview.
8. **"Sync and close Obsidian"** command, and a check that the sync on leaving the app finishes when a desktop window closes.
9. **Excluded files greyed out** in the file explorer, plus "Git: Exclude this file" and an "Edit exclude patterns" command.
10. **Vault in a subfolder of the repository** (monorepos, several vaults in one repository), reusing the shared-folder subfolder mapping.
11. **Status bar:** optional next-sync countdown and branch name.
12. **Line authoring:** "last changed by device X on date Y", built on the device from history so it also works with encryption.
13. **Sync events for other plugins** and leaving out notes by frontmatter (`sync: false`).

