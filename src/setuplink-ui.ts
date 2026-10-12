// "Add a device" screens: create a setup link and QR code on a configured device, and confirm before
// applying a link opened on a new one. Links can come from anywhere, so nothing is applied unasked.

import { App, Modal, Notice, Platform, Setting } from "obsidian";
import qrcode from "qrcode-generator";
import type VaultSyncPlugin from "./main.ts";
import { HOSTS } from "./hosts.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { buildSetupLink, decryptToken, encryptToken, newSetupCode } from "./setuplink.ts";
import type { SetupPayload } from "./setuplink.ts";
import { errMsg } from "./util.ts";
import { t } from "./i18n.ts";

const SVG = "http://www.w3.org/2000/svg";

/** Draws a QR code as one SVG path (no innerHTML, scales crisply). */
function renderQr(parent: HTMLElement, text: string) {
	const qr = qrcode(0, "M");
	qr.addData(text, "Byte");
	qr.make();
	const n = qr.getModuleCount();
	const quiet = 4;
	let d = "";
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + quiet},${r + quiet}h1v1h-1z`;
	const svg = document.createElementNS(SVG, "svg");
	svg.setAttribute("viewBox", `0 0 ${n + quiet * 2} ${n + quiet * 2}`);
	svg.setAttribute("class", "vsg-qr");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", t("link.qrLabel"));
	const bg = document.createElementNS(SVG, "rect");
	bg.setAttribute("width", "100%");
	bg.setAttribute("height", "100%");
	bg.setAttribute("fill", "#fff");
	const path = document.createElementNS(SVG, "path");
	path.setAttribute("d", d);
	path.setAttribute("fill", "#000");
	svg.append(bg, path);
	parent.appendChild(svg);
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		new Notice(t("link.copied"));
	} catch {
		/* the text is on screen */
	}
}

/** On a configured device: build a link (and QR code) that sets up another device. */
export class CreateSetupLinkModal extends Modal {
	private plugin: VaultSyncPlugin;
	private includeToken = false;

	constructor(app: App, plugin: VaultSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		this.titleEl.setText(t("link.createTitle"));
		this.modalEl.addClass("vsg-setup-link");
		this.render();
	}

	private payload(): SetupPayload {
		const p = this.plugin;
		const s = p.settings;
		const api = p.getApiBase();
		return {
			v: 1,
			provider: s.provider,
			...(api !== HOSTS[s.provider].defaultApi ? { api } : {}),
			owner: s.owner,
			repo: s.repo,
			branch: s.branch,
			syncConfigDir: s.syncConfigDir,
			configSync: s.configSync,
			syncHidden: s.syncHidden,
			useGitignore: s.useGitignore,
			...(s.excludePatterns !== DEFAULT_SETTINGS.excludePatterns ? { exclude: s.excludePatterns } : {}),
		};
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		const p = this.plugin;
		contentEl.createEl("p", { cls: "vsg-muted", text: t("link.createIntro") });
		// Signed in with GitHub: the new device signs in itself (its own short-lived tokens).
		const canIncludeToken = !p.usingGitHubApp() && !!p.getToken();
		if (canIncludeToken) {
			new Setting(contentEl)
				.setName(t("link.includeToken"))
				.setDesc(t("link.includeTokenDesc"))
				.addToggle((tg) =>
					tg.setValue(this.includeToken).onChange((v) => {
						this.includeToken = v;
						this.render();
					}),
				);
		} else if (p.usingGitHubApp()) {
			contentEl.createEl("p", { cls: "vsg-muted", text: t("link.signInNote") });
		}
		const out = contentEl.createDiv({ cls: "vsg-link-out", text: this.includeToken ? t("link.encrypting") : "" });
		this.build(out).catch((e) => out.setText(errMsg(e)));
	}

	private async build(out: HTMLElement) {
		const payload = this.payload();
		let code = "";
		if (this.includeToken) {
			code = newSetupCode();
			payload.token = await encryptToken(this.plugin.getToken(), code);
		}
		const link = buildSetupLink(payload);
		out.empty();
		// A phone can scan the code with its camera; on a phone, share the link instead.
		if (!Platform.isMobile) {
			// Very long links (many custom patterns) don't fit in a QR code: then share the link only.
			const box = out.createDiv({ cls: "vsg-qr-box" });
			try {
				renderQr(box, link);
			} catch {
				box.remove();
				out.createEl("p", { cls: "vsg-muted", text: t("link.tooLongForQr") });
			}
		}
		new Setting(out)
			.setName(t("link.link"))
			.setDesc(t("link.linkDesc"))
			.addButton((b) => b.setButtonText(t("link.copyLink")).setCta().onClick(() => void copy(link)));
		if (code) {
			const box = out.createDiv({ cls: "vsg-link-code" });
			box.createDiv({ cls: "vsg-muted", text: t("link.codeIntro") });
			box.createDiv({ cls: "vsg-device-code", text: code });
		}
		out.createEl("p", { cls: "vsg-muted", text: code ? t("link.keepApart") : t("link.noSecrets") });
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** On the new device: show what the link would change, and apply it only when confirmed. */
export class ApplySetupLinkModal extends Modal {
	private plugin: VaultSyncPlugin;
	private payload: SetupPayload;

	constructor(app: App, plugin: VaultSyncPlugin, payload: SetupPayload) {
		super(app);
		this.plugin = plugin;
		this.payload = payload;
	}

	onOpen() {
		const { contentEl, payload: s, plugin: p } = this;
		this.titleEl.setText(t("link.applyTitle"));
		contentEl.createEl("p", { text: t("link.applyIntro", { vault: this.app.vault.getName() }) });
		const ul = contentEl.createEl("ul");
		ul.createEl("li", { text: `${HOSTS[s.provider].label}: ${s.owner}/${s.repo} (${s.branch})` });
		if (s.api) ul.createEl("li", { text: t("link.server", { url: s.api }) });
		if (s.syncConfigDir) ul.createEl("li", { text: t("link.withSettings") });
		if (s.syncHidden) ul.createEl("li", { text: t("link.withHidden") });
		if (s.useGitignore) ul.createEl("li", { text: t("link.withGitignore") });
		if (s.exclude !== undefined) ul.createEl("li", { text: t("link.withExclude") });
		if (s.token) ul.createEl("li", { text: t("link.withToken") });
		const warn = contentEl.createDiv({ cls: "vsg-h-error" });
		warn.setText(t("link.onlyYours"));
		if (p.isConfigured()) contentEl.createEl("p", { cls: "vsg-h-accent", text: t("link.replaces", { repo: `${p.settings.owner}/${p.settings.repo}` }) });

		let code = "";
		if (s.token) {
			new Setting(contentEl)
				.setName(t("link.code"))
				.setDesc(t("link.codeDesc"))
				.addText((tx) => tx.onChange((v) => (code = v)));
		}
		const status = contentEl.createDiv({ cls: "vsg-muted" });
		let busy = false;
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("u.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("link.apply"))
					.setCta()
					.onClick(async () => {
						if (busy) return;
						busy = true;
						b.setDisabled(true);
						const release = () => {
							busy = false;
							b.setDisabled(false);
						};
						let token = "";
						if (s.token) {
							if (!code.trim()) {
								release();
								return void status.setText(t("link.needCode"));
							}
							try {
								status.setText(t("link.decrypting"));
								token = await decryptToken(s.token, code);
							} catch {
								release();
								return void status.setText(t("link.wrongCode"));
							}
						}
						try {
							this.close();
							await p.applySetupPayload(s, token);
						} catch (e) {
							new Notice(errMsg(e), 8000);
						}
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
