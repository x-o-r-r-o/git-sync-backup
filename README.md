# Vault Sync for GitHub

Sync and back up an Obsidian vault across **desktop and mobile** (Windows, macOS, Linux, iOS, Android) using a private Git repository on **GitHub**, **GitLab** (beta) or **Gitea / Forgejo / Codeberg** (beta), optionally **end-to-end encrypted**.

- **No dependencies.** No git install, no `.git` folder, no native code. It talks to the GitHub API through Obsidian's own network layer, so it behaves the same on every device.
- **Real merging.** If two devices edit different parts of the same note, the changes are merged line by line. If they edit the same lines, both versions are kept (or you choose).
- **Safe by default.** Edits always win over deletions, deleted files go to the trash, and a delete guard stops accidental mass deletions.
- **Backups built in.** Every sync is one commit, so the full history lives on GitHub. Per-file version history and restore, recovery of deleted files, and manual or daily snapshot tags.
- **Grows with you (v0.5).** Share a folder with a team through its own repository, keep big media in Git LFS, and use the interface in your language.
- **Private by design (v0.4).** Optional end-to-end encryption: the host only ever stores unreadable data, including file names. Tokens are kept in Obsidian's secure storage.
- **Understands your vault (v0.3).** Renames travel as renames, canvases and frontmatter merge by structure, each device can sync only what it needs, and a setup wizard gets a new device running in a minute.
- **See before you sync (v0.2).** Visual diffs everywhere, review-and-pick before syncing, change-by-change conflict resolution, a sync health panel, and point-in-time restore of the whole vault or one folder.

See [docs/RESEARCH.md](docs/RESEARCH.md) for the comparison with existing plugins and the gaps this one closes.

## Setup (once per device)

The quickest way is the **setup wizard**. It opens automatically on first launch, or run **Setup wizard** from settings or the command palette. It connects your account, lets you pick or create a private repository, asks whether this device should upload, download or merge, and runs the first sync with progress.

Manual setup:

1. Create a **private** repository on GitHub, or use **Create private repo** in the settings.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: *Only select repositories* → your vault repo
   - Permissions → Repository → **Contents: Read and write** (Metadata read is added automatically)
   - Add **Administration: Read and write** only if you want the plugin to create the repo for you.
3. In Obsidian: Settings → Vault Sync for GitHub → paste the token, set owner and repository → **Test connection**.
4. Run **Sync now** (ribbon icon, status bar, or command palette).

Repeat on each device: install the plugin, paste the token, same owner/repo. An existing vault on a second device is safe: the first sync never deletes anything, and any file that differs is kept in both versions.

The token is stored only on the device, in Obsidian's secure SecretStorage. It is never written to `data.json`, so it is never uploaded, even with settings-folder sync on.

## How a sync works

1. Hashes local files (cached by modified time and size, so this is fast).
2. Reads the remote branch. If nothing changed on either side, it stops after one API call.
3. Compares each file against the version from the last sync (a three-way comparison):
   - changed only here → upload; changed only on GitHub → download
   - deleted only on one side → delete on the other (to the trash)
   - changed on both sides → merge or resolve the conflict
4. Uploads everything as **one commit**. If another device pushed in the meantime, it re-reads and retries.

## Features

| Area | What you get |
|---|---|
| Triggers | on startup, after edits (debounced), periodic interval, when the app comes back to the foreground, when it goes to the background, manual |
| Modes | Two-way sync · Backup only (push, never touches local files) · Pull only (read-only mirror) |
| Conflicts | Auto merge (default) · merge with `<<<<<<<` markers · keep both · ask (side-by-side dialog) · this device wins · GitHub wins |
| Scope | Optional settings-folder sync (themes, snippets, plugins, hotkeys); gitignore-style excludes; max file size. Files outside scope are never touched on either side |
| Safety | Delete guard, edit beats delete, trash instead of delete, skips files whose names differ only by letter case, retry and backoff on bad networks, rate-limit aware |
| Backup | One commit per sync, daily or manual snapshot tags, **Version history** in the file menu, **Recover deleted files** |
| Visibility | Status bar (desktop), spinning ribbon icon, sync log, **Preview sync (dry run)** |
| Other | GitHub Enterprise (custom API URL), commit message template, device names |

## New in v0.5

- **Shared folders** (Settings → *Shared folders*). Sync one folder with its own repository, for example `Work/` ↔ `team/notes`, while the rest of your vault stays in your private repository.
  - The folder maps to the root of the shared repository, so collaborators can use it as a normal vault or repository.
  - Each shared folder has its own state, can use its own token and host, and syncs after the main vault. Its status appears in the status panel.
  - The main repository never touches shared folders.
