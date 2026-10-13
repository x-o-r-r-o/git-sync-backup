# Features and commands

[README](../README.md) · [Setup](SETUP.md) · [Features](FEATURES.md) · [Security](SECURITY.md) · [Hosts and limits](LIMITS.md)

## How a sync works

1. Hashes local files (cached by modified time and size, so this is fast).
2. Reads the remote branch. If nothing changed on either side, it stops after one request.
3. Compares each file with the version from the last sync (a three-way comparison):
   - changed only on this device → upload; changed only in the repository → download
   - deleted on one side only → delete on the other (to the trash)
   - changed on both sides → merge, or resolve the conflict
4. Uploads everything as **one commit**. If another device pushed in the meantime, it reads the new changes and tries again.

## Syncing

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

## Merging and conflicts

When a file changed on both sides, choose what happens: **merge automatically** (default: changes to different lines are combined, and both versions are kept when the same lines changed), merge with `<<<<<<<` markers, keep both, **ask me each time**, this device wins, or the repository wins.

- Markdown merges line by line. Frontmatter merges key by key, and lists such as `tags` and `aliases` merge as sets: adding tag A on your phone and tag B on your laptop gives you both.
- `.canvas` and JSON files merge card by card and setting by setting.
- **Conflict markers in the editor:** when a note contains `<<<<<<<` / `=======` / `>>>>>>>` blocks (from *merge with markers*, or anywhere else), each block gets **Keep this device**, **Keep repository** and **Keep both** buttons right in the note. The two sides are tinted and the marker lines show as small labels. If a side itself contains a marker-like line, the plugin keeps both versions as files instead of writing markers.
- With **Ask me each time**, a side-by-side dialog lets you keep this device's version, the repository's version, or both, for each changed block.
- A conflict copy can be **resolved** later from the status panel: pick change by change (images and other binary files: pick a whole version), the result goes into the note, and the copy goes to the trash. Conflict copies are listed even before sync is set up.
- Two conflicts on the same note never overwrite each other's copies.

## Backups and history

