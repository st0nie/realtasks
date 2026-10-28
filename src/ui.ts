// Dock widget, status counts, /tasks overlay, and the notification renderer.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { readTail } from "./output.ts";
import type { Runtime } from "./runtime.ts";
import type { Task } from "./task.ts";
import { cleanOutput, formatDuration, lastNonEmptyLine } from "./text.ts";
import type { NotificationDetails } from "./notify.ts";

export const DOCK_WIDGET = "realtasks-dock";
export const STATUS_KEY = "realtasks";
const DOCK_MAX_PILLS = 3;

function icon(t: Task): string {
	if (t.rec.kind === "monitor") return "◉";
	return t.rec.tty ? "⌨" : "⚙";
}

function statusIcon(t: Task, th: Theme): string {
	switch (t.rec.status) {
		case "running":
			return th.fg("accent", "●");
		case "completed":
			return th.fg("success", "✓");
		case "stopped":
			return th.fg("dim", "■");
		case "lost":
			return th.fg("warning", "?");
		default:
			return th.fg("error", "✗");
	}
}

/** Dock lines: one pill per running task, collapsed past three. */
export function dockLines(tasks: Task[], th: Theme, width: number, now = Date.now()): string[] {
	const running = tasks.filter((t) => t.running && !t.rec.foreground);
	if (running.length === 0) return [];
	if (running.length > DOCK_MAX_PILLS) {
		const kinds = running.map((t) => icon(t)).join("");
		return [truncateToWidth(th.fg("dim", `${kinds} ${running.length} running · /tasks to manage`), width)];
	}
	return running.map((t) => {
		const last = lastNonEmptyLine(cleanOutput(t.ring.recent().slice(-2048)));
		const head = `${icon(t)} ${th.fg("accent", t.rec.id)} ${t.rec.label} ${th.fg("dim", formatDuration(now - t.rec.startedAt))}`;
		const tail = last ? th.fg("dim", ` │ ${last}`) : "";
		return truncateToWidth(head + tail, width);
	});
}

/** `✓2 ✗1` counts for terminal tasks the agent has not read yet. */
export function statusCounts(tasks: Task[], th: Theme): string | undefined {
	let ok = 0;
	let bad = 0;
	let running = 0;
	for (const t of tasks) {
		if (t.rec.foreground) continue;
		if (t.running) running++;
		else if (!t.rec.notified && !t.uiSeen) {
			if (t.rec.status === "completed" || t.rec.status === "stopped") ok++;
			else bad++;
		}
	}
	const parts: string[] = [];
	if (running) parts.push(th.fg("accent", `⚙${running}`));
	if (ok) parts.push(th.fg("success", `✓${ok}`));
	if (bad) parts.push(th.fg("error", `✗${bad}`));
	return parts.length ? parts.join(" ") : undefined;
}

class DockComponent implements Component {
	private readonly rt: Runtime;
	private readonly th: Theme;
	private readonly tui: TUI;
	private readonly off: () => void;
	private readonly ticker: ReturnType<typeof setInterval>;

	constructor(rt: Runtime, tui: TUI, th: Theme) {
		this.rt = rt;
		this.tui = tui;
		this.th = th;
		this.off = rt.onChange(() => this.tui.requestRender());
		this.ticker = setInterval(() => this.tui.requestRender(), 1000);
		this.ticker.unref();
	}
	render(width: number): string[] {
		return dockLines(this.rt.manager.list(), this.th, width);
	}
	invalidate(): void {}
	dispose(): void {
		this.off();
		clearInterval(this.ticker);
	}
}

/** Install the dock and keep the status line updated. TUI only. */
export function installDock(rt: Runtime, ctx: ExtensionContext): () => void {
	if (ctx.mode !== "tui") return () => {};
	let shown = false;
	const sync = () => {
		const tasks = rt.manager.list();
		const anyRunning = tasks.some((t) => t.running);
		if (anyRunning && !shown) {
			ctx.ui.setWidget(DOCK_WIDGET, (tui, th) => new DockComponent(rt, tui, th));
			shown = true;
		} else if (!anyRunning && shown) {
			ctx.ui.setWidget(DOCK_WIDGET, undefined);
			shown = false;
		}
		ctx.ui.setStatus(STATUS_KEY, statusCounts(tasks, ctx.ui.theme));
	};
	const off = rt.onChange(sync);
	sync();
	return () => {
		off();
		try {
			ctx.ui.setWidget(DOCK_WIDGET, undefined);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			/* stale ctx */
		}
	};
}

// ── /tasks overlay ─────────────────────────────────────────────

export type ManagerAction =
	| { type: "input"; id: string }
	| { type: "restart"; id: string }
	| undefined;

export class TasksOverlay implements Component {
	private selected = 0;
	private follow = true;
	private scroll = 0;
	private flash = "";
	private readonly rt: Runtime;
	private readonly tui: TUI;
	private readonly th: Theme;
	private readonly done: (a: ManagerAction) => void;
	private readonly off: () => void;
	private readonly ticker: ReturnType<typeof setInterval>;

	constructor(rt: Runtime, tui: TUI, th: Theme, done: (a: ManagerAction) => void) {
		this.rt = rt;
		this.tui = tui;
		this.th = th;
		this.done = done;
		this.off = rt.onChange(() => this.tui.requestRender());
		this.ticker = setInterval(() => this.tui.requestRender(), 1000);
		this.ticker.unref();
		for (const t of rt.manager.list()) if (!t.running) t.uiSeen = true;
		rt.emitChange();
	}

