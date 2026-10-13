// First-run setup: connect to a Git host, pick or create a repo, decide how this vault relates to it,
// then run the first sync with live progress.

import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { HOSTS } from "./hosts.ts";
import { confirmPlan } from "./ui.ts";
import type { HostKind } from "./hosts.ts";
import { createEncryption, passphraseStrength } from "./crypto.ts";
import { EncryptionModal, readRemoteMarker } from "./encryption-ui.ts";
import type VaultSyncPlugin from "./main.ts";
import { localizeError } from "./errors.ts";
import { t as tr } from "./i18n.ts";
import { DeviceSignInModal } from "./ghapp-ui.ts";
import { installUrl } from "./ghapp.ts";

type Step = "connect" | "repo" | "vault" | "syncing" | "done";
type FirstSync = "upload" | "download" | "merge" | "prefer-local";


export class SetupWizard extends Modal {
	private step: Step = "connect";
	private login = "";
	private cancelled = false;
	private choice: FirstSync = "merge";
	private resultText = "";

	constructor(app: App, private plugin: VaultSyncPlugin, start?: "vault") {
		super(app);
		if (start) this.step = start;
	}

	onOpen() {
		this.modalEl.addClass("vsg-wizard");
		this.render();
	}
	onClose() {
		this.cancelled = true;
		this.stopRepoWatch();
		this.contentEl.empty();
		this.plugin.onProgress = null;
	}

	private go(step: Step) {
		if (step !== "repo") this.stopRepoWatch();
		this.step = step;
		this.render();
	}

	private header(n: number, title: string, sub: string) {
		const steps = [tr("w.stepConnect"), tr("w.stepRepo"), tr("w.stepVault"), tr("w.stepSync")];
		const bar = this.contentEl.createDiv({ cls: "vsg-wz-steps" });
		steps.forEach((s, i) => bar.createSpan({ text: `${i + 1}. ${s}`, cls: i + 1 === n ? "is-active" : i + 1 < n ? "is-done" : "" }));
		this.titleEl.setText(title);
		this.contentEl.createEl("p", { text: sub, cls: "vsg-muted" });
	}

	/** Bumped on every render: async steps check it after awaiting, so a stale step never draws into a newer one. */
	private generation = 0;

	private render() {
		this.generation++;
		this.contentEl.empty();
		if (this.step === "connect") this.renderConnect();
		else if (this.step === "repo") void this.renderRepo();
		else if (this.step === "vault") void this.renderVault();
		else if (this.step === "syncing") this.renderSyncing();
		else this.renderDone();
	}

