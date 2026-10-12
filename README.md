# Vault Sync for Git

**Sync and back up your Obsidian vault with a Git repository on GitHub, GitLab, Gitea or Bitbucket.** It works the same on desktop and mobile (Windows, macOS, Linux, iOS, Android), and you don't need to install Git.

Your vault lives in a repository you own, on the host you choose. Every device syncs through that repository, which also keeps a full history of every change. You can switch hosts at any time in the setup wizard or settings.

| Host | Status | Notes |
|---|---|---|
| **GitHub** (github.com and GitHub Enterprise) | Stable | Every sync is one atomic commit with fast-forward-only updates. |
| **GitLab** (gitlab.com and self-managed) | Beta | Atomic multi-file commits with per-file locking. |
| **Gitea / Forgejo** (including **Codeberg** and self-hosted servers) | Beta | Atomic multi-file commits with per-file locking. Needs Gitea or Forgejo 1.20+. |
| **Bitbucket Cloud** | Beta | Multi-file commits checked against the expected parent. The first sync downloads each file once to index it. |

## Highlights

- **No Git install.** No `git` binary, no `.git` folder, no native code. The plugin talks to your host's API through Obsidian's own network layer, so it behaves the same on every device.
- **Real merging.** Two devices editing different parts of a note are merged line by line. Canvases and frontmatter merge by structure, so tags added on two devices are combined. When the same lines change, both versions are kept, or you pick change by change.
- **Safe by default.** Edits always win over deletions, deleted files go to the trash, a delete guard stops accidental mass deletions, and a file you are editing during a sync is never overwritten.
- **Backups built in.** Every sync is one commit. Restore a single file, a folder or the whole vault to any earlier point, recover deleted files and take snapshot tags.
- **Private by design.** Optional end-to-end encryption means the host only ever stores unreadable data, including file names. Sign in with GitHub instead of pasting a token, and credentials stay in Obsidian's secure storage.
- **See before you sync.** Visual diffs, a review step with checkboxes, and a status panel that shows what's pending and how to fix problems.
- **Fits every device.** Each device can sync only the folders it needs, and big attachments can stay in the repository and be downloaded on demand. Renames travel as renames, even when the file was also edited.
- **Grows with you.** Share a folder with a team through its own repository, keep big media in Git LFS, and use the interface in English, Simplified Chinese, German, Spanish, French, Japanese, Korean or Portuguese.

See [docs/RESEARCH.md](docs/RESEARCH.md) for how this compares with other sync plugins.

## Install

- **Community plugins:** in Obsidian, open Settings → Community plugins → Browse, search for **Vault Sync for Git**, then install and enable it.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest [release](../../releases) into `<vault>/.obsidian/plugins/vault-sync-git/`, then enable the plugin under Community plugins.
- **BRAT:** add this repository in the BRAT plugin to get new releases on each device.

## Setup (once per device)

The quickest way is the **setup wizard**. It opens on first launch, or run **Run setup wizard** from the command palette or settings. It connects your account, lets you pick or create a private repository, asks whether this device should upload, download or merge, and runs the first sync with progress.

### Sign in with GitHub

On github.com you don't need a token:

1. In the wizard (or Settings → Vault Sync for Git), select **Sign in**.
2. Select **Copy and open GitHub**, paste the code on the page that opens, and approve.
3. Select **Choose repositories** and give the *Vault Sync for Git* app access to your vault repository. It can only see the repositories you pick, and only their contents.

Access renews automatically. Signing in is per device and can be undone with **Sign out**. On GitHub Enterprise, an administrator can register their own GitHub App and enter its client ID in settings (see [docs/AUTH.md](docs/AUTH.md)).

### With an access token

For GitLab, Gitea / Forgejo / Codeberg, Bitbucket, or if you prefer a token on GitHub:

