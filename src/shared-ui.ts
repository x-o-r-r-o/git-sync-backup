// Add a shared folder (a folder synced to its own repository).

import { AbstractInputSuggest, App, Modal, Notice, Setting, TFolder } from "obsidian";
import { HOSTS, makeRemote } from "./hosts.ts";
import type { HostKind } from "./hosts.ts";
import type VaultSyncPlugin from "./main.ts";
import type { SharedFolder } from "./types.ts";
import { errMsg } from "./util.ts";
import { t as tr } from "./i18n.ts";

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
		this.titleEl.setText(tr("s.sharedAdd"));
		contentEl.createEl("p", {
			cls: "vsg-muted",
			text: tr("sh.intro"),
		});
		new Setting(contentEl).setName(tr("sh.folder")).addText((t) => {
			t.setPlaceholder(tr("sh.folderPlaceholder")).onChange((v) => (this.def.folder = v.trim().replace(/^\/+|\/+$/g, "")));
			new FolderInputSuggest(this.app, t.inputEl, (f) => (this.def.folder = f));
		});
		new Setting(contentEl).setName(tr("s.host")).addDropdown((d) => {
			for (const [k, h] of Object.entries(HOSTS)) d.addOption(k, h.label);
			d.setValue(this.def.provider).onChange((v) => (this.def.provider = v as HostKind));
		});
		new Setting(contentEl).setName(tr("s.owner")).setDesc(tr("sh.ownerDesc")).addText((t) => t.onChange((v) => (this.def.owner = v.trim())));
		new Setting(contentEl).setName(tr("s.repo")).addText((t) => t.onChange((v) => (this.def.repo = v.trim())));
		new Setting(contentEl).setName(tr("s.branch")).addText((t) => t.setValue("main").onChange((v) => (this.def.branch = v.trim() || "main")));
		new Setting(contentEl)
			.setName(tr("sh.token"))
			.setDesc(tr("sh.tokenDesc"))
			.addText((t) => {
				t.inputEl.type = "password";
				t.onChange((v) => (this.token = v.trim()));
			});
		contentEl.createEl("p", {
			cls: "vsg-muted",
			text: tr("sh.note"),
		});
		const msg = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(tr("sh.add"))
				.setCta()
				.onClick(async () => {
					const d = this.def;
					if (!d.folder || !d.owner || !d.repo) return void msg.setText(tr("sh.required"));
					if ((this.plugin.settings.sharedFolders ?? []).some((f) => d.folder === f.folder || d.folder.startsWith(f.folder + "/") || f.folder.startsWith(d.folder + "/")))
						return void msg.setText(tr("sh.overlap"));
					if (this.token) this.plugin.setSecret(`token-shared-${d.id}`, this.token);
					msg.setText(tr("sh.checking"));
					try {
						const remote = makeRemote(d.provider, () => ({ token: this.token || this.plugin.getToken(), apiBase: this.plugin.getApiBaseFor(d.provider), owner: d.owner, repo: d.repo }));
						if (!(await remote.getRepo())) throw new Error("repository not found or not accessible with this token");
					} catch (e) {
						return void msg.setText(tr("sh.noAccess", { repo: `${d.owner}/${d.repo}`, error: errMsg(e) }));
					}
					this.plugin.settings.sharedFolders = [...(this.plugin.settings.sharedFolders ?? []), d];
					await this.plugin.saveSettings();
					new Notice(tr("sh.added", { folder: d.folder, repo: `${d.owner}/${d.repo}` }));
					this.close();
					this.done();
				}),
		);
	}
	onClose() {
		this.contentEl.empty();
	}
}
