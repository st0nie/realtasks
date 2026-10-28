// TUI renderers for the task tools: name tasks by label, show human durations,
// and a live "waiting" line for task_output.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { Runtime } from "../runtime.ts";
import { formatDuration, oneLine } from "../text.ts";
import { spinnerFrame } from "../ui.ts";

/** Human duration for a millisecond cap: 600000 → "10m", 1500 → "1.5s". */
export function humanMs(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 10_000 && ms % 1000 !== 0) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	if (s % 3600 === 0) return `${s / 3600}h`;
	if (s % 60 === 0) return `${s / 60}m`;
	return formatDuration(ms);
}

/** `npm test (b7f3k9a2)`, or just the id when the task is unknown. */
export function taskName(rt: Runtime, id: unknown): string {
	if (typeof id !== "string" || !id) return "…";
	if (id === "all") return "all running tasks";
	try {
		const t = rt.manager.resolve(id);
		return `${oneLine(t.rec.label, 50)} (${t.rec.id})`;
	} catch {
		return id;
	}
}

/** Short visible preview of text sent with task_input. */
export function inputPreview(text: unknown, keys: unknown, eof: unknown): string {
	const parts: string[] = [];
	if (typeof text === "string") {
		const shown = text.replace(/\\r|\\n/g, "⏎").replace(/\\x03/g, "^C").replace(/\\x04/g, "^D");
		parts.push(`"${shown.length > 40 ? `${shown.slice(0, 39)}…` : shown}"`);
	}
	if (Array.isArray(keys) && keys.length) parts.push(`keys ${keys.join(" ")}`);
	if (eof === true) parts.push("EOF");
	return parts.join(" + ");
}

export function callLine(th: Theme, tool: string, name: string, extra?: string): Component {
	const head = th.fg("toolTitle", th.bold(tool));
	const tail = extra ? th.fg("muted", ` · ${extra}`) : "";
	return new Text(`${head} ${th.fg("accent", name)}${tail}`, 0, 0);
}

/** Details task_output sends while waiting (via onUpdate) and when done. */
export interface WaitDetails {
	phase: "waiting" | "done";
	label: string;
	id: string;
	waitedMs: number;
	capMs: number;
	last?: string;
	/** Why the wait ended: exit, grep, cap, abort, or none (no wait requested). */
	reason?: "exit" | "grep" | "cap" | "abort" | "none";
	status?: string;
	exitCode?: number;
}

export function waitLine(d: WaitDetails, th: Theme, now = Date.now()): string {
	const waited = formatDuration(d.waitedMs);
	if (d.phase === "waiting") {
		const tail = d.last ? th.fg("dim", ` │ ${oneLine(d.last, 80)}`) : "";
		return `${th.fg("accent", spinnerFrame(now))} waiting for ${d.label} ${th.fg("dim", `· ${waited} of ${humanMs(d.capMs)}`)}${tail}`;
	}
	const code = d.exitCode !== undefined ? ` exit ${d.exitCode}` : "";
	switch (d.reason) {
		case "exit": {
			const ok = d.status === "completed";
			const mark = ok ? th.fg("success", "✓") : th.fg("error", "✗");
			return `${mark} ${d.label} ${d.status}${code} ${th.fg("dim", `· waited ${waited}`)}`;
		}
		case "grep":
			return `${th.fg("success", "✓")} grep matched ${th.fg("dim", `· waited ${waited}`)}`;
		case "cap":
			return `${th.fg("warning", "…")} still running ${th.fg("dim", `· waited ${waited} (cap)`)}`;
		case "abort":
			return `${th.fg("dim", "■")} wait cancelled ${th.fg("dim", `· ${waited}`)}`;
		default:
			return `${th.fg("dim", "·")} ${d.label} ${d.status ?? ""}${code}`;
	}
}
