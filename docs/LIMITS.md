# Hosts and limits

[README](../README.md) · [Setup](SETUP.md) · [Features](FEATURES.md) · [Security](SECURITY.md) · [Hosts and limits](LIMITS.md)

## Hosts

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
