# Authentication: research and plan (2026-10-12)

## Today

You paste a **personal access token**. The setup wizard and settings link to GitHub's **prefilled fine-grained token page**, which uses GitHub's template URL (Aug 2025) to fill in the name, a 366-day expiry and `contents=write`. You only have to pick the repository.

The token is kept in **Obsidian's SecretStorage** (1.11.4+) and never in `data.json`. Older Obsidian versions fall back to device-local storage. A classic `repo` token is offered as a simpler alternative.

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
