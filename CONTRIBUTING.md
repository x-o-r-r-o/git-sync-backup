# Contributing to Vault Sync for Git

Thanks for helping. Bug reports, translations and pull requests are all welcome.

## Reporting a bug

Open an issue with:

- your Obsidian version and platform (Windows, macOS, Linux, iOS, Android)
- the Git host (GitHub, GitLab, Gitea / Forgejo / Codeberg, Bitbucket)
- what you did, what you expected, and what happened
- the sync log (command palette → **Show sync log**). Remove anything private first. The log never contains your token.

Please report security problems privately through GitHub's **Report a vulnerability** button on the repository's Security tab, not in a public issue.

## Development setup

```bash
npm ci
npm run dev      # watch build into main.js
npm test         # unit tests and simulated multi-device sync
npm run lint     # Obsidian's official review rules
npm run build    # type-check and production bundle
```

To try a build, copy `main.js`, `manifest.json` and `styles.css` into `<test vault>/.obsidian/plugins/vault-sync-git/`. Use a throwaway vault and a throwaway repository, never your real ones.

The live suite runs against the real GitHub API in a repository you are happy to have overwritten:

```bash
VSG_LIVE_TOKEN=$(gh auth token) VSG_LIVE_REPO=owner/throwaway-repo npm run test:live
```

Every host can be tested the same way with `tests/live/hosts.live.test.ts`. It works on a new throwaway branch and never deletes anything:

```bash
VSG_LIVE_KIND=gitlab VSG_LIVE_TOKEN=… VSG_LIVE_REPO=me/throwaway npm run test:hosts
```

`VSG_LIVE_KIND` is `github`, `gitlab`, `gitea` or `bitbucket`; set `VSG_LIVE_API` for self-hosted servers (e.g. `https://codeberg.org/api/v1`) and `VSG_LIVE_PR=1` to include the pull request test.

## Project layout

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

## Rules for changes

- **Desktop and mobile.** The bundle may only `require("obsidian")` and the `@codemirror/*` packages Obsidian provides. No Node or Electron APIs, no native modules, no runtime dependencies. Use `requestUrl`, WebCrypto and the vault adapter.
- **Never lose data.** Edits beat deletions, deleted files go to the trash, and anything ambiguous keeps both versions. Changes to sync decisions (`src/plan.ts`, `src/sync.ts`) need tests.
- **Pass lint and tests.** `npm run lint` must report 0 errors and `npm test` must pass.
- **Lockfile.** Commit `package-lock.json` whenever dependencies change, and check that `npm ci` succeeds.
- **Strings.** Text the user sees goes through `t()` with a key in `src/locales/en.ts`. See [docs/TRANSLATING.md](docs/TRANSLATING.md).
- Keep the docs up to date for anything users will notice: `CHANGELOG.md`, and the guide it belongs in ([setup](docs/SETUP.md), [features and commands](docs/FEATURES.md), [security](docs/SECURITY.md), [hosts and limits](docs/LIMITS.md)). The README stays a short overview: pitch, screenshots, install, quick start and the network disclosure.

## Translations

Adding a language is one file. See [docs/TRANSLATING.md](docs/TRANSLATING.md).

## Releases

Maintainers release by following [docs/RELEASING.md](docs/RELEASING.md).

By contributing, you agree that your contributions are licensed under the MIT License.
