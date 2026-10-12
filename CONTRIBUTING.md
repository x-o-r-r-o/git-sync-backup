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

## Rules for changes

- **Desktop and mobile.** The bundle may only `require("obsidian")`. No Node or Electron APIs, no native modules, no runtime dependencies. Use `requestUrl`, WebCrypto and the vault adapter.
- **Never lose data.** Edits beat deletions, deleted files go to the trash, and anything ambiguous keeps both versions. Changes to sync decisions (`src/plan.ts`, `src/sync.ts`) need tests.
- **Pass lint and tests.** `npm run lint` must report 0 errors and `npm test` must pass.
- **Lockfile.** Commit `package-lock.json` whenever dependencies change, and check that `npm ci` succeeds.
- **Strings.** Text the user sees goes through `t()` with a key in `src/locales/en.ts`. See [docs/TRANSLATING.md](docs/TRANSLATING.md).
- Keep `README.md` and `CHANGELOG.md` up to date for anything users will notice.

## Translations

Adding a language is one file. See [docs/TRANSLATING.md](docs/TRANSLATING.md).

## Releases

Maintainers release by following [docs/RELEASING.md](docs/RELEASING.md).

By contributing, you agree that your contributions are licensed under the MIT License.
