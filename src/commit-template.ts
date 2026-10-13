// Commit message templates. Pure module (tested without Obsidian).
//
// Variables: {{device}}, {{summary}}, {{count}}, {{files}} (changed paths, first 10 then "and N more"),
// {{trigger}} (manual, startup, change, interval, resume, background, open, close), {{date}} (ISO time)
// and {{date:FORMAT}} (moment.js format such as YYYY-MM-DD HH:mm; a small built-in formatter is used
// when moment isn't there).

export const DEFAULT_COMMIT_TEMPLATE = "{{device}}: {{summary}}";
export const FILES_IN_MESSAGE = 10;

export interface CommitVars {
	device: string;
	summary: string;
	count: number;
	files: string[];
	trigger: string;
	date: Date;
}

type MomentLike = (d: Date) => { format(f: string): string };

/** Syncs started by the user (the command, ribbon, "Sync and close"); everything else is automatic. */
export function isAutomaticTrigger(trigger: string | undefined): boolean {
	return !!trigger && trigger !== "manual" && trigger !== "close";
}

/** Picks the template for a sync: the automatic one (when set) for automatic syncs, else the main one. */
export function templateFor(main: string, auto: string | undefined, trigger: string | undefined): string {
	const m = main.trim() || DEFAULT_COMMIT_TEMPLATE;
	return isAutomaticTrigger(trigger) && auto?.trim() ? auto.trim() : m;
}

/** "a.md, b.md and 3 more". */
export function filesList(files: string[], max = FILES_IN_MESSAGE): string {
	if (!files.length) return "";
	const shown = files.slice(0, max).join(", ");
	return files.length > max ? `${shown} and ${files.length - max} more` : shown;
}

/** Fallback for {{date:FORMAT}} without moment: YYYY YY MM M DD D HH H mm m ss s (other text kept as is). */
export function formatDate(d: Date, format: string): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const tokens: Record<string, () => string> = {
		YYYY: () => String(d.getFullYear()),
		YY: () => String(d.getFullYear()).slice(-2),
		MM: () => p(d.getMonth() + 1),
		M: () => String(d.getMonth() + 1),
		DD: () => p(d.getDate()),
		D: () => String(d.getDate()),
		HH: () => p(d.getHours()),
		H: () => String(d.getHours()),
		mm: () => p(d.getMinutes()),
		m: () => String(d.getMinutes()),
		ss: () => p(d.getSeconds()),
		s: () => String(d.getSeconds()),
	};
	return format.replace(/\[([^\]]*)\]|YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s/g, (tok: string, lit?: string) => (lit !== undefined ? lit : tokens[tok]()));
}

function momentFromGlobal(): MomentLike | null {
	// Obsidian puts moment.js on window; tests run without a window.
	const m = typeof window === "undefined" ? undefined : (window as unknown as { moment?: unknown }).moment;
	return typeof m === "function" ? (m as MomentLike) : null;
}

/** The commit subject from a template. Unknown {{variables}} are left as they are. */
export function renderCommitTemplate(template: string, v: CommitVars, moment: MomentLike | null = momentFromGlobal()): string {
	const out = template.replace(/\{\{\s*(\w+)(?::([^}]*))?\s*\}\}/g, (all: string, name: string, fmt?: string) => {
		switch (name) {
			case "device":
				return v.device;
			case "summary":
				return v.summary;
			case "count":
				return String(v.count);
			case "files":
				return filesList(v.files);
			case "trigger":
				return v.trigger;
			case "date": {
				const f = fmt?.trim();
				if (!f) return v.date.toISOString();
				try {
					if (moment) return moment(v.date).format(f);
				} catch {
					/* fall back below */
				}
				return formatDate(v.date, f);
			}
			default:
				return all;
		}
	});
	// A subject is one line: a multi-line result would push the file list around.
	return out.replace(/[\r\n]+/g, " ").trim();
}

/** What the settings preview shows. */
export function previewCommitMessage(template: string, device: string, trigger = "manual", moment?: MomentLike | null): string {
	return renderCommitTemplate(template.trim() || DEFAULT_COMMIT_TEMPLATE, {
		device,
		summary: "1 added, 2 updated",
		count: 3,
		files: ["Notes/Idea.md", "Daily/2026-10-13.md", "Projects/Plan.md"],
		trigger,
		date: new Date(),
	}, moment === undefined ? momentFromGlobal() : moment);
}
