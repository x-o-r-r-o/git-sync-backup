# Vault Sync for GitHub

Sync and back up an Obsidian vault across **desktop and mobile** (Windows, macOS, Linux, iOS, Android) using a private GitHub repository.

- **No dependencies.** No git install, no `.git` folder, no native code. It talks to the GitHub API through Obsidian's own network layer, so it behaves the same on every device.
- **Real merging.** If two devices edit different parts of the same note, the changes are merged line by line. If they edit the same lines, both versions are kept (or you choose).
- **Safe by default.** Edits always win over deletions, deleted files go to the trash, and a delete guard stops accidental mass deletions.
- **Backups built in.** Every sync is one commit, so the full history lives on GitHub. Per-file version history and restore, recovery of deleted files, and manual or daily snapshot tags.

See [docs/RESEARCH.md](docs/RESEARCH.md) for the comparison with existing plugins and the gaps this one closes.

## Setup (once per device)

1. Create a **private** repository on GitHub, or use **Create private repo** in the settings.
2. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: *Only select repositories* → your vault repo
   - Permissions → Repository → **Contents: Read and write** (Metadata read is added automatically)
   - Add **Administration: Read and write** only if you want the plugin to create the repo for you.
3. In Obsidian: Settings → Vault Sync for GitHub → paste the token, set owner and repository → **Test connection**.
4. Run **Sync now** (ribbon icon, status bar, or command palette).

Repeat on each device: install the plugin, paste the token, same owner/repo. An existing vault on a second device is safe: the first sync never deletes anything, and any file that differs is kept in both versions.

The token is stored only on the device (local storage). It is never written to `data.json`, so it is never uploaded, even with settings-folder sync on.

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

## Commands

Sync now · Pull from GitHub only · Back up to GitHub only (push) · Preview sync (dry run) · Create backup snapshot on GitHub · Show sync log · Show history of current file · Recover deleted files · Open repository on GitHub

## Install

**Manual:** copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/vault-sync-github/`, then enable the plugin under Community plugins. On mobile, copy the folder in with the Files app or a file manager, or let the first desktop sync bring it over with settings-folder sync turned on.

**BRAT:** push this repo to GitHub, tag a version (for example `0.1.0`) so the release workflow publishes the files, then add the repo in BRAT on each device.

## Development

```bash
npm install
npm run dev      # watch build
npm test         # unit tests + two-device simulation against an in-memory GitHub
npm run build    # type-check + production bundle
```

Source layout: `src/sync.ts` (engine), `src/plan.ts` (three-way decisions), `src/merge.ts` (diff3), `src/github.ts` (REST client on `requestUrl`), `src/io.ts` (vault access), `src/ui.ts` and `src/settings-tab.ts`.

## Security notes

- The token, API base URL and device name are stored per device and never synced. A changed `data.json` arriving from another device cannot send your token anywhere else.
- Use a fine-grained token scoped to the vault repo only. If it leaks, the damage is limited to that one repo.
- With **settings-folder sync** on, plugin code (`.obsidian/plugins/*/main.js`) syncs too. Anyone who can push to the repo can then run code on your devices. Keep the repo private and don't give others write access.
- Remote paths are validated (no `..`, no absolute paths, no empty segments) before anything is written.

## Limits

- GitHub rejects files over 100 MB (default limit here is 50 MB). Keep large media out with exclude patterns.
- Plugin code synced through the settings folder needs an Obsidian restart on the other device to load.
- No Git LFS.
- A case-only rename (for example `Note.md` → `note.md`) takes two syncs to settle on case-insensitive devices; the file sits in the trash in between.