- **Large files with Git LFS** (Settings → *Store large files with Git LFS*). Files above a size you choose go to the host's large-file storage, and the repository keeps a small pointer.
  - Works with GitHub, GitLab and Gitea through the standard LFS batch API.
  - Every device reads LFS files correctly even if it doesn't upload with LFS.
  - Turning it on converts existing big files on the next sync, with no conflicts.
  - Check your host's LFS quota.
- **Translations.** The interface follows Obsidian's language. Commands, the status panel and notifications are available in English and Simplified Chinese. Contributions are welcome: see [docs/TRANSLATING.md](docs/TRANSLATING.md).

## New in v0.4

- **End-to-end encryption** (Settings → *End-to-end encryption*, or in the setup wizard).
  - What gets encrypted: content and file names, on your device, before upload. Files are encrypted with AES-256-GCM, the key comes from your passphrase through PBKDF2-SHA256 with 600,000 iterations, and names become opaque paths.
  - What keeps working: change detection, merges, rename detection, history, restore and the timeline all work on the encrypted repository.
  - Joining from another device: other devices unlock with the same passphrase. A device without it is refused instead of downloading gibberish, and so is a device with a different passphrase.
  - Moving an existing repository to encryption: *Remove unencrypted copies* deletes the old plain files in one commit. Their history still contains them, so for full privacy start with a new, empty repository.
  - **There is no passphrase recovery.** Keep it in a password manager.
- **GitLab and Gitea / Forgejo / Codeberg** support (beta). Choose the host in the wizard or settings, with host-specific token instructions. Commits use GitLab's Commits API and Gitea's multi-file ChangeFiles API, so every sync is still one commit (very large uploads are split into parts).
- **Safer tokens.**
  - Tokens are stored in Obsidian's SecretStorage.
  - The GitHub token link prefills name, expiry and `contents=write`.
  - "Sign in with GitHub" (GitHub App device flow) has been researched and planned: see [docs/AUTH.md](docs/AUTH.md).

## New in v0.3

- **Rename and move detection.** A note renamed or moved on another device is renamed here: nothing is downloaded again, and open tabs and bookmarks follow it. If you rename a note on one device while editing it on another, the edit lands under the new name instead of creating a duplicate. Moving a whole folder no longer trips the delete guard. Commit messages say "N renamed".
- **Structure-aware merging.**
  - `.canvas` and JSON files merge card by card and setting by setting. Text inside a card merges line by line.
  - In Markdown, frontmatter merges key by key, and lists such as `tags` and `aliases` merge as sets. Adding tag A on your phone and tag B on your laptop gives you both.
  - The note body still uses the line-by-line merge. Anything ambiguous is kept as both versions.
- **Per-device scope** (Settings → *This device only*, stored on the device and not synced):
  - sync only some folders (for example `Daily/` on your phone)
  - exclude more patterns
  - don't download attachments larger than N MB
  - **Free up space**: removes local copies this device doesn't need, but only when they are identical to the copy on GitHub.

  Files outside a device's scope are never uploaded, downloaded or deleted from that device.
- **Setup wizard** with a searchable repository picker, a "create a private repo" button, an upload / download / merge choice for the first sync, and live progress.

## New in v0.2

- **Visual diff viewer.** Side by side on desktop, single column on mobile, with line numbers and collapsible unchanged lines. Shown in review, version history ("Compare with current"), conflicts, and the new **Compare with GitHub** command and file-menu item.
- **Change-by-change conflict resolution.** With "Ask me each time", every changed block gets *This device / GitHub / Both* buttons, plus whole-file options.
- **Sync status panel** (ribbon icon, or click the status bar). It shows:
  - the current state, and the last error in plain language with a fix button (Open settings / Try again)
  - files edited since the last sync, and whether GitHub has newer changes
  - conflict copies, each with Compare / Open / Delete copy
  - files skipped in the last sync, and why
  - when each device last synced
  - the API budget and the next scheduled sync
- **Review before sync.** Every pending change with a checkbox and a diff. Unticked files are deferred and left alone on both sides. Turn on *Review before manual sync* to make it the default.
- **Timeline and point-in-time restore.** Browse every sync and snapshot, browse files at any point, and restore the **whole vault or a single folder**. Restores are new commits, so history is never rewritten and you can undo a restore the same way.
- **Make this device match GitHub.** Discards unsynced local changes; replaced and removed files go to the trash first.
- **Faster on phones.** Only files whose timestamps changed, or that Obsidian reports as edited, are re-checked. The settings folder is read from disk at most every 5 minutes. A full rescan runs periodically as a safety net. Hashing yields to the UI so Obsidian never freezes.
- **Line-ending safety.** A change that is only CRLF ↔ LF is ignored (on by default).
- Commits now carry a `Device:` trailer, which the status panel uses to show per-device activity.

## Commands

