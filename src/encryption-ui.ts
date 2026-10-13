// Turn on / unlock end-to-end encryption.

import { App, Modal, Notice, Setting } from "obsidian";
import { createEncryption, keyMatches, MARKER_PATH, passphraseStrength, pickMarker, unlockEncryption } from "./crypto.ts";
import { normalizeSubdir } from "./codec.ts";
import type { EncryptionMeta } from "./crypto.ts";
import type VaultSyncPlugin from "./main.ts";
import { localizeError } from "./errors.ts";
import { t as tr } from "./i18n.ts";
import { destructive } from "./ui.ts";

/** This vault's encryption marker in the repository (inside its repository folder when it has one). */
export async function readRemoteMarker(plugin: VaultSyncPlugin): Promise<EncryptionMeta | null> {
	const head = await plugin.gh.getRef(plugin.settings.branch);
	if (!head) return null;
	const sub = normalizeSubdir(plugin.settings.repoSubdir);
	let data: ArrayBuffer | null;
	if (!sub) data = await plugin.gh.getFileAt(MARKER_PATH, head);
	else {
		// Its own copy, else (migration) the root copy of an older version when this vault is the encrypted one.
		const picked = pickMarker(await plugin.gh.listTree(await plugin.gh.getCommitTree(head)), sub, plugin.isEncrypted());
		data = picked.sha ? await plugin.gh.getBlob(picked.sha) : null;
	}
	return data ? (JSON.parse(new TextDecoder().decode(data)) as EncryptionMeta) : null;
}

export class EncryptionModal extends Modal {
	constructor(app: App, private plugin: VaultSyncPlugin, private done?: () => void) {
		super(app);
	}

	async onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(tr("s.hEncryption"));
		const status = contentEl.createEl("p", { text: tr("e.checking"), cls: "vsg-muted" });
		let meta: EncryptionMeta | null = null;
		try {
			meta = await readRemoteMarker(this.plugin);
		} catch (e) {
			status.setText(tr("w.readFailed", { error: localizeError(e) }));
			return;
		}
		status.remove();
		if (keyMatches(this.plugin.encryptionRecord()?.meta ?? null, meta)) this.renderOn();
		else if (meta) this.renderUnlock(meta);
		else this.renderEnable();
	}

	/** This device already holds the repository's key (or will publish its marker on the next sync). */
	private renderOn() {
		const { contentEl } = this;
		this.titleEl.setText(tr("s.hEncryption"));
		contentEl.createEl("p", { text: tr("s.encOn") });
		contentEl.createEl("p", { text: tr("s.encOnDesc"), cls: "vsg-muted" });
		new Setting(contentEl)
			.setClass("vsg-wrap-controls")
			.addButton((b) =>
				b.setButtonText(tr("s.encRemovePlain")).onClick(() => {
					this.close();
					void this.plugin.removeUnencryptedFiles();
				}),
			)
			.addButton((b) =>
				destructive(b.setButtonText(tr("s.encLock"))).onClick(async () => {
						await this.plugin.lockEncryption();
						this.close();
						this.done?.();
					}),
			)
			.addButton((b) => b.setButtonText(tr("u.close")).setCta().onClick(() => this.close()));
	}

	private renderUnlock(meta: EncryptionMeta) {
		const { contentEl } = this;
		this.titleEl.setText(tr("e.unlockTitle"));
		contentEl.createEl("p", { text: tr("e.unlockBody") });
		let pass = "";
		const msg = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).setName(tr("w.passphrase")).addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => (pass = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") void unlock();
			});
		});
		const unlock = async () => {
			msg.setText(tr("e.unlocking"));
			try {
				const { master } = await unlockEncryption(pass, meta);
				await this.plugin.saveEncryption({ meta, master });
				new Notice(tr("e.unlocked"));
				this.close();
				this.done?.();
			} catch (e) {
				msg.setText(localizeError(e));
			}
		};
		new Setting(contentEl).addButton((b) => b.setButtonText(tr("e.unlock")).setCta().onClick(unlock));
	}

	private renderEnable() {
		const { contentEl } = this;
		this.titleEl.setText(tr("e.enableTitle"));
		const ul = contentEl.createEl("ul");
		ul.createEl("li", { text: tr("e.point1") });
		ul.createEl("li", { text: tr("e.point2") });
		ul.createEl("li", { text: tr("e.point3") });
		ul.createEl("li", { text: tr("e.point4") });
		let pass = "";
		let again = "";
		let ack = false;
		const hint = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).setName(tr("w.passphrase")).addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				pass = v;
				hint.setText(passphraseStrength(v).hint);
			});
		});
		new Setting(contentEl).setName(tr("e.repeat")).addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => (again = v));
		});
		new Setting(contentEl).setName(tr("e.ack")).addToggle((t) => t.onChange((v) => (ack = v)));
		const msg = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(tr("e.turnOn"))
				.setCta()
				.onClick(async () => {
					if (!passphraseStrength(pass).ok) return void msg.setText(passphraseStrength(pass).hint);
					if (pass !== again) return void msg.setText(tr("e.mismatch"));
					if (!ack) return void msg.setText(tr("e.confirmSaved"));
					msg.setText(tr("e.settingUp"));
					try {
						const { meta, master } = await createEncryption(pass);
						await this.plugin.saveEncryption({ meta, master });
						new Notice(tr("e.enabled"));
						this.close();
						this.done?.();
					} catch (e) {
						msg.setText(localizeError(e));
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
