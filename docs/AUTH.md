# Authentication

How the plugin authenticates: Sign in with GitHub (since 1.2), Sign in with GitLab (since 1.4), or a pasted access token on every host. The sections below the GitHub status also keep the original evaluation for reference.

**Sign in with GitHub** (GitHub App + device flow, `src/ghapp.ts`). The plugin's app is [Git Sync & Backup](https://github.com/apps/git-sync-backup) (client ID `Iv23liUZtWNN2F2Zemwj`, *Contents: read and write* only). On GitHub Enterprise a device can enter its own app's client ID in settings. Token entry stays available everywhere. Verified against the real API: sign-in, token refresh (both tokens rotate) and the full live sync suite running on the app's token.

## Pasted tokens

You can always paste a **personal access token**. The setup wizard and settings link to GitHub's **prefilled fine-grained token page**, which uses GitHub's template URL (Aug 2025) to fill in the name, a 366-day expiry and `contents=write`. You only have to pick the repository.

The token is kept in **Obsidian's SecretStorage** (1.11.4+) and never in `data.json`. A classic `repo` token is offered as a simpler alternative.

## Options evaluated

| | OAuth App + device flow | **GitHub App + device flow** | Web flow + PKCE + `obsidian://` | Fine-grained token (current) |
|---|---|---|---|---|
| What the user does | Copy an 8-character code, approve in the browser | Same, plus a one-time "install on repo" page | Approve in the browser, get redirected back | Open the prefilled link, pick the repo, copy and paste |
| Access granted | `repo` scope: **all** private repos | **Per repository**, Contents read & write | Depends on the app type | Per repository |
| Token lifetime | No expiry (revoked after 1 year unused) | 8 h, auto-refreshed for 6 months, **no secret needed** with device flow | Depends on the app type | 1–366 days |
| Mobile | Yes | Yes | Fragile | Yes (pasting on a phone is awkward) |
| Needs a backend or client secret | No | No | **Yes**: GitHub still requires the client secret for code exchange | No |
| Organization repos | **Blocked by default** (OAuth app restrictions) | Org owner approves the install | Depends on the app type | Org token policies apply |
| Upkeep for the plugin author | One OAuth App | One GitHub App | App plus a server | None |

Sources:
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions
- https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/
- https://github.com/orgs/community/discussions/15752
- https://github.blog/changelog/2025-08-26-template-urls-for-fine-grained-pats-and-updated-permissions-ui

## Decision

- **Not now:** an OAuth App would need the broad `repo` scope and is blocked in organizations, and the web flow needs a server. An early OAuth App device-flow prototype was removed in v0.4.
- **Keep:** fine-grained tokens with the prefilled link and SecretStorage. This works everywhere, including GitHub Enterprise and locked-down organizations, with no upkeep.
- **Planned (best option):** "Sign in with GitHub" through a **GitHub App with the device flow**.
  - The plugin author registers a GitHub App: Contents read & write, *Enable Device Flow* ticked, expiring user tokens on. No secret ships in the plugin; the client ID is public by design.
  - Sign-in flow:
    1. Copy the code and open `github.com/login/device`.
    2. Poll for the token, respecting `interval` and `slow_down`.
    3. If `GET /user/installations` shows no access to the repo, open `github.com/apps/<slug>/installations/new`.
  - Refresh the access token before its 8-hour expiry, and save the rotated refresh token immediately.
  - Keep token entry as the fallback for GitHub Enterprise, locked-down organizations, and users who prefer it.
  - Risk: if the app is suspended or deleted, sign-in stops working for everyone, which is another reason to keep tokens.

## How it works (1.2.0)

1. The plugin posts its public client ID to `https://github.com/login/device/code` and shows the user code.
2. **Copy and open GitHub** copies the code and opens `github.com/login/device`. The user pastes the code and approves.
3. The plugin polls `login/oauth/access_token` at the interval GitHub asks for (and slows down on `slow_down`) until it gets an access token (8 hours) and a refresh token (6 months).
4. Tokens are stored in Obsidian's SecretStorage on that device only, under its own key; the pasted token is kept separately, so signing out falls back to it.
5. Before each sync, and once after any 401, the access token is refreshed. Only one refresh runs at a time, because GitHub rotates the refresh token on every use. No client secret is sent: GitHub doesn't require one for tokens that came from the device flow.
6. If the refresh token has expired (6 months unused) or was revoked, the user is asked to sign in again.

The app only sees the repositories the user installed it on. In the wizard, **Choose repositories** opens `github.com/apps/<slug>/installations/new`, and the repository list refreshes afterwards. The app can't create repositories, so the wizard links to `github.com/new` instead.

## Registering the GitHub App

One-time step for the plugin author (or a GitHub Enterprise admin for their server):

1. GitHub → Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Name: *Git Sync & Backup* (the URL name becomes the slug, here `git-sync-backup`). Homepage: the plugin repository.
3. Callback URL: not needed. Untick *Expire user authorization tokens* only if you want non-expiring tokens (not recommended).
4. Tick **Enable Device Flow**.
5. Webhook: untick *Active*.
6. Repository permissions: **Contents: Read and write**. Metadata: Read-only is added automatically. Nothing else.
7. *Where can this GitHub App be installed?* **Any account**.
8. Create the app, then copy the **Client ID** (not the App ID) and the slug from the app's public URL into `GITHUB_APP` in `src/ghapp.ts`. No client secret or private key is needed.

## Listing repositories

`GET /user/repos` with an app token lists every repository the *user* can see, not the ones the app may write to. With a `ghu_` token the plugin lists `GET /user/installations` and each installation's repositories instead, so the wizard only offers repositories that will actually sync.

## Sign in with GitLab

Same device flow (GitLab 17.9+, RFC 8628), in `src/gitlabapp.ts`:

1. `POST <server>/oauth/authorize_device` with `client_id` and `scope=api` returns a user code and `verification_uri_complete`.
2. The dialog shows the code and opens the approval page with the code filled in.
3. The plugin polls `POST <server>/oauth/token` (`grant_type=urn:ietf:params:oauth:grant-type:device_code`), honouring `interval` and `slow_down`.
4. Access tokens last two hours. Before a sync, and on a 401, the plugin refreshes with the rotating refresh token (`grant_type=refresh_token`); only one refresh runs at a time.
5. API calls use `Authorization: Bearer` instead of `PRIVATE-TOKEN`.

Tokens are stored in Obsidian's secret storage on the device and are bound to the server address and Application ID they were issued for; they are never sent to another server.

### Registering the GitLab application

On gitlab.com the plugin author registered the *Vault Sync for Git* application; its Application ID is `GITLAB_APP` in `src/gitlabapp.ts` (public, not a secret). On a self-managed server, a user or administrator does the same and pastes the ID into *GitLab application ID* in settings:

1. Avatar → Edit profile → Applications (or Group / Admin area → Applications) → **Add new application**.
2. Name: *Vault Sync for Git*. Redirect URI: any https URL (required by the form, unused by the device flow).
3. **Confidential: unticked.** **Device authorization grant: ticked** (without it GitLab answers `access_denied`). Scopes: **api** only.
4. Save and copy the **Application ID**. The secret is not used.
