import { App, Modal, Setting } from "obsidian";
import type { CommitInfo } from "./github.ts";
import type { Decision } from "./plan.ts";
import type { ConflictChoice, ConflictInfo, DeleteGuardChoice } from "./types.ts";

function list(el: HTMLElement, items: string[], max = 200) {
	const ul = el.createEl("ul", { cls: "vsg-list" });
	for (const i of items.slice(0, max)) ul.createEl("li", { text: i });
	if (items.length > max) ul.createEl("li", { text: `…and ${items.length - max} more` });
}

/** Side-by-side conflict chooser. Resolves when the user picks; closing = keep both (safe). */
export class ConflictModal extends Modal {
	private choice: ConflictChoice = "keep-both";
	constructor(app: App, private info: ConflictInfo, private done: (c: ConflictChoice) => void) {
		super(app);
	}
	onOpen() {
		const { contentEl, info } = this;
		this.titleEl.setText(`Conflict: ${info.path}`);
		contentEl.createEl("p", { text: "This file changed on this device and on GitHub since the last sync." });
		const grid = contentEl.createDiv({ cls: "vsg-diff" });
		const col = (title: string, text: string | null, size: number) => {
			const c = grid.createDiv({ cls: "vsg-diff-col" });
			c.createEl("h4", { text: title });
			c.createEl("pre", { text: text ?? `(binary file, ${size} bytes)` });
		};
		col("This device", this.info.localText, info.localSize);
		col("GitHub", this.info.remoteText, info.remoteSize);
		const btns = new Setting(contentEl);
		const pick = (c: ConflictChoice) => {
			this.choice = c;
			this.close();
		};
		btns.addButton((b) => b.setButtonText("Keep this device").onClick(() => pick("local")));
		btns.addButton((b) => b.setButtonText("Keep GitHub").onClick(() => pick("remote")));
		btns.addButton((b) => b.setButtonText("Keep both").setCta().onClick(() => pick("keep-both")));
		if (info.localText !== null && info.remoteText !== null) {
			btns.addButton((b) => b.setButtonText("Merge with markers").onClick(() => pick("markers")));
		}
	}
	onClose() {
		this.contentEl.empty();
		this.done(this.choice);
	}
}

export class DeleteGuardModal extends Modal {
	private choice: DeleteGuardChoice = "cancel";
	constructor(app: App, private local: string[], private remote: string[], private done: (c: DeleteGuardChoice) => void) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Large deletion detected");
		contentEl.createEl("p", {
			text: `This sync would delete ${this.local.length + this.remote.length} files. Please confirm this is intended.`,
		});
		if (this.local.length) {
			contentEl.createEl("h4", { text: `Delete on this device (moved to trash): ${this.local.length}` });
			list(contentEl, this.local, 50);
		}
		if (this.remote.length) {
			contentEl.createEl("h4", { text: `Delete on GitHub (kept in history): ${this.remote.length}` });
			list(contentEl, this.remote, 50);
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel sync").onClick(() => this.pick("cancel")))
			.addButton((b) => b.setButtonText("Sync but skip deletions").setCta().onClick(() => this.pick("skip")))
			.addButton((b) => b.setButtonText("Delete them").setWarning().onClick(() => this.pick("proceed")));
	}
	private pick(c: DeleteGuardChoice) {
		this.choice = c;
		this.close();
	}
	onClose() {
		this.contentEl.empty();
		this.done(this.choice);
	}
}

export class PreviewModal extends Modal {
	constructor(app: App, private decisions: Decision[], private skipped: string[], private onSync: () => void) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Sync preview");
		const groups: [string, Decision["kind"]][] = [
			["Download from GitHub", "download"],
			["Upload to GitHub", "upload"],
			["Delete on this device", "delete-local"],
			["Delete on GitHub", "delete-remote"],
			["Conflicts (changed on both sides)", "conflict"],
		];
		if (!this.decisions.length) contentEl.createEl("p", { text: "Everything is up to date." });
		for (const [title, kind] of groups) {
			const items = this.decisions.filter((d) => d.kind === kind).map((d) => d.path);
			if (!items.length) continue;
			contentEl.createEl("h4", { text: `${title}: ${items.length}` });
			list(contentEl, items);
		}
		if (this.skipped.length) {
			contentEl.createEl("h4", { text: `Skipped: ${this.skipped.length}` });
			list(contentEl, this.skipped);
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Close").onClick(() => this.close()))
			.addButton((b) =>
				b.setButtonText("Sync now").setCta().onClick(() => {
					this.close();
					this.onSync();
				}),
			);
	}
	onClose() {
		this.contentEl.empty();
	}
}

export class LogModal extends Modal {
	constructor(app: App, private lines: string[]) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Sync log");
		const pre = this.contentEl.createEl("pre", { cls: "vsg-log" });
		pre.setText(this.lines.length ? [...this.lines].reverse().join("\n") : "No sync activity yet.");
	}
	onClose() {
		this.contentEl.empty();
	}
}

/** Generic list of commits; clicking a row runs `onPick`. */
export class CommitListModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private load: () => Promise<{ label: string; sub: string; run: () => void }[]>,
	) {
		super(app);
	}
	async onOpen() {
		this.titleEl.setText(this.title);
		const status = this.contentEl.createEl("p", { text: "Loading from GitHub…" });
		try {
			const rows = await this.load();
			status.remove();
			if (!rows.length) this.contentEl.createEl("p", { text: "Nothing found." });
			const ul = this.contentEl.createEl("ul", { cls: "vsg-commits" });
			for (const r of rows) {
				const li = ul.createEl("li");
				li.createDiv({ text: r.label, cls: "vsg-commit-title" });
				li.createDiv({ text: r.sub, cls: "vsg-commit-sub" });
				li.onClickEvent(() => {
					this.close();
					r.run();
				});
			}
		} catch (e) {
			status.setText(`Failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	onClose() {
		this.contentEl.empty();
	}
}

export class FileVersionModal extends Modal {
	constructor(
		app: App,
		private path: string,
		private commit: CommitInfo | { sha: string; message: string; date: string },
		private text: string | null,
		private size: number,
		private onRestore: (asCopy: boolean) => void,
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText(`${this.path} @ ${this.commit.sha.slice(0, 7)}`);
		this.contentEl.createEl("p", {
			text: `${new Date(this.commit.date).toLocaleString()} · ${this.commit.message.split("\n")[0]}`,
			cls: "vsg-commit-sub",
		});
		this.contentEl.createEl("pre", { cls: "vsg-version", text: this.text ?? `(binary file, ${this.size} bytes)` });
		new Setting(this.contentEl)
			.addButton((b) =>
				b.setButtonText("Restore as copy").onClick(() => {
					this.close();
					this.onRestore(true);
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Restore this version")
					.setCta()
					.onClick(() => {
						this.close();
						this.onRestore(false);
					}),
			);
	}
	onClose() {
		this.contentEl.empty();
	}
}
