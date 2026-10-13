# Changelog

## 1.7.0 (2026-10-13)

**New**
- **History follows renames.** *Version history* and *Who last changed this line* continue past a rename (also through several renames and with end-to-end encryption): versions from before it show the file's old name, and open, compare and restore correctly.
- **Who last changed this line in shared folders**, read from the shared folder's own repository (it was only available for the vault's repository).

**Fixed**
- **GitHub: older versions of some binary files came back altered.** GitHub's file endpoint took certain binary data for UTF-16 text and converted it (an encrypted 60-byte file came back as 90 bytes). Encrypted files then failed to open from history; an unencrypted binary file restored from history could have been written with the wrong bytes. Older versions are now read from the stored blob, byte for byte. GitLab, Codeberg and Bitbucket were checked live and were not affected.

**Fixed (found testing on an Android phone)**
- *End-to-end encryption: turn on or unlock* no longer asks for the passphrase on a device that already has the key. It shows that encryption is on, with *Remove unencrypted copies…*, *Lock this device* and *Close*.
- The *Download* box under an embed of a file that isn't on the device now goes away once the file is downloaded (it stayed until the note was reopened), and its button can't be pressed twice.
- Settings rows with several buttons wrap on phones instead of running off the screen (encryption, files on demand, pause, sign-in).
- Counts in settings (such as files available on demand) no longer go stale on Obsidian 1.13+ when a page is opened from settings search after a sync.

## 1.6.2 (2026-10-13)

**Fixed**
- **Encrypted vaults leaked file names in commit messages.** With end-to-end encryption on, files and their names were encrypted, but the message of each sync still listed the changed paths (and `{{files}}` in a commit template filled them in). Commit messages of encrypted vaults now only give counts (for example "Phone: 1 updated"), conflict pull requests say how many files they hold instead of naming them, and restoring a folder no longer names the folder. Messages of commits made before this version still contain the names; for full privacy start a new, empty repository.

## 1.6.1 (2026-10-13)

**Fixed**
- **Sync could turn itself off on every device.** With settings-folder sync on, a list of enabled plugins without Vault Sync (from a device where it was switched off, or a list read while the plugin was starting) spread to all devices, so sync stopped everywhere after the next restart. A sync now never removes this plugin from the enabled list on a device where it runs, repairs a stale list before syncing, and uploads the repaired list so the repository heals itself.

## 1.6.0 (2026-10-13)