	// ---------- 1. connect ----------
	private renderConnect() {
		const p = this.plugin;
		this.header(1, tr("w.title"), tr("w.sub"));

		new Setting(this.contentEl)
			.setName(tr("w.where"))
			.addDropdown((d) => {
				for (const [k, h] of Object.entries(HOSTS)) d.addOption(k, h.label + (h.beta ? ` (${tr("s.beta")})` : ""));
				d.setValue(p.settings.provider).onChange(async (v) => {
					p.settings.provider = v as HostKind;
					await p.saveSettings();
					this.render();
				});
			});
		const host = HOSTS[p.settings.provider];
		// Shown for every host (GitHub Enterprise too); saved when committed, then the token links follow it.
		new Setting(this.contentEl)
			.setName(tr("w.apiUrl"))
			.setDesc(host.apiHint)
			.addText((t) => {
				t.setValue(p.getApiBase());
				t.inputEl.addEventListener("change", () => {
					const url = t.getValue().trim().replace(/\/+$/, "") || host.defaultApi;
					if (!/^https:\/\/[^\s/?#]+/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
						new Notice(tr("s.apiBaseInvalid"));
						t.setValue(p.getApiBase());
						return;
					}
					p.setApiBase(url);
					p.rebindToken();
					this.render();
				});
			});

		new Setting(this.contentEl)
			.setName(tr("w.deviceName"))
			.setDesc(tr("w.deviceNameDesc"))
			.addText((t) => {
				t.setValue(p.deviceName());
				t.inputEl.addEventListener("change", () => p.setDeviceName(t.getValue().trim()));
			});

		// Another sync tool on the same vault can overwrite changes: say so before anything syncs.
		const others = this.contentEl.createDiv();
		void p.checkOtherSync().then((found) => {
			if (!found.length) return;
			const box = others.createDiv({ cls: "vsg-h-error" });
			box.createDiv({ text: tr("os.found", { list: found.map((x) => (x === ".git" ? tr("os.gitFolder") : x)).join(", ") }) });
			box.createDiv({ cls: "vsg-muted", text: tr("os.hint") });
		});
		this.contentEl.createEl("p", { cls: "vsg-muted", text: tr("link.wizardHint") });

		const status = this.contentEl.createDiv({ cls: "vsg-wz-status" });
		const done = async (token?: string) => {
			if (token !== undefined) p.setToken(token);
			try {
				this.login = (await p.gh.getUser()).login;
				new Notice(tr("w.signedIn", { user: this.login }));
				this.go("repo");
			} catch (e) {
				status.setText(tr("w.tokenFailed", { error: localizeError(e) }));
			}
		};

		if (p.getToken()) {
			new Setting(this.contentEl)
				.setName(tr("w.alreadyConnected"))
				.addButton((b) => b.setButtonText(tr("w.continue")).setCta().onClick(() => done()));
		}

		const kind = p.settings.provider === "github" && p.githubApp() ? "github" : p.settings.provider === "gitlab" && p.gitlabApp() ? "gitlab" : null;
		const app = kind !== null;
		if (kind) {
			const box = this.contentEl.createDiv({ cls: "vsg-wz-token" });
			box.createEl("h4", { text: kind === "gitlab" ? tr("app.signInGitLab") : tr("app.signIn") });
			new Setting(box)
				.setDesc(kind === "gitlab" ? tr("app.signInDescGitLab") : tr("app.signInDesc"))
				.addButton((b) =>
					b
						.setButtonText(tr("app.signInBtn"))
						.setCta()
						.onClick(() => new DeviceSignInModal(this.app, p.signInFlow(kind), (ok) => void (ok && done())).open()),
				);
		}

		const tokenBox = this.contentEl.createDiv({ cls: "vsg-wz-token" });
		tokenBox.createEl("h4", { text: app ? tr("app.orToken") : tr("w.connectWith", { host: host.label.split(" ")[0] }) });
		const tips = tokenBox.createEl("ol", { cls: "vsg-muted" });
		for (const step of host.tokenSteps(p.getApiBase(), this.app.vault.getName())) {
			const li = tips.createEl("li");
			li.appendText(step.text + (step.link ? " " : ""));
			if (step.link) li.createEl("a", { text: step.link.label, href: step.link.href });
		}
		tips.createEl("li", { text: tr("w.tokenStored") });
		let value = "";
		new Setting(tokenBox)
			.setName(tr("w.token"))
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder(tr("s.tokenPlaceholder")).onChange((v) => (value = v.trim()));
			})
			.addButton((b) =>
				b.setButtonText(tr("w.continue")).onClick(() => {
					if (!value) return void status.setText(tr("w.pasteFirst"));
					void done(value);
				}),
			);
	}

	// ---------- 2. repository ----------
	/** While the user grants repositories on GitHub: reload the list when Obsidian gets focus again, and every few seconds. */
	private reloadRepos: (() => Promise<void>) | null = null;
	private watchTimer: number | null = null;
	private readonly onFocus = () => void this.reloadRepos?.();
	private startRepoWatch() {
		this.stopRepoWatch();
		window.addEventListener("focus", this.onFocus);
		const until = Date.now() + 3 * 60_000;
		this.watchTimer = window.setInterval(() => {
			if (Date.now() > until) this.stopRepoWatch();
			else void this.reloadRepos?.();
		}, 4000);
	}
	private stopRepoWatch() {
		window.removeEventListener("focus", this.onFocus);
		if (this.watchTimer !== null) window.clearInterval(this.watchTimer);
		this.watchTimer = null;
	}

	private async renderRepo() {
		const p = this.plugin;
		const gen = this.generation;
		// Opened from a setup link (straight to step 3) and then "Back": the account name isn't known yet.
		if (!this.login) {
			try {
				this.login = (await p.gh.getUser()).login;
			} catch {
				this.login = p.settings.owner;
			}
			if (gen !== this.generation) return;
		}
		this.header(2, tr("w.repoTitle"), tr("w.repoSub", { user: this.login }));
		const pick = async (owner: string, name: string, branch: string) => {
			this.stopRepoWatch();
			p.settings.owner = owner;
			p.settings.repo = name;
			p.settings.branch = branch || "main";
			await p.saveSettings();
			this.go("vault");
		};
		const signedInApp = p.usingGitHubApp();

		let newName = this.app.vault.getName().replace(/[^A-Za-z0-9._-]+/g, "-");
		if (!signedInApp)
			new Setting(this.contentEl)
				.setName(tr("w.createNew"))
				.addText((t) => t.setValue(newName).onChange((v) => (newName = v.trim())))
				.addButton((b) =>
					b
						.setButtonText(tr("w.create"))
						.setCta()
						.onClick(async () => {
							if (!this.login) return void new Notice(tr("w.createFailed", { error: "unknown account" }), 10000);
							// The new repository belongs to the signed-in account; put the old owner back if it fails.
							const previousOwner = p.settings.owner;
							try {
								p.settings.owner = this.login;
								await p.gh.createRepo(newName);
								await pick(this.login, newName, "main");
							} catch (e) {
								p.settings.owner = previousOwner;
								new Notice(tr("w.createFailed", { error: localizeError(e) }), 10000);
							}
						}),
				);

		// Signed in with the GitHub App: the list shows the repositories the app may use; more are added on GitHub.
		this.contentEl.createEl("h4", { text: signedInApp ? tr("app.reposTitle") : tr("w.useExisting") });
		const search = this.contentEl.createEl("input", { type: "search", placeholder: tr("w.filter"), cls: "vsg-wz-search" });
		const listEl = this.contentEl.createDiv({ cls: "vsg-wz-repos" });
		listEl.setText(tr("w.loadingRepos"));

		let watchNote: HTMLElement | null = null;
		if (signedInApp) {
			const app = p.githubApp();
			const web = p.githubWeb();
			const st = new Setting(this.contentEl).setName(tr("app.chooseRepos")).setDesc(tr("app.chooseReposDesc"));
			const away = (url: string) => {
				window.open(url);
				this.startRepoWatch();
				watchNote?.setText(tr("app.watching"));
			};
			if (app?.slug) st.addButton((b) => b.setButtonText(tr("app.addRepos")).onClick(() => away(installUrl(web, app.slug))));
			st.addButton((b) => b.setButtonText(tr("app.createOnGitHub")).onClick(() => away(`${web}/new`)));
			st.addButton((b) => b.setButtonText(tr("app.refresh")).onClick(() => void this.reloadRepos?.()));
			watchNote = this.contentEl.createDiv({ cls: "vsg-muted" });
		}
		new Setting(this.contentEl).addButton((b) =>
			b.setButtonText(tr("w.back")).onClick(() => {
				this.stopRepoWatch();
				this.go("connect");
			}),
		);

		type Repo = Awaited<ReturnType<typeof p.gh.listRepos>>[number];
		let repos: Repo[] = [];
		let known: Set<string> | null = null;
		const fresh = new Set<string>();
		const key = (r: Repo) => `${r.owner}/${r.name}`;
		const draw = () => {
			listEl.empty();
			const q = search.value.toLowerCase();
			// Newly granted repositories first, then the most recently updated.
			const sorted = [...repos].sort((a, b) => Number(fresh.has(key(b))) - Number(fresh.has(key(a))));
			const shown = sorted.filter((r) => key(r).toLowerCase().includes(q)).slice(0, 100);
			if (!shown.length) listEl.createDiv({ cls: "vsg-muted", text: repos.length || q ? tr("w.noMatch") : signedInApp ? tr("app.noRepos") : tr("w.noMatch") });
			for (const r of shown) {
				const row = listEl.createDiv({ cls: "vsg-wz-repo" });
				row.setAttr("role", "button");
				row.setAttr("tabindex", "0");
				row.createSpan({ text: key(r) });
				if (fresh.has(key(r))) row.createSpan({ text: tr("app.newRepo"), cls: "vsg-badge vsg-badge-new" });
				row.createSpan({ text: r.private ? tr("w.private") : tr("w.public"), cls: r.private ? "vsg-badge" : "vsg-badge vsg-badge-warn" });
				const choose = async () => {
					if (!r.private && !(await confirmPlan(this.app, tr("w.publicTitle"), tr("w.publicBody", { repo: key(r) }), [], tr("w.useAnyway"), true))) return;
					void pick(r.owner, r.name, r.defaultBranch);
				};
				row.onClickEvent(() => void choose());
				row.addEventListener("keydown", (e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						void choose();
					}
				});
			}
		};
		search.oninput = draw;
		let loading = false;
		this.reloadRepos = async () => {
			if (loading || gen !== this.generation || this.cancelled) return;
			loading = true;
			try {
				const list = await p.gh.listRepos();
				if (gen !== this.generation) return; // the wizard moved on while the list was loading
				if (known) for (const r of list) if (!known.has(key(r))) fresh.add(key(r));
				known = new Set(list.map(key));
				repos = list;
				draw();
				if (fresh.size && this.watchTimer !== null) {
					// The new repository arrived: stop polling and say so.
					this.stopRepoWatch();
					watchNote?.setText(tr("app.newArrived"));
				}
			} catch (e) {
				if (gen === this.generation && !repos.length) listEl.setText(tr("w.listFailed", { error: localizeError(e) }));
			} finally {
				loading = false;
			}
		};
		await this.reloadRepos();
		if (gen === this.generation && !Platform.isMobile) search.focus();
	}

	// ---------- 3. this vault ----------
	private async renderVault() {
		const p = this.plugin;
		const gen = this.generation;
		this.header(3, tr("w.vaultTitle"), `${p.settings.owner}/${p.settings.repo} (${p.settings.branch})`);
		const info = this.contentEl.createDiv({ cls: "vsg-wz-status", text: tr("w.looking") });
		let remoteCount = 0;
		try {
			remoteCount = await p.gh.countFiles(p.settings.branch);
		} catch (e) {
			if (gen !== this.generation) return;
			info.setText(tr("w.readFailed", { error: localizeError(e) }));
			new Setting(this.contentEl).addButton((b) => b.setButtonText(tr("w.back")).onClick(() => this.go("repo")));
			return;
		}
		if (gen !== this.generation) return;
		const localCount = this.app.vault.getFiles().length;
		info.setText(tr("w.counts", { local: localCount, remote: remoteCount }));

		const options: [FirstSync, string, string][] = [];
		if (remoteCount <= 1) options.push(["upload", tr("w.optUpload"), tr("w.optUploadDesc")]);
		else if (localCount <= 3) {
			options.push(["download", tr("w.optDownload"), tr("w.optDownloadDesc")]);
			options.push(["merge", tr("w.optMerge"), tr("w.optMergeDesc")]);
		} else {
			options.push(["merge", tr("w.optMergeSafe"), tr("w.optMergeSafeDesc")]);
			options.push(["download", tr("w.optRemoteWins"), tr("w.optRemoteWinsDesc")]);
			options.push(["prefer-local", tr("w.optLocalWins"), tr("w.optLocalWinsDesc")]);
		}
		this.choice = options[0][0];
		const group = this.contentEl.createDiv({ cls: "vsg-wz-options" });
		for (const [key, title, desc] of options) {
			const label = group.createEl("label", { cls: "vsg-wz-option" });
			const radio = label.createEl("input", { type: "radio" });
			radio.name = "vsg-first";
			radio.checked = key === this.choice;
			radio.onchange = () => (this.choice = key);
			const t = label.createDiv();
			t.createDiv({ text: title, cls: "vsg-commit-title" });
			t.createDiv({ text: desc, cls: "vsg-muted" });
		}
		this.contentEl.createEl("p", { cls: "vsg-muted", text: tr("w.neverDeletes") });

		// Encryption: unlock an encrypted repo, or offer to encrypt a new one.
		let encPass = "";
		let encWanted = false;
		const marker = await readRemoteMarker(p).catch(() => null);
		if (gen !== this.generation) return;
		if (marker && !p.isEncrypted()) {
			const box = this.contentEl.createDiv({ cls: "vsg-h-error" });
			box.createDiv({ text: tr("w.encrypted") });
			new Setting(box).addButton((b) => b.setButtonText(tr("health.enterPassphrase")).setCta().onClick(() => new EncryptionModal(this.app, p, () => this.render()).open()));
		} else if (!marker && !p.isEncrypted() && remoteCount <= 1) {
			const hint = this.contentEl.createDiv({ cls: "vsg-muted" });
			new Setting(this.contentEl)
				.setName(tr("w.encryptOpt"))
				.setDesc(tr("w.encryptOptDesc"))
				.addToggle((t) => t.onChange((v) => (encWanted = v)))
				.addText((t) => {
					t.inputEl.type = "password";
					t.setPlaceholder(tr("w.passphrase")).onChange((v) => {
						encPass = v;
						hint.setText(v ? passphraseStrength(v).hint : "");
					});
				});
		} else if (p.isEncrypted()) {
			this.contentEl.createDiv({ cls: "vsg-muted", text: tr("w.encOnDevice") });
		}

		new Setting(this.contentEl)
			.setName(tr("w.alsoConfig", { dir: this.app.vault.configDir }))
			.addToggle((t) =>
				t.setValue(p.settings.syncConfigDir).onChange(async (v) => {
					p.settings.syncConfigDir = v;
					await p.saveSettings();
				}),
			);
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(tr("w.back")).onClick(() => this.go("repo")))
			.addButton((b) =>
				b
					.setButtonText(tr("w.start"))
					.setCta()
					.onClick(async () => {
						if (marker && !p.isEncrypted()) return void new Notice(tr("w.unlockFirst"));
						if (encWanted) {
							if (!passphraseStrength(encPass).ok) return void new Notice(passphraseStrength(encPass).hint);
							if (!(await confirmPlan(this.app, tr("w.saveTitle"), tr("w.saveBody"), [], tr("w.saved")))) return;
							const { meta, master } = await createEncryption(encPass);
							await p.saveEncryption({ meta, master });
						}
						this.go("syncing");
					}),
			);
	}

	// ---------- 4. syncing ----------
	private renderSyncing() {
		const p = this.plugin;
		this.header(4, tr("w.syncTitle"), tr("w.syncSub"));
		const prog = this.contentEl.createDiv({ cls: "vsg-wz-progress", text: tr("w.starting") });
		p.onProgress = (t) => prog.setText(t);
		const prefer = this.choice === "download" ? "remote" : this.choice === "prefer-local" ? "local" : undefined;
		void p.firstSync(prefer).then((r) => {
			p.onProgress = null;
			if (this.cancelled) return;
			this.resultText = r;
			this.go("done");
		});
	}

	// ---------- done ----------
	private renderDone() {
		this.titleEl.setText(tr("w.doneTitle"));
		this.contentEl.createEl("p", { text: this.resultText });
		const ul = this.contentEl.createEl("ul", { cls: "vsg-muted" });
		ul.createEl("li", { text: tr("w.tip1") });
		ul.createEl("li", { text: tr("w.tip2") });
		ul.createEl("li", { text: tr("w.tip3") });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(tr("w.openStatus")).onClick(() => void this.plugin.openHealth().then(() => this.close())))
			.addButton((b) => b.setButtonText(tr("w.done")).setCta().onClick(() => this.close()));
	}
}
