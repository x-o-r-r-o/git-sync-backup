import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultSyncPlugin from "./main.ts";
import type { ConflictStrategy, NoticeLevel } from "./types.ts";
import type { SyncMode } from "./plan.ts";
import { errMsg } from "./util.ts";
import { HOSTS } from "./hosts.ts";
import { SharedFolderModal } from "./shared-ui.ts";
import type { HostKind } from "./hosts.ts";

export class VaultSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VaultSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		const save = async () => {
			await p.saveSettings();
		};
		containerEl.empty();

		new Setting(containerEl)
			.setName("Setup wizard")
			.setDesc("Connect, pick or create a repository, and run the first sync step by step.")
			.addButton((b) => b.setButtonText("Run setup wizard").setCta().onClick(() => p.openWizard()));

		// ---------- connection ----------
		new Setting(containerEl).setName("Connection").setHeading();
		new Setting(containerEl)
			.setName("Git host")
			.setDesc("GitLab and Gitea/Forgejo support is in beta.")
			.addDropdown((d) => {
				for (const [k, h] of Object.entries(HOSTS)) d.addOption(k, h.label + (h.beta ? " (beta)" : ""));
				d.setValue(s.provider).onChange(async (v) => {
					s.provider = v as HostKind;
					await save();
					this.display();
				});
			});
		const host = HOSTS[s.provider];
		const tokenDesc = createFragment((f) => {
			f.appendText("Stored securely on this device only (Obsidian secret storage), never in the synced settings. Enter it once per device. ");
			const first = host.tokenSteps(p.getApiBase(), this.app.vault.getName())[0];
			f.appendText(first.text + " ");
			if (first.link) f.createEl("a", { text: first.link.label, href: first.link.href });
		});
		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(tokenDesc)
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder(s.provider === "github" ? "github_pat_…" : s.provider === "gitlab" ? "glpat-…" : "token").setValue(p.getToken()).onChange((v) => p.setToken(v.trim()));
			});

		new Setting(containerEl).setName("Owner").setDesc(s.provider === "gitlab" ? "User or group path (subgroups allowed, e.g. team/notes)." : "User or organisation that owns the repo.").addText((t) =>
			t.setPlaceholder("your-username").setValue(s.owner).onChange(async (v) => {
				s.owner = v.trim();
				await save();
			}),
		);
		new Setting(containerEl).setName("Repository").setDesc("Use a private repository.").addText((t) =>
			t.setPlaceholder("my-vault").setValue(s.repo).onChange(async (v) => {
				s.repo = v.trim();
				await save();
			}),
		);
		new Setting(containerEl).setName("Branch").addText((t) =>
			t.setValue(s.branch).onChange(async (v) => {
				s.branch = v.trim() || "main";
				await save();
			}),
		);

		new Setting(containerEl)
			.setName("Check setup")
			.setDesc("Test the token and repo, or create a new private repository.")
			.addButton((b) =>
				b.setButtonText("Test connection").onClick(async () => {
					try {
						const user = await p.gh.getUser();
						if (!s.owner) {
							s.owner = user.login;
							await save();
							this.display();
						}
						const repo = s.repo ? await p.gh.getRepo() : null;
						if (!s.repo) new Notice(`Signed in as ${user.login}. Now set a repository name.`);
						else if (!repo) new Notice(`Signed in as ${user.login}, but ${s.owner}/${s.repo} was not found or is not accessible.`);
						else new Notice(`OK: ${s.owner}/${s.repo} (${repo.private ? "private" : "PUBLIC: consider making it private"}).`);
					} catch (e) {
						new Notice(`Connection failed: ${errMsg(e)}`);
					}
				}),
			)
			.addButton((b) =>
				b.setButtonText("Create private repo").onClick(async () => {
					try {
						const user = await p.gh.getUser();
						if (!s.owner) s.owner = user.login;
						if (!s.repo) s.repo = this.app.vault.getName().replace(/[^A-Za-z0-9._-]+/g, "-");
						await save();
						const repo = await p.gh.createRepo(s.repo, s.owner !== user.login ? s.owner : undefined);
						new Notice(`Created ${repo.html_url}`);
						this.display();
					} catch (e) {
						new Notice(`Could not create repo: ${errMsg(e)}. Fine-grained tokens need "Administration: write" for this; or create it on github.com.`);
					}
				}),
			);

		new Setting(containerEl)
			.setName("API base URL")
			.setDesc(`${host.apiHint}. Stored on this device only.`)
			.addText((t) => t.setValue(p.getApiBase()).onChange((v) => p.setApiBase(v.trim() || host.defaultApi)));

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown in commit messages and conflict file names. Stored on this device only.")
			.addText((t) => t.setValue(p.deviceName()).onChange((v) => p.setDeviceName(v.trim())));

		// ---------- behaviour ----------
		new Setting(containerEl).setName("Sync behaviour").setHeading();

		new Setting(containerEl)
			.setName("Mode")
			.setDesc("Two-way sync, backup only (upload, never change local files), or pull only (read-only copy).")
			.addDropdown((d) =>
				d
					.addOptions({ sync: "Two-way sync", push: "Backup only (push)", pull: "Pull only (mirror)" })
					.setValue(s.mode)
					.onChange(async (v) => {
						s.mode = v as SyncMode;
						await save();
					}),
			);

		const toggle = (name: string, desc: string, key: "syncOnStartup" | "syncOnChange" | "syncOnResume" | "syncOnBackground") =>
			new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
				t.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					await save();
					p.rescheduleTriggers();
				}),
			);
		toggle("Sync on startup", "Pull and push when the vault opens.", "syncOnStartup");
		toggle("Sync after edits", "Sync shortly after you stop editing.", "syncOnChange");

		new Setting(containerEl)
			.setName("Edit delay (seconds)")
			.setDesc("How long to wait after the last edit before syncing.")
			.addSlider((sl) =>
				sl.setLimits(5, 300, 5).setValue(s.changeDebounceSec).setDynamicTooltip().onChange(async (v) => {
					s.changeDebounceSec = v;
					await save();
					p.rescheduleTriggers();
				}),
			);
		new Setting(containerEl)
			.setName("Periodic sync (minutes)")
			.setDesc("0 turns it off. Also catches changes to settings/config files.")
			.addText((t) =>
				t.setValue(String(s.intervalMin)).onChange(async (v) => {
					s.intervalMin = Math.max(0, Number(v) || 0);
					await save();
					p.rescheduleTriggers();
				}),
			);
		toggle("Sync when app comes back", "On mobile, sync when you switch back to Obsidian.", "syncOnResume");
		toggle("Sync when app goes to background", "Best-effort push when you leave Obsidian (mobile) or hide the window.", "syncOnBackground");

		// ---------- scope ----------
		new Setting(containerEl).setName("What to sync").setHeading();

		new Setting(containerEl)
			.setName(`Sync settings folder (${this.app.vault.configDir})`)
			.setDesc("Themes, snippets, hotkeys, plugins and their settings. Workspace layout is excluded by default.")
			.addToggle((t) =>
				t.setValue(s.syncConfigDir).onChange(async (v) => {
					s.syncConfigDir = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setClass("vsg-stacked")
			.setName("Exclude patterns")
			.setDesc("gitignore style, one per line. {config} means the settings folder. Excluded files are never uploaded, downloaded or deleted.")
			.addTextArea((t) => {
				t.inputEl.rows = 8;
				t.inputEl.addClass("vsg-textarea");
				t.setValue(s.excludePatterns).onChange(async (v) => {
					s.excludePatterns = v;
					await save();
				});
			});
		new Setting(containerEl)
			.setName("Max file size (MB)")
			.setDesc("Larger files are skipped. GitHub's hard limit is 100 MB.")
			.addText((t) =>
				t.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
					s.maxFileSizeMB = Math.min(s.lfsThresholdMB > 0 ? 2000 : 100, Math.max(1, Number(v) || 50));
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Store large files with Git LFS (MB)")
			.setDesc("Files at least this big are kept in the host's large-file storage instead of the repository, keeping the repo small and fast. 0 = off. Check your host's LFS quota (GitHub's free plan is limited). With LFS on, the max file size above can go up to 2000 MB.")
			.addText((t) =>
				t.setValue(String(s.lfsThresholdMB)).onChange(async (v) => {
					s.lfsThresholdMB = Math.max(0, Number(v) || 0);
					await save();
				}),
			);

		// ---------- encryption ----------
		new Setting(containerEl).setName("End-to-end encryption").setHeading();
		if (p.isEncrypted()) {
			new Setting(containerEl)
				.setName("Encryption is on (unlocked on this device)")
				.setDesc("Notes, attachments and file names are encrypted before upload. Other devices need the same passphrase.")
				.addButton((b) => b.setButtonText("Remove unencrypted copies…").onClick(() => p.removeUnencryptedFiles()))
				.addButton((b) =>
					b
						.setButtonText("Lock this device")
						.setWarning()
						.onClick(async () => {
							await p.lockEncryption();
							this.display();
						}),
				);
		} else {
			new Setting(containerEl)
				.setName("Encrypt your vault")
				.setDesc("GitHub only ever sees unreadable data. Also use this to unlock a repository that another device already encrypted.")
				.addButton((b) => b.setButtonText("Turn on or unlock…").onClick(() => p.openEncryption(() => this.display())));
		}

		// ---------- shared folders ----------
		new Setting(containerEl).setName("Shared folders").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Sync a folder with its own repository (for example a team folder) while the rest of the vault stays private.",
		});
		for (const f of s.sharedFolders ?? []) {
			new Setting(containerEl)
				.setName(`${f.folder} ↔ ${f.owner}/${f.repo}`)
				.setDesc(`${f.provider}, branch ${f.branch}`)
				.addToggle((t) =>
					t.setValue(f.enabled).onChange(async (v) => {
						f.enabled = v;
						await save();
					}),
				)
				.addExtraButton((b) =>
					b
						.setIcon("trash")
						.setTooltip("Stop syncing this folder separately")
						.onClick(async () => {
							s.sharedFolders = s.sharedFolders.filter((x) => x.id !== f.id);
							p.setSecret(`token-shared-${f.id}`, "");
							await save();
							this.display();
						}),
				);
		}
		new Setting(containerEl).addButton((b) => b.setButtonText("Add shared folder…").onClick(() => new SharedFolderModal(this.app, p, () => this.display()).open()));

		// ---------- this device ----------
		new Setting(containerEl).setName("This device only").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "These choices are stored on this device and are not synced, so a phone can sync less than a laptop. Files outside this device's scope are never uploaded, downloaded or deleted from here, and stay safe on GitHub.",
		});
		const ds = p.deviceScope();
		new Setting(containerEl)
			.setName("Only sync these folders")
			.setDesc("One folder or pattern per line, e.g. Daily/ or Projects/. Leave empty to sync everything.")
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setPlaceholder("Daily/\nProjects/").setValue(ds.include.join("\n")).onChange((v) => p.setDeviceScope({ ...p.deviceScope(), include: v.split("\n").map((x) => x.trim()).filter(Boolean) }));
			});
		new Setting(containerEl)
			.setName("Also exclude on this device")
			.setDesc("gitignore style, one per line, e.g. Attachments/ or *.mp4")
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setValue(ds.exclude.join("\n")).onChange((v) => p.setDeviceScope({ ...p.deviceScope(), exclude: v.split("\n").map((x) => x.trim()).filter(Boolean) }));
			});
		new Setting(containerEl)
			.setName("Don't download files larger than (MB)")
			.setDesc("Big attachments stay on GitHub and are not downloaded to this device. 0 = no limit.")
			.addText((t) => t.setValue(String(ds.maxDownloadMB)).onChange((v) => p.setDeviceScope({ ...p.deviceScope(), maxDownloadMB: Math.max(0, Number(v) || 0) })));
		new Setting(containerEl)
			.setName("Free up space")
			.setDesc("Remove local copies of files this device doesn't sync, but only when they are identical to the copy on GitHub.")
			.addButton((b) => b.setButtonText("Free up space…").onClick(() => p.freeUpSpace()));

		// ---------- conflicts & safety ----------
		new Setting(containerEl).setName("Conflicts and safety").setHeading();

		new Setting(containerEl)
			.setName("When a file changed on both sides")
			.addDropdown((d) =>
				d
					.addOptions({
						auto: "Merge automatically, keep both if lines overlap (recommended)",
						markers: "Merge, mark overlaps with <<<<<<< markers",
						"keep-both": "Keep both (save my version as a copy)",
						ask: "Ask me each time",
						local: "This device wins",
						remote: "GitHub wins",
					})
					.setValue(s.conflictStrategy)
					.onChange(async (v) => {
						s.conflictStrategy = v as ConflictStrategy;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Review before manual sync")
			.setDesc("When you press Sync, first show every pending change with diffs and checkboxes. Automatic syncs are not affected.")
			.addToggle((t) =>
				t.setValue(s.reviewBeforeManualSync).onChange(async (v) => {
					s.reviewBeforeManualSync = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Ignore line-ending-only changes")
			.setDesc("A file whose only change is Windows (CRLF) vs Unix (LF) line endings is treated as unchanged, so editors on other systems don't cause needless uploads or conflicts.")
			.addToggle((t) =>
				t.setValue(s.ignoreLineEndingChanges).onChange(async (v) => {
					s.ignoreLineEndingChanges = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Delete guard")
			.setDesc("Ask before a sync deletes many files at once.")
			.addToggle((t) =>
				t.setValue(s.deleteGuardEnabled).onChange(async (v) => {
					s.deleteGuardEnabled = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Delete guard threshold")
			.setDesc("Ask when deleting more than this many files (left) or this percent of the vault (right), whichever is larger.")
			.addText((t) =>
				t.setPlaceholder("files").setValue(String(s.deleteGuardMin)).onChange(async (v) => {
					s.deleteGuardMin = Math.max(0, Number(v) || 0);
					await save();
				}),
			)
			.addText((t) =>
				t.setPlaceholder("%").setValue(String(s.deleteGuardPercent)).onChange(async (v) => {
					s.deleteGuardPercent = Math.max(0, Math.min(100, Number(v) || 0));
					await save();
				}),
			);

		// ---------- backup ----------
		new Setting(containerEl).setName("Backup").setHeading();
		new Setting(containerEl)
			.setName("Daily snapshot")
			.setDesc("Once a day, tag the current state on GitHub (snapshot-YYYYMMDD-HHMMSS) so you can always get back to it.")
			.addToggle((t) =>
				t.setValue(s.dailySnapshot).onChange(async (v) => {
					s.dailySnapshot = v;
					await save();
				}),
			);

		// ---------- advanced ----------
		new Setting(containerEl).setName("Advanced").setHeading();
		new Setting(containerEl)
			.setName("Commit message")
			.setDesc("Variables: {{device}}, {{summary}}, {{date}}, {{count}}")
			.addText((t) =>
				t.setValue(s.commitTemplate).onChange(async (v) => {
					s.commitTemplate = v || "{{device}}: {{summary}}";
					await save();
				}),
			);
		new Setting(containerEl)
			.setName("Full rescan every (minutes)")
			.setDesc("Between full rescans only files Obsidian reports as edited are re-checked, and the settings folder is read from disk at most every 5 minutes. Keeps phones fast.")
			.addText((t) =>
				t.setValue(String(s.fullScanMinutes)).onChange(async (v) => {
					s.fullScanMinutes = Math.max(1, Number(v) || 30);
					await save();
				}),
			);
		new Setting(containerEl).setName("Notifications").addDropdown((d) =>
			d
				.addOptions({ all: "Every sync", errors: "Errors and conflicts only", silent: "None" })
				.setValue(s.noticeLevel)
				.onChange(async (v) => {
					s.noticeLevel = v as NoticeLevel;
					await save();
				}),
		);
		new Setting(containerEl)
			.setName("Reset sync state")
			.setDesc("Forget what was last synced on this device. The next sync compares everything and never deletes; differing files are kept as both versions.")
			.addButton((b) =>
				b
					.setButtonText("Reset")
					.setWarning()
					.onClick(async () => {
						await p.resetState();
						new Notice("Sync state reset.");
					}),
			);
	}
}
