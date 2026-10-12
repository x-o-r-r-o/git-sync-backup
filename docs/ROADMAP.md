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

## Status after 1.0.0 (2026-10-12): what's left

Roadmap items 1–15 have shipped, except the parts below. They are kept for later releases, roughly in order of value:

| Item | What's left | Why it isn't done |
|---|---|---|
| 9 | **Sign in with GitHub** (GitHub App + device flow) | Planned only, by decision (see [AUTH.md](AUTH.md)). Needs a GitHub App registered and owned by the author. |
| 15 | **Full translations**: settings and setup wizard text, plus more languages | Commands, the status panel and notices are translated (English and Simplified Chinese); long setting texts are English only. |
| 6 / 12 | **Attachments on demand**: list big files without downloading them, fetch when opened | LFS and per-device download limits cover storage today; on-demand fetching needs a placeholder design. |
| 4 | **Rename + edit detection** by content similarity | Exact-content renames are detected (the common Obsidian case); a renamed *and* edited file still syncs as delete + add. |
| 11 | **Bitbucket** host | GitHub, GitLab and Gitea/Forgejo are done. |
| new | **Settings search on Obsidian 1.13+** (`getSettingDefinitions`) | The classic settings tab works on all versions; the declarative API would make settings searchable on new versions. |

Verification still to do:

- Real phones (iOS and Android).
- Real GitLab and Gitea/Codeberg servers. So far they are tested against simulated servers only.
- A visual pass of the 1.0 screens (host picker, encryption, shared folders).
