// Diff rendering (split on desktop, unified on mobile) and a per-change conflict picker.

import { Platform } from "obsidian";
import { assemble, diffLines, diffStats, HunkPick, Segment, segments } from "./diff.ts";
import { t as tr } from "./i18n.ts";

export interface DiffViewOptions {
	oldLabel: string;
	newLabel: string;
	mode?: "split" | "unified";
	context?: number;
}

const strip = (l: string) => l.replace(/\r?\n$/, "");

function lineEl(parent: HTMLElement, kind: "eq" | "add" | "del" | "empty", no: number | null, text: string) {
	const row = parent.createDiv({ cls: `vsg-dl vsg-dl-${kind}` });
	row.createSpan({ cls: "vsg-dl-no", text: no === null ? "" : String(no) });
	row.createSpan({ cls: "vsg-dl-sign", text: kind === "add" ? "+" : kind === "del" ? "−" : " " });
	row.createSpan({ cls: "vsg-dl-text", text: text || " " });
}

/** Renders a diff of oldText → newText into `parent`, with a split/unified toggle on desktop. */
export function renderDiff(parent: HTMLElement, oldText: string, newText: string, o: DiffViewOptions): void {
	const ctx = o.context ?? 3;
	const ops = diffLines(oldText, newText);
	const segs = segments(ops);
	const stats = diffStats(ops);
	let mode: "split" | "unified" = o.mode ?? (Platform.isMobile ? "unified" : "split");

	const wrap = parent.createDiv({ cls: "vsg-dv" });
	const head = wrap.createDiv({ cls: "vsg-dv-head" });
	head.createSpan({ cls: "vsg-dv-label vsg-dl-del", text: `− ${o.oldLabel}` });
	head.createSpan({ cls: "vsg-dv-label vsg-dl-add", text: `+ ${o.newLabel}` });
	head.createSpan({ cls: "vsg-dv-stats", text: `+${stats.added} −${stats.removed}` });
	const body = wrap.createDiv({ cls: "vsg-dv-body" });
	if (!Platform.isMobile) {
		const btn = head.createEl("button", { cls: "vsg-dv-toggle", text: tr("d.unified") });
		btn.onClickEvent(() => {
			mode = mode === "split" ? "unified" : "split";
			btn.setText(mode === "split" ? tr("d.unified") : tr("d.split"));
			draw();
		});
		btn.setText(mode === "split" ? tr("d.unified") : tr("d.split"));
	}

	const draw = () => {
		body.empty();
		if (!stats.added && !stats.removed) {
			body.createDiv({ cls: "vsg-dv-same", text: tr("d.same") });
			return;
		}
		body.toggleClass("vsg-dv-split", mode === "split");
		let oldNo = 1;
		let newNo = 1;
		const left = mode === "split" ? body.createDiv({ cls: "vsg-dv-col" }) : body;
		const right = mode === "split" ? body.createDiv({ cls: "vsg-dv-col" }) : body;

		segs.forEach((s, idx) => {
			if (s.kind === "same") {
				const n = s.lines.length;
				const first = idx === 0;
				const last = idx === segs.length - 1;
				const keepHead = first ? 0 : ctx;
				const keepTail = last ? 0 : ctx;
				const show = (from: number, to: number) => {
					for (let i = from; i < to; i++) {
						lineEl(left, "eq", oldNo + i, strip(s.lines[i]));
						if (mode === "split") lineEl(right, "eq", newNo + i, strip(s.lines[i]));
					}
				};
				if (n <= keepHead + keepTail + 1) show(0, n);
				else {
					show(0, keepHead);
					const hidden = n - keepHead - keepTail;
					const startOld = oldNo;
					const startNew = newNo;
					const folds = mode === "split" ? [left, right] : [left];
					const els = folds.map((col) => col.createDiv({ cls: "vsg-dl-fold", text: tr("d.unchanged", { n: hidden }) }));
					const expand = () => {
						els.forEach((el, k) => {
							const frag = createDiv();
							for (let i = keepHead; i < keepHead + hidden; i++) {
								lineEl(frag, "eq", (k === 0 ? startOld : startNew) + i, strip(s.lines[i]));
							}
							el.replaceWith(...Array.from(frag.childNodes));
						});
					};
					els.forEach((el) => clickable(el, expand));
					for (let i = n - keepTail; i < n; i++) {
						lineEl(left, "eq", oldNo + i, strip(s.lines[i]));
						if (mode === "split") lineEl(right, "eq", newNo + i, strip(s.lines[i]));
					}
				}
				oldNo += n;
				newNo += n;
			} else if (mode === "unified") {
				s.a.forEach((l, i) => lineEl(body, "del", oldNo + i, strip(l)));
				s.b.forEach((l, i) => lineEl(body, "add", newNo + i, strip(l)));
				oldNo += s.a.length;
				newNo += s.b.length;
			} else {
				const rows = Math.max(s.a.length, s.b.length);
				for (let i = 0; i < rows; i++) {
					if (i < s.a.length) lineEl(left, "del", oldNo + i, strip(s.a[i]));
					else lineEl(left, "empty", null, "");
					if (i < s.b.length) lineEl(right, "add", newNo + i, strip(s.b[i]));
					else lineEl(right, "empty", null, "");
				}
				oldNo += s.a.length;
				newNo += s.b.length;
			}
		});
	};
	draw();
}

