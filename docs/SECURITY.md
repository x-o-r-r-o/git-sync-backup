# Security

[README](../README.md) · [Setup](SETUP.md) · [Features](FEATURES.md) · [Security](SECURITY.md) · [Hosts and limits](LIMITS.md)

For network use, accounts and privacy, see the [README](../README.md#network-use-accounts-and-privacy).

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
