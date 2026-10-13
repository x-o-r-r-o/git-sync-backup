// Smaller workflow features around the sync: sync with a typed commit message, "Sync and close
// Obsidian", the final push when a desktop window closes, excluding and including files from the file
// explorer, the exclude-patterns editor, the status bar countdown and branch, events for other
// plugins, and leaving out notes marked `sync: false` in their frontmatter.

import { Modal, Notice, Platform, Setting, TFile, TFolder, setIcon } from "obsidian";
import type { App, Menu, TAbstractFile } from "obsidian";
import type VaultSyncPlugin from "./main.ts";
import { addExclusion, excludedByPatterns, removeExclusion } from "./scope-edit.ts";
import type { SyncEventSummary } from "./types.ts";
import { confirmPlan } from "./ui.ts";
import { t } from "./i18n.ts";
import { errMsg } from "./util.ts";
import { closeVerdict } from "./errors.ts";

// ---------------- events for other plugins ----------------

export const SYNC_START_EVENT = "vault-sync-git:sync-start";
export const SYNC_DONE_EVENT = "vault-sync-git:sync-done";

/** Tells other plugins about a sync. A listener that throws never breaks the sync. */
export function emitSyncEvent(app: App, name: typeof SYNC_START_EVENT, data: { trigger: string; mode: string }): void;
export function emitSyncEvent(app: App, name: typeof SYNC_DONE_EVENT, data: SyncEventSummary): void;
export function emitSyncEvent(app: App, name: string, data: unknown): void {
	try {
		app.workspace.trigger(name, data);
	} catch (e) {
		console.error(`Git Sync & Backup: a ${name} listener failed`, e);
	}
}

// ---------------- sync: false in frontmatter ----------------

const OFF = /^(false|no|off)$/i;

/**
 * Markdown notes whose frontmatter says `sync: false` (or "no"/"off"), and notes Obsidian hasn't read
 * yet (no metadata cache entry): those wait for the next sync rather than risk being uploaded.
 */
export function frontmatterScope(app: App): { out: Set<string>; unknown: Set<string> } {
	const out = new Set<string>();
	const unknown = new Set<string>();
	for (const f of app.vault.getMarkdownFiles()) {
		const cache = app.metadataCache.getFileCache(f);
		if (!cache) {
			unknown.add(f.path);
			continue;
		}
		const v: unknown = cache.frontmatter?.sync;
		if (v === false || (typeof v === "string" && OFF.test(v.trim()))) out.add(f.path);
	}
	return { out, unknown };
}

// ---------------- commit message prompt ----------------

class CommitMessageModal extends Modal {
	private text = "";
	private done: (msg: string | null) => void;
	private sent = false;
	constructor(app: App, done: (msg: string | null) => void) {
		super(app);
		this.done = done;
	}
	onOpen() {
		this.titleEl.setText(t("msg.title"));
		const input = this.contentEl.createEl("textarea", { cls: "vsg-textarea vsg-commit-input", attr: { rows: "3", placeholder: t("msg.placeholder"), "aria-label": t("msg.title") } });
		input.addEventListener("input", () => (this.text = input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit();
			}
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("u.cancel")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("msg.sync")).setCta().onClick(() => this.submit()));
		window.setTimeout(() => input.focus(), 0);
	}
	private submit() {
		const msg = this.text.replace(/\s+/g, " ").trim();
		if (!msg) return void new Notice(t("msg.empty"));
		this.sent = true;
		this.close();
		this.done(msg);
	}
	onClose() {
		this.contentEl.empty();
		if (!this.sent) this.done(null);
	}
}

/** Waits until no sync is running (at most `maxMs`). */
async function waitIdle(plugin: VaultSyncPlugin, maxMs: number): Promise<boolean> {
	const until = Date.now() + maxMs;
	while (plugin.isSyncing()) {
		if (Date.now() > until) return false;
		await new Promise<void>((r) => window.setTimeout(r, 300));
	}
	return true;
}

// ---------------- exclude / include from the file explorer ----------------

function isFolder(file: TAbstractFile): boolean {
	return file instanceof TFolder;
}

async function excludePath(plugin: VaultSyncPlugin, file: TAbstractFile) {
	const cfg = plugin.app.vault.configDir;
	const next = addExclusion(plugin.settings.excludePatterns, file.path, isFolder(file), cfg);
	if (next === null) return void new Notice(t("m.alreadyExcluded", { folder: file.path }));
	if (!(await confirmPlan(plugin.app, t("menu.excludeFile"), t("m.excludeFileBody", { path: file.path }), [], t("menu.excludeFile")))) return;
	plugin.settings.excludePatterns = next;
	await plugin.saveSettings();
	plugin.refreshBadges();
	new Notice(t("m.excludedFile", { path: file.path }));
}

async function includePath(plugin: VaultSyncPlugin, file: TAbstractFile) {
	const cfg = plugin.app.vault.configDir;
	const next = removeExclusion(plugin.settings.excludePatterns, file.path, isFolder(file), cfg);
	if (next === null) return void new Notice(t("m.includeImpossible", { path: file.path }));
	plugin.settings.excludePatterns = next;
	await plugin.saveSettings();
	plugin.refreshBadges();
	new Notice(t("m.included", { path: file.path }));
}

/** "Git: Exclude this file from sync" / "Git: Include in sync" in the file explorer menu. */
export function addScopeMenuItems(plugin: VaultSyncPlugin, menu: Menu, file: TAbstractFile) {
	if (!file.path || file.path === "/") return;
	const ours = (item: string) => t("menu.prefixed", { item });
	const byPatterns = excludedByPatterns(plugin.settings.excludePatterns, file.path, plugin.app.vault.configDir);
	if (byPatterns) {
		menu.addItem((i) => i.setTitle(ours(t("menu.include"))).setIcon("eye").onClick(() => void includePath(plugin, file)));
	} else if (file instanceof TFile && plugin.isPathSynced(file.path)) {
		menu.addItem((i) => i.setTitle(ours(t("menu.excludeFile"))).setIcon("eye-off").onClick(() => void excludePath(plugin, file)));
	}
}

