# Setup

[README](../README.md) · [Setup](SETUP.md) · [Features](FEATURES.md) · [Security](SECURITY.md) · [Hosts and limits](LIMITS.md)

The quickest way is the **setup wizard**. It opens on first launch, or run **Run setup wizard** from the command palette or settings. It connects your account, lets you pick or create a private repository, asks whether this device should upload, download or merge, and runs the first sync with progress. It warns when another sync tool (Obsidian Sync, iCloud, Obsidian Git, …) is active on the same vault, since two sync tools on one vault fight over the files.

## Sign in with GitHub

On github.com you don't need a token:

1. In the wizard (or Settings → Git Sync & Backup), select **Sign in**.
2. Select **Copy and open GitHub**, paste the code on the page that opens, and approve.
3. Pick your vault repository from **Repositories the app can use**. If it isn't listed yet, select **Add repositories on GitHub**, choose it there and come back: the list updates by itself, and newly added repositories are marked **New**. The app can only see the repositories you pick, and only their contents.

Access renews automatically. Signing in is per device and can be undone with **Sign out**. On GitHub Enterprise, an administrator can register their own GitHub App and enter its client ID in settings (see [docs/AUTH.md](AUTH.md)).

## Sign in with GitLab

On gitlab.com you don't need a token either: choose GitLab as the host, select **Sign in**, then **Copy and open GitLab**, and approve (the code is filled in). Access lasts two hours at a time and renews automatically; signing in is per device and can be undone with **Sign out**. On a self-managed GitLab server (17.9+), create a non-confidential OAuth application with **Device authorization grant** ticked and the `api` scope (Edit profile → Applications, see [docs/AUTH.md](AUTH.md)) and enter its Application ID in settings (*GitLab application ID*).

## With an access token

For Gitea / Forgejo / Codeberg, Bitbucket, or if you prefer a token on GitHub or GitLab:

1. Create a **private** repository on your host, or use **Create private repository** in the settings.
2. Create an access token (the wizard and settings link straight to the right page):

   | Host | Token |
   |---|---|
   | GitHub | [Fine-grained token](https://github.com/settings/personal-access-tokens/new): *Only select repositories* → your vault repository, **Contents: Read and write**. Add **Administration: Read and write** only if you want the plugin to create the repository. |
   | GitLab | Personal access token with the `api` scope. A project access token (role Developer, scope `api`) limits access to the one project. |
   | Gitea / Forgejo / Codeberg | Settings → Applications: a token with **repository: Read and Write** and **user: Read** (**user: Read and Write** if you want the plugin to create the repository). |
   | Bitbucket | Repository access token with **Repositories: Read and Write**. To pick or create repositories in the wizard, use an Atlassian API token with Bitbucket scopes, entered as `email:token`. |

3. In Obsidian, open Settings → Git Sync & Backup, choose the host, paste the token, set owner and repository (or select **Choose** next to *Repository* to pick from your repositories), then select **Test connection**. For self-hosted servers and GitHub Enterprise, also set the API URL.
4. Run **Sync now** (ribbon icon, status bar or command palette).

Repeat on each device with the same repository. An existing vault on a second device is safe: the first sync never deletes anything, and any file that differs is kept in both versions.

## Add another device with a link or QR code

On a device that already syncs, choose **Add another device** (status panel, settings, or the command palette). It shows a QR code and a link with the host, repository, branch and your sync choices. Install the plugin on the new device, then scan the code with its camera or open the link there. The new device shows exactly what the link will change and asks before applying it.

- Signed in with GitHub or GitLab: the new device signs in itself; the sign-in token is never put in a link.
- With a token: optionally include it. It is encrypted with a one-time code that is shown next to the QR code and never included in the link; type it on the new device.
- Only open setup links you created yourself.

The token is stored only on the device, in Obsidian's secure storage. It is never written to `data.json`, so it is never uploaded, even with settings-folder sync on.

## Requirements

- Obsidian 1.11.4 or newer, on desktop (Windows, macOS, Linux) or mobile (iOS, Android).
- An account with a supported Git host, and an access token (or Sign in on github.com or gitlab.com).