1. Create a **private** repository on your host, or use **Create private repo** in the settings.
2. Create an access token (the wizard and settings link straight to the right page):

   | Host | Token |
   |---|---|
   | GitHub | [Fine-grained token](https://github.com/settings/personal-access-tokens/new): *Only select repositories* → your vault repository, **Contents: Read and write**. Add **Administration: Read and write** only if you want the plugin to create the repository. |
   | GitLab | Personal access token with the `api` scope. A project access token (role Developer, scope `api`) limits access to the one project. |
   | Gitea / Forgejo / Codeberg | Settings → Applications: a token with **repository: Read and Write** and **user: Read**. |
   | Bitbucket | Repository access token with **Repositories: Read and Write**. To pick or create repositories in the wizard, use an Atlassian API token with Bitbucket scopes, entered as `email:token`. |

3. In Obsidian, open Settings → Vault Sync for Git, choose the host, paste the token, set owner and repository, then select **Test connection**. For self-hosted servers and GitHub Enterprise, also set the API URL.
4. Run **Sync now** (ribbon icon, status bar or command palette).

Repeat on each device with the same repository. An existing vault on a second device is safe: the first sync never deletes anything, and any file that differs is kept in both versions.

The token is stored only on the device, in Obsidian's secure storage. It is never written to `data.json`, so it is never uploaded, even with settings-folder sync on.

## How a sync works

1. Hashes local files (cached by modified time and size, so this is fast).
2. Reads the remote branch. If nothing changed on either side, it stops after one request.
3. Compares each file with the version from the last sync (a three-way comparison):
   - changed only on this device → upload; changed only in the repository → download
   - deleted on one side only → delete on the other (to the trash)
   - changed on both sides → merge, or resolve the conflict
4. Uploads everything as **one commit**. If another device pushed in the meantime, it reads the new changes and tries again.

## Features

### Syncing

- **Triggers:** on startup, after edits (debounced), on a timer, when the app returns to the foreground or goes to the background, and manually.
- **Modes:** two-way sync, backup only (upload, never changes local files) or pull only (read-only copy).
- **Scope:** gitignore-style exclude patterns (`*`, `**`, `?`, `/` to anchor, `!` to re-include; the last matching pattern wins; brackets are literal), a maximum file size, and optional sync of the settings folder (themes, snippets, plugins, hotkeys). Files outside scope are never touched on either side.
- **Renames and moves** are detected, also when the file was edited at the same time. Nothing is downloaded again, open tabs and bookmarks follow the file, and moving a whole folder doesn't trip the delete guard.
- **Line endings:** a change that is only CRLF ↔ LF is ignored (on by default).
- **Fast on phones:** only files whose timestamps changed, or that Obsidian reports as edited, are re-checked, with a periodic full rescan as a safety net. Hashing yields to the interface so Obsidian never freezes.

### Merging and conflicts

When a file changed on both sides, choose what happens: **merge automatically** (default, keeps both versions if the same lines changed), merge with `<<<<<<<` markers, keep both, **ask me each time**, this device wins, or the repository wins.

- Markdown merges line by line. Frontmatter merges key by key, and lists such as `tags` and `aliases` merge as sets: adding tag A on your phone and tag B on your laptop gives you both.
- `.canvas` and JSON files merge card by card and setting by setting.
- With **Ask me each time**, a side-by-side dialog lets you keep this device's version, the repository's version, or both, for each changed block.
- A conflict copy can be **resolved** later from the status panel: pick change by change, the result goes into the note, and the copy goes to the trash.
- Two conflicts on the same note never overwrite each other's copies.

### Backups and history

- One commit per sync. Commits carry a `Device:` line, so you can see which device made each change.
- **Version history** of any file from the file menu, with **Compare with current**.
- **Timeline:** browse every sync and snapshot, and restore the whole vault or a single folder to an earlier point. Restores are new commits, so history is never rewritten and a restore can be undone the same way.
- **Recover deleted files**, plus daily or manual snapshot tags.
- **Make this device match the repository** discards unsynced local changes. Replaced and removed files go to the trash first.

### See before you sync

- **Visual diffs:** side by side on desktop, single column on mobile.
- **Review changes and sync:** every pending change with a checkbox and a diff. Unticked files are left alone on both sides until the next sync. Turn on *Review before manual sync* to make this the default.
- **Preview sync (dry run)** lists what the next sync would do, with diffs, and changes nothing.
- **Sync status panel** (ribbon icon, or click the status bar):
  - the current state, and the last error in plain language with a fix button
  - files edited since the last sync, and whether the repository has newer changes
  - conflict copies, with **Resolve** (pick change by change, then the copy goes to the trash), Compare, Open and Delete copy buttons
  - files skipped in the last sync and why, and files kept in the repository only
  - when each device last synced, the API budget (GitHub) and the next scheduled sync
- **Sync log**, status bar (desktop) and a spinning ribbon icon while syncing.

### End-to-end encryption

Settings → *End-to-end encryption*, or in the setup wizard.

- Content and file names are encrypted on your device before upload, with AES-256-GCM. The key comes from your passphrase through PBKDF2-SHA256 with 600,000 iterations, and file names become opaque paths.
- Change detection, merging, rename detection, history, restore and the timeline all keep working.
- Other devices unlock with the same passphrase. A device without it, or with a different one, is refused instead of downloading unreadable files.
- To encrypt an existing repository, *Remove unencrypted copies* deletes the old plain files in one commit. Their history still contains them, so for full privacy start with a new, empty repository.
- **There is no passphrase recovery.** Keep it in a password manager.

### Per-device settings

Settings → *This device only*. These are stored on the device and never synced.

- Sync only some folders (for example `Daily/` on your phone) and exclude more patterns.
- **Attachments on demand:** files above a size limit stay in the repository and are listed instead of downloaded. Phones default to 25 MB. On GitLab the limit can't apply, because GitLab doesn't report file sizes. Download them from the status panel, from **Download files that aren't on this device**, or from the **Download** button that reading view shows in place of a missing embed. A downloaded file then stays in sync on that device.
- **Free up space** removes local copies this device doesn't need, but only when they are identical to the repository copy.
- Changing any of these triggers a full comparison on the next sync.

### Shared folders

Settings → *Shared folders*. Sync one folder with its own repository, for example `Work/` ↔ `team/notes`, while the rest of your vault stays in your private repository.

- The folder maps to the root of the shared repository, so collaborators can use it as a normal vault or repository.
- Each shared folder has its own state, can use its own host and token, and syncs after the main vault. Its status appears in the status panel.
- The main repository never touches shared folders.

### Large files with Git LFS

Settings → *Large file storage threshold*. Files at least this big go to the host's large-file storage, and the repository keeps a small pointer.

- Works with GitHub, GitLab and Gitea through the standard LFS batch API. Bitbucket uses the same API but is untested.
- Every device reads LFS files correctly, even if it doesn't upload with LFS.
- Turning it on converts existing large files on the next sync, without conflicts.
- Check your host's LFS quota.

### Languages and settings search

The interface follows Obsidian's language. Every screen is available in English, Simplified Chinese, German, Spanish, French, Japanese, Korean and Portuguese (Brazil). Corrections are welcome, and adding a language is one file: see [docs/TRANSLATING.md](docs/TRANSLATING.md). On Obsidian 1.13+ the plugin's settings appear in Obsidian's settings search.

### Other

Custom API URL for GitHub Enterprise and self-hosted servers, commit message template, and device names (shown in commits and on conflict copies).

## Commands

| Command | What it does |
|---|---|
| Sync now | Two-way sync |
| Review changes and sync | Pick which changes to sync, with diffs |
| Preview sync (dry run) | Show what a sync would do |
| Pull only (download changes) | Download without uploading |
| Back up only (upload changes) | Upload without changing local files |
| Open sync status panel | State, pending changes, conflicts and devices |
| Run setup wizard | Connect a host and repository |
| End-to-end encryption: turn on or unlock | Set or enter the passphrase |
| Download files that aren't on this device | Attachments on demand |
| Free up space on this device | Remove local copies this device doesn't need |
| Timeline: restore vault or folder to an earlier point | Point-in-time restore |
| Make this device match the repository (discard local changes) | Reset this device |
| Create backup snapshot | Tag the current state |
| Show history of current file | Version history |
| Compare current file with the repository | Diff against the repository's latest version |
| Recover deleted files | Restore files deleted in earlier syncs |
| Show sync log | Recent sync activity |
| Open repository in browser | Open the repository on your host |

## Requirements

- Obsidian 1.11.4 or newer, on desktop (Windows, macOS, Linux) or mobile (iOS, Android).
- An account with a supported Git host and an access token.

## Network use, accounts and privacy

This section covers the disclosures Obsidian's developer policies require.

- **Account required.** You need an account with a Git host (GitHub, GitLab, Bitbucket, or a Gitea / Forgejo / Codeberg server) and an access token. The plugin itself is free; no payment.
- **Network use.** The plugin only connects to the Git host **you configure**, to read and write your repository:
  - `api.github.com` (or your GitHub Enterprise server), `gitlab.com` (or your GitLab server), your Gitea / Forgejo / Codeberg server, or `api.bitbucket.org`
  - with Sign in with GitHub, also `github.com/login/device/code` and `github.com/login/oauth/access_token` to sign in and renew access
  - the same host's Git LFS endpoint, if you turn on large file storage
  - for GitHub LFS, the file-storage address GitHub returns for each upload or download
- **No telemetry, no ads, no third-party services.** Nothing is sent anywhere except your own repository host. The author runs no servers.
- **Files.** The plugin lists and reads the files in your vault to sync them, and writes only inside your vault, including the vault's settings folder if you turn on settings sync. It keeps its own state in its plugin folder.
- **Your data stays in your repository.** With end-to-end encryption on, the host only stores encrypted content and encrypted file names.

## Security notes

- The token, API URL and device name are stored per device and never synced. A changed `data.json` arriving from another device cannot send your token anywhere else.
- Use a token limited to the vault repository. If it leaks, the damage is limited to that one repository.
- **Sign in with GitHub** uses the *Vault Sync for Git* GitHub App with only *Contents: read and write* on the repositories you choose. Its access token lasts 8 hours and is renewed on the device; no client secret exists in the plugin, and the author never sees your tokens or data. Revoke it any time in GitHub → Settings → Applications.
- For pasted GitHub tokens, the status panel warns two weeks before the token expires, and a notice appears in the last week.
- With **settings-folder sync** on, plugin code (`.obsidian/plugins/*/main.js`) syncs too. Anyone who can push to the repository can then run code on your devices. Keep the repository private and don't give others write access.
- Remote paths are validated (no `..`, no absolute paths, no empty segments) before anything is written.
- **End-to-end encryption limits.**
  - Encrypted files still reveal approximate file sizes and path lengths, and whether two files are identical.
  - Content isn't bound to its path, so someone with write access to the repository could swap or roll back encrypted files. They still can't read or forge content.
  - Shared folders are never encrypted, because collaborators must read them.
- **Deleting files.** Local deletions follow Obsidian's *Deleted files* setting (system trash, `.trash` folder, or permanent). Keep a trash option on if you want local deletions recoverable; everything also stays in the repository's history.
- **Data-safety guarantees.**
  - A file you are editing while a sync runs is never overwritten; it waits for the next sync.
  - A missing or renamed branch never reads as "everything was deleted".
  - Sync state copied in from another device (for example by iCloud) is ignored.

## Host notes

- **GitHub:** stable. Every sync is one atomic commit with fast-forward-only updates.
- **GitLab:** beta. Atomic multi-file commits with per-file locking (`last_commit_id`), so concurrent edits from two devices are merged, never overwritten. GitLab's API doesn't report file sizes, so the size limits can't skip large files there; use LFS for big media.
- **Gitea / Forgejo (1.20+), Codeberg:** beta. Atomic multi-file commits with per-file locking. Very large uploads are split into several commits. The server's API refuses files above its blob limit (10 MB by default); such files are reported instead of synced, so use Git LFS for them.
- **Bitbucket Cloud:** beta. Commits carry the expected parent, so a concurrent push is detected. Bitbucket's API has no file hashes, so the plugin keeps a hash index of the repository on each device (in its plugin folder, never synced); after the first sync only changed files are fetched.
- Snapshots are tags on every host. The API budget is shown for GitHub only.

## Limits

- GitHub rejects files over 100 MB (the default limit here is 50 MB). Use Git LFS or exclude patterns for large media.
- Plugin code synced through the settings folder needs an Obsidian restart on the other device to load.
- A case-only rename (for example `Note.md` → `note.md`) takes two syncs to settle on case-insensitive devices; the file sits in the trash in between.
- Sign in with GitHub works on github.com. GitLab, Gitea and Bitbucket use access tokens.
- GitHub is tested against the real API on every release. GitLab, Gitea and Bitbucket are tested against simulated servers, which is why they are marked beta. Reports from real servers and phones are welcome.

## Development

```bash
npm ci
npm run dev      # watch build
npm test         # unit tests and multi-device simulation against fake GitHub, GitLab, Gitea, Bitbucket and LFS servers
VSG_LIVE_TOKEN=$(gh auth token) VSG_LIVE_REPO=owner/throwaway-repo npm run test:live   # real GitHub API, including encrypted sync
npm run build    # type-check and production bundle
npm run lint     # Obsidian's official review rules (eslint-plugin-obsidianmd)
```

Main source files:

| File | Purpose |
|---|---|
| `src/sync.ts`, `src/plan.ts` | Sync engine and three-way decisions |
| `src/merge.ts`, `src/smartmerge.ts` | Line merge (diff3) and structure-aware merge for JSON, canvas and frontmatter |
| `src/remote.ts`, `src/hosts.ts` | Host interface and registry |
| `src/github.ts`, `src/gitlab.ts`, `src/gitea.ts`, `src/bitbucket.ts` | Host clients on Obsidian's `requestUrl` |
| `src/codec.ts`, `src/crypto.ts`, `src/lfs.ts` | Shared-folder mapping, encryption and Git LFS layers |
| `src/main.ts`, `src/settings-tab.ts`, `src/wizard.ts`, `src/health.ts`, `src/ui.ts` | Plugin, settings, setup wizard, status panel and dialogs |
| `src/locales/` | Translations |

See [CONTRIBUTING.md](CONTRIBUTING.md) to report bugs or send changes, [CHANGELOG.md](CHANGELOG.md) for what changed in each release, and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

## License

[MIT](LICENSE)