class ExcludePatternsModal extends Modal {
	private plugin: VaultSyncPlugin;
	constructor(plugin: VaultSyncPlugin) {
		super(plugin.app);
		this.plugin = plugin;
	}
	onOpen() {
		this.titleEl.setText(t("s.exclude"));
		this.contentEl.createEl("p", { cls: "vsg-muted", text: t("s.excludeDesc") });
		const area = this.contentEl.createEl("textarea", { cls: "vsg-textarea vsg-exclude-editor", attr: { rows: "14", "aria-label": t("s.exclude"), spellcheck: "false" } });
		area.value = this.plugin.settings.excludePatterns;
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText(t("u.cancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("ex.save"))
					.setCta()
					.onClick(async () => {
						this.plugin.settings.excludePatterns = area.value;
						await this.plugin.saveSettings();
						this.plugin.refreshBadges();
						new Notice(t("ex.saved"));
						this.close();
					}),
			);
	}
	onClose() {
		this.contentEl.empty();
	}
}

// ---------------- status bar: next sync and branch (desktop) ----------------

class StatusExtras {
	private el: HTMLElement;
	private plugin: VaultSyncPlugin;
	constructor(plugin: VaultSyncPlugin, el: HTMLElement) {
		this.plugin = plugin;
		this.el = el;
		el.addClass("vsg-status-extra");
	}
	update() {
		const p = this.plugin;
		const s = p.settings;
		this.el.empty();
		const parts: { icon: string; text: string; tip: string }[] = [];
		if (s.statusBranch && p.isConfigured()) parts.push({ icon: "git-branch", text: s.branch, tip: t("sb.branchTip", { branch: s.branch }) });
		const next = p.nextScheduledSync();
		if (s.statusCountdown && next > 0 && p.isConfigured() && !p.isPaused()) {
			const min = Math.ceil((next - Date.now()) / 60_000);
			parts.push({ icon: "timer", text: min <= 1 ? t("sb.soon") : t("sb.next", { n: min }), tip: t("sb.nextTip") });
		}
		this.el.toggle(parts.length > 0);
		for (const part of parts) {
			const span = this.el.createSpan({ cls: "vsg-status-part", attr: { "aria-label": part.tip } });
			setIcon(span.createSpan({ cls: "vsg-status-icon" }), part.icon);
			span.createSpan({ text: part.text });
		}
	}
}

// ---------------- install ----------------

/** Commands, status bar items and window-close handling. Called once from onload. */
export function installSyncExtras(plugin: VaultSyncPlugin): { updateStatus: () => void } {
	plugin.addCommand({
		id: "sync-with-message",
		name: t("cmd.syncMessage"),
		callback: () => {
			if (plugin.isSyncing()) return void new Notice(t("notice.busy"));
			new CommitMessageModal(plugin.app, (msg) => {
				if (!msg) return;
				plugin.setCustomCommitMessage(msg);
				void plugin.sync("manual");
			}).open();
		},
	});
	plugin.addCommand({
		id: "edit-exclude-patterns",
		name: t("cmd.editExcludes"),
		callback: () => new ExcludePatternsModal(plugin).open(),
	});

	let status: StatusExtras | null = null;
	if (!Platform.isMobile) {
		// Phones and tablets can't close the app from a plugin; there the command would only sync.
		plugin.addCommand({ id: "sync-and-close", name: t("cmd.syncClose"), callback: () => void syncAndClose(plugin) });

		status = new StatusExtras(plugin, plugin.addStatusBarItem());
		status.update();
		plugin.registerInterval(window.setInterval(() => status?.update(), 30_000));

		// Closing a desktop window: start a last push of pending edits. The page can't wait for it to finish
		// (beforeunload can't await), so a large or slow upload may be cut off; "Sync and close Obsidian"
		// is the reliable way. Nothing is lost either way: the edits stay pending for the next sync.
		plugin.registerDomEvent(window, "beforeunload", () => {
			if (!plugin.settings.syncOnBackground || plugin.isSyncing() || !plugin.isConfigured()) return;
			try {
				if (plugin.pendingLocalPaths().size) void plugin.sync("background");
			} catch {
				/* never block closing */
			}
		});
	}
	return { updateStatus: () => status?.update() };
}

/** "Sync and close Obsidian": sync, and close the window only when that sync succeeded. */
export async function syncAndClose(plugin: VaultSyncPlugin) {
	const notice = new Notice(t("m.closeSyncing"), 0);
	try {
		if (!(await waitIdle(plugin, 5 * 60_000))) return void new Notice(t("m.closeNotSynced"), 8000);
		const before = plugin.syncOutcome?.seq ?? 0;
		await plugin.sync("close");
		await waitIdle(plugin, 5 * 60_000);
		// Only a fully successful sync closes Obsidian: a failed shared folder, backup mirror or file keeps it open.
		const verdict = closeVerdict(before, plugin.syncOutcome, plugin.lastError);
		if (!verdict.quit) return void new Notice(verdict.message, 15000);
	} catch (e) {
		return void new Notice(t("m.closeFailed", { error: errMsg(e) }), 10000);
	} finally {
		notice.hide();
	}
	const commands = (plugin.app as unknown as { commands?: { commands?: Record<string, unknown>; executeCommandById?: (id: string) => boolean } }).commands;
	if (commands?.commands?.["app:quit"] && commands.executeCommandById) commands.executeCommandById("app:quit");
	else window.close();
}
