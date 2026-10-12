// "Sign in with GitHub" dialog: shows the device code, opens GitHub and waits for approval.

import { App, Modal, Notice, Setting } from "obsidian";
import type VaultSyncPlugin from "./main.ts";
import { DeviceFlowError, pollDeviceFlow, startDeviceFlow } from "./ghapp.ts";
import { errMsg } from "./util.ts";
import { t } from "./i18n.ts";

function message(e: unknown): string {
	if (e instanceof DeviceFlowError) {
		if (e.code === "expired_token") return t("app.expired");
		if (e.code === "access_denied") return t("app.denied");
		if (e.code === "device_flow_disabled") return t("app.disabled");
	}
	return t("app.failed", { error: errMsg(e) });
}

export class GitHubSignInModal extends Modal {
	private plugin: VaultSyncPlugin;
	private onDone: (ok: boolean) => void;
	private cancelled = false;
	private finished = false;

	constructor(app: App, plugin: VaultSyncPlugin, onDone: (ok: boolean) => void) {
		super(app);
		this.plugin = plugin;
		this.onDone = onDone;
	}

	onOpen() {
		this.modalEl.addClass("vsg-signin");
		this.titleEl.setText(t("app.signIn"));
		void this.run();
	}

	onClose() {
		this.cancelled = true;
		this.contentEl.empty();
		if (!this.finished) this.onDone(false);
	}

	private async run() {
		const app = this.plugin.githubApp();
		const status = this.contentEl.createDiv({ cls: "vsg-muted", text: t("app.starting") });
		if (!app) return void status.setText(t("app.notAvailable"));
		const web = this.plugin.githubWeb();
		let code;
		try {
			code = await startDeviceFlow(web, app.clientId);
		} catch (e) {
			return void status.setText(message(e));
		}
		if (this.cancelled) return;
		status.remove();

		const userCode = code.userCode;
		this.contentEl.createEl("p", { text: t("app.codeBody") });
		this.contentEl.createDiv({ cls: "vsg-device-code", text: userCode });
		const copy = async () => {
			try {
				await navigator.clipboard.writeText(userCode);
				new Notice(t("app.copied"));
			} catch {
				/* clipboard unavailable: the code is on screen */
			}
		};
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("app.copy")).onClick(() => void copy()))
			.addButton((b) =>
				b
					.setButtonText(t("app.open"))
					.setCta()
					.onClick(() => {
						void copy();
						window.open(code.verificationUri);
					}),
			);
		const wait = this.contentEl.createDiv({ cls: "vsg-muted", text: t("app.waiting") });

		try {
			const tokens = await pollDeviceFlow(web, app.clientId, code, { isCancelled: () => this.cancelled });
			if (this.cancelled) return;
			this.plugin.signedInWithApp(tokens);
			this.finished = true;
			this.close();
			this.onDone(true);
		} catch (e) {
			if (!this.cancelled) wait.setText(message(e));
		}
	}
}