	private tasks(): Task[] {
		return this.rt.manager.list().slice().reverse();
	}

	private current(): Task | undefined {
		const list = this.tasks();
		if (this.selected >= list.length) this.selected = Math.max(0, list.length - 1);
		return list[this.selected];
	}

	handleInput(data: string): void {
		const t = this.current();
		this.flash = "";
		if (matchesKey(data, "escape") || data === "q") return this.close(undefined);
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.scroll = 0;
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(this.tasks().length - 1, this.selected + 1);
			this.scroll = 0;
		} else if (matchesKey(data, "return")) {
			this.follow = !this.follow;
			this.scroll = 0;
		} else if (matchesKey(data, "pageUp")) {
			this.follow = false;
			this.scroll += 10;
		} else if (matchesKey(data, "pageDown")) {
			this.scroll = Math.max(0, this.scroll - 10);
			if (this.scroll === 0) this.follow = true;
		} else if (t && data === "k") {
			if (t.running) {
				t.stop();
				this.flash = `Stopping ${t.rec.id}…`;
			}
		} else if (t && data === "i") {
			if (t.running && t.hasInput) return this.close({ type: "input", id: t.rec.id });
			this.flash = "Task has no open input";
		} else if (t && data === "r") {
			return this.close({ type: "restart", id: t.rec.id });
		} else if (t && data === "c") {
			void copyToClipboard(t.rec.logPath).then(
				() => {
					this.flash = "Log path copied";
					this.tui.requestRender();
				},
				() => {
					this.flash = t.rec.logPath;
					this.tui.requestRender();
				},
			);
		} else if (data === "x") {
			const n = this.rt.manager.clearFinished();
			this.flash = `Cleared ${n} finished`;
		}
		this.tui.requestRender();
	}

	private close(a: ManagerAction): void {
		this.dispose();
		this.done(a);
	}

	render(width: number): string[] {
		const th = this.th;
		const w = Math.max(40, width);
		const inner = w - 2;
		const leftW = Math.min(44, Math.floor(inner * 0.4));
		const rightW = inner - leftW - 1;
		const height = Math.max(10, Math.min(30, this.tui.terminal.rows - 6));
		const pad = (s: string, n: number) => {
			const c = truncateToWidth(s, n);
			return c + " ".repeat(Math.max(0, n - visibleWidth(c)));
		};
		const border = (s: string) => th.fg("border", s);
		const tasks = this.tasks();
		const cur = this.current();

		const left: string[] = tasks.map((t, i) => {
			const sel = i === this.selected;
			const line = `${statusIcon(t, th)} ${t.rec.id} ${t.rec.label}`;
			return sel ? th.fg("accent", `▶ ${line}`) : `  ${line}`;
		});
		if (left.length === 0) left.push(th.fg("dim", "  no tasks"));

		let right: string[] = [];
		if (cur) {
			const r = cur.rec;
			const cmd = r.rewritten ? `${r.requested} → ${r.executed}` : r.executed;
			const code = r.exitCode !== undefined ? ` exit ${r.exitCode}` : r.signal ? ` ${r.signal}` : "";
			right.push(th.bold(`${r.id} ${r.status}${code} · ${formatDuration((r.endedAt ?? Date.now()) - r.startedAt)}`));
			right.push(th.fg("dim", `$ ${cmd}`));
			right.push(th.fg("dim", `log: ${r.logPath}`));
			const log = cleanOutput(cur.running ? cur.ring.recent() : readTail(r.logPath, 64 * 1024)).split("\n");
			const room = height - right.length;
			const end = Math.max(0, log.length - (this.follow ? 0 : this.scroll));
			right = right.concat(log.slice(Math.max(0, end - room), end));
		}

		const lines: string[] = [];
		const title = ` Tasks ${th.fg("dim", `(${tasks.filter((t) => t.running).length} running)`)} `;
		lines.push(border(`╭${"─".repeat(inner)}╮`));
		lines.push(border("│") + pad(title, inner) + border("│"));
		for (let i = 0; i < height; i++) {
			lines.push(border("│") + pad(left[i] ?? "", leftW) + border("│") + pad(right[i] ?? "", rightW) + border("│"));
		}
		const keys = "↑↓ select · enter follow · k stop · i input · r restart · c copy path · x clear · esc close";
		lines.push(border("│") + pad(th.fg("dim", this.flash || keys), inner) + border("│"));
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.off();
		clearInterval(this.ticker);
	}
}

// ── notification renderer ──────────────────────────────────────

export function renderNotification(details: NotificationDetails | undefined, content: string, expanded: boolean, th: Theme): Component {
	const items = details?.items ?? [];
	if (expanded || items.length === 0) return new Text(th.fg("dim", content), 1, 0);
	const lines = items.map((i) => {
		const color = i.level === "error" ? "error" : i.level === "warning" ? "warning" : "success";
		const mark = i.kind === "event" ? "◉" : i.level === "error" ? "✗" : i.level === "warning" ? "!" : "✓";
		return `${th.fg(color, mark)} ${th.fg("dim", "task")} ${i.summary}`;
	});
	return new Text(lines.join("\n"), 1, 0);
}
