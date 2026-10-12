import { App, Notice, PluginSettingTab, Setting, TextComponent } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type VaultSyncPlugin from "./main.ts";
import type { ConflictStrategy, NoticeLevel } from "./types.ts";
import type { SyncMode } from "./plan.ts";
import { errMsg } from "./util.ts";
import { HOSTS } from "./hosts.ts";
import type { HostKind } from "./hosts.ts";
import { SharedFolderModal } from "./shared-ui.ts";
import { destructive } from "./ui.ts";
import { t } from "./i18n.ts";

/** Runs `fn` when the field is committed (blur or Enter) instead of on every keystroke. */
function onCommit(c: TextComponent, fn: (v: string) => Promise<void>): TextComponent {
	c.inputEl.addEventListener("change", () => void fn(c.getValue()));
	return c;
}

interface Item {
	name: string;
	desc?: string | DocumentFragment;
	render: (s: Setting) => unknown;
	cls?: string;
	searchable?: boolean;
}

interface Group {
	heading?: string;
	items: Item[];
}

/**
 * The settings are described once, as data. `display()` renders them on every Obsidian version, and
 * `getSettingDefinitions()` exposes the same items to Obsidian 1.13+ so they appear in settings search.
 */
export class VaultSyncSettingTab extends PluginSettingTab {
	private plugin: VaultSyncPlugin;

