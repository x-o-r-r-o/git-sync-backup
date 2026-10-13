# Releasing and listing in the Obsidian Community directory

Since May 2026, plugins are listed through the **Obsidian Community directory** (community.obsidian.md), which reviews them automatically. The old pull request to `obsidianmd/obsidian-releases` is no longer used.

## Every release

1. Bump `version` in `manifest.json` and `package.json`. Add `"<version>": "<minAppVersion>"` to `versions.json` and a `## <version>` section to `CHANGELOG.md`.
2. Run `npm run build && npm run lint && npm test` (lint must show 0 errors).
3. Commit, push, then tag **exactly the version, with no `v`**:

   ```bash
   git tag 1.0.1
   git push origin 1.0.1
   ```

4. The **Release** workflow checks the tag against the manifest, then builds, lints and tests. On a public repository it also attests build provenance. It then publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`, using the changelog section as notes.

The directory re-scans every new release. If a release fails review, it is hidden from search until a fixed version ships.

## First listing (done once, by the author)

1. Make the repository **public**. The directory doesn't accept closed-source or private plugins.
2. Re-run the latest release (delete and re-push the tag) so it carries a provenance attestation for the "verified" badge.
3. Go to community.obsidian.md, sign in with your Obsidian account, and connect GitHub.
4. Choose **Plugins → New plugin**, enter `https://github.com/x-o-r-r-o/git-sync-backup`, pick the owner, accept the developer policies, and submit.
5. Review results appear on the dashboard within minutes. Listed plugins show up in Obsidian within about 24 hours.

## Checklist the plugin already meets

- **Manifest:** id has no "obsidian" and doesn't end in "plugin"; the name is Basic Latin; the description starts with a verb, ends with a period, and is under 250 characters; `isDesktopOnly: false` (no Node or Electron APIs); minAppVersion 1.11.4 matches the APIs used.
- **Files:** LICENSE (MIT). README discloses that an account is needed, the network use (only the Git host you configure), and that there is no telemetry, no ads and no access outside the vault.
- **Code:**
  - `eslint-plugin-obsidianmd`: 0 errors. The 2 warnings are the deprecated `display()`/`setWarning()`, which Obsidian versions before 1.13 still require.
  - No innerHTML, no inline styles, no browser storage, no default hotkeys; command names don't include the plugin name.
  - Uses `requestUrl`, `fileManager.trashFile`, `normalizePath` and `configDir`.