Sync now · Review changes and sync · Open sync status panel · Run setup wizard · End-to-end encryption: turn on or unlock · Free up space on this device · Pull from GitHub only · Back up to GitHub only (push) · Preview sync (dry run) · Timeline: restore vault or folder to an earlier point · Make this device match GitHub · Create backup snapshot on GitHub · Show sync log · Show history of current file · Compare current file with GitHub · Recover deleted files · Open repository on GitHub

## Requirements

- Obsidian 1.11.4 or newer, on desktop (Windows, macOS, Linux) or mobile (iOS, Android). Tokens and encryption keys are kept in Obsidian's SecretStorage.
- Phones default to not downloading files over 25 MB (Settings → *This device only*), because very large files are memory-heavy on mobile.

## Install

**Community plugins:** once listed, search for "Vault Sync for GitHub" in Settings → Community plugins.

**Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest [release](../../releases) into `<vault>/.obsidian/plugins/vault-sync-github/`, then enable the plugin under Community plugins.

**BRAT:** add this repository in the BRAT plugin to get the latest release on each device.

## Development

```bash
npm install
npm run dev      # watch build
npm test         # unit tests + two-device simulation against an in-memory GitHub (90 tests, including fake GitLab, Gitea and LFS servers)
VSG_LIVE_TOKEN=$(gh auth token) VSG_LIVE_REPO=owner/throwaway-repo npm run test:live   # real GitHub API (13 tests, including encrypted sync)
npm run build    # type-check + production bundle
npm run lint     # Obsidian's official review rules (eslint-plugin-obsidianmd)
```

Source layout: `src/sync.ts` (engine), `src/plan.ts` (three-way decisions), `src/merge.ts` (diff3), `src/github.ts` (REST client on `requestUrl`), `src/io.ts` (vault access), `src/ui.ts` and `src/settings-tab.ts`.

## Network use, accounts and privacy

This section covers the disclosures Obsidian's developer policies require.

- **Account required.** You need an account with a Git host (GitHub, GitLab, or a Gitea / Forgejo / Codeberg server) and an access token. The plugin itself is free; no payment.
- **Network use.** The plugin only connects to the Git host **you configure**, to read and write your repository:
  - `api.github.com` (or your GitHub Enterprise server), `gitlab.com` (or your GitLab server), or your Gitea / Forgejo / Codeberg server
  - the same host's Git LFS endpoint, if you turn on large file storage
  - for GitHub LFS, the file-storage address GitHub returns for each upload or download
- **No telemetry, no ads, no third-party services.** Nothing is sent anywhere except your own repository host. The author runs no servers.
- **Files.** The plugin reads and writes only files inside your vault, including the vault's settings folder if you turn on settings sync. It keeps its own state in its plugin folder.
- **Your data stays in your repository.** With end-to-end encryption on, the host only stores encrypted content and encrypted file names.

## Security notes

- The token, API base URL and device name are stored per device and never synced. A changed `data.json` arriving from another device cannot send your token anywhere else.
- Use a fine-grained token scoped to the vault repo only. If it leaks, the damage is limited to that one repo.
- With **settings-folder sync** on, plugin code (`.obsidian/plugins/*/main.js`) syncs too. Anyone who can push to the repo can then run code on your devices. Keep the repo private and don't give others write access.
- Remote paths are validated (no `..`, no absolute paths, no empty segments) before anything is written.
- **End-to-end encryption limits.**
  - Ciphertext reveals approximate file sizes and path lengths, and whether two files are identical.
  - Content isn't bound to its path, so someone with write access to the repository could swap or roll back encrypted files. They still can't read or forge content.
  - Shared folders are never encrypted, because collaborators must read them.
- **Deleting files.** Local deletions follow Obsidian's *Deleted files* setting (system trash, `.trash` folder, or permanent). Keep a trash option on if you want local deletions recoverable; everything also stays in the repository's history.
- **Data-safety guarantees.**
  - A file you are editing while a sync runs is never overwritten; it waits for the next sync.
  - A missing or renamed branch never reads as "everything was deleted".
  - Sync state copied in from another device (for example by iCloud) is ignored.

## Host notes

- **GitHub:** fully supported. Every sync is one atomic commit with fast-forward-only updates.
- **Gitea / Forgejo (1.20+), Codeberg:** beta. Atomic multi-file commits with per-file optimistic locking.
- **GitLab:** beta. Atomic multi-file commits with per-file locking (`last_commit_id`), so concurrent edits from two devices are merged, never overwritten. GitLab's API doesn't report file sizes, so the size limits can't skip large files there; use LFS for big media.
- Snapshots are tags on every host. The API budget is shown for GitHub only.

## Limits

- GitHub rejects files over 100 MB (default limit here is 50 MB). Keep large media out with exclude patterns.
- Plugin code synced through the settings folder needs an Obsidian restart on the other device to load.
- No Git LFS.
- A case-only rename (for example `Note.md` → `note.md`) takes two syncs to settle on case-insensitive devices; the file sits in the trash in between.
