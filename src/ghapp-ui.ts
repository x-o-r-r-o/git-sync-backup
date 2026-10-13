// "Sign in" dialog (device flow): shows the code, opens the host's approval page and waits. Used by
// Sign in with GitHub and Sign in with GitLab; the host-specific steps come in as a SignInFlow.

import { App, Modal, Notice, Setting } from "obsidian";
import type VaultSyncPlugin from "./main.ts";
import { errMsg } from "./util.ts";
import { t } from "./i18n.ts";

export interface SignInCode {
	userCode: string;
	verificationUri: string;
	/** The approval page with the code already filled in, when the host offers it. */
	verificationUriComplete?: string;
}

export interface SignInFlow {
	/** Dialog title, e.g. "Sign in with GitHub". */
	title: string;
	/** Host name shown in the dialog ("GitHub", "GitLab"). */
	host: string;
	/** False when no app is set up for this server. */
	available(): boolean;
	start(): Promise<SignInCode>;
	/** Waits for approval and stores the tokens. */
	finish(isCancelled: () => boolean): Promise<void>;
}

function message(e: unknown, host: string): string {
	const code = (e as { code?: unknown } | null)?.code;
	if (code === "expired_token") return t("app.expired");
	if (code === "access_denied") return t("app.denied", { host });
	if (code === "device_flow_disabled") return t("app.disabled");
	return t("app.failed", { error: errMsg(e) });
}

export class DeviceSignInModal extends Modal {
	private flow: SignInFlow;
	private onDone: (ok: boolean) => void;
	private cancelled = false;
	private finished = false;

	constructor(app: App, flow: SignInFlow, onDone: (ok: boolean) => void) {
		super(app);
		this.flow = flow;
		this.onDone = onDone;
	}

	onOpen() {
		this.modalEl.addClass("vsg-signin");
		this.titleEl.setText(this.flow.title);
		void this.run();
	}

	onClose() {
		this.cancelled = true;
		this.contentEl.empty();
		if (!this.finished) this.onDone(false);
	}

	private async run() {
		const status = this.contentEl.createDiv({ cls: "vsg-muted", text: t("app.starting", { host: this.flow.host }) });
		if (!this.flow.available()) return void status.setText(t("app.notAvailable", { host: this.flow.host }));
		let code: SignInCode;
		try {
			code = await this.flow.start();
		} catch (e) {
			// Refused before any code was shown: the app isn't set up for device sign-in on this server.
			const code = (e as { code?: unknown } | null)?.code;
			return void status.setText(code === "access_denied" || code === "unauthorized_client" ? t("app.notAvailable", { host: this.flow.host }) : message(e, this.flow.host));
		}
		if (this.cancelled) return;
		status.remove();

		const userCode = code.userCode;
		this.contentEl.createEl("p", { text: t("app.codeBody", { host: this.flow.host }) });
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
					.setButtonText(t("app.open", { host: this.flow.host }))
					.setCta()
					.onClick(() => {
						void copy();
						window.open(code.verificationUriComplete ?? code.verificationUri);
					}),
			);
		const wait = this.contentEl.createDiv({ cls: "vsg-muted", text: t("app.waiting", { host: this.flow.host }) });

		try {
			await this.flow.finish(() => this.cancelled);
			if (this.cancelled) return;
			this.finished = true;
			this.close();
			this.onDone(true);
		} catch (e) {
			if (!this.cancelled) wait.setText(message(e, this.flow.host));
		}
	}
}

/** Sign in with GitHub (kept for callers that open it directly). */
export class GitHubSignInModal extends DeviceSignInModal {
	constructor(app: App, plugin: VaultSyncPlugin, onDone: (ok: boolean) => void) {
		super(app, plugin.signInFlow("github"), onDone);
	}
}
