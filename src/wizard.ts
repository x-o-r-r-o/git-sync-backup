// First-run setup: connect to a Git host, pick or create a repo, decide how this vault relates to it,
// then run the first sync with live progress.

import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { HOSTS } from "./hosts.ts";
import { confirmPlan } from "./ui.ts";
import type { HostKind } from "./hosts.ts";
import { createEncryption, passphraseStrength } from "./crypto.ts";
import { EncryptionModal, readRemoteMarker } from "./encryption-ui.ts";
import type VaultSyncPlugin from "./main.ts";
import { errMsg } from "./util.ts";
import { t as tr } from "./i18n.ts";

type Step = "connect" | "repo" | "vault" | "syncing" | "done";
type FirstSync = "upload" | "download" | "merge" | "prefer-local";


export class SetupWizard extends Modal {
	private step: Step = "connect";
	private login = "";
	private cancelled = false;
	private choice: FirstSync = "merge";
	private resultText = "";

	constructor(app: App, private plugin: VaultSyncPlugin) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("vsg-wizard");
		this.render();
	}
	onClose() {
		this.cancelled = true;
		this.contentEl.empty();
		this.plugin.onProgress = null;
	}

	private go(step: Step) {
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

	private render() {
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
		if (p.settings.provider !== "github") {
			new Setting(this.contentEl)
				.setName(tr("w.apiUrl"))
				.setDesc(host.apiHint)
				.addText((t) => t.setValue(p.getApiBase()).onChange((v) => p.setApiBase(v.trim() || host.defaultApi)));
		}

		new Setting(this.contentEl)
			.setName(tr("w.deviceName"))
			.setDesc(tr("w.deviceNameDesc"))
			.addText((t) => t.setValue(p.deviceName()).onChange((v) => p.setDeviceName(v.trim())));

		const status = this.contentEl.createDiv({ cls: "vsg-wz-status" });
		const done = async (token: string) => {
			p.setToken(token);
			try {
				this.login = (await p.gh.getUser()).login;
				new Notice(tr("w.signedIn", { user: this.login }));
				this.go("repo");
			} catch (e) {
				status.setText(tr("w.tokenFailed", { error: errMsg(e) }));
			}
		};

		if (p.getToken()) {
			new Setting(this.contentEl)
				.setName(tr("w.alreadyConnected"))
				.addButton((b) => b.setButtonText(tr("w.continue")).setCta().onClick(() => done(p.getToken())));
		}

		const tokenBox = this.contentEl.createDiv({ cls: "vsg-wz-token" });
		tokenBox.createEl("h4", { text: tr("w.connectWith", { host: host.label.split(" ")[0] }) });
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
	private async renderRepo() {
		const p = this.plugin;
		this.header(2, tr("w.repoTitle"), tr("w.repoSub", { user: this.login }));
		const pick = async (owner: string, name: string, branch: string) => {
			p.settings.owner = owner;
			p.settings.repo = name;
			p.settings.branch = branch || "main";
			await p.saveSettings();
			this.go("vault");
		};

		let newName = this.app.vault.getName().replace(/[^A-Za-z0-9._-]+/g, "-");
		new Setting(this.contentEl)
			.setName(tr("w.createNew"))
			.addText((t) => t.setValue(newName).onChange((v) => (newName = v.trim())))
			.addButton((b) =>
				b
					.setButtonText(tr("w.create"))
					.setCta()
					.onClick(async () => {
						try {
							p.settings.owner = this.login;
							await p.gh.createRepo(newName);
							await pick(this.login, newName, "main");
						} catch (e) {
							new Notice(tr("w.createFailed", { error: errMsg(e) }), 10000);
						}
					}),
			);

		this.contentEl.createEl("h4", { text: tr("w.useExisting") });
		const search = this.contentEl.createEl("input", { type: "search", placeholder: tr("w.filter"), cls: "vsg-wz-search" });
		const listEl = this.contentEl.createDiv({ cls: "vsg-wz-repos" });
		listEl.setText(tr("w.loadingRepos"));
		try {
			const repos = await p.gh.listRepos();
			const draw = () => {
				listEl.empty();
				const q = search.value.toLowerCase();
				const shown = repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q)).slice(0, 100);
				if (!shown.length) listEl.createDiv({ cls: "vsg-muted", text: tr("w.noMatch") });
				for (const r of shown) {
					const row = listEl.createDiv({ cls: "vsg-wz-repo" });
					row.createSpan({ text: `${r.owner}/${r.name}` });
					row.createSpan({ text: r.private ? tr("w.private") : tr("w.public"), cls: r.private ? "vsg-badge" : "vsg-badge vsg-badge-warn" });
					row.onClickEvent(async () => {
						if (!r.private && !(await confirmPlan(this.app, tr("w.publicTitle"), tr("w.publicBody", { repo: `${r.owner}/${r.name}` }), [], tr("w.useAnyway"), true))) return;
						void pick(r.owner, r.name, r.defaultBranch);
					});
				}
			};
			search.oninput = draw;
			draw();
			if (!Platform.isMobile) search.focus();
		} catch (e) {
			listEl.setText(tr("w.listFailed", { error: errMsg(e) }));
		}
		new Setting(this.contentEl).addButton((b) => b.setButtonText(tr("w.back")).onClick(() => this.go("connect")));
	}

	// ---------- 3. this vault ----------
	private async renderVault() {
		const p = this.plugin;
		this.header(3, tr("w.vaultTitle"), `${p.settings.owner}/${p.settings.repo} (${p.settings.branch})`);
		const info = this.contentEl.createDiv({ cls: "vsg-wz-status", text: tr("w.looking") });
		let remoteCount = 0;
		try {
			remoteCount = await p.gh.countFiles(p.settings.branch);
		} catch (e) {
			info.setText(tr("w.readFailed", { error: errMsg(e) }));
			new Setting(this.contentEl).addButton((b) => b.setButtonText(tr("w.back")).onClick(() => this.go("repo")));
			return;
		}
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
