# Changelog

## 0.5.0 (2026-10-12) "Grows with you"

- Shared folders: map a vault folder to its own repository (any supported host, optional own token); the main repository excludes it; status shown in the panel.
- Git LFS for large files (GitHub, GitLab, Gitea) via the batch API. Pointers are always resolved; enabling it converts existing big files without conflicts (codec fingerprint invalidates cached hashes).
- i18n framework following Obsidian's language; English and Simplified Chinese for commands, status panel and notices. Host-neutral wording.
- 90 unit/e2e tests.

## 0.4.0 (2026-10-12) "Unique"

- End-to-end encryption: AES-256-GCM content, encrypted file names, PBKDF2-SHA256 (600k) key from a passphrase, verified via a marker file. Deterministic nonces keep change and rename detection working. Encrypted repos refuse devices without the key or with a different key. "Remove unencrypted copies" for migrating repos.
- New host architecture: the engine talks to a generic interface; GitHub (Git Data API), Gitea/Forgejo (ChangeFiles API) and GitLab (Commits API) are implemented. GitLab and Gitea are beta.
- Transform layer (codec) between vault and repository: a basis for encryption, folder mapping and LFS.
- Tokens in Obsidian SecretStorage (with migration); prefilled fine-grained token link; removed the OAuth App prototype (see docs/AUTH.md for the planned GitHub App sign-in).
- Tests: 86 unit/e2e (including fake GitLab and Gitea servers) and 13 live GitHub (including encrypted sync).

## 0.3.0 (2026-10-12) "Correctness"

- Rename and move detection: a rename on another device is applied as a rename here (no re-download; tabs and bookmarks follow). Renamed here + edited elsewhere, or the reverse, keeps the edit under the new name instead of creating a duplicate. Folder renames no longer trip the delete guard. Commit messages say "N renamed".
- Structure-aware merge: `.canvas` and JSON merged by node id and key (text fields line by line); Markdown frontmatter merged per key, with tags and aliases merged as sets; body via diff3. Unsafe cases fall back to keep-both.
- Per-device scope (stored on the device, not synced): only-these-folders, extra excludes, a download size limit, and "Free up space" (removes local copies only when identical to GitHub).
- Setup wizard: Sign in with GitHub (OAuth device flow, needs a client ID) or a token with guided links; searchable repo picker or create a private repo; "upload / download / merge" choice for the first sync, with live progress.
- Progress reporting for long syncs.

## 0.2.0 (2026-10-12) "Trust & visibility"

- Visual diff viewer: split on desktop, unified on mobile. Used in review, history, conflicts and "Compare with GitHub".
- Change-by-change conflict resolution in the "Ask me" dialog.
- Sync status panel: state, plain-language errors with fixes, pending local and remote changes, conflict copies, skipped files, device activity, API budget, schedule, tools.
- Review before sync, with per-file checkboxes (deferred files are left alone) and an optional "review before manual sync".
- Timeline: browse commits and snapshots and the files at any point; restore the whole vault or one folder as a forward commit.
- "Make this device match GitHub" (old versions go to the trash first).
- Incremental scanning: event-flagged paths are re-hashed; the config dir is walked at most every 5 minutes; a periodic full rescan; the UI is never blocked.
- Line-ending-only changes are ignored (option).
- `Device:` commit trailer; a pending-changes badge in the status bar; status bar click opens the panel.
- Tests: 45 unit and e2e, 11 live GitHub. Verified in Obsidian 1.14.4 desktop.

## 0.1.1 (2026-10-12)

- Fix: stale HTTP cache could make remote files look deleted. Added no-cache headers and a stale-head guard (compare API).
- Live GitHub test suite; settings polish.

## 0.1.0 (2026-10-12)

- First version: three-way sync over the GitHub Git Data API, diff3 merge, keep-both, delete guard, snapshots, history and restore, three modes.