- One commit per sync. Commits carry a `Device:` line, so you can see which device made each change.
- **Version history** of any file from the file menu (**Git: Version history**, next to Obsidian Sync's own *Open version history*), with **Compare with current**. History follows the file back through renames: versions from before a rename show the name the file had then, and open and restore correctly.
- **Timeline:** browse every sync and snapshot, and restore the whole vault or a single folder to an earlier point. Restores are new commits, so history is never rewritten and a restore can be undone the same way.
- **Sync history sidebar** (ribbon or **Open sync history**): every sync with its date, device and author, and its changed files (added, modified, deleted, renamed; encrypted names shown decrypted). Click a file for its diff, restore a single file, browse the files at that point or restore a folder or the whole vault. Filter by path, load older syncs, works with keyboard and on mobile.
- **Use the repository version** of one file (in *Compare with repository*, the status panel's list of edited files, the file menu and a command): replaces the file on this device with the repository's latest version. The version on this device goes to the trash first, and the next sync uploads nothing for that file.
- **Changes since the last sync in the editor:** lines added, changed or deleted since the last sync are marked next to the text (desktop and mobile). Click or tap a mark to see the last-synced text and **Revert** it; or use **Revert this change**, **Go to next change** and **Go to previous change**. The last-synced text is read once per version and kept in memory, decrypted on the device; files over 1 MB and binary files get no marks. Turn it off under *Settings → Sync behaviour*.
- **Who last changed this line:** walks the file's last 30 versions on the device (so it works with encryption), following the file back through renames, and shows the date, device and commit of the last change to the line under the cursor, with a button to open that version. Also in the change popover, for the line as it was at the last sync. Works in shared folders too, from the shared folder's own repository.
- **Recover deleted files**, plus daily or manual snapshot tags.
- **Make this device match the repository** discards unsynced local changes. Replaced and removed files go to the trash first.

## See before you sync

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

## End-to-end encryption

Settings → *End-to-end encryption*, or in the setup wizard.

- Content and file names are encrypted on your device before upload, with AES-256-GCM. The key comes from your passphrase through PBKDF2-SHA256 with 600,000 iterations, and file names become opaque paths. Commit messages don't name files either: they only say how many were added, updated, renamed or deleted (`{{files}}` stays empty).
- Change detection, merging, rename detection, history, restore and the timeline all keep working.
- Other devices unlock with the same passphrase. A device without it, or with a different one, is refused instead of downloading unreadable files.
- To encrypt an existing repository, *Remove unencrypted copies* deletes the old plain files in one commit. Their history still contains them, so for full privacy start with a new, empty repository.
- **There is no passphrase recovery.** Keep it in a password manager.

## Per-device settings

Settings → *This device only*. These are stored on the device and never synced.

- Sync only some folders (for example `Daily/` on your phone) and exclude more patterns.
- **Attachments on demand:** files above a size limit stay in the repository and are listed instead of downloaded. Phones default to 25 MB. Download them from the status panel, from **Download files that aren't on this device**, or from the **Download** button that reading view shows in place of a missing embed. A downloaded file then stays in sync on that device.
- **Free up space** removes local copies this device doesn't need, but only when they are identical to the repository copy.
- Changing any of these triggers a full comparison on the next sync.

## Shared folders

Settings → *Shared folders*. Sync one folder with its own repository, for example `Work/` ↔ `team/notes`, while the rest of your vault stays in your private repository.

- The folder maps to the root of the shared repository, so collaborators can use it as a normal vault or repository, or to a folder inside it (for example `docs/`), leaving the rest of the repository alone.
- **Conflicts as pull requests** (optional, per shared folder): when two people change the same lines, this device's version goes to a new branch with a pull request (merge request on GitLab) for the team to review, instead of a conflict copy. If the pull request can't be opened, it falls back to a conflict copy.
- **GitHub-friendly Markdown** (optional, per shared folder): notes are stored so they read well on GitHub (wikilinks become normal links, callouts become GitHub alerts, `==highlights==` become `<mark>`), while your vault keeps the exact Obsidian text. A small hidden comment after each converted spot lets the original come back exactly; if a collaborator edits that spot on GitHub, their edit wins.
- Right-click a folder → **Git: Share this folder with a repository…** to start.
- Each shared folder has its own state, can use its own host and token, and syncs after the main vault. Its status appears in the status panel.
- The main repository never touches shared folders.

## Large files with Git LFS

Settings → *Large file storage threshold*. Files at least this big go to the host's large-file storage, and the repository keeps a small pointer.

- Works with GitHub, GitLab and Gitea through the standard LFS batch API. Bitbucket uses the same API but is untested.
- Files the repository's `.gitattributes` marks `filter=lfs` (as set up by `git lfs track`) also go to LFS, whatever their size.
- Every device reads LFS files correctly, even if it doesn't upload with LFS.
- Turning it on converts existing large files on the next sync, without conflicts.
- Check your host's LFS quota.

## Languages and settings search

The interface follows Obsidian's language. Every screen and error message is available in English, Simplified Chinese, German, Spanish, French, Japanese, Korean and Portuguese (Brazil). Corrections are welcome, and adding a language is one file: see [docs/TRANSLATING.md](TRANSLATING.md). On Obsidian 1.13+ the plugin's settings appear in Obsidian's settings search. The sync log and *Copy diagnostics* stay in English so bug reports are readable.

## Backup mirror

Settings → *Backup mirror*. Every sync also uploads this vault to a second repository, on the same or another host (for example GitHub plus Codeberg). Push only: the mirror is never read back, and it follows the main repository's scope. With end-to-end encryption on, the mirror is encrypted too. It can use its own token.

## Plugins from official releases

With settings-folder sync on, *Install plugin code from official releases* keeps plugin versions in sync without syncing the code itself. When another device turns on or updates a community plugin, this device offers to install that exact version from the plugin's official GitHub release, as listed in Obsidian's community directory. Nobody can push plugin code to your devices through the repository.

## Control and convenience

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
- **Sync and close Obsidian** (desktop command): syncs, then closes Obsidian only if every part of the sync succeeded (main repository, shared folders and mirror; otherwise it lists what failed). When a desktop window is closed without it, the plugin starts a last upload of pending edits, but the window can't wait for it to finish (see [Hosts and limits](LIMITS.md)).
- **Status bar extras** (desktop, optional): time until the next scheduled sync ("in 4 min") and the branch name, refreshed every 30 seconds.
- Commit author name and email, custom API URL for GitHub Enterprise and self-hosted servers, and device names (shown in commits and on conflict copies).

## For other plugins

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
