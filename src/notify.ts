// Exactly-once task notifications: coalescing, delivery policy, settle handling.

import type { NotifyPolicy } from "./config.ts";
import type { TaskRecord } from "./types.ts";
import { cleanOutput, formatDuration, lastLines } from "./text.ts";

export const NOTIFICATION_TYPE = "task-notification";
export const EVENT_TYPE = "task-event";
export const COALESCE_MS = 300;

export type Mode = "tui" | "rpc" | "json" | "print";

export interface NoticeItem {
	/** Task id; terminal notices are latched per id, events are not. */
	id: string;
	kind: "terminal" | "signal" | "event";
	policy: NotifyPolicy;
	block: string;
	/** Short one-line summary for UI toasts and the renderer. */
	summary: string;
	level: "info" | "warning" | "error";
}

export interface SendOptions {
	triggerTurn?: boolean;
	deliverAs?: "steer" | "followUp" | "nextTurn";
}

/** Opaque timer handle (Node Timeout in production, anything in tests). */
export type Timer = ReturnType<typeof setTimeout> | number | symbol;
export interface NotifierDeps {
	send(content: string, details: NotificationDetails, opts: SendOptions): void;
	toast(message: string, level: "info" | "warning" | "error"): void;
	mode(): Mode;
	isBusy(): boolean;
	/** True if the agent already learned the terminal state of this task. */
	isNotified(id: string): boolean;
	/** Flip the latch for a task (persisting it). */
	markNotified(id: string): void;
	setTimer?(fn: () => void, ms: number): Timer;
	clearTimer?(t: Timer): void;
}

export interface NotificationDetails {
	items: Array<{ id: string; kind: NoticeItem["kind"]; summary: string; level: NoticeItem["level"] }>;
}

/** Build the `<task-notification>` block for a terminal task. */
export function terminalBlock(rec: TaskRecord, rawTail: string, now = Date.now()): string {
	const dur = formatDuration((rec.endedAt ?? now) - rec.startedAt);
	const attrs = [`id="${rec.id}"`, `status="${rec.status}"`];
	if (rec.exitCode !== undefined) attrs.push(`exit="${rec.exitCode}"`);
	if (rec.signal) attrs.push(`signal="${rec.signal}"`);
	attrs.push(`duration="${dur}"`);
	const n = rec.status === "completed" ? 15 : 40;
	const tail = lastLines(cleanOutput(rawTail), n).trimEnd();
	const cmd = rec.rewritten && rec.executed !== rec.requested ? `${rec.requested} → ${rec.executed}` : rec.executed;
	const lines = [`<task-notification ${attrs.join(" ")}>`, `${rec.label} — $ ${cmd}`];
	if (tail) lines.push(tail);
	lines.push(`log: ${rec.logPath}`, "</task-notification>");
	return lines.join("\n");
}

export function terminalSummary(rec: TaskRecord, now = Date.now()): string {
	const dur = formatDuration((rec.endedAt ?? now) - rec.startedAt);
	const code = rec.exitCode !== undefined ? ` exit ${rec.exitCode}` : rec.signal ? ` ${rec.signal}` : "";
	return `${rec.id} ${rec.status}${code} ${dur} · ${rec.label}`;
}

export function terminalLevel(rec: TaskRecord): NoticeItem["level"] {
	if (rec.status === "completed" || rec.status === "stopped") return "info";
	if (rec.status === "lost") return "warning";
	return "error";
}

/** One-shot signal block (stall, ready, log cap, flood). */
export function signalBlock(id: string, signal: string, body: string): string {
	return `<task-notification id="${id}" signal="${signal}">\n${body}\n</task-notification>`;
}

export function eventBlock(id: string, label: string, lines: string[], dropped = 0): string {
	const extra = dropped > 0 ? ` dropped="${dropped}"` : "";
	return `<task-event id="${id}" count="${lines.length}"${extra}>\n${label}\n${lines.join("\n")}\n</task-event>`;
}

