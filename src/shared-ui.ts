// Add a shared folder (a folder synced to its own repository).

import { AbstractInputSuggest, App, Modal, Notice, Setting, TFolder } from "obsidian";
import { HOSTS, makeRemote } from "./hosts.ts";
import type { HostKind } from "./hosts.ts";
import type VaultSyncPlugin from "./main.ts";
import type { SharedFolder } from "./types.ts";
import { errMsg } from "./util.ts";

class FolderInputSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, private input: HTMLInputElement, private onPick: (f: string) => void) {
		super(app, input);
	}
	getSuggestions(q: string): TFolder[] {
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && f.path.toLowerCase().includes(q.toLowerCase()))
			.slice(0, 30);
	}
	renderSuggestion(f: TFolder, el: HTMLElement) {
		el.setText(f.path);
	}
	selectSuggestion(f: TFolder) {
		this.input.value = f.path;
		this.onPick(f.path);
		this.close();
	}
}

export class SharedFolderModal extends Modal {
	private def: SharedFolder;
	private token = "";
	constructor(app: App, private plugin: VaultSyncPlugin, private done: () => void) {
		super(app);
		this.def = { id: Math.random().toString(36).slice(2, 10), folder: "", provider: plugin.settings.provider, owner: "", repo: "", branch: "main", enabled: true };
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Add a shared folder");
		contentEl.createEl("p", {
			cls: "vsg-muted",
			text: "Sync one folder with its own repository, for example a team folder, while the rest of your vault stays in your private repository. The folder maps to the root of that repository.",
		});
		new Setting(contentEl).setName("Folder").addText((t) => {
			t.setPlaceholder("Work").onChange((v) => (this.def.folder = v.trim().replace(/^\/+|\/+$/g, "")));
			new FolderInputSuggest(this.app, t.inputEl, (f) => (this.def.folder = f));
		});
		new Setting(contentEl).setName("Host").addDropdown((d) => {
			for (const [k, h] of Object.entries(HOSTS)) d.addOption(k, h.label);
			d.setValue(this.def.provider).onChange((v) => (this.def.provider = v as HostKind));
		});
		new Setting(contentEl).setName("Owner").setDesc("User, organisation or group of the shared repository.").addText((t) => t.onChange((v) => (this.def.owner = v.trim())));
		new Setting(contentEl).setName("Repository").addText((t) => t.onChange((v) => (this.def.repo = v.trim())));
		new Setting(contentEl).setName("Branch").addText((t) => t.setValue("main").onChange((v) => (this.def.branch = v.trim() || "main")));
		new Setting(contentEl)
			.setName("Token (optional)")
			.setDesc("Leave empty to use your main token (same host only). Stored securely on this device.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.onChange((v) => (this.token = v.trim()));
			});
		contentEl.createEl("p", {
			cls: "vsg-muted",
			text: "Files already in this folder in your main repository stay there (in its history) but are no longer synced to it. Encryption does not apply to shared folders, because collaborators need to read them.",
		});
		const msg = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Add")
				.setCta()
				.onClick(async () => {
					const d = this.def;
					if (!d.folder || !d.owner || !d.repo) return void msg.setText("Folder, owner and repository are required.");
					if ((this.plugin.settings.sharedFolders ?? []).some((f) => d.folder === f.folder || d.folder.startsWith(f.folder + "/") || f.folder.startsWith(d.folder + "/")))
						return void msg.setText("That folder overlaps an existing shared folder.");
					if (this.token) this.plugin.setSecret(`token-shared-${d.id}`, this.token);
					msg.setText("Checking access…");
					try {
						const remote = makeRemote(d.provider, () => ({ token: this.token || this.plugin.getToken(), apiBase: this.plugin.getApiBaseFor(d.provider), owner: d.owner, repo: d.repo }));
						if (!(await remote.getRepo())) throw new Error("repository not found or not accessible with this token");
					} catch (e) {
						return void msg.setText(`Can't access ${d.owner}/${d.repo}: ${errMsg(e)}`);
					}
					this.plugin.settings.sharedFolders = [...(this.plugin.settings.sharedFolders ?? []), d];
					await this.plugin.saveSettings();
					new Notice(`Shared folder added: ${d.folder} ↔ ${d.owner}/${d.repo}`);
					this.close();
					this.done();
				}),
		);
	}
	onClose() {
		this.contentEl.empty();
	}
}
