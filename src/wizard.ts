// First-run setup: connect to GitHub, pick or create a repo, decide how this vault relates to it,
// then run the first sync with live progress.

import { App, Modal, Notice, Platform, Setting } from "obsidian";
import { HOSTS } from "./hosts.ts";
import type { HostKind } from "./hosts.ts";
import { createEncryption, passphraseStrength } from "./crypto.ts";
import { EncryptionModal, readRemoteMarker } from "./encryption-ui.ts";
import type VaultSyncPlugin from "./main.ts";
import { errMsg } from "./util.ts";

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
		const steps = ["Connect", "Repository", "This vault", "First sync"];
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
		this.header(1, "Set up vault sync", "Your notes are stored in a private git repository you own. Works on desktop and mobile; nothing to install.");

		new Setting(this.contentEl)
			.setName("Where should your vault live?")
			.addDropdown((d) => {
				for (const [k, h] of Object.entries(HOSTS)) d.addOption(k, h.label + (h.beta ? " (beta)" : ""));
				d.setValue(p.settings.provider).onChange(async (v) => {
					p.settings.provider = v as HostKind;
					await p.saveSettings();
					this.render();
				});
			});
		const host = HOSTS[p.settings.provider];
		if (p.settings.provider !== "github") {
			new Setting(this.contentEl)
				.setName("Server API URL")
				.setDesc(host.apiHint)
				.addText((t) => t.setValue(p.getApiBase()).onChange((v) => p.setApiBase(v.trim() || host.defaultApi)));
		}

		new Setting(this.contentEl)
			.setName("Name this device")
			.setDesc("Shown in history and on conflict copies.")
			.addText((t) => t.setValue(p.deviceName()).onChange((v) => p.setDeviceName(v.trim())));

		const status = this.contentEl.createDiv({ cls: "vsg-wz-status" });
		const done = async (token: string) => {
			p.setToken(token);
			try {
				this.login = (await p.gh.getUser()).login;
				new Notice(`Signed in as ${this.login}`);
				this.go("repo");
			} catch (e) {
				status.setText(`That token didn't work: ${errMsg(e)}`);
			}
		};

		if (p.getToken()) {
			new Setting(this.contentEl)
				.setName("Already connected on this device")
				.addButton((b) => b.setButtonText("Continue").setCta().onClick(() => done(p.getToken())));
		}

		const tokenBox = this.contentEl.createDiv({ cls: "vsg-wz-token" });
		tokenBox.createEl("h4", { text: `Connect with a ${host.label.split(" ")[0]} token` });
		const tips = tokenBox.createEl("ol", { cls: "vsg-muted" });
		for (const step of host.tokenSteps(p.getApiBase(), this.app.vault.getName())) {
			const li = tips.createEl("li");
			li.appendText(step.text + (step.link ? " " : ""));
			if (step.link) li.createEl("a", { text: step.link.label, href: step.link.href });
		}
		tips.createEl("li", { text: "The token is stored securely on this device only, never in synced settings." });
		let value = "";
		new Setting(tokenBox)
			.setName("Token")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("github_pat_… or ghp_…").onChange((v) => (value = v.trim()));
			})
			.addButton((b) =>
				b.setButtonText("Continue").onClick(() => {
					if (!value) return void status.setText("Paste a token first.");
					void done(value);
				}),
			);
	}

	// ---------- 2. repository ----------
	private async renderRepo() {
		const p = this.plugin;
		this.header(2, "Choose a repository", `Signed in as ${this.login}. Pick the repository for this vault, or create a new private one.`);
		const pick = async (owner: string, name: string, branch: string) => {
			p.settings.owner = owner;
			p.settings.repo = name;
			p.settings.branch = branch || "main";
			await p.saveSettings();
			this.go("vault");
		};

		let newName = this.app.vault.getName().replace(/[^A-Za-z0-9._-]+/g, "-");
		new Setting(this.contentEl)
			.setName("Create a new private repository")
			.addText((t) => t.setValue(newName).onChange((v) => (newName = v.trim())))
			.addButton((b) =>
				b
					.setButtonText("Create")
					.setCta()
					.onClick(async () => {
						try {
							p.settings.owner = this.login;
							await p.gh.createRepo(newName);
							await pick(this.login, newName, "main");
						} catch (e) {
							new Notice(`Could not create the repository: ${errMsg(e)}. Fine-grained tokens need Administration = Read and write; or create it on github.com and pick it below.`, 10000);
						}
					}),
			);

		this.contentEl.createEl("h4", { text: "Or use an existing repository" });
		const search = this.contentEl.createEl("input", { type: "search", placeholder: "Filter…", cls: "vsg-wz-search" });
		const listEl = this.contentEl.createDiv({ cls: "vsg-wz-repos" });
		listEl.setText("Loading your repositories…");
		try {
			const repos = await p.gh.listRepos();
			const draw = () => {
				listEl.empty();
				const q = search.value.toLowerCase();
				const shown = repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q)).slice(0, 100);
				if (!shown.length) listEl.createDiv({ cls: "vsg-muted", text: "No repositories match." });
				for (const r of shown) {
					const row = listEl.createDiv({ cls: "vsg-wz-repo" });
					row.createSpan({ text: `${r.owner}/${r.name}` });
					row.createSpan({ text: r.private ? "private" : "PUBLIC", cls: r.private ? "vsg-badge" : "vsg-badge vsg-badge-warn" });
					row.onClickEvent(() => {
						if (!r.private && !confirm(`${r.owner}/${r.name} is public: anyone could read your notes. Use it anyway?`)) return;
						void pick(r.owner, r.name, r.defaultBranch);
					});
				}
			};
			search.oninput = draw;
			draw();
			if (!Platform.isMobile) search.focus();
		} catch (e) {
			listEl.setText(`Could not list repositories: ${errMsg(e)}`);
		}
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Back").onClick(() => this.go("connect")));
	}

	// ---------- 3. this vault ----------
	private async renderVault() {
		const p = this.plugin;
		this.header(3, "This vault and the repository", `${p.settings.owner}/${p.settings.repo} (${p.settings.branch})`);
		const info = this.contentEl.createDiv({ cls: "vsg-wz-status", text: "Looking at both sides…" });
		let remoteCount = 0;
		try {
			remoteCount = await p.gh.countFiles(p.settings.branch);
		} catch (e) {
			info.setText(`Could not read the repository: ${errMsg(e)}`);
			new Setting(this.contentEl).addButton((b) => b.setButtonText("Back").onClick(() => this.go("repo")));
			return;
		}
		const localCount = this.app.vault.getFiles().length;
		info.setText(`This vault: ${localCount} file${localCount === 1 ? "" : "s"} · Repository: ${remoteCount} file${remoteCount === 1 ? "" : "s"}`);

		const options: [FirstSync, string, string][] = [];
		if (remoteCount <= 1) options.push(["upload", "Upload this vault", "This is the first device. Everything here is copied to GitHub."]);
		else if (localCount <= 3) {
			options.push(["download", "Download the vault from GitHub", "This device is new. Files from GitHub replace any starter files here."]);
			options.push(["merge", "Merge, keep both when different", "Nothing is overwritten; differing files are kept side by side."]);
		} else {
			options.push(["merge", "Merge, keep both when different (safest)", "Files only on one side are copied over. Files that differ are kept side by side."]);
			options.push(["download", "Merge, GitHub wins when different", "Use the repository's version when a file exists on both sides."]);
			options.push(["prefer-local", "Merge, this device wins when different", "Use this device's version when a file exists on both sides."]);
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
		this.contentEl.createEl("p", { cls: "vsg-muted", text: "Nothing is ever deleted on the first sync." });

		// Encryption: unlock an encrypted repo, or offer to encrypt a new one.
		let encPass = "";
		let encWanted = false;
		const marker = await readRemoteMarker(p).catch(() => null);
		if (marker && !p.isEncrypted()) {
			const box = this.contentEl.createDiv({ cls: "vsg-h-error" });
			box.createDiv({ text: "🔒 This repository is end-to-end encrypted. Unlock it to continue." });
			new Setting(box).addButton((b) => b.setButtonText("Enter passphrase").setCta().onClick(() => new EncryptionModal(this.app, p, () => this.render()).open()));
		} else if (!marker && !p.isEncrypted() && remoteCount <= 1) {
			const hint = this.contentEl.createDiv({ cls: "vsg-muted" });
			new Setting(this.contentEl)
				.setName("Encrypt end-to-end (optional)")
				.setDesc("GitHub only sees unreadable data. Every device will need this passphrase, and it can't be recovered.")
				.addToggle((t) => t.onChange((v) => (encWanted = v)))
				.addText((t) => {
					t.inputEl.type = "password";
					t.setPlaceholder("Passphrase").onChange((v) => {
						encPass = v;
						hint.setText(v ? passphraseStrength(v).hint : "");
					});
				});
		} else if (p.isEncrypted()) {
			this.contentEl.createDiv({ cls: "vsg-muted", text: "🔒 End-to-end encryption is on for this device." });
		}

		new Setting(this.contentEl)
			.setName(`Also sync settings, themes and plugins (${this.app.vault.configDir})`)
			.addToggle((t) =>
				t.setValue(p.settings.syncConfigDir).onChange(async (v) => {
					p.settings.syncConfigDir = v;
					await p.saveSettings();
				}),
			);
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Back").onClick(() => this.go("repo")))
			.addButton((b) =>
				b
					.setButtonText("Start first sync")
					.setCta()
					.onClick(async () => {
						if (marker && !p.isEncrypted()) return void new Notice("Unlock the encrypted repository first.");
						if (encWanted) {
							if (!passphraseStrength(encPass).ok) return void new Notice(passphraseStrength(encPass).hint);
							if (!confirm("Have you saved this passphrase somewhere safe? Without it your notes on GitHub can't be read.")) return;
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
		this.header(4, "First sync", "This can take a while for a large vault. You can close this window; sync continues in the background.");
		const prog = this.contentEl.createDiv({ cls: "vsg-wz-progress", text: "Starting…" });
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
		this.titleEl.setText("You're all set");
		this.contentEl.createEl("p", { text: this.resultText });
		const ul = this.contentEl.createEl("ul", { cls: "vsg-muted" });
		ul.createEl("li", { text: "Sync runs on startup, after edits and periodically. The ribbon button syncs now." });
		ul.createEl("li", { text: "The sync status panel (activity icon) shows what's pending and anything that needs attention." });
		ul.createEl("li", { text: "On each other device: install the plugin and run this wizard with the same repository." });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Open sync status").onClick(() => void this.plugin.openHealth().then(() => this.close())))
			.addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
	}
}