export class Notifier {
	private pending: NoticeItem[] = [];
	/** Wake items held for agent_before_settle in print/json mode or near settle. */
	private held: NoticeItem[] = [];
	private timer: Timer | undefined;
	private readonly deps: NotifierDeps;

	constructor(deps: NotifierDeps) {
		this.deps = deps;
	}

	queue(item: NoticeItem): void {
		this.pending.push(item);
		if (this.timer !== undefined) return;
		const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
		this.timer = set(() => {
			this.timer = undefined;
			this.flush();
		}, COALESCE_MS);
	}

	/** Drop the latch-suppressed items, then deliver the rest by policy. */
	flush(): void {
		this.cancelTimer();
		const items = this.takeLive(this.pending);
		this.pending = [];
		if (items.length === 0) return;
		const mode = this.deps.mode();
		const headless = mode === "print" || mode === "json";
		const wake = items.filter((i) => i.policy === "wake");
		const passive = items.filter((i) => i.policy === "passive");
		const silent = items.filter((i) => i.policy === "silent");

		for (const i of silent) this.toast(i);
		if (headless) {
			// Passive and silent are dropped in print/json mode; wake waits for settle.
			this.held.push(...wake);
			return;
		}
		if (wake.length) {
			this.deliver(wake, this.deps.isBusy() ? { deliverAs: "steer" } : { triggerTurn: true });
		}
		if (passive.length) this.deliver(passive, { deliverAs: "nextTurn" });
	}

	/**
	 * For agent_before_settle: take queued or held wake items as one message
	 * body, latched. Returns undefined when there is nothing to deliver.
	 */
	takeForSettle(): { content: string; details: NotificationDetails } | undefined {
		const pendingWake = this.pending.filter((i) => i.policy === "wake");
		this.pending = this.pending.filter((i) => i.policy !== "wake");
		if (this.pending.length === 0) this.cancelTimer();
		const items = this.takeLive([...this.held, ...pendingWake]);
		this.held = [];
		if (items.length === 0) return undefined;
		for (const i of items) this.latch(i);
		return this.compose(items);
	}

	hasHeldWake(): boolean {
		return this.held.length > 0 || this.pending.some((i) => i.policy === "wake");
	}

	/** Drop everything without sending (session shutdown). */
	cancel(): void {
		this.cancelTimer();
		this.pending = [];
		this.held = [];
	}

	private takeLive(items: NoticeItem[]): NoticeItem[] {
		const seen = new Set<string>();
		return items.filter((i) => {
			if (i.kind !== "terminal") return true;
			if (this.deps.isNotified(i.id) || seen.has(i.id)) return false;
			seen.add(i.id);
			return true;
		});
	}

	private latch(i: NoticeItem): void {
		if (i.kind === "terminal") this.deps.markNotified(i.id);
	}

	private compose(items: NoticeItem[]): { content: string; details: NotificationDetails } {
		return {
			content: items.map((i) => i.block).join("\n\n"),
			details: { items: items.map(({ id, kind, summary, level }) => ({ id, kind, summary, level })) },
		};
	}

	private deliver(items: NoticeItem[], opts: SendOptions): void {
		const { content, details } = this.compose(items);
		try {
			this.deps.send(content, details, opts);
		} catch {
			// Stale runtime: keep them for the next flush attempt.
			this.pending.unshift(...items);
			return;
		}
		for (const i of items) this.latch(i);
		for (const i of items) this.toast(i);
	}

	private toast(i: NoticeItem): void {
		try {
			this.deps.toast(i.summary, i.level);
		} catch {
			/* no UI */
		}
	}

	private cancelTimer(): void {
		if (this.timer === undefined) return;
		if (this.deps.clearTimer) this.deps.clearTimer(this.timer);
		else clearTimeout(this.timer as ReturnType<typeof setTimeout>);
		this.timer = undefined;
	}
}
