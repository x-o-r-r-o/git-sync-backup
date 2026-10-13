import { App, Modal, Notice, Platform, PluginSettingTab, requireApiVersion, Setting, TextComponent } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type VaultSyncPlugin from "./main.ts";
import type { ConflictStrategy, NoticeLevel } from "./types.ts";
import type { SyncMode } from "./plan.ts";
import { localizeError } from "./errors.ts";
import { HOSTS } from "./hosts.ts";
import type { HostKind } from "./hosts.ts";
import { SharedFolderModal } from "./shared-ui.ts";
import { confirmPlan, destructive, RepoSuggestModal } from "./ui.ts";
import { t } from "./i18n.ts";
import { DeviceSignInModal } from "./ghapp-ui.ts";
import { GITLAB_APP } from "./gitlabapp.ts";
import type { PluginSyncMode } from "./scope-config.ts";

/** Runs `fn` when the field is committed (blur or Enter) instead of on every keystroke. */
function onCommit(c: TextComponent, fn: (v: string) => Promise<void>): TextComponent {
	c.inputEl.addEventListener("change", () => void fn(c.getValue()));
	return c;
}

interface Item {
	name: string;
	/** A string, or a factory for a fragment: a DocumentFragment is emptied once it is rendered. */
	desc?: string | (() => DocumentFragment);
	render: (s: Setting) => unknown;
	cls?: string;
	searchable?: boolean;
}

interface Group {
	heading?: string;
	/** Shown folded (in display()); basics stay open so the first screen is short. */
	collapsed?: boolean;
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

	private openGroups = new Set<string>();

	/** Backup mirror: a second repository every sync also uploads to (push only). */
	private mirrorItems(): Item[] {
		const p = this.plugin;
		const s = p.settings;
		const m = s.mirror ?? { enabled: false, provider: s.provider, owner: "", repo: "", branch: "main" };
		// Merge into the current value: fields save without redrawing, so `m` may be stale.
		const save = async (patch: Partial<typeof m>) => {
			s.mirror = { ...(s.mirror ?? m), ...patch };
			await p.saveSettings();
		};
		const def = { id: "mirror", provider: m.provider, folder: "", owner: m.owner, repo: m.repo, branch: m.branch, enabled: m.enabled };
		const text = (get: () => string, set: (v: string) => Partial<typeof m>) => (st: Setting): unknown =>
			st.addText((c) => onCommit(c.setValue(get()), async (v) => save(set(v.trim()))));
		return [
			{ name: "", desc: t("s.mirrorIntro"), render: () => undefined, searchable: false },
			{
				name: t("s.mirrorOn"),
				render: (st) =>
					st.addToggle((c) =>
						c.setValue(m.enabled).onChange(async (v) => {
							await save({ enabled: v });
							this.refresh();
						}),
					),
			},
			{
				name: t("s.host"),
				render: (st) =>
					st.addDropdown((d) => {
						for (const [k, h] of Object.entries(HOSTS)) d.addOption(k, h.label);
						d.setValue(m.provider).onChange(async (v) => {
							await save({ provider: v as HostKind });
							this.refresh();
						});
					}),
			},
			{ name: t("s.owner"), render: text(() => m.owner, (v) => ({ owner: v })) },
			{ name: t("s.repo"), render: text(() => m.repo, (v) => ({ repo: v })) },
			{ name: t("s.branch"), render: text(() => m.branch, (v) => ({ branch: v || "main" })) },
			{
				name: t("s.mirrorToken"),
				desc: t("s.mirrorTokenDesc"),
				render: (st) =>
					st
						.addText((c) => {
							c.inputEl.type = "password";
							onCommit(c.setValue(p.mirrorToken(def)), async (v) => p.setSharedToken(def, v.trim()));
						})
						.addButton((b) =>
							b.setButtonText(t("s.test")).onClick(async () => {
								try {
									const h = await p.mirror();
									if (!h) return void new Notice(t("s.mirrorIncomplete"));
									const repo = await h.gh.getRepo();
									const cur = s.mirror ?? m;
									new Notice(repo ? t("s.mirrorOk", { repo: `${cur.owner}/${cur.repo}` }) : t("s.testNotFound", { user: cur.owner, repo: `${cur.owner}/${cur.repo}` }));
								} catch (e) {
									new Notice(t("s.testFailed", { error: localizeError(e) }));
								}
							}),
						),
			},
		];
	}

