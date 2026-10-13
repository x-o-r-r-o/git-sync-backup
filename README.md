# Vault Sync for Git

**Sync and back up your Obsidian vault with a Git repository on GitHub, GitLab, Gitea or Bitbucket.** It works the same on desktop and mobile (Windows, macOS, Linux, iOS, Android), and you don't need to install Git.

Your vault lives in a repository you own, on the host you choose. Every device syncs through that repository, which also keeps a full history of every change. You can switch hosts at any time in the setup wizard or settings.

| Host | Status | Notes |
|---|---|---|
| **GitHub** (github.com and GitHub Enterprise) | Stable | Every sync is one atomic commit with fast-forward-only updates. |
| **GitLab** (gitlab.com and self-managed) | Beta, live-tested | Atomic multi-file commits with per-file locking. |
| **Gitea / Forgejo** (including **Codeberg** and self-hosted servers) | Beta, live-tested | Atomic multi-file commits with per-file locking. Needs Gitea or Forgejo 1.20+. |
| **Bitbucket Cloud** | Beta, live-tested | Multi-file commits checked against the expected parent. The first sync downloads each file once to index it. |

*Live-tested* means the full sync test suite passed against the real gitlab.com, codeberg.org and bitbucket.org for this release. Gitee and Azure DevOps were removed in 1.4.0.

## Highlights

- **No Git install.** No `git` binary, no `.git` folder, no native code. The plugin talks to your host's API through Obsidian's own network layer, so it behaves the same on every device.
- **Real merging.** Two devices editing different parts of a note are merged line by line. Canvases and frontmatter merge by structure, so tags added on two devices are combined. When the same lines change, both versions are kept, or you pick change by change.
- **Safe by default.** Edits always win over deletions, deleted files go to the trash, a delete guard stops accidental mass deletions, and a file you are editing during a sync is never overwritten.
- **Backups built in.** Every sync is one commit. Restore a single file, a folder or the whole vault to any earlier point, recover deleted files and take snapshot tags. A **sync history** sidebar shows every sync with its files and diffs.
- **Private by design.** Optional end-to-end encryption means the host only ever stores unreadable data, including file names. Sign in with GitHub or GitLab instead of pasting a token, and credentials stay in Obsidian's secure storage.
- **See before you sync.** Visual diffs, a review step with checkboxes, and a status panel that shows what's pending and how to fix problems. In the editor, lines changed since the last sync are marked in the margin, with one-click revert and *who last changed this line*.
- **Fits every device.** Each device can sync only the folders it needs, and big attachments can stay in the repository and be downloaded on demand. Choose which parts of the settings folder sync, down to single plugins. Renames travel as renames, even when the file was also edited.
- **A new device in seconds.** Scan a QR code or open a setup link from a device that already syncs. The plugin warns when another sync tool (Obsidian Sync, iCloud, Obsidian Git, …) is active on the same vault.
- **Grows with you.** Share a folder with a team through its own repository (conflicts can become pull requests), keep big media in Git LFS, mirror everything to a second repository as a backup, and use the interface in English, Simplified Chinese, German, Spanish, French, Japanese, Korean or Portuguese.
- **You stay in control.** Pause syncing, save battery on phones, pick the branch, open any note on the host, and make the repository match this device in one forward commit when you need to. Keep notes with `sync: false` on one device, grey out what isn't synced, keep the vault in a folder of a bigger repository, and sync and close in one step.

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
3. Pick your vault repository from **Repositories the app can use**. If it isn't listed yet, select **Add repositories on GitHub**, choose it there and come back: the list updates by itself, and newly added repositories are marked **New**. The app can only see the repositories you pick, and only their contents.

Access renews automatically. Signing in is per device and can be undone with **Sign out**. On GitHub Enterprise, an administrator can register their own GitHub App and enter its client ID in settings (see [docs/AUTH.md](docs/AUTH.md)).

### Sign in with GitLab

On gitlab.com you don't need a token either: choose GitLab as the host, select **Sign in**, then **Copy and open GitLab**, and approve (the code is filled in). Access lasts two hours at a time and renews automatically; signing in is per device and can be undone with **Sign out**. On a self-managed GitLab server (17.9+), create a non-confidential OAuth application with **Device authorization grant** ticked and the `api` scope (Edit profile → Applications, see [docs/AUTH.md](docs/AUTH.md)) and enter its Application ID in settings (*GitLab application ID*).