**New**
- **Sync history sidebar.** *Open sync history* (ribbon, command or the status panel's Tools) lists recent syncs of the repository with date, device (from the `Device:` line) and author, 30 at a time with *Load more*. Expand a sync to see its changed files as added, modified, deleted or renamed, with encrypted names shown decrypted; click a file for its diff against the previous version, or restore that file. *Browse files*, *Restore a folder…* and *Restore whole vault* work from any sync. Filter by path; refreshes after every sync; keyboard and touch friendly.
- **Use the repository version of a file.** In *Compare with repository*, in the status panel's list of edited files, from the file menu (*Git: Use repository version*) and as a command: the file on this device is replaced by the repository's latest version after a confirmation. The version on this device goes to the trash first (system trash, else the vault's `.trash`, even when Obsidian is set to delete files permanently), and the next sync uploads nothing for that file. Refused while a sync runs.
- **Changes since the last sync in the editor.** Lines added, changed or deleted since the last sync are marked next to the text, on desktop and mobile. Click or tap a mark for a popover with the last-synced text and **Revert**; commands *Revert this change*, *Go to next change* and *Go to previous change*. The last-synced version is read once (through encryption and large file storage, like a sync) and cached in memory, so marks keep working offline; files over 1 MB and binary files are skipped. Setting: *Show changes since the last sync in the editor* (on by default).
- **Who last changed this line.** A command (and a button in the change popover) that walks the file's last 30 versions on the device and shows *Last changed on … by … (commit)*, with the device from the commit's `Device:` line and a button to open that version. Works with end-to-end encryption.
- **Vault in a folder of the repository.** *Folder in the repository* (settings, and optional in the wizard's repository step) keeps the vault in a subfolder such as `vaults/personal/`, for monorepos or several vaults in one repository. Files outside that folder are never downloaded, changed or deleted; changing the folder starts a fresh comparison that deletes nothing. Setup links carry the folder.
- **Commit message upgrades.** New template variables `{{files}}` (changed paths, first 10 then "and N more"), `{{trigger}}` (manual, interval, startup, …) and `{{date:FORMAT}}` (moment.js formats such as `YYYY-MM-DD HH:mm`), a live preview under the template, an optional separate template for automatic syncs, and the command *Sync with a custom message…*.
- **Sync and close Obsidian** (desktop command): syncs, then closes Obsidian only when the sync succeeded. Closing a desktop window now also starts a last upload of pending edits (best effort: a closing window can't wait for it).
- **Excluded files greyed out** in the file explorer (with *Show sync status in the file explorer* on), with the tooltip *Not synced*. File menu: *Git: Exclude this file from sync* and *Git: Include in sync* (removes your pattern or adds a `!` re-include); command *Edit exclude patterns*.
- **Leave out notes with `sync: false`** in their properties: never uploaded from that device, and a copy already in the repository stays as it is. Setting *Respect sync: false in frontmatter* (on by default).
- **Status bar extras** (desktop, optional): time until the next scheduled sync and the branch name.
- **Events for other plugins:** `vault-sync-git:sync-start` and `vault-sync-git:sync-done` (with counts of uploaded, downloaded, deleted and conflicting files, and an error if any) on `app.workspace`. See the README.

**Improved**
- Restoring an older version over the current file (*Version history* → *Restore this version*) now moves the current contents to the trash first instead of overwriting them.
- Vaults in different folders of one repository each keep their own encryption marker, so one vault can be encrypted while another isn't; their history, timeline and large-file rules only cover their own folder.
- Changing *Folder in the repository* asks first, and warns when that folder already holds files; setup links show the folder.

**Fixed (review before release)**
- The backup mirror respects `sync: false` notes and never uploads them.
- *Sync and close* only closes when every part of the sync succeeded (main repository, shared folders, mirror); otherwise it lists what failed.
- The history sidebar only reloads when there is something new and it is visible; change markers reuse this device's text instead of downloading it again after a sync; *Free up space* never removes `sync: false` notes; Gitea renames show in history; Bitbucket history pages follow the server's own paging links; sync events never carry unredacted error details.

## 1.5.0 (2026-10-13)

**New**
- **Error messages in your language.** Sync, connection and download errors in notices and the status panel are now translated into all eight languages, with host-specific hints (sign-in expired, repository not found, rate limit, server or network trouble). The sync log and *Copy diagnostics* stay in English for bug reports.
- **Back up only keeps both.** In *Back up only* mode, when the repository also changed a file, its version is saved next to yours as a conflict copy before your version is uploaded, instead of surviving only in history. The backup mirror is unchanged.

**Improved**
- **Smarter rename detection.** Lines a note shares with the other notes in its folder (a template) no longer count when deciding whether a deleted note and a new note are the same note renamed, so notes from rich templates aren't paired by mistake.
- **Lighter scanning for big vaults.** Hidden files and `.gitignore` files inside folders are found through folder changes, full scans and a 30-minute check instead of listing every folder every few minutes; folders are listed four at a time.
- **Bitbucket download checks.** Each download is checked against the size in the repository listing (and the server's length header), so a cut-off download is retried instead of saved.
- **Steadier conflict dialog:** it keeps its height when switching between *Choose changes* and *Full diff*.
- **Clearer file menu:** the plugin's items are prefixed *Git:* (for example *Git: Version history*), so they don't mix with Obsidian Sync's *Open version history*.

## 1.4.0 (2026-10-13)

**New**
- **Resolve conflicts right in the note.** Every `<<<<<<<` / `=======` / `>>>>>>>` block gets **Keep this device**, **Keep repository** and **Keep both** buttons in the editor. The two sides are tinted and the marker lines show as small labels, so Markdown no longer turns them into headings or quotes.
- **Sign in with GitLab** on gitlab.com without a token (device flow; access renews automatically). Self-managed GitLab can use its own OAuth application (*GitLab application ID* in settings).
- **GitHub-friendly Markdown** for shared folders (optional): wikilinks become links, callouts become GitHub alerts, highlights become `<mark>` in the repository, while the vault keeps the exact Obsidian text.
- **Hidden files inside folders** (optional, e.g. `Notes/.assets/`), and **`.gitignore` files inside folders** apply to their folder, as in Git.

**Improved**
- **Choosing a repository after Sign in with GitHub:** the wizard shows the repositories the app can use first; *Add repositories on GitHub* is a secondary step, and the list refreshes by itself when you come back (newly added repositories are marked *New* and listed first). Settings also gained a **Choose** button next to *Repository* that lists your repositories on any host.
- Conflict copies are listed in the status panel even before sync is set up.

**Fixed**
- On Windows, a note renamed elsewhere to a name Windows can't store *and* edited here is kept with the edit instead of being skipped silently.
- Review before release: a shared folder or mirror on the same GitLab as a signed-in vault now uses the sign-in token correctly; sign-out, pasting a token or closing the sign-in dialog can't be undone by a renewal finishing later; a failed renewal no longer blocks later ones until restart; a `.gitignore` that can't be read keeps the previous rules (instead of none), and edits to `.gitignore` files inside folders apply on the next sync; nested settings folders (`.obsidian`), trash and `.git` are never synced as hidden files; a folder holding only hidden synced files is no longer treated as empty; the Windows rename check no longer blocks deletions in that folder on later syncs; the editor buttons don't rescan big notes on every keystroke.
- A setup link made on a device signed in with GitLab no longer offers to include the short-lived sign-in token (the new device signs in itself).
- **Full audit before release (about 40 fixes):**
  - Sync engine: a new note made from the same template as a deleted note (for example a daily note) is no longer mistaken for a rename that moves the other device's edits into it; after a force-push, files skipped in a sync are no longer trashed later; deleted binary or large-file-storage files are never downloaded just to check for renames; large-file-storage files over the size limit are skipped on download; a conflict whose text itself contains a `=======` line keeps both versions instead of marking it; replaced local content always goes to a recoverable trash, even with Obsidian's *permanently delete* setting; empty-folder cleanup can no longer race a download into the same folder; a folder that can't be listed is never removed.
  - Hosts: Bitbucket can no longer adopt another device's commit as its own during a large push; GitLab paging works behind proxies whose address differs; Gitea/Forgejo files over the server's blob limit download through the file API; very large Gitea trees report an error instead of a partial list; a GitHub branch moved backwards mid-sync is detected; Bitbucket never sends the token to another address; changing the API URL to a different server no longer carries a pasted token along; setup links with `.` or `..` as owner or repository are refused.
  - Settings and screens: settings changed on another device no longer make edits in an open settings tab silently not save; battery saver also skips sync on open and on leaving the app; the status-bar count updates as you edit; the paused icon is accurate and the pause row says until when; *Reset sync state* and *Restore this version* ask first; picks in the conflict dialog survive switching to the full diff; bigger conflict buttons on phones; the file size limit is 2000 MB on every host except GitHub without large file storage (100 MB); the conflict-strategy dropdown is no longer cut off; the branch picker has a proper title.
- Translations: proofreading pass over German, Spanish, French, Japanese, Korean and Portuguese.

**Removed**
- **Gitee and Azure DevOps hosts.** They couldn't be verified against real servers. Settings that use them pause sync with a notice until you choose another host (a backup mirror on them is turned off, a shared folder on them is skipped); your files are untouched.

**Development**
- Live test suite for every host (`tests/live/hosts.live.test.ts`; `VSG_LIVE_KIND`, `VSG_LIVE_TOKEN`, `VSG_LIVE_REPO`), working on a throwaway branch.
- The bundle may now also use the `@codemirror/*` packages Obsidian provides (for the editor buttons).

## 1.3.0 (2026-10-12)

**New**
- **Settings folder, part by part.** Appearance and themes, CSS snippets, hotkeys, core settings, which plugins are on, plugin code and plugin settings each have their own switch, and **Choose per plugin** sets single plugins to code and settings, code only, settings only, or this device only. Implemented as generated exclude patterns that run before yours, so your own patterns still win.
- **Add another device** with a QR code or setup link (status panel, settings, command palette). The link carries host, repository, branch and sync choices; a token can be included, encrypted with a one-time code that is never in the link. Opening a link shows what it changes and asks first. Uses the bundled `qrcode-generator` (MIT) for the QR code.
- **Warning about other sync tools** on the same vault (Obsidian Sync, Obsidian Git or a `.git` folder, Remotely Save, LiveSync, Fit and others, and iCloud/Dropbox/OneDrive/Google Drive folders on desktop), in the setup wizard and the status panel.
- **Respect the vault's `.gitignore`** (optional), and **sync hidden files and folders** at the top of the vault (optional, e.g. `.github/`, `.editorconfig`).
- **File-explorer badges:** a dot on files edited since the last sync and a warning on conflict copies.
- **Sync current file now** (command) and **Sync when opening a note** (optional, at most every 30 s).
- **Notifications:** new "When files changed" level, and a new default, *Automatic*, that shows changes on phones (no status bar) and only errors on desktop. Saved choices are kept.
- **Simpler settings:** connection and sync behaviour stay open; the other sections are folded.

**Also new (from researching 29 other Git and sync plugins)**
- **Two more hosts (beta): Azure DevOps** (atomic pushes) **and Gitee** (one commit per file, as its API requires).
- **Backup mirror:** every sync also uploads the vault to a second repository on any host (push only; encrypted when the vault is).
- **Conflicts as pull requests** for shared folders: this device's version goes to a branch with a PR/MR instead of a conflict copy (falls back to a copy if the PR can't be opened).
- **Shared folder → folder inside a repository** (for example `Work/` ↔ `repo/docs/`).
- **Install plugin code from official releases** instead of syncing it: versions sync, each device installs that exact version from the plugin's GitHub release (community directory only, after confirming).
- **Make the repository match this device:** one forward commit, the opposite of reset.
- **Branch picker** with "create a branch"; **.gitattributes LFS rules** (`git lfs track`) honoured; **empty folders** kept across devices.
- **Pause automatic sync** (an hour or until resumed), **battery saver** per device, and a **"changes on the host" dot** on the ribbon and status bar.
- **Open / copy a note's link or history on the host**, **exclude a folder** and **share a folder** from the file menu.
- **Copy diagnostics** with tokens hidden; **commit author** name and email; **plugin-version mismatch** warning between devices; **names Windows can't store** listed (and skipped on Windows); **filters and search** in the review list.

**Fixed (full audit before release: settings, commands, sync engine, host clients)**
- Sync engine: conflict copies in the settings folder or hidden files no longer bounce between devices; partial syncs (current file, review, push mode, delete-guard "skip") no longer hide remote changes from the next sync; a file moved out of a device's folder scope stays in the repository (remembered, not just for one sync); a case-only rename on another device is applied as a rename (never strands or overwrites a file); names that differ only in Unicode form no longer become duplicates; large numbers in JSON files are never rounded by a structured merge; line-ending-only changes no longer show as pending; encryption can't change under a running sync.
- Host clients: Gitea history comparison works when the server returns fewer items per page; GitLab now reports file sizes (so size limits apply), remembered on the device; Bitbucket keeps executable bits and API-token LFS access; GitHub Enterprise Cloud (ghe.com) addresses; history and tags beyond the first page; GitHub's secondary rate limit is waited out once; no extra wait after the last network retry.
- Settings: Obsidian 1.13+ draws the settings from definitions (folded sections are sub-pages); fields save when you leave them (also when settings close), numbers are validated and shown as stored, the file size cap follows large file storage, API addresses must use https, the periodic sync interval is limited to 1–1440 minutes.
- Safety: a shared folder never sends the main token to another host and only saves its own token once it works; tokens can't be re-bound to another host; history and timeline ask to unlock an encrypted repository first; "Delete copy" asks first; status panel actions can't run twice and show errors; "Make this device match" reports failures; a queued sync with choices is never replaced.
- SQLite side files (`-wal`, `-shm`, `-journal`) are never synced.
- Wizard: no stray buttons after fast navigation, API address field for every host, owner restored when creating a repository fails.
- Accessibility: labels for review checkboxes; history, timeline and diff rows work with the keyboard.
- Other sync tools: Obsidian Sync is only reported when it is actually connected (its core plugin is on by default).

**Security**
- A pasted token is now bound to the host and API URL it was entered for. Switching hosts, a changed API URL in a synced `data.json`, or a setup link can no longer send it to another server; enter a token for the new host instead. (Before, switching hosts in settings reused the previous host's token.)

## 1.2.0 (2026-10-12)

**New**
- **Sign in with GitHub.** No token to create: approve a short code on github.com and pick the repositories the *Vault Sync for Git* GitHub App may use (Contents only). Access renews automatically (8-hour tokens, refreshed before expiry and once after a 401, one refresh at a time because GitHub rotates refresh tokens). No client secret, no server. GitHub Enterprise can use its own app. Tokens remain available for every host.
- **Six more languages:** German, Spanish, French, Japanese, Korean and Portuguese (Brazil), alongside English and Simplified Chinese. Tests check every catalog for every key and placeholder.
- **Resolve conflict copies** from the status panel: pick change by change, the result goes into the note and the copy to the trash.
- **Token expiry warning** for pasted GitHub tokens (status panel two weeks ahead, a notice in the last week).
- **Exclude patterns:** `!pattern` re-includes (the last matching pattern wins), with `\!` and `\#` escapes. Brackets stay literal, so folder names like `Team [Acme]` keep matching.
- **Preview sync (dry run)** is now a true preview, without checkboxes or a sync button.

**Fixed (from a full code audit)**
- Downloads are checked against their git hash, so a truncated or empty response (Gitea's 10 MB API limit, a proxy) is refused instead of written over the file.
- Two conflicts on the same note within a minute no longer overwrite the first conflict copy.
- Conflict and merge results re-check that the note wasn't edited during the download or the conflict dialog before writing.
- A branch moved back on purpose (undo + force-push) no longer blocks syncing forever: after retries it is compared from scratch, without deleting anything.
- Large-file (LFS) objects respect this device's download limit; the listing only shows the pointer's size, so phones could download huge files.
- Deleting or renaming a big file on a device with a download limit now reaches the repository instead of being mistaken for "available on demand".
- Bitbucket: change listings use a plain two-commit diff (`topic=false`), fixing timeline and restore listings when the cache is ahead.
- Unloading the plugin (update, disable) stops a running sync at the next safe point, so a reloaded copy never syncs alongside it.
- A running sync keeps using the repository it started with, even if settings change meanwhile.
- The setup wizard's first sync waits for an automatic sync already running, so its own choice runs and is reported.
- Progress messages are translated and name the actual host; the status panel no longer shows the GitHub API budget for other hosts and has a clean empty state before setup; the Compare dialog names the configured host.
- Docs: corrected setting names, documented GitLab's missing file sizes and Gitea's blob limit, and the testing status of beta hosts.

## 1.1.1 (2026-10-12)

- Fix the Obsidian Community scorecard: `package-lock.json` is back in sync with `package.json` (the `obsidian` type package is pinned instead of `latest`), so `npm ci` succeeds and source review and build verification can run.
- Dev-only `moment` (pulled in by the lint plugin) overridden to a patched version: `npm audit` reports 0 vulnerabilities.
- The release workflow uses plain `npm ci`, so a stale lockfile fails CI instead of the directory scan.
- Added `CONTRIBUTING.md`.
- README: corrected an outdated Git LFS note under Limits.

## 1.1.0 (2026-10-12)

- **Bitbucket Cloud** support (beta): API 2.0, multi-file commits pinned to the expected parent, and a hash index computed and cached on the device (Bitbucket exposes no blob hashes) that only re-fetches changed paths.
- **Attachments on demand:** files above a device's download limit are listed instead of downloaded, with a browse-and-download dialog, a command, a status panel section and a Download button in reading view. Downloaded files stay in sync, and "Free up space" leaves them alone.
- **Rename + edit detection:** a content-similarity pass pairs renamed-and-edited files. Edits from the other device are merged under the new name, both ways.
- **Complete translations:** all UI strings moved to `src/locales` (English, Simplified Chinese), with a completeness test.
- **Settings search** on Obsidian 1.13+ through `getSettingDefinitions()`; the settings tab is now data-driven.
- Fix: changing a device's scope (folders, limits, on-demand list) now forces a full comparison instead of waiting for a remote change.
- 103 unit/e2e tests.

## 1.0.0 (2026-10-12) First public release

**Renamed to Vault Sync for Git** (plugin id `vault-sync-git`). It syncs with GitHub, GitLab or Gitea / Forgejo / Codeberg, and the interface names the host you use.

Full audit (independent code review plus Obsidian's official lint rules), with these fixes:

- **Critical:** a shared folder now matches only its top-level folder. A nested folder with the same name (e.g. `Projects/Work/`) could previously leak to the shared repository. The folder mapping also refuses any path outside its folder.
- **High:** a missing or renamed branch, or lost access, now stops the sync instead of being read as an empty repository, which could have deleted local files.
- **High:** "Free up space" also forgets the baseline, so a freed file can never later be read as deleted locally.
- **High:** files edited while a sync is running are never overwritten or deleted; they sync next time.
- **High:** GitLab commits lock each file (`last_commit_id`). Concurrent edits from two devices are merged instead of overwritten. Real API errors are no longer mistaken for "another device pushed" (GitHub, Gitea, GitLab).
- Gitea: deep ancestry walk, so devices that were offline for a long time don't trigger mass conflict copies.
- Sync state is stamped with a device id and written atomically. State copied in by iCloud or another tool is ignored.
- "Repository wins" conflict choices move the local version to the trash before replacing it.
- Settings are snapshotted per sync; owner, repository and branch apply when you leave the field.
- Maintenance actions are blocked while a sync runs. Phones default to a 25 MB download limit. Commits reuse the known file list (much faster on GitLab and Gitea). Unicode-normalized case checks.
- Obsidian compliance: zero errors under `eslint-plugin-obsidianmd`; no browser storage (Obsidian's vault-scoped storage and SecretStorage); `getLanguage()`; `fileManager.trashFile()`; no regex lookbehind (iOS < 16.4); no `confirm()`; popout-safe timers; typed API responses; sentence-case UI; minAppVersion 1.11.4.
- LICENSE (MIT); README disclosures for network use, accounts and privacy; release workflow checks the tag against the manifest, runs lint and tests, and publishes build provenance attestations.

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