	constructor(app: App, plugin: VaultSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private refresh() {
		this.display();
	}

	private groups(): Group[] {
		const p = this.plugin;
		const s = p.settings;
		const save = () => p.saveSettings();
		const host = HOSTS[s.provider];
		const ds = p.deviceScope();
		const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);

		const toggle = (key: "syncOnStartup" | "syncOnChange" | "syncOnResume" | "syncOnBackground" | "syncConfigDir" | "reviewBeforeManualSync" | "ignoreLineEndingChanges" | "deleteGuardEnabled" | "dailySnapshot", reschedule = false) => (st: Setting): unknown =>
			st.addToggle((c) =>
				c.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					await save();
					if (reschedule) p.rescheduleTriggers();
				}),
			);

		const tokenDesc = createFragment((f) => {
			f.appendText(t("s.tokenDesc") + " ");
			const first = host.tokenSteps(p.getApiBase(), this.app.vault.getName())[0];
			f.appendText(first.text + " ");
			if (first.link) f.createEl("a", { text: first.link.label, href: first.link.href });
		});

		return [
			{
				items: [
					{
						name: t("s.wizard"),
						desc: t("s.wizardDesc"),
						render: (st) => st.addButton((b) => b.setButtonText(t("s.wizardBtn")).setCta().onClick(() => p.openWizard())),
					},
				],
			},
			{
				heading: t("s.hConnection"),
				items: [
					{
						name: t("s.host"),
						desc: t("s.hostDesc"),
						render: (st) =>
							st.addDropdown((d) => {
								for (const [k, h] of Object.entries(HOSTS)) d.addOption(k, h.label + (h.beta ? ` (${t("s.beta")})` : ""));
								d.setValue(s.provider).onChange(async (v) => {
									s.provider = v as HostKind;
									await save();
									this.refresh();
								});
							}),
					},
					{
						name: t("s.token"),
						desc: tokenDesc,
						render: (st) =>
							st.addText((c) => {
								c.inputEl.type = "password";
								c.setPlaceholder(t("s.tokenPlaceholder"))
									.setValue(p.getToken())
									.onChange((v) => p.setToken(v.trim()));
							}),
					},
					{
						name: t("s.owner"),
						desc: s.provider === "gitlab" ? t("s.ownerDescGitlab") : s.provider === "bitbucket" ? t("s.ownerDescBitbucket") : t("s.ownerDesc"),
						render: (st) =>
							st.addText((c) =>
								onCommit(c.setPlaceholder(t("s.ownerPlaceholder")).setValue(s.owner), async (v) => {
									s.owner = v.trim();
									await save();
								}),
							),
					},
					{
						name: t("s.repo"),
						desc: t("s.repoDesc"),
						render: (st) =>
							st.addText((c) =>
								onCommit(c.setPlaceholder(t("s.repoPlaceholder")).setValue(s.repo), async (v) => {
									s.repo = v.trim();
									await save();
								}),
							),
					},
					{
						name: t("s.branch"),
						render: (st) =>
							st.addText((c) =>
								onCommit(c.setValue(s.branch), async (v) => {
									s.branch = v.trim() || "main";
									await save();
								}),
							),
					},
					{
						name: t("s.check"),
						desc: t("s.checkDesc"),
						render: (st) =>
							st
								.addButton((b) =>
									b.setButtonText(t("s.test")).onClick(async () => {
										try {
											const user = await p.gh.getUser();
											if (!s.owner) {
												s.owner = user.login;
												await save();
												this.refresh();
											}
											const repo = s.repo ? await p.gh.getRepo() : null;
											if (!s.repo) new Notice(t("s.testNoRepo", { user: user.login }));
											else if (!repo) new Notice(t("s.testNotFound", { user: user.login, repo: `${s.owner}/${s.repo}` }));
											else new Notice(t(repo.private ? "s.testOkPrivate" : "s.testOkPublic", { repo: `${s.owner}/${s.repo}` }));
										} catch (e) {
											new Notice(t("s.testFailed", { error: errMsg(e) }));
										}
									}),
								)
								.addButton((b) =>
									b.setButtonText(t("s.createRepo")).onClick(async () => {
										try {
											const user = await p.gh.getUser();
											if (!s.owner) s.owner = user.login;
											if (!s.repo) s.repo = this.app.vault.getName().replace(/[^A-Za-z0-9._-]+/g, "-");
											await save();
											const repo = await p.gh.createRepo(s.repo, s.owner !== user.login ? s.owner : undefined);
											new Notice(t("s.created", { url: repo.html_url }));
											this.refresh();
										} catch (e) {
											new Notice(t("s.createFailed", { error: errMsg(e) }));
										}
									}),
								),
					},
					{
						name: t("s.apiBase"),
						desc: t("s.apiBaseDesc", { hint: host.apiHint }),
						render: (st) => st.addText((c) => c.setValue(p.getApiBase()).onChange((v) => p.setApiBase(v.trim() || host.defaultApi))),
					},
					{
						name: t("s.device"),
						desc: t("s.deviceDesc"),
						render: (st) => st.addText((c) => c.setValue(p.deviceName()).onChange((v) => p.setDeviceName(v.trim()))),
					},
				],
			},
			{
				heading: t("s.hBehaviour"),
				items: [
					{
						name: t("s.mode"),
						desc: t("s.modeDesc"),
						render: (st) =>
							st.addDropdown((d) =>
								d
									.addOptions({ sync: t("s.modeSync"), push: t("s.modePush"), pull: t("s.modePull") })
									.setValue(s.mode)
									.onChange(async (v) => {
										s.mode = v as SyncMode;
										await save();
									}),
							),
					},
					{ name: t("s.onStartup"), desc: t("s.onStartupDesc"), render: toggle("syncOnStartup", true) },
					{ name: t("s.onChange"), desc: t("s.onChangeDesc"), render: toggle("syncOnChange", true) },
					{
						name: t("s.delay"),
						desc: t("s.delayDesc"),
						render: (st) =>
							st.addSlider((sl) =>
								sl.setLimits(5, 300, 5)
									.setValue(s.changeDebounceSec)
									.onChange(async (v) => {
										s.changeDebounceSec = v;
										await save();
										p.rescheduleTriggers();
									}),
							),
					},
					{
						name: t("s.interval"),
						desc: t("s.intervalDesc"),
						render: (st) =>
							st.addText((c) =>
								c.setValue(String(s.intervalMin)).onChange(async (v) => {
									s.intervalMin = Math.max(0, Number(v) || 0);
									await save();
									p.rescheduleTriggers();
								}),
							),
					},
					{ name: t("s.onResume"), desc: t("s.onResumeDesc"), render: toggle("syncOnResume", true) },
					{ name: t("s.onBackground"), desc: t("s.onBackgroundDesc"), render: toggle("syncOnBackground", true) },
				],
			},
			{
				heading: t("s.hScope"),
				items: [
					{ name: t("s.configDir", { dir: this.app.vault.configDir }), desc: t("s.configDirDesc"), render: toggle("syncConfigDir") },
					{
						name: t("s.exclude"),
						desc: t("s.excludeDesc"),
						cls: "vsg-stacked",
						render: (st) =>
							st.addTextArea((c) => {
								c.inputEl.rows = 8;
								c.inputEl.addClass("vsg-textarea");
								c.setValue(s.excludePatterns).onChange(async (v) => {
									s.excludePatterns = v;
									await save();
								});
							}),
					},
					{
						name: t("s.maxSize"),
						desc: t("s.maxSizeDesc"),
						render: (st) =>
							st.addText((c) =>
								c.setValue(String(s.maxFileSizeMB)).onChange(async (v) => {
									s.maxFileSizeMB = Math.min(s.lfsThresholdMB > 0 ? 2000 : 100, Math.max(1, Number(v) || 50));
									await save();
								}),
							),
					},
					{
						name: t("s.lfs"),
						desc: t("s.lfsDesc"),
						render: (st) =>
							st.addText((c) =>
								c.setValue(String(s.lfsThresholdMB)).onChange(async (v) => {
									s.lfsThresholdMB = Math.max(0, Number(v) || 0);
									await save();
								}),
							),
					},
				],
			},
			{
				heading: t("s.hEncryption"),
				items: p.isEncrypted()
					? [
							{
								name: t("s.encOn"),
								desc: t("s.encOnDesc"),
								render: (st) =>
									st
										.addButton((b) => b.setButtonText(t("s.encRemovePlain")).onClick(() => p.removeUnencryptedFiles()))
										.addButton((b) =>
											destructive(b.setButtonText(t("s.encLock"))).onClick(async () => {
												await p.lockEncryption();
												this.refresh();
											}),
										),
							},
						]
					: [
							{
								name: t("s.encOff"),
								desc: t("s.encOffDesc"),
								render: (st) => st.addButton((b) => b.setButtonText(t("s.encTurnOn")).onClick(() => p.openEncryption(() => this.refresh()))),
							},
						],
			},
			{
				heading: t("s.hShared"),
				items: [
					{ name: "", desc: t("s.sharedIntro"), render: () => undefined, searchable: false },
					...(s.sharedFolders ?? []).map(
						(f): Item => ({
							name: `${f.folder} ↔ ${f.owner}/${f.repo}`,
							desc: t("s.sharedRowDesc", { host: HOSTS[f.provider]?.label ?? f.provider, branch: f.branch }),
							render: (st) =>
								st
									.addToggle((c) =>
										c.setValue(f.enabled).onChange(async (v) => {
											f.enabled = v;
											await save();
										}),
									)
									.addExtraButton((b) =>
										b
											.setIcon("trash")
											.setTooltip(t("s.sharedRemove"))
											.onClick(async () => {
												s.sharedFolders = s.sharedFolders.filter((x) => x.id !== f.id);
												p.setSecret(`token-shared-${f.id}`, "");
												await save();
												this.refresh();
											}),
									),
						}),
					),
					{
						name: t("s.sharedAdd"),
						render: (st) => st.addButton((b) => b.setButtonText(t("s.sharedAddBtn")).onClick(() => new SharedFolderModal(this.app, p, () => this.refresh()).open())),
					},
				],
			},
			{
				heading: t("s.hDevice"),
				items: [
					{ name: "", desc: t("s.deviceIntro"), render: () => undefined, searchable: false },
					{
						name: t("s.include"),
						desc: t("s.includeDesc"),
						render: (st) =>
							st.addTextArea((c) => {
								c.inputEl.rows = 3;
								c.setPlaceholder(t("s.includePlaceholder"))
									.setValue(ds.include.join("\n"))
									.onChange((v) => p.setDeviceScope({ ...p.deviceScope(), include: lines(v) }));
							}),
					},
					{
						name: t("s.deviceExclude"),
						desc: t("s.deviceExcludeDesc"),
						render: (st) =>
							st.addTextArea((c) => {
								c.inputEl.rows = 3;
								c.setValue(ds.exclude.join("\n")).onChange((v) => p.setDeviceScope({ ...p.deviceScope(), exclude: lines(v) }));
							}),
					},
					{
						name: t("s.maxDownload"),
						desc: t("s.maxDownloadDesc"),
						render: (st) => st.addText((c) => c.setValue(String(ds.maxDownloadMB)).onChange((v) => p.setDeviceScope({ ...p.deviceScope(), maxDownloadMB: Math.max(0, Number(v) || 0) }))),
					},
					{
						name: t("s.onDemand"),
						desc: t("s.onDemandDesc", { n: p.remoteOnlyFiles().length, pinned: p.pinned().length }),
						render: (st) =>
							st
								.addButton((b) => b.setButtonText(t("s.onDemandBrowse")).onClick(() => p.openRemoteOnly()))
								.addButton((b) =>
									b.setButtonText(t("s.onDemandForget")).onClick(() => {
										p.clearPinned();
										new Notice(t("s.onDemandForgotten"));
										this.refresh();
									}),
								),
					},
					{
						name: t("s.freeSpace"),
						desc: t("s.freeSpaceDesc"),
						render: (st) => st.addButton((b) => b.setButtonText(t("s.freeSpaceBtn")).onClick(() => p.freeUpSpace())),
					},
				],
			},
			{
				heading: t("s.hConflicts"),
				items: [
					{
						name: t("s.strategy"),
						render: (st) =>
							st.addDropdown((d) =>
								d
									.addOptions({
										auto: t("s.strategyAuto"),
										markers: t("s.strategyMarkers"),
										"keep-both": t("s.strategyBoth"),
										ask: t("s.strategyAsk"),
										local: t("s.strategyLocal"),
										remote: t("s.strategyRemote", { host: host.label }),
									})
									.setValue(s.conflictStrategy)
									.onChange(async (v) => {
										s.conflictStrategy = v as ConflictStrategy;
										await save();
									}),
							),
					},
					{ name: t("s.review"), desc: t("s.reviewDesc"), render: toggle("reviewBeforeManualSync") },
					{ name: t("s.eol"), desc: t("s.eolDesc"), render: toggle("ignoreLineEndingChanges") },
					{ name: t("s.guard"), desc: t("s.guardDesc"), render: toggle("deleteGuardEnabled") },
					{
						name: t("s.guardThreshold"),
						desc: t("s.guardThresholdDesc"),
						render: (st) =>
							st
								.addText((c) =>
									c.setPlaceholder("10")
										.setValue(String(s.deleteGuardMin))
										.onChange(async (v) => {
											s.deleteGuardMin = Math.max(0, Number(v) || 0);
											await save();
										}),
								)
								.addText((c) =>
									c.setPlaceholder("20")
										.setValue(String(s.deleteGuardPercent))
										.onChange(async (v) => {
											s.deleteGuardPercent = Math.max(0, Math.min(100, Number(v) || 0));
											await save();
										}),
								),
					},
				],
			},
			{
				heading: t("s.hBackup"),
				items: [{ name: t("s.snapshot"), desc: t("s.snapshotDesc"), render: toggle("dailySnapshot") }],
			},
			{
				heading: t("s.hAdvanced"),
				items: [
					{
						name: t("s.commitMsg"),
						desc: t("s.commitMsgDesc"),
						render: (st) =>
							st.addText((c) =>
								c.setValue(s.commitTemplate).onChange(async (v) => {
									s.commitTemplate = v || "{{device}}: {{summary}}";
									await save();
								}),
							),
					},
					{
						name: t("s.fullScan"),
						desc: t("s.fullScanDesc"),
						render: (st) =>
							st.addText((c) =>
								c.setValue(String(s.fullScanMinutes)).onChange(async (v) => {
									s.fullScanMinutes = Math.max(1, Number(v) || 30);
									await save();
								}),
							),
					},
					{
						name: t("s.notices"),
						render: (st) =>
							st.addDropdown((d) =>
								d
									.addOptions({ all: t("s.noticesAll"), errors: t("s.noticesErrors"), silent: t("s.noticesNone") })
									.setValue(s.noticeLevel)
									.onChange(async (v) => {
										s.noticeLevel = v as NoticeLevel;
										await save();
									}),
							),
					},
					{
						name: t("s.resetState"),
						desc: t("s.resetStateDesc"),
						render: (st) =>
							st.addButton((b) =>
								b.setButtonText(t("s.resetBtn")).onClick(async () => {
									await p.resetState();
									new Notice(t("s.resetDone"));
								}),
							),
					},
				],
			},
		];
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const g of this.groups()) {
			if (g.heading) new Setting(containerEl).setName(g.heading).setHeading();
			for (const item of g.items) {
				if (!item.name) {
					containerEl.createEl("p", { cls: "setting-item-description", text: typeof item.desc === "string" ? item.desc : (item.desc?.textContent ?? "") });
					continue;
				}
				const st = new Setting(containerEl).setName(item.name);
				if (item.desc) st.setDesc(item.desc);
				if (item.cls) st.setClass(item.cls);
				item.render(st);
			}
		}
	}

	/** Obsidian 1.13+: the same settings, described for settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.groups().map((g) => ({
			type: "group" as const,
			heading: g.heading,
			items: g.items.map((item) => ({
				name: item.name,
				desc: item.desc,
				searchable: item.searchable ?? Boolean(item.name),
				render: (st: Setting) => {
					if (item.name) st.setName(item.name);
					if (item.desc) st.setDesc(item.desc);
					if (item.cls) st.setClass(item.cls);
					item.render(st);
				},
			})),
		}));
	}
}
