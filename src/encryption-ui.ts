// Turn on / unlock end-to-end encryption.

import { App, Modal, Notice, Setting } from "obsidian";
import { createEncryption, MARKER_PATH, passphraseStrength, unlockEncryption } from "./crypto.ts";
import type { EncryptionMeta } from "./crypto.ts";
import type VaultSyncPlugin from "./main.ts";
import { errMsg } from "./util.ts";

export async function readRemoteMarker(plugin: VaultSyncPlugin): Promise<EncryptionMeta | null> {
	const head = await plugin.gh.getRef(plugin.settings.branch);
	if (!head) return null;
	const data = await plugin.gh.getFileAt(MARKER_PATH, head);
	return data ? (JSON.parse(new TextDecoder().decode(data)) as EncryptionMeta) : null;
}

export class EncryptionModal extends Modal {
	constructor(app: App, private plugin: VaultSyncPlugin, private done?: () => void) {
		super(app);
	}

	async onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("End-to-end encryption");
		const status = contentEl.createEl("p", { text: "Checking the repository…", cls: "vsg-muted" });
		let meta: EncryptionMeta | null = null;
		try {
			meta = await readRemoteMarker(this.plugin);
		} catch (e) {
			status.setText(`Could not read the repository: ${errMsg(e)}`);
			return;
		}
		status.remove();
		if (meta) this.renderUnlock(meta);
		else this.renderEnable();
	}

	private renderUnlock(meta: EncryptionMeta) {
		const { contentEl } = this;
		this.titleEl.setText("Unlock encrypted vault");
		contentEl.createEl("p", { text: "This repository is end-to-end encrypted. Enter its passphrase to sync on this device. The key is kept in this device's secure storage." });
		let pass = "";
		const msg = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).setName("Passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => (pass = v));
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") void unlock();
			});
		});
		const unlock = async () => {
			msg.setText("Unlocking… (this takes a second on purpose)");
			try {
				const { master } = await unlockEncryption(pass, meta);
				await this.plugin.saveEncryption({ meta, master });
				new Notice("Encrypted vault unlocked on this device.");
				this.close();
				this.done?.();
			} catch (e) {
				msg.setText(errMsg(e));
			}
		};
		new Setting(contentEl).addButton((b) => b.setButtonText("Unlock").setCta().onClick(unlock));
	}

	private renderEnable() {
		const { contentEl } = this;
		this.titleEl.setText("Turn on end-to-end encryption");
		const ul = contentEl.createEl("ul");
		ul.createEl("li", { text: "Notes, attachments and file names are encrypted on this device before upload. The repository host only stores unreadable data." });
		ul.createEl("li", { text: "Every device needs the same passphrase. There is no way to recover it: if you forget it, the copy in the repository can't be read." });
		ul.createEl("li", { text: "If this repository already has unencrypted notes, they remain in its history. For full privacy use a new, empty repository." });
		ul.createEl("li", { text: "You can't browse the notes on github.com any more; use the plugin's history and timeline instead." });
		let pass = "";
		let again = "";
		let ack = false;
		const hint = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).setName("Passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => {
				pass = v;
				hint.setText(passphraseStrength(v).hint);
			});
		});
		new Setting(contentEl).setName("Repeat passphrase").addText((t) => {
			t.inputEl.type = "password";
			t.onChange((v) => (again = v));
		});
		new Setting(contentEl).setName("I have saved the passphrase somewhere safe, for example in a password manager").addToggle((t) => t.onChange((v) => (ack = v)));
		const msg = contentEl.createDiv({ cls: "vsg-muted" });
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Turn on encryption")
				.setCta()
				.onClick(async () => {
					if (!passphraseStrength(pass).ok) return void msg.setText(passphraseStrength(pass).hint);
					if (pass !== again) return void msg.setText("The passphrases don't match.");
					if (!ack) return void msg.setText("Please confirm you've saved the passphrase.");
					msg.setText("Setting up… (this takes a second on purpose)");
					try {
						const { meta, master } = await createEncryption(pass);
						await this.plugin.saveEncryption({ meta, master });
						new Notice("Encryption is on. The next sync uploads everything encrypted.");
						this.close();
						this.done?.();
					} catch (e) {
						msg.setText(errMsg(e));
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