### With an access token

For Gitea / Forgejo / Codeberg, Bitbucket, or if you prefer a token on GitHub or GitLab:

1. Create a **private** repository on your host, or use **Create private repository** in the settings.
2. Create an access token (the wizard and settings link straight to the right page):

   | Host | Token |
   |---|---|
   | GitHub | [Fine-grained token](https://github.com/settings/personal-access-tokens/new): *Only select repositories* → your vault repository, **Contents: Read and write**. Add **Administration: Read and write** only if you want the plugin to create the repository. |
   | GitLab | Personal access token with the `api` scope. A project access token (role Developer, scope `api`) limits access to the one project. |
   | Gitea / Forgejo / Codeberg | Settings → Applications: a token with **repository: Read and Write** and **user: Read** (**user: Read and Write** if you want the plugin to create the repository). |
   | Bitbucket | Repository access token with **Repositories: Read and Write**. To pick or create repositories in the wizard, use an Atlassian API token with Bitbucket scopes, entered as `email:token`. |

3. In Obsidian, open Settings → Vault Sync for Git, choose the host, paste the token, set owner and repository (or select **Choose** next to *Repository* to pick from your repositories), then select **Test connection**. For self-hosted servers and GitHub Enterprise, also set the API URL.
4. Run **Sync now** (ribbon icon, status bar or command palette).

Repeat on each device with the same repository. An existing vault on a second device is safe: the first sync never deletes anything, and any file that differs is kept in both versions.

### Add another device with a link or QR code

On a device that already syncs, choose **Add another device** (status panel, settings, or the command palette). It shows a QR code and a link with the host, repository, branch and your sync choices. Install the plugin on the new device, then scan the code with its camera or open the link there. The new device shows exactly what the link will change and asks before applying it.

- Signed in with GitHub or GitLab: the new device signs in itself; the sign-in token is never put in a link.
- With a token: optionally include it. It is encrypted with a one-time code that is shown next to the QR code and never included in the link; type it on the new device.
- Only open setup links you created yourself.

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
- **Modes:** two-way sync, backup only (upload; never changes your files, and when the repository also changed a file its version is saved next to yours as a conflict copy) or pull only (read-only copy).
- **Scope:** gitignore-style exclude patterns (`*`, `**`, `?`, `/` to anchor, `!` to re-include; the last matching pattern wins; brackets are literal) and a maximum file size. Files outside scope are never touched on either side. With *Show sync status in the file explorer* on, files and folders that don't sync are greyed out (tooltip *Not synced*). The file menu has **Git: Exclude this file from sync** and, for anything your patterns leave out, **Git: Include in sync**; **Edit exclude patterns** (command) opens the patterns in a window.
- **Leave out a note with `sync: false`:** a note whose properties (frontmatter) say `sync: false` stays on the device: it is never uploaded, and a copy already in the repository is kept as it is (not deleted, not downloaded over the local note). Other devices sync it as usual unless their copy says the same. On by default (*Respect sync: false in frontmatter*).
- **Vault in a folder of the repository** (Settings → *Folder in the repository*, or the wizard's repository step): keeps the vault in, say, `vaults/personal/` of a monorepo or a repository shared by several vaults. Everything outside that folder is never downloaded, changed or deleted. Changing the folder starts a fresh comparison that deletes nothing, but files already at the new location are downloaded into the vault and the vault's files are uploaded there (the plugin asks first and warns when that folder already has files). With several vaults in one repository, give each its own folder: the folders must not be nested inside each other (`vaults/a/` and `vaults/a/b/`), and no vault may use the repository root while others use subfolders, or one vault would see the other's files as its own. Each vault in a folder keeps its own end-to-end encryption marker (`<folder>/.vault-sync/encryption.json`), so encrypting one vault doesn't affect the others.
- **Settings folder, part by part:** turn on settings-folder sync, then choose appearance and themes, CSS snippets, hotkeys, core settings, which plugins are on, plugin code and plugin settings separately. **Choose per plugin** sets single plugins to code and settings, code only, settings only, or this device only, which is useful for plugins that store device-specific paths. Your exclude patterns still have the last word.
- **Hidden files** (optional): files and folders at the top of the vault whose names start with a dot, such as `.github/` or `.editorconfig`. Turn on **Hidden files inside folders** to also include ones inside your notes folders (for example `Notes/.assets/`). Never `.git`, `.trash` or the settings folder.
- **`.gitignore`** (optional): files listed in the vault's `.gitignore` files are not synced (a `.gitignore` inside a folder applies to that folder, as in Git), and the `.gitignore` files themselves sync to every device.
- **Sync current file now** (command) syncs only the open note; everything else waits for the next sync. **Sync when opening a note** (optional) fetches its latest version first, at most every 30 seconds.
- **Renames and moves** are detected, also when the file was edited at the same time. Nothing is downloaded again, open tabs and bookmarks follow the file, and moving a whole folder doesn't trip the delete guard. Lines a note shares with its neighbours (a template) don't count, so a deleted note and a new note from the same template aren't mistaken for a rename.
- **Line endings:** a change that is only CRLF ↔ LF is ignored (on by default).
- **Fast on phones:** only files whose timestamps changed, or that Obsidian reports as edited, are re-checked, with a periodic full rescan as a safety net. Hashing yields to the interface so Obsidian never freezes.

### Merging and conflicts

When a file changed on both sides, choose what happens: **merge automatically** (default: changes to different lines are combined, and both versions are kept when the same lines changed), merge with `<<<<<<<` markers, keep both, **ask me each time**, this device wins, or the repository wins.

- Markdown merges line by line. Frontmatter merges key by key, and lists such as `tags` and `aliases` merge as sets: adding tag A on your phone and tag B on your laptop gives you both.
- `.canvas` and JSON files merge card by card and setting by setting.
- **Conflict markers in the editor:** when a note contains `<<<<<<<` / `=======` / `>>>>>>>` blocks (from *merge with markers*, or anywhere else), each block gets **Keep this device**, **Keep repository** and **Keep both** buttons right in the note. The two sides are tinted and the marker lines show as small labels. If a side itself contains a marker-like line, the plugin keeps both versions as files instead of writing markers.
- With **Ask me each time**, a side-by-side dialog lets you keep this device's version, the repository's version, or both, for each changed block.
- A conflict copy can be **resolved** later from the status panel: pick change by change (images and other binary files: pick a whole version), the result goes into the note, and the copy goes to the trash. Conflict copies are listed even before sync is set up.
- Two conflicts on the same note never overwrite each other's copies.

### Backups and history

- One commit per sync. Commits carry a `Device:` line, so you can see which device made each change.
- **Version history** of any file from the file menu (**Git: Version history**, next to Obsidian Sync's own *Open version history*), with **Compare with current**. History follows the file back through renames: versions from before a rename show the name the file had then, and open and restore correctly.
- **Timeline:** browse every sync and snapshot, and restore the whole vault or a single folder to an earlier point. Restores are new commits, so history is never rewritten and a restore can be undone the same way.
- **Sync history sidebar** (ribbon or **Open sync history**): every sync with its date, device and author, and its changed files (added, modified, deleted, renamed; encrypted names shown decrypted). Click a file for its diff, restore a single file, browse the files at that point or restore a folder or the whole vault. Filter by path, load older syncs, works with keyboard and on mobile.
- **Use the repository version** of one file (in *Compare with repository*, the status panel's list of edited files, the file menu and a command): replaces the file on this device with the repository's latest version. The version on this device goes to the trash first, and the next sync uploads nothing for that file.
- **Changes since the last sync in the editor:** lines added, changed or deleted since the last sync are marked next to the text (desktop and mobile). Click or tap a mark to see the last-synced text and **Revert** it; or use **Revert this change**, **Go to next change** and **Go to previous change**. The last-synced text is read once per version and kept in memory, decrypted on the device; files over 1 MB and binary files get no marks. Turn it off under *Settings → Sync behaviour*.
- **Who last changed this line:** walks the file's last 30 versions on the device (so it works with encryption), following the file back through renames, and shows the date, device and commit of the last change to the line under the cursor, with a button to open that version. Also in the change popover, for the line as it was at the last sync. Works in shared folders too, from the shared folder's own repository.
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
- **File explorer:** a dot on files edited since the last sync, a warning on conflict copies, and files that aren't synced shown greyed out with *Not synced* (can be turned off). The file menu adds *Git: Exclude this file from sync* and *Git: Include in sync*.
- **Notifications:** by default a short notice when a sync changed files on phones (which have no status bar), and only errors on desktop. Errors are shown in your language with a hint for the likely cause (sign-in expired, repository not found, rate limit, server or network trouble).
- **Sync log**, status bar (desktop; optionally with the time until the next sync and the branch name) and a spinning ribbon icon while syncing.

### End-to-end encryption

Settings → *End-to-end encryption*, or in the setup wizard.

- Content and file names are encrypted on your device before upload, with AES-256-GCM. The key comes from your passphrase through PBKDF2-SHA256 with 600,000 iterations, and file names become opaque paths. Commit messages don't name files either: they only say how many were added, updated, renamed or deleted (`{{files}}` stays empty).
- Change detection, merging, rename detection, history, restore and the timeline all keep working.
- Other devices unlock with the same passphrase. A device without it, or with a different one, is refused instead of downloading unreadable files.
- To encrypt an existing repository, *Remove unencrypted copies* deletes the old plain files in one commit. Their history still contains them, so for full privacy start with a new, empty repository.
- **There is no passphrase recovery.** Keep it in a password manager.

### Per-device settings

Settings → *This device only*. These are stored on the device and never synced.

- Sync only some folders (for example `Daily/` on your phone) and exclude more patterns.
- **Attachments on demand:** files above a size limit stay in the repository and are listed instead of downloaded. Phones default to 25 MB. Download them from the status panel, from **Download files that aren't on this device**, or from the **Download** button that reading view shows in place of a missing embed. A downloaded file then stays in sync on that device.
- **Free up space** removes local copies this device doesn't need, but only when they are identical to the repository copy.
- Changing any of these triggers a full comparison on the next sync.

### Shared folders

Settings → *Shared folders*. Sync one folder with its own repository, for example `Work/` ↔ `team/notes`, while the rest of your vault stays in your private repository.

- The folder maps to the root of the shared repository, so collaborators can use it as a normal vault or repository, or to a folder inside it (for example `docs/`), leaving the rest of the repository alone.
- **Conflicts as pull requests** (optional, per shared folder): when two people change the same lines, this device's version goes to a new branch with a pull request (merge request on GitLab) for the team to review, instead of a conflict copy. If the pull request can't be opened, it falls back to a conflict copy.
- **GitHub-friendly Markdown** (optional, per shared folder): notes are stored so they read well on GitHub (wikilinks become normal links, callouts become GitHub alerts, `==highlights==` become `<mark>`), while your vault keeps the exact Obsidian text. A small hidden comment after each converted spot lets the original come back exactly; if a collaborator edits that spot on GitHub, their edit wins.
- Right-click a folder → **Git: Share this folder with a repository…** to start.
- Each shared folder has its own state, can use its own host and token, and syncs after the main vault. Its status appears in the status panel.
- The main repository never touches shared folders.

### Large files with Git LFS

Settings → *Large file storage threshold*. Files at least this big go to the host's large-file storage, and the repository keeps a small pointer.

- Works with GitHub, GitLab and Gitea through the standard LFS batch API. Bitbucket uses the same API but is untested.
- Files the repository's `.gitattributes` marks `filter=lfs` (as set up by `git lfs track`) also go to LFS, whatever their size.
- Every device reads LFS files correctly, even if it doesn't upload with LFS.
- Turning it on converts existing large files on the next sync, without conflicts.
- Check your host's LFS quota.

### Languages and settings search

The interface follows Obsidian's language. Every screen and error message is available in English, Simplified Chinese, German, Spanish, French, Japanese, Korean and Portuguese (Brazil). Corrections are welcome, and adding a language is one file: see [docs/TRANSLATING.md](docs/TRANSLATING.md). On Obsidian 1.13+ the plugin's settings appear in Obsidian's settings search. The sync log and *Copy diagnostics* stay in English so bug reports are readable.

### Backup mirror

Settings → *Backup mirror*. Every sync also uploads this vault to a second repository, on the same or another host (for example GitHub plus Codeberg). Push only: the mirror is never read back, and it follows the main repository's scope. With end-to-end encryption on, the mirror is encrypted too. It can use its own token.

### Plugins from official releases

With settings-folder sync on, *Install plugin code from official releases* keeps plugin versions in sync without syncing the code itself. When another device turns on or updates a community plugin, this device offers to install that exact version from the plugin's official GitHub release, as listed in Obsidian's community directory. Nobody can push plugin code to your devices through the repository.

### Control and convenience

- **Pause automatic sync** (command, status panel, or Settings → *This device only*): for an hour or until you resume; the settings show until when. Manual sync keeps working.
- **Battery saver** (this device): no timer, no sync after each edit, when opening a note or when leaving the app; syncs on startup, when you come back to Obsidian, and manually.
- **Changes on the host**: a dot on the ribbon icon and status bar when another device pushed and this device hasn't synced yet (checked every 5 minutes while Obsidian is open).
- **Repository and branch pickers** (Settings → *Repository* / *Branch* → *Choose*): pick from the repositories your token or the signed-in app can use, and switch branches or create one, for example a drafts branch. Switching starts a fresh comparison; nothing is deleted.
- **Open or copy a note's link on the host**: file menu (**Git: Open on …** / **Git: Copy link on …**) or commands; links point at the last synced commit. History pages too.
- **Make the repository match this device**: one forward commit that uploads this device's versions and deletes what isn't here (it stays in history). The opposite of *Make this device match the repository*.
- **Keep empty folders** across devices (off with encryption).
- **Exclude a folder** from the file menu (**Git: Exclude this folder from sync**).
- **Names Windows can't store** (such as `a:b.md`) are listed in the status panel; a Windows device skips them instead of failing.
- **Plugin versions**: commits record the plugin version, and the status panel warns when devices run different versions.
- **Copy diagnostics** for a bug report, with tokens hidden.
- **Commit messages:** a template with `{{device}}`, `{{summary}}`, `{{count}}`, `{{files}}` (the changed paths, the first 10 then "and N more"), `{{trigger}}` (`manual`, `startup`, `change`, `interval`, `resume`, `background`, `open` or `close`), `{{date}}` (ISO time) and `{{date:YYYY-MM-DD HH:mm}}` (any moment.js format), with a live preview in settings. An optional second template is used for automatic syncs. **Sync with a custom message…** asks for the message of one sync.
- **Sync and close Obsidian** (desktop command): syncs, then closes Obsidian only if every part of the sync succeeded (main repository, shared folders and mirror; otherwise it lists what failed). When a desktop window is closed without it, the plugin starts a last upload of pending edits, but the window can't wait for it to finish (see *Limits*).
- **Status bar extras** (desktop, optional): time until the next scheduled sync ("in 4 min") and the branch name, refreshed every 30 seconds.
- Commit author name and email, custom API URL for GitHub Enterprise and self-hosted servers, and device names (shown in commits and on conflict copies).

### For other plugins

The plugin triggers two workspace events that other plugins (or scripts such as Templater) can listen to:

```js
app.workspace.on("vault-sync-git:sync-start", ({ trigger, mode }) => { /* a sync started */ });
app.workspace.on("vault-sync-git:sync-done", (summary) => {
	// summary: { trigger, mode, upToDate, uploaded, downloaded, deleted, conflicts, error? }
});
```

Counts are numbers of files in the main repository's sync; `error` is set when the sync failed or was cancelled (or the first file error). A listener that throws doesn't affect the sync.

## Commands

| Command | What it does |
|---|---|
| Sync now | Two-way sync |
| Review changes and sync | Pick which changes to sync, with diffs |
| Preview sync (dry run) | Show what a sync would do |
| Pull only (download changes) | Download without uploading |
| Back up only (upload changes) | Upload without changing local files (a file the repository also changed keeps its repository version as a conflict copy next to it) |
| Open sync status panel | State, pending changes, conflicts and devices |
| Run setup wizard | Connect a host and repository |
| End-to-end encryption: turn on or unlock | Set or enter the passphrase; on a device that already has the key, shows that encryption is on, with *Lock this device* |
| Download files that aren't on this device | Attachments on demand |
| Free up space on this device | Remove local copies this device doesn't need |
| Timeline: restore vault or folder to an earlier point | Point-in-time restore |
| Make this device match the repository (discard local changes) | Reset this device |
| Create backup snapshot | Tag the current state |
| Show history of current file | Version history |
| Revert this change / Go to next change / Go to previous change (since the last sync) | Work with the change marks in the editor |
| Show who last changed this line | Date, device and commit of the last change to the line under the cursor |
| Compare current file with the repository | Diff against the repository's latest version |
| Use the repository version of this file | Replace the open note with the repository's latest version (the local one goes to the trash) |
| Open sync history | Sidebar of recent syncs with their changed files, diffs and restore |
| Recover deleted files | Restore files deleted in earlier syncs |
| Show sync log | Recent sync activity |
| Open repository in browser | Open the repository on your host |
| Open current file on the host / Open history of current file on the host / Copy link to current file on the host | The note's page, history or permalink on the host |
| Pause or resume automatic sync / Pause automatic sync for an hour | Stop automatic syncs on this device |
| Make the repository match this device | One forward commit that sets the repository to this device's files |
| Copy diagnostics (for a bug report) | Versions, settings and recent log, with tokens hidden |
| Sync current file now | Sync only the open note |
| Sync with a custom message… | Sync once with a commit message you type |
| Sync and close Obsidian | Sync, then close Obsidian if the sync succeeded (desktop) |
| Edit exclude patterns | Edit the exclude patterns in a window |
| Add another device (setup link) | Show a QR code and setup link for a new device |

## Requirements

- Obsidian 1.11.4 or newer, on desktop (Windows, macOS, Linux) or mobile (iOS, Android).
- An account with a supported Git host, and an access token (or Sign in on github.com or gitlab.com).

## Network use, accounts and privacy

This section covers the disclosures Obsidian's developer policies require.

- **Account required.** You need an account with a Git host (GitHub, GitLab, Bitbucket, or a Gitea / Forgejo / Codeberg server) and an access token (or Sign in with GitHub or GitLab). The plugin itself is free; no payment.
- **Network use.** The plugin only connects to the Git host **you configure**, to read and write your repository:
  - `api.github.com` (or your GitHub Enterprise server), `gitlab.com` (or your GitLab server), your Gitea / Forgejo / Codeberg server, or `api.bitbucket.org`
  - the backup mirror's host, if you set up a mirror
  - with *Install plugin code from official releases* on: `raw.githubusercontent.com` (Obsidian's community plugin list, read only when a plugin turned on elsewhere is missing or outdated here) and `github.com` (the plugin's release files, only after you confirm an install, which GitHub serves from its file storage, `*.githubusercontent.com`)
  - with Sign in with GitHub, also `github.com/login/device/code` and `github.com/login/oauth/access_token` to sign in and renew access
  - with Sign in with GitLab, also `/oauth/authorize_device` and `/oauth/token` on `gitlab.com` (or your GitLab server) to sign in and renew access
  - the same host's Git LFS endpoint, if you turn on large file storage
  - for Git LFS on any host, the file-storage address the LFS server returns for each upload or download
- **No telemetry, no ads, no third-party services.** Nothing is sent anywhere except the hosts listed above. The author runs no servers.
- **Files.** The plugin lists and reads the files in your vault to sync them, and writes only inside your vault, including the vault's settings folder if you turn on settings sync. It keeps its own state in its plugin folder.
- **Your data stays in your repository.** With end-to-end encryption on, the host only stores encrypted content and encrypted file names.

## Security notes

- The token, API URL and device name are stored per device and never synced. A pasted token is bound to the host and API URL it was entered for, so a changed `data.json`, a setup link or switching hosts can't send it anywhere else.
- Use a token limited to the vault repository. If it leaks, the damage is limited to that one repository.
- **Sign in with GitHub** uses the *Vault Sync for Git* GitHub App with only *Contents: read and write* on the repositories you choose. Its access token lasts 8 hours and is renewed on the device; no client secret exists in the plugin, and the author never sees your tokens or data. Revoke it any time in GitHub → Settings → Applications.
- **Sign in with GitLab** uses GitLab's `api` scope, which GitLab doesn't let apps narrow further: the token can reach every project your account can. Its access token lasts 2 hours and is renewed on the device. Revoke it in GitLab → Edit profile → Applications. To limit access to one project, use a project access token instead.
- For pasted GitHub tokens, the status panel warns two weeks before the token expires, and a notice appears in the last week.
- With **settings-folder sync** on, plugin code (`.obsidian/plugins/*/main.js`) syncs too. Anyone who can push to the repository can then run code on your devices. Keep the repository private and don't give others write access, or turn on *Install plugin code from official releases* so code only ever comes from the plugin's official release, after you confirm.
- Remote paths are validated (no `..`, no absolute paths, no empty segments) before anything is written.
- **Setup links** contain the host, repository, branch and sync choices, and no secrets unless you include the token, which is encrypted with a one-time code (AES-GCM, key from PBKDF2-SHA256) that is never part of the link. Opening a link only shows what it would change; nothing is applied until you confirm. Only open links you created yourself.
- **End-to-end encryption limits.**
  - Encrypted files still reveal approximate file sizes and path lengths, and whether two files are identical. Commit messages show the device name, the time and how many files changed.
  - Commits made before version 1.6.2 list the changed file names in their messages, and those messages stay in the repository's history.
  - Content isn't bound to its path, so someone with write access to the repository could swap or roll back encrypted files. They still can't read or forge content.
  - Shared folders are never encrypted, because collaborators must read them.
- **Deleting files.** Deletions that arrive from another device follow Obsidian's *Deleted files* setting (system trash, `.trash` folder, or permanent); they also stay in the repository's history. Local content that was never uploaded and gets replaced (for example "the repository wins", or *Make this device match the repository*) always goes to the system trash or `.trash`, even with permanent deletion on.
- **Data-safety guarantees.**
  - A file you are editing while a sync runs is never overwritten; it waits for the next sync.
  - A missing or renamed branch never reads as "everything was deleted", and a force-pushed (rewritten) history never makes files look deleted.
  - A deleted note and a new note made from the same template are not mistaken for a rename.
  - Sync state copied in from another device (for example by iCloud) is ignored.

## Host notes

- **GitHub:** stable. Every sync is one atomic commit with fast-forward-only updates.
- **GitLab:** beta, live-tested on gitlab.com. Atomic multi-file commits with per-file locking (`last_commit_id`), so concurrent edits from two devices are merged, never overwritten. GitLab's file listing has no sizes, so the plugin looks each new file's size up once and remembers it on the device.
- **Gitea / Forgejo (1.20+), Codeberg:** beta, live-tested on Codeberg. Atomic multi-file commits with per-file locking. Very large uploads are split into several commits. Files above the server's blob API limit (10 MB by default) are downloaded through its file API instead; Git LFS is still the better home for big media. Creating a repository from the plugin needs a token with **user: Read and Write**.
- **Bitbucket Cloud:** beta, live-tested. Commits carry the expected parent, so a concurrent push is detected. Bitbucket's API has no file hashes, so the plugin keeps a hash index of the repository on each device (in its plugin folder, never synced); after the first sync only changed files are fetched. Each download is checked against the size in the listing, so a cut-off download is retried instead of saved.
- Snapshots are tags on every host. The API budget is shown for GitHub only.
- **Removed in 1.4.0:** Gitee and Azure DevOps. A vault set up with either pauses sync with a notice (nothing is uploaded elsewhere and no files change) until you choose another host.

## Limits

- The maximum file size defaults to 50 MB. On GitHub without large file storage it can go up to 100 MB (GitHub's own limit); with large file storage, and on the other hosts, up to 2000 MB. Use Git LFS or exclude patterns for large media.
- Plugin code synced through the settings folder needs an Obsidian restart on the other device to load.
- Files Obsidian doesn't index (the settings folder, hidden files, `.gitignore`) are checked every few minutes (at most every 5 minutes, and on every full scan), rather than right after each change. A new hidden file or `.gitignore` inside a normal folder is found after a folder is created or moved in Obsidian, on the next full scan, or within 30 minutes; changes to ones already known are picked up as above. Hidden files inside normal folders are only synced with *Hidden files inside folders* on.
- A case-only rename (for example `Note.md` → `note.md`) takes two syncs to settle on case-insensitive devices; the file sits in the trash in between.
- Sign in works on github.com and gitlab.com, and on GitHub Enterprise or self-managed GitLab with your own app. The other hosts use access tokens.
- GitHub-friendly Markdown doesn't rewrite links relative to the note's folder, and doesn't convert callouts nested inside other quotes.
- GitHub is tested against the real API on every release. GitLab (gitlab.com), Gitea / Forgejo (Codeberg) and Bitbucket Cloud passed the same live suite against the real servers for 1.4.0, but stay marked beta until they have more real-world use. Android has been tested on a real phone (Obsidian 1.14.4, Android 13): setup and sign-in, two-way sync, conflicts by touch, change markers, history, battery saver, end-to-end encryption and attachments on demand. iPhone and iPad haven't been tested on a real device yet. Reports from real servers and phones are welcome.
- Conflicts as pull requests are available for shared folders. Empty folders aren't kept while end-to-end encryption is on.
- Closing a desktop window starts a last upload of pending edits, but a closing window can't wait for network requests, so a large or slow upload may not finish; the edits then simply sync next time. Use **Sync and close Obsidian** to be sure.
- With the vault in a folder of the repository, empty folders aren't kept, and the vault's end-to-end encryption marker lives in its folder (`<folder>/.vault-sync/encryption.json`). The setup wizard's file count covers the whole repository.
- `sync: false` is read from Obsidian's metadata cache; a note Obsidian hasn't indexed yet waits for the next sync instead of being uploaded.
- On Windows, a note renamed elsewhere to a name Windows can't store (such as `a:b.md`) is kept under its old name here, and the status panel lists the name to fix.

## Development

```bash
npm ci
npm run dev      # watch build
npm test         # unit tests and multi-device simulation against fake GitHub, GitLab, Gitea, Bitbucket and LFS servers
VSG_LIVE_TOKEN=$(gh auth token) VSG_LIVE_REPO=owner/throwaway-repo npm run test:live   # real GitHub API, including encrypted sync
VSG_LIVE_KIND=gitlab VSG_LIVE_TOKEN=… VSG_LIVE_REPO=me/throwaway npm run test:hosts      # any host, on a throwaway branch
npm run build    # type-check and production bundle
npm run lint     # Obsidian's official review rules (eslint-plugin-obsidianmd)
```

Main source files:

| File | Purpose |
|---|---|
| `src/sync.ts`, `src/plan.ts` | Sync engine and three-way decisions |
| `src/merge.ts`, `src/smartmerge.ts` | Line merge (diff3) and structure-aware merge for JSON, canvas and frontmatter |
| `src/remote.ts`, `src/hosts.ts`, `src/removed-hosts.ts` | Host interface, registry, and the pause for removed hosts |
| `src/github.ts`, `src/gitlab.ts`, `src/gitea.ts`, `src/bitbucket.ts` | Host clients on Obsidian's `requestUrl` |
| `src/ghapp.ts`, `src/gitlabapp.ts`, `src/ghapp-ui.ts` | Sign in with GitHub / GitLab (device flow) |
| `src/codec.ts`, `src/crypto.ts`, `src/lfs.ts`, `src/ghformat.ts` | Shared-folder mapping, encryption, Git LFS and GitHub-friendly Markdown layers |
| `src/conflict-editor.ts` | Keep/keep-both buttons on conflict markers in the editor |
| `src/main.ts`, `src/settings-tab.ts`, `src/wizard.ts`, `src/health.ts`, `src/ui.ts` | Plugin, settings, setup wizard, status panel and dialogs |
| `src/locales/` | Translations |

See [CONTRIBUTING.md](CONTRIBUTING.md) to report bugs or send changes, [CHANGELOG.md](CHANGELOG.md) for what changed in each release, and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

## License

[MIT](LICENSE). Bundled third-party code (the QR code generator) is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