	/** Closing settings with a field still focused fires no change event: blur it first so it saves. */
	hide(): void {
		const active = this.containerEl.ownerDocument.activeElement;
		if (active instanceof HTMLElement && this.containerEl.contains(active)) active.blur();
		super.hide();
	}

	/** Obsidian 1.13+ renders the tab from getSettingDefinitions(): rebuild those. Older versions use display(). */
	private refresh() {
		if (requireApiVersion("1.13.0")) this.update();
		else this.display();
	}

	/** Redraws the tab when it is on screen (e.g. after data.json changed on disk); does nothing otherwise. */
	refreshIfOpen() {
		if (this.containerEl.isShown()) this.refresh();
	}

	private groups(): Group[] {
		const p = this.plugin;
		const s = p.settings;
		const save = () => p.saveSettings();
		const host = HOSTS[s.provider];
		const ds = p.deviceScope();
		const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
		/** Number field saved when committed (blur/Enter), clamped, and the stored value written back. */
		const numberField = (get: () => number, set: (n: number) => void, opts: { min: number; max: number; fallback: number; integer?: boolean; after?: () => void }) => (st: Setting): unknown =>
			st.addText((c) => {
				c.inputEl.type = "number";
				c.inputEl.inputMode = "decimal";
				onCommit(c.setValue(String(get())), async (v) => {
					let n = v.trim() === "" ? opts.fallback : Number(v);
					if (!Number.isFinite(n)) n = opts.fallback;
					if (opts.integer) n = Math.round(n);
					set(Math.min(opts.max, Math.max(opts.min, n)));
					c.setValue(String(get()));
					await save();
					opts.after?.();
				});
			});
		/** GitHub refuses files over 100 MB without large file storage; other hosts (or LFS) allow up to 2000 MB here. */
		const maxSizeCap = () => ((s.provider ?? "github") === "github" && !(s.lfsThresholdMB > 0) ? 100 : 2000);

		type ToggleKey = "syncOnStartup" | "syncOnChange" | "syncOnResume" | "syncOnBackground" | "syncConfigDir" | "reviewBeforeManualSync" | "ignoreLineEndingChanges" | "deleteGuardEnabled" | "dailySnapshot" | "syncHidden" | "useGitignore" | "syncOnOpen" | "explorerBadges" | "keepEmptyFolders" | "syncHiddenNested";
		const toggle = (key: ToggleKey, reschedule = false, redraw = false) => (st: Setting): unknown =>
			st.addToggle((c) =>
				c.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					await save();
					if (reschedule) p.rescheduleTriggers();
					if (key === "explorerBadges") p.refreshBadges();
					if (redraw) this.refresh();
				}),
			);
		const cfgToggle = (key: "appearance" | "snippets" | "hotkeys" | "core" | "pluginList" | "pluginCode" | "pluginSettings" | "installFromReleases") => (st: Setting): unknown =>
			st.addToggle((c) =>
				c.setValue(s.configSync[key]).onChange(async (v) => {
					s.configSync = { ...s.configSync, [key]: v };
					await save();
				}),
			);
		const cfgItems: Item[] = s.syncConfigDir
			? [
					{ name: t("s.cfgAppearance"), desc: t("s.cfgAppearanceDesc"), cls: "vsg-indent", render: cfgToggle("appearance") },
					{ name: t("s.cfgSnippets"), cls: "vsg-indent", render: cfgToggle("snippets") },
					{ name: t("s.cfgHotkeys"), cls: "vsg-indent", render: cfgToggle("hotkeys") },
					{ name: t("s.cfgCore"), desc: t("s.cfgCoreDesc"), cls: "vsg-indent", render: cfgToggle("core") },
					{ name: t("s.cfgPluginList"), desc: t("s.cfgPluginListDesc"), cls: "vsg-indent", render: cfgToggle("pluginList") },
					{ name: t("s.cfgPluginCode"), desc: t("s.cfgPluginCodeDesc"), cls: "vsg-indent", render: cfgToggle("pluginCode") },
					{ name: t("s.cfgInstall"), desc: t("s.cfgInstallDesc"), cls: "vsg-indent", render: cfgToggle("installFromReleases") },
					{ name: t("s.cfgPluginSettings"), desc: t("s.cfgPluginSettingsDesc"), cls: "vsg-indent", render: cfgToggle("pluginSettings") },
					{
						name: t("s.cfgPerPlugin"),
						desc: t("s.cfgPerPluginDesc", { n: Object.keys(s.configSync.plugins).length }),
						cls: "vsg-indent",
						render: (st) => st.addButton((b) => b.setButtonText(t("s.cfgPerPluginBtn")).onClick(() => new PluginSyncModal(this.app, p, () => this.refresh()).open())),
					},
				]
			: [];

		const tokenDesc = () =>
			createFragment((f) => {
				f.appendText(t("s.tokenDesc") + " ");
				const first = host.tokenSteps(p.getApiBase(), this.app.vault.getName())[0];
				f.appendText(first.text + " ");
				if (first.link) f.createEl("a", { text: first.link.label, href: first.link.href });
			});

		// GitHub / GitLab: sign in with the host's app when one is available, else (or instead) paste a token.
		// Signed in only while the tokens exist and belong to this server (else offer sign-in / a token again).
		const usingApp = p.signedInNow();
		const auth: Item[] = [];
		const signInKind = s.provider === "github" && p.githubApp() ? "github" : s.provider === "gitlab" && p.gitlabApp() ? "gitlab" : null;
		if (usingApp) {
			auth.push({
				name: s.provider === "gitlab" ? t("app.signedInGitLab") : t("app.signedIn"),
				desc: s.provider === "gitlab" ? t("app.signedInDescGitLab") : t("app.signedInDesc"),
				render: (st) =>
					st.addButton((b) =>
						b.setButtonText(t("app.signOut")).onClick(() => {
							if (s.provider === "gitlab") p.signOutGitLab();
							else p.signOutApp();
							this.refresh();
						}),
					),
			});
		} else if (signInKind) {
			auth.push({
				name: signInKind === "gitlab" ? t("app.signInGitLab") : t("app.signIn"),
				desc: signInKind === "gitlab" ? t("app.signInDescGitLab") : t("app.signInDesc"),
				render: (st) => st.addButton((b) => b.setButtonText(t("app.signInBtn")).setCta().onClick(() => new DeviceSignInModal(this.app, p.signInFlow(signInKind), () => this.refresh()).open())),
			});
		}
		if (!usingApp) {
			auth.push({
				name: t("s.token"),
				desc: tokenDesc,
				render: (st) =>
					st.addText((c) => {
						c.inputEl.type = "password";
						onCommit(c.setPlaceholder(t("s.tokenPlaceholder")).setValue(p.getToken()), async (v) => {
							p.setToken(v.trim());
						});
					}),
			});
		}
		// GitHub Enterprise: sign-in needs the organisation's own GitHub App.
		const enterpriseApp: Item[] =
			s.provider === "github" && !/^https:\/\/api\.github\.com\/?$/i.test(p.getApiBase())
				? [
						{
							name: t("app.clientId"),
							desc: t("app.clientIdDesc"),
							render: (st) =>
								st.addText((c) =>
									onCommit(c.setValue(p.customGitHubApp().clientId), async (v) => {
										p.setCustomGitHubApp(v.trim(), p.customGitHubApp().slug);
										this.refresh();
									}),
								),
						},
						{
							name: t("app.slug"),
							desc: t("app.slugDesc"),
							render: (st) =>
								st.addText((c) =>
									onCommit(c.setValue(p.customGitHubApp().slug), async (v) => {
										p.setCustomGitHubApp(p.customGitHubApp().clientId, v.trim());
									}),
								),
						},
					]
				: [];
		// GitLab sign-in needs an OAuth application: the built-in one (gitlab.com, when registered) or your own.
		if (s.provider === "gitlab" && (!GITLAB_APP.clientId || !/^https:\/\/gitlab\.com\/api\/v4\/?$/i.test(p.getApiBase()))) {
			enterpriseApp.push({
				name: t("app.glClientId"),
				desc: t("app.glClientIdDesc"),
				render: (st) =>
					st.addText((c) =>
						onCommit(c.setValue(p.gitlabApp()?.clientId ?? ""), async (v) => {
							p.setCustomGitLabApp(v.trim());
							this.refresh();
						}),
					),
			});
		}

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
					...auth,
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
							st
								.addText((c) =>
									onCommit(c.setPlaceholder(t("s.repoPlaceholder")).setValue(s.repo), async (v) => {
										s.repo = v.trim();
										await save();
									}),
								)
								.addButton((b) =>
									// Pick from the repositories this account (or the signed-in app) can use.
									b.setButtonText(t("s.branchChoose")).onClick(async () => {
										if (!p.getToken()) return void new Notice(t("m.needToken"));
										b.setDisabled(true);
										try {
											const repos = await p.gh.listRepos();
											if (!repos.length) return void new Notice(p.usingGitHubApp() ? t("app.noRepos") : t("w.noMatch"));
											new RepoSuggestModal(this.app, repos, (r) =>
												void (async () => {
													if (!r.private && !(await confirmPlan(this.app, t("w.publicTitle"), t("w.publicBody", { repo: `${r.owner}/${r.name}` }), [], t("w.useAnyway"), true))) return;
													s.owner = r.owner;
													s.repo = r.name;
													s.branch = r.defaultBranch || "main";
													await save();
													this.refresh();
												})(),
											).open();
										} catch (e) {
											new Notice(t("w.listFailed", { error: localizeError(e) }), 10000);
										} finally {
											b.setDisabled(false);
										}
									}),
								),
					},
					{
						name: t("s.branch"),
						desc: t("s.branchDesc"),
						render: (st) =>
							st
								.addText((c) =>
									onCommit(c.setValue(s.branch), async (v) => {
										s.branch = v.trim() || "main";
										c.setValue(s.branch);
										await save();
									}),
								)
								.addButton((b) =>
									b.setButtonText(t("s.branchChoose")).onClick(() => {
										if (!p.isConfigured()) return void new Notice(t("m.needRepo"));
										new BranchModal(this.app, p, async (name) => {
											s.branch = name;
											await save();
											this.refresh();
										}).open();
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
											new Notice(t("s.testFailed", { error: localizeError(e) }));
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
											new Notice(t("s.createFailed", { error: localizeError(e) }));
										}
									}),
								),
					},
					{
						name: t("link.addDevice"),
						desc: t("link.addDeviceDesc"),
						render: (st) => st.addButton((b) => b.setButtonText(t("link.createBtn")).onClick(() => p.openSetupLink())),
					},
					{
						name: t("s.apiBase"),
						desc: t("s.apiBaseDesc", { hint: host.apiHint }),
						render: (st) =>
							st.addText((c) =>
								onCommit(c.setValue(p.getApiBase()), async (v) => {
									const url = v.trim().replace(/\/+$/, "") || host.defaultApi;
									// The token travels to this address: only https (http only for a local test server).
									if (!/^https:\/\/[^\s/?#]+/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
										new Notice(t("s.apiBaseInvalid"));
										c.setValue(p.getApiBase());
										return;
									}
									p.setApiBase(url);
									p.rebindToken();
									this.refresh();
								}),
							),
					},
					...enterpriseApp,
					{
						name: t("s.device"),
						desc: t("s.deviceDesc"),
						render: (st) =>
							st.addText((c) =>
								onCommit(c.setValue(p.deviceName()), async (v) => {
									p.setDeviceName(v.trim());
									c.setValue(p.deviceName());
								}),
							),
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
						render: (st) => {
							// Obsidian 1.13+ shows the value next to the slider; older versions show nothing, so
							// the description carries it there.
							const showValue = () => {
								if (!requireApiVersion("1.13.0")) st.setDesc(`${t("s.delayDesc")} ${t("s.delayNow", { n: s.changeDebounceSec })}`);
							};
							showValue();
							return st.addSlider((sl) =>
								sl.setLimits(5, 300, 5)
									.setValue(s.changeDebounceSec)
									.onChange(async (v) => {
										s.changeDebounceSec = v;
										showValue();
										await save();
										p.rescheduleTriggers();
									}),
							);
						},
					},
					{
						name: t("s.interval"),
						desc: t("s.intervalDesc"),
						render: numberField(() => s.intervalMin, (n) => (s.intervalMin = n === 0 ? 0 : Math.max(1, n)), { min: 0, max: 1440, fallback: 0, integer: true, after: () => p.rescheduleTriggers() }),
					},
					{ name: t("s.onResume"), desc: t("s.onResumeDesc"), render: toggle("syncOnResume", true) },
					{ name: t("s.onBackground"), desc: t("s.onBackgroundDesc"), render: toggle("syncOnBackground", true) },
					{ name: t("s.onOpen"), desc: t("s.onOpenDesc"), render: toggle("syncOnOpen") },
					{ name: t("s.badges"), desc: t("s.badgesDesc"), render: toggle("explorerBadges") },
				],
			},
			{
				heading: t("s.hScope"),
				collapsed: true,
				items: [
					{ name: t("s.configDir", { dir: this.app.vault.configDir }), desc: `${t("s.configDirDesc")} ${t("s.configDirWarn")}`, render: toggle("syncConfigDir", false, true) },
					...cfgItems,
					{ name: t("s.hidden"), desc: t("s.hiddenDesc"), render: toggle("syncHidden", false, true) },
					...(s.syncHidden ? [{ name: t("s.hiddenNested"), desc: t("s.hiddenNestedDesc"), render: toggle("syncHiddenNested") }] : []),
					{ name: t("s.gitignore"), desc: t("s.gitignoreDesc"), render: toggle("useGitignore") },
					{ name: t("s.emptyFolders"), desc: t("s.emptyFoldersDesc"), render: toggle("keepEmptyFolders") },
					{
						name: t("s.exclude"),
						desc: t("s.excludeDesc"),
						cls: "vsg-stacked",
						render: (st) =>
							st.addTextArea((c) => {
								c.inputEl.rows = 8;
								c.inputEl.addClass("vsg-textarea");
								onCommit(c.setValue(s.excludePatterns) as unknown as TextComponent, async (v) => {
									s.excludePatterns = v;
									await save();
								});
							}),
					},
					{
						name: t("s.maxSize"),
						desc: t("s.maxSizeDesc"),
						render: numberField(() => s.maxFileSizeMB, (n) => (s.maxFileSizeMB = Math.min(maxSizeCap(), n)), { min: 1, max: 2000, fallback: 50 }),
					},
					{
						name: t("s.lfs"),
						desc: t("s.lfsDesc"),
						render: numberField(() => s.lfsThresholdMB, (n) => (s.lfsThresholdMB = n), {
							min: 0,
							max: 2000,
							fallback: 0,
							after: () => {
								// The size cap depends on large file storage: re-apply it, and warn when LFS can never apply.
								s.maxFileSizeMB = Math.min(maxSizeCap(), s.maxFileSizeMB);
								void save();
								if (s.lfsThresholdMB > 0 && s.lfsThresholdMB >= s.maxFileSizeMB) new Notice(t("s.lfsAboveMax", { max: s.maxFileSizeMB }), 8000);
								this.refresh();
							},
						}),
					},
				],
			},
			{
				heading: t("s.hEncryption"),
				collapsed: true,
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
				collapsed: true,
				items: [
					{ name: "", desc: t("s.sharedIntro"), render: () => undefined, searchable: false },
					...(s.sharedFolders ?? []).map(
						(f): Item => ({
							name: `${f.folder} ↔ ${f.owner}/${f.repo}`,
							desc: t("s.sharedRowDesc", { host: HOSTS[f.provider]?.label ?? f.provider, branch: f.branch }) + (f.githubFormat ? ` · ${t("sh.ghFormat")}` : ""),
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
												p.setSharedToken(f, "");
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
				heading: t("s.hMirror"),
				collapsed: true,
				items: this.mirrorItems(),
			},
			{
				heading: t("s.hDevice"),
				collapsed: true,
				items: [
					{ name: "", desc: t("s.deviceIntro"), render: () => undefined, searchable: false },
					{
						name: t("s.battery"),
						desc: t("s.batteryDesc"),
						render: (st) => st.addToggle((c) => c.setValue(p.batterySaver()).onChange((v) => p.setBatterySaver(v))),
					},
					{
						name: t("s.pause"),
						desc: !p.isPaused()
							? t("s.pauseDesc")
							: Number.isFinite(p.pausedUntil())
								? t("s.pauseDescUntil", { time: new Date(p.pausedUntil()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })
								: t("s.pauseDescOn"),
						render: (st) =>
							p.isPaused()
								? st.addButton((b) =>
										b.setButtonText(t("h.resume")).setCta().onClick(() => {
											p.resumeSync();
											this.refresh();
										}),
									)
								: st
										.addButton((b) =>
											b.setButtonText(t("h.pause")).onClick(() => {
												p.pauseSync(60);
												this.refresh();
											}),
										)
										.addButton((b) =>
											b.setButtonText(t("s.pauseUntilResumed")).onClick(() => {
												p.pauseSync(null);
												this.refresh();
											}),
										),
					},
					{
						name: t("s.include"),
						desc: t("s.includeDesc"),
						render: (st) =>
							st.addTextArea((c) => {
								c.inputEl.rows = 3;
								c.setPlaceholder(t("s.includePlaceholder"))
									.setValue(ds.include.join("\n"));
								onCommit(c as unknown as TextComponent, async (v) => p.setDeviceScope({ ...p.deviceScope(), include: lines(v) }));
							}),
					},
					{
						name: t("s.deviceExclude"),
						desc: t("s.deviceExcludeDesc"),
						render: (st) =>
							st.addTextArea((c) => {
								c.inputEl.rows = 3;
								c.setValue(ds.exclude.join("\n"));
								onCommit(c as unknown as TextComponent, async (v) => p.setDeviceScope({ ...p.deviceScope(), exclude: lines(v) }));
							}),
					},
					{
						name: t("s.maxDownload"),
						desc: t("s.maxDownloadDesc"),
						render: (st) =>
							st.addText((c) => {
								c.inputEl.type = "number";
								onCommit(c.setValue(String(ds.maxDownloadMB)), async (v) => {
									const n = Number(v);
									// Empty or invalid: back to this platform's default (25 MB on phones, none on desktop).
									const value = v.trim() === "" || !Number.isFinite(n) ? (Platform.isMobile ? 25 : 0) : Math.max(0, n);
									p.setDeviceScope({ ...p.deviceScope(), maxDownloadMB: value });
									c.setValue(String(value));
								});
							}),
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
				collapsed: true,
				items: [
					{
						name: t("s.strategy"),
						desc: t("s.strategyDesc"),
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
								.addText((c) => {
									c.inputEl.type = "number";
									c.inputEl.setAttr("aria-label", t("s.guardMinLabel"));
									onCommit(c.setValue(String(s.deleteGuardMin)), async (v) => {
										s.deleteGuardMin = Math.max(0, Math.round(Number(v)) || 0);
										c.setValue(String(s.deleteGuardMin));
										await save();
									});
								})
								.addText((c) => {
									c.inputEl.type = "number";
									c.inputEl.setAttr("aria-label", t("s.guardPercentLabel"));
									onCommit(c.setValue(String(s.deleteGuardPercent)), async (v) => {
										s.deleteGuardPercent = Math.max(0, Math.min(100, Number(v) || 0));
										c.setValue(String(s.deleteGuardPercent));
										await save();
									});
								}),
					},
				],
			},
			{
				heading: t("s.hBackup"),
				collapsed: true,
				items: [{ name: t("s.snapshot"), desc: t("s.snapshotDesc"), render: toggle("dailySnapshot") }],
			},
			{
				heading: t("s.hAdvanced"),
				collapsed: true,
				items: [
					{
						name: t("s.commitMsg"),
						desc: t("s.commitMsgDesc"),
						render: (st) =>
							st.addText((c) =>
								onCommit(c.setValue(s.commitTemplate), async (v) => {
									s.commitTemplate = v.trim() || "{{device}}: {{summary}}";
									c.setValue(s.commitTemplate);
									await save();
								}),
							),
					},
					{
						name: t("s.author"),
						desc: t("s.authorDesc"),
						render: (st) =>
							st
								.addText((c) => {
									c.setPlaceholder(t("s.authorName"));
									c.inputEl.setAttr("aria-label", t("s.authorName"));
									onCommit(c.setValue(s.authorName ?? ""), async (v) => {
										s.authorName = v.trim();
										await save();
									});
								})
								.addText((c) => {
									c.inputEl.type = "email";
									c.setPlaceholder(t("s.authorEmail"));
									c.inputEl.setAttr("aria-label", t("s.authorEmail"));
									onCommit(c.setValue(s.authorEmail ?? ""), async (v) => {
										s.authorEmail = v.trim();
										await save();
									});
								}),
					},
					{
						name: t("s.fullScan"),
						desc: t("s.fullScanDesc"),
						render: numberField(() => s.fullScanMinutes, (n) => (s.fullScanMinutes = n), { min: 1, max: 1440, fallback: 30, integer: true }),
					},
					{
						name: t("s.notices"),
						render: (st) =>
							st.addDropdown((d) =>
								d
									.addOptions({ auto: t("s.noticesAuto"), all: t("s.noticesAll"), changes: t("s.noticesChanges"), errors: t("s.noticesErrors"), silent: t("s.noticesNone") })
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
									if (p.isSyncing()) return void new Notice(t("notice.busy"));
									if (!(await confirmPlan(this.app, t("s.resetState"), t("s.resetConfirm"), [], t("s.resetBtn"), true))) return;
									if (await p.resetState()) new Notice(t("s.resetDone"));
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
			let parent: HTMLElement = containerEl;
			if (g.heading && g.collapsed) {
				// Folded sections remember whether they were open while the settings stay open.
				const det = containerEl.createEl("details", { cls: "vsg-group" });
				det.open = this.openGroups.has(g.heading);
				det.createEl("summary", { cls: "vsg-group-summary", text: g.heading });
				const heading = g.heading;
				det.addEventListener("toggle", () => (det.open ? this.openGroups.add(heading) : this.openGroups.delete(heading)));
				parent = det;
			} else if (g.heading) new Setting(containerEl).setName(g.heading).setHeading();
			for (const item of g.items) {
				const desc = typeof item.desc === "function" ? item.desc() : item.desc;
				if (!item.name) {
					parent.createEl("p", { cls: "setting-item-description", text: typeof desc === "string" ? desc : (desc?.textContent ?? "") });
					continue;
				}
				const st = new Setting(parent).setName(item.name);
				if (desc) st.setDesc(desc);
				if (item.cls) st.setClass(item.cls);
				item.render(st);
			}
		}
	}

	/**
	 * Obsidian 1.13+: the tab is rendered from these definitions (and they feed settings search).
	 * Folded sections become sub-pages, so the first screen only shows the basics.
	 */
	getSettingDefinitions(): SettingDefinitionItem[] {
		const toGroup = (g: Group): SettingDefinitionItem => ({
			type: "group" as const,
			heading: g.heading,
			items: g.items.map((item) => ({
				name: item.name,
				desc: typeof item.desc === "function" ? item.desc() : item.desc,
				searchable: item.searchable ?? Boolean(item.name),
				render: (st: Setting) => {
					// Obsidian has already applied name and description.
					if (item.cls) st.setClass(item.cls);
					item.render(st);
				},
			})),
		});
		return this.groups().map((g) =>
			g.collapsed && g.heading ? { type: "page" as const, name: g.heading, items: [toGroup({ ...g, heading: undefined })] } : toGroup(g),
		);
	}
}

/** Per-plugin choice for the settings folder: follow the switches, or sync code and/or settings. */
class PluginSyncModal extends Modal {
	private plugin: VaultSyncPlugin;
	private onDone: () => void;

	constructor(app: App, plugin: VaultSyncPlugin, onDone: () => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	async onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(t("s.cfgPerPlugin"));
		contentEl.createEl("p", { cls: "vsg-muted", text: t("s.cfgPerPluginIntro") });
		const adapter = this.app.vault.adapter;
		const dir = `${this.app.vault.configDir}/plugins`;
		let folders: string[] = [];
		try {
			folders = (await adapter.list(dir)).folders.map((f) => f.split("/").pop() ?? f).sort();
		} catch {
			/* no plugins folder */
		}
		if (!folders.length) contentEl.createEl("p", { text: t("s.cfgNoPlugins") });
		const s = this.plugin.settings;
		for (const id of folders) {
			let name = id;
			try {
				name = (JSON.parse(await adapter.read(`${dir}/${id}/manifest.json`)) as { name?: string }).name || id;
			} catch {
				/* folder without a manifest */
			}
			new Setting(contentEl)
				.setName(name)
				.setDesc(id === this.plugin.manifest.id ? `${id} · ${t("s.cfgThisPlugin")}` : id)
				.addDropdown((d) =>
					d
						.addOptions({ default: t("s.cfgFollow"), all: t("s.cfgAll"), code: t("s.cfgCodeOnly"), settings: t("s.cfgSettingsOnly"), none: t("s.cfgNone") })
						.setValue(s.configSync.plugins[id] ?? "default")
						.onChange(async (v) => {
							const plugins = { ...s.configSync.plugins };
							if (v === "default") delete plugins[id];
							else plugins[id] = v as PluginSyncMode;
							s.configSync = { ...s.configSync, plugins };
							await this.plugin.saveSettings();
						}),
				);
		}
	}

	onClose() {
		this.contentEl.empty();
		this.onDone();
	}
}

/** Pick a branch of the repository, or create a new one from the current branch. */
class BranchModal extends Modal {
	private plugin: VaultSyncPlugin;
	private onPick: (name: string) => Promise<void>;

	constructor(app: App, plugin: VaultSyncPlugin, onPick: (name: string) => Promise<void>) {
		super(app);
		this.plugin = plugin;
		this.onPick = onPick;
	}

	async onOpen() {
		const { contentEl } = this;
		const p = this.plugin;
		this.titleEl.setText(t("s.branchPick"));
		contentEl.createEl("p", { cls: "vsg-muted", text: t("s.branchIntro") });
		const status = contentEl.createDiv({ cls: "vsg-muted", text: t("w.loadingRepos") });
		let newName = "";
		new Setting(contentEl)
			.setName(t("s.branchNew"))
			.addText((c) => c.onChange((v) => (newName = v.trim())))
			.addButton((b) =>
				b.setButtonText(t("w.create")).onClick(async () => {
					if (!/^[\w./-]+$/.test(newName) || newName.includes("..")) return void new Notice(t("s.branchInvalid"));
					try {
						const head = await p.gh.getRef(p.settings.branch);
						if (!head) throw new Error(t("s.branchNoHead", { branch: p.settings.branch }));
						await p.gh.createRef(`refs/heads/${newName}`, head);
						await this.onPick(newName);
						this.close();
					} catch (e) {
						new Notice(t("w.createFailed", { error: localizeError(e) }), 8000);
					}
				}),
			);
		try {
			const branches = (await p.gh.listBranches?.()) ?? [];
			status.remove();
			if (!branches.length) contentEl.createEl("p", { text: t("s.branchNone") });
			for (const br of branches.sort((a, b) => a.name.localeCompare(b.name))) {
				new Setting(contentEl)
					.setName(br.name)
					.setDesc(br.name === p.settings.branch ? t("s.branchCurrent") : br.sha.slice(0, 7))
					.addButton((b) =>
						b
							.setButtonText(t("s.branchUse"))
							.setDisabled(br.name === p.settings.branch)
							.onClick(async () => {
								await this.onPick(br.name);
								this.close();
							}),
					);
			}
		} catch (e) {
			status.setText(t("w.listFailed", { error: localizeError(e) }));
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