/**
 * Change-by-change conflict picker: for every block that differs, choose this device, GitHub, or
 * both. Returns a function that builds the resulting text.
 */
export function renderHunkPicker(parent: HTMLElement, localText: string, remoteText: string, labels: { a: string; b: string }): () => string {
	const segs: Segment[] = segments(diffLines(localText, remoteText));
	const picks: HunkPick[] = [];
	const wrap = parent.createDiv({ cls: "vsg-hp" });
	let k = 0;
	segs.forEach((s, idx) => {
		if (s.kind === "same") {
			const n = s.lines.length;
			const box = wrap.createDiv({ cls: "vsg-hp-same" });
			const preview = n > 4 && idx !== 0 && idx !== segs.length - 1 ? [...s.lines.slice(0, 2), null, ...s.lines.slice(-2)] : s.lines;
			for (const l of preview) {
				if (l === null) box.createDiv({ cls: "vsg-dl-fold", text: tr("d.unchanged", { n: n - 4 }) });
				else lineEl(box, "eq", null, strip(l));
			}
			return;
		}
		const i = k++;
		picks[i] = "both";
		const block = wrap.createDiv({ cls: "vsg-hp-block" });
		const bar = block.createDiv({ cls: "vsg-hp-bar" });
		bar.createSpan({ text: tr("d.change", { n: i + 1 }), cls: "vsg-hp-title" });
		const opts: [HunkPick, string][] = [
			["a", labels.a],
			["b", labels.b],
			["both", tr("d.both")],
		];
		const buttons = opts.map(([p, label]) => {
			const b = bar.createEl("button", { text: label, cls: "vsg-hp-btn" });
			b.onClickEvent(() => {
				picks[i] = p;
				buttons.forEach((x, j) => x.toggleClass("is-active", opts[j][0] === p));
				sideA.toggleClass("vsg-hp-off", p === "b");
				sideB.toggleClass("vsg-hp-off", p === "a");
			});
			return b;
		});
		buttons[2].addClass("is-active");
		const sideA = block.createDiv({ cls: "vsg-hp-side" });
		sideA.createDiv({ cls: "vsg-hp-side-label", text: labels.a });
		if (!s.a.length) sideA.createDiv({ cls: "vsg-hp-empty", text: tr("d.nothing") });
		s.a.forEach((l) => lineEl(sideA, "del", null, strip(l)));
		const sideB = block.createDiv({ cls: "vsg-hp-side" });
		sideB.createDiv({ cls: "vsg-hp-side-label", text: labels.b });
		if (!s.b.length) sideB.createDiv({ cls: "vsg-hp-empty", text: tr("d.nothing") });
		s.b.forEach((l) => lineEl(sideB, "add", null, strip(l)));
	});
	if (!k) wrap.createDiv({ cls: "vsg-dv-same", text: tr("d.identical") });
	return () => assemble(segs, picks);
}

/** Makes a clickable element usable from the keyboard and by screen readers (role, focus, Enter/Space). */
export function clickable(el: HTMLElement, fn: () => void, label?: string) {
	el.setAttr("role", "button");
	el.setAttr("tabindex", "0");
	if (label) el.setAttr("aria-label", label);
	el.onClickEvent(fn);
	el.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			fn();
		}
	});
}
