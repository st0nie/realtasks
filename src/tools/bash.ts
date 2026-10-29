// `bash` override: same name and core params as the built-in, plus task params.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, BashToolDetails } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import type { NotifyPolicy } from "../config.ts";
import { formatForModel, readRange } from "../output.ts";
import { recoverCommand } from "../rtk.ts";
import type { Runtime } from "../runtime.ts";
import type { Task } from "../task.ts";
import { cleanOutput, formatDuration, lastLines } from "../text.ts";
import type { ReadySpec } from "../types.ts";
import { Container, Text } from "@earendil-works/pi-tui";
import { humanMs } from "./render.ts";

const HINT_AFTER_MS = 2000;
const UPDATE_MS = 250;

export const bashParams = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Seconds to wait in the foreground (default 120, max 600). Still running then → it keeps running as a background task (never killed) and you are notified when it ends",
		}),
	),
	description: Type.Optional(
		Type.String({ description: "3–8 word label for the UI and notifications, e.g. 'run unit tests'" }),
	),
	run_in_background: Type.Optional(
		Type.Boolean({ description: "Start as a background task and return its id immediately" }),
	),
	ready: Type.Optional(
		Type.Object(
			{
				pattern: Type.Optional(Type.String({ description: "Regex on live output" })),
				port: Type.Optional(Type.Number({ description: "TCP port on localhost" })),
				url: Type.Optional(Type.String({ description: "HTTP URL; any status < 500 counts" })),
				timeout_ms: Type.Optional(Type.Number({ description: "Max wait (default 60000)" })),
			},
			{ description: "Implies run_in_background: wait until the service is ready, then return" },
		),
	),
	tty: Type.Optional(Type.Boolean({ description: "Run in a PTY (REPLs, prompts, TUIs); drive it with task_input" })),
	stdin: Type.Optional(Type.Boolean({ description: "Keep stdin open so task_input can write to it" })),
	notify: Type.Optional(
		Type.Union([Type.Literal("wake"), Type.Literal("passive"), Type.Literal("silent")], {
			description: "Completion delivery: wake (default) reacts, passive waits for the next turn, silent only shows a toast",
		}),
	),
	keep_alive: Type.Optional(Type.Boolean({ description: "Keep running after Pi exits; re-adopted next session" })),
	rtk: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("off")], {
			description: "off runs the command exactly as written, undoing an rtk rewrite",
		}),
	),
});

export interface BashParams {
	command: string;
	timeout?: number;
	description?: string;
	run_in_background?: boolean;
	ready?: ReadySpec;
	tty?: boolean;
	stdin?: boolean;
	notify?: NotifyPolicy;
	keep_alive?: boolean;
	rtk?: "auto" | "off";
}

/** Built-in bash details (so Pi's renderer works) plus task fields. */
export interface BashDetails extends BashToolDetails {
	taskId?: string;
	requested?: string;
	executed?: string;
	status?: string;
	/** Dim hint for the running row (partial results only; never sent to the model). */
	hint?: string;
}

type Result = AgentToolResult<BashDetails | undefined> & {
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};

function text(t: string): { type: "text"; text: string } {
	return { type: "text", text: t };
}

export function cmdLine(requested: string, executed: string): string {
	return requested === executed ? executed : `${requested} → ${executed}`;
}

/** Foreground window in ms: `timeout` seconds or the default, clamped to 1 s–maxTimeoutMs. */
export function foregroundWindowMs(timeout: number | undefined, defaultMs: number, maxMs: number): number {
	const ms = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : defaultMs;
	return Math.min(maxMs, Math.max(1000, ms));
}

/**
 * Hint line for a running foreground row: `ctrl+shift+b to background · auto in 1m48s`.
 * `key` is the registered background shortcut, if any. Undefined before HINT_AFTER_MS.
 */
export function backgroundHint(key: string | undefined, elapsedMs: number, windowMs: number): string | undefined {
	if (elapsedMs < HINT_AFTER_MS) return undefined;
	const left = humanMs(Math.max(1, Math.ceil((windowMs - elapsedMs) / 1000)) * 1000);
	return key ? `${key} to background · auto in ${left}` : `backgrounds in ${left}`;
}

export function registerBash(rt: Runtime): void {
	const builtin = createBashToolDefinition(process.cwd());
	rt.pi.registerTool({
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr (truncated to the last 2000 lines or 50KB). " +
			"Commands still running after timeout (seconds, default 120, max 600) are not killed: they become background tasks, you get a task id and are notified once when they end. " +
			"Use run_in_background for long jobs, ready for servers, tty/stdin for interactive programs.",
		promptSnippet: "Run shell commands; long ones become background tasks with a completion notification",
		promptGuidelines: [
			"Long or unbounded commands (test suites, builds, servers): use bash with run_in_background=true, or let them pass their timeout and move to the background. You will get one <task-notification> when the task ends; do not poll or sleep while waiting.",
			"Dev servers: bash with run_in_background=true and ready={port|url|pattern}; it returns once the server is ready.",
			"Read task output with task_output (use wait_ms to wait for exit or a grep match instead of sleep loops). Drive interactive tasks (tty/stdin) with task_input; stop with task_stop; list with task_list.",
			"For per-line event streams (tail -f, log watching) use the monitor tool, not bash.",
		],
		parameters: bashParams,
		outputSchema: builtin.outputSchema,
		renderCall: builtin.renderCall,
		renderResult(result, options, theme, context) {
			const c = builtin.renderResult!(result as AgentToolResult<BashToolDetails | undefined>, options, theme, context);
			const hint = (result.details as BashDetails | undefined)?.hint;
			// Pi's renderer clears and rebuilds the container each call, so the hint never stacks.
			if (options.isPartial && hint && c instanceof Container) c.addChild(new Text(`\n${theme.fg("dim", hint)}`, 0, 0));
			return c;
		},
		async execute(toolCallId, rawParams, signal, onUpdate, ctx): Promise<Result> {
			const p = rawParams as BashParams;
			rt.ctx = ctx;
			if (!p.command?.trim()) throw new Error("Command is empty.");
			// rtk contract 2: read the command here, after every tool_call handler ran.
			const rec = recoverCommand(toolCallId, p.command, () => ctx.sessionManager.getBranch());
			const wantsLive = Boolean(p.ready) || Boolean(p.tty);
			const passthrough =
				p.rtk === "off" ||
				(p.ready !== undefined && rt.cfg.rtkPassthroughFor.includes("ready")) ||
				(p.tty === true && rt.cfg.rtkPassthroughFor.includes("tty"));
			const executed = rec.rewritten && passthrough ? rec.requested : rec.executed;
			const rewritten = executed !== rec.requested;
			const notes: string[] = [];
			if (rec.rewritten && passthrough) notes.push(`(ran the original command; rtk rewrite skipped${wantsLive ? " for live output" : ""})`);
			if (p.rtk === "off" && !rec.known) notes.push("(rtk: off requested, but the original command was not recoverable; ran as received)");

			const background = Boolean(p.run_in_background) || p.ready !== undefined;
			if (background) rt.manager.assertCapacity();
			const windowMs = foregroundWindowMs(p.timeout, rt.cfg.defaultTimeoutMs, rt.cfg.maxTimeoutMs);
			const task = rt.manager.start({
				kind: "shell",
				requested: rec.requested,
				executed,
				rewritten,
				label: p.description,
				cwd: ctx.cwd,
				notify: p.notify ?? rt.cfg.defaultNotify,
				tty: Boolean(p.tty),
				stdin: Boolean(p.stdin),
				keepAlive: Boolean(p.keep_alive),
				ready: p.ready,
				toolCallId,
				foreground: !background,
			});
			const details: BashDetails = { taskId: task.rec.id, requested: rec.requested, executed };

			if (background) {
				if (!p.ready) {
					return {
						content: [text(withNotes(startedText(task), notes))],
						details: { ...details, status: "running" },
					};
				}
				return waitForReady(rt, task, p.ready, signal, details, notes);
			}
			return runForeground(rt, task, windowMs, signal, onUpdate, details, notes);
		},
	});
}

function withNotes(t: string, notes: string[]): string {
	return notes.length ? `${t}\n${notes.join("\n")}` : t;
}

function startedText(t: Task): string {
	return (
		`Started task ${t.rec.id} ("${t.rec.label}"): $ ${cmdLine(t.rec.requested, t.rec.executed)}\n` +
		`Log: ${t.rec.logPath}\nYou will be notified when it ends; read output with task_output.`
	);
}

async function waitForReady(
	rt: Runtime,
	task: Task,
	ready: ReadySpec,
	signal: AbortSignal | undefined,
	details: BashDetails,
	notes: string[],
): Promise<Result> {
	let res;
	try {
		res = await task.waitReady(ready, signal);
	} catch (e) {
		task.stop();
		throw new Error(`Invalid ready spec: ${(e as Error).message}`);
	}
	const out = formatForModel(task.ring.recent(), task.rec.logPath, 40).text;
	if (res.fired === "exit") {
		const info = await task.waitExit();
		rt.manager.reveal(task);
		const status = `Task ${task.rec.id} exited before it was ready (${info.status}${info.exitCode !== undefined ? `, exit ${info.exitCode}` : ""}).`;
		return {
			content: [text(withNotes(`${out || "(no output)"}\n\n${status}\nLog: ${task.rec.logPath}`, notes))],
			details: { ...details, status: info.status },
			isError: true,
		};
	}
	if (res.fired === "timeout") {
		armLateReady(rt, task, ready);
		return {
			content: [
				text(
					withNotes(
						`Task ${task.rec.id} is running but not ready after ${ready.timeout_ms ?? 60000}ms. ` +
							`You will get a one-time ready signal if it becomes ready.\n${out ? `Output so far:\n${out}\n` : ""}Log: ${task.rec.logPath}`,
						notes,
					),
				),
			],
			details: { ...details, status: "running" },
		};
	}
	return {
		content: [
			text(
				withNotes(
					`Task ${task.rec.id} is ready (${res.fired} matched). It keeps running in the background.\n` +
						`${out ? `Output so far:\n${out}\n` : ""}Log: ${task.rec.logPath}`,
					notes,
				),
			),
		],
		details: { ...details, status: "running" },
	};
}

/** After a ready timeout, keep watching and send one passive signal on success. */
function armLateReady(rt: Runtime, task: Task, ready: ReadySpec): void {
	void task.waitReady({ ...ready, timeout_ms: 24 * 3600_000 }).then((r) => {
		if (r.fired === "exit" || r.fired === "timeout") return;
		const s = (task.rec.signals ??= {});
		if (s.ready) return;
		s.ready = true;
		rt.manager.persist(task);
		rt.manager.notifier.queue({
			id: task.rec.id,
			kind: "signal",
			policy: "passive",
			block: `<task-notification id="${task.rec.id}" signal="ready">\n${task.rec.label} is ready (${r.fired} matched).\n</task-notification>`,
			summary: `${task.rec.id} ready`,
			level: "info",
		});
	});
}

async function runForeground(
	rt: Runtime,
	task: Task,
	windowMs: number,
	signal: AbortSignal | undefined,
	onUpdate: ((r: AgentToolResult<BashDetails | undefined>) => void) | undefined,
	details: BashDetails,
	notes: string[],
): Promise<Result> {
	const started = Date.now();
	let promoted: "timeout" | "shortcut" | undefined;
	let resolvePromote: (() => void) | undefined;
	const promoteP = new Promise<void>((r) => (resolvePromote = r));
	const promote = (why: "timeout" | "shortcut") => {
		if (promoted || !task.running) return;
		promoted = why;
		resolvePromote?.();
	};
	const toolCallId = task.rec.toolCallId ?? task.rec.id;
	rt.foreground.set(toolCallId, { task, promote });

	// Esc cancels (kills) unless the command was already promoted.
	const onAbort = () => {
		if (!promoted) task.stop("SIGTERM", 2000);
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	const windowTimer = setTimeout(() => promote("timeout"), windowMs);
	const updater = onUpdate
		? setInterval(() => {
				const elapsed = Date.now() - started;
				const tail = lastLines(cleanOutput(task.ring.recent()), 8);
				const head = `${cmdLine(task.rec.requested, task.rec.executed)} · ${formatDuration(elapsed)}`;
				const hint = backgroundHint(rt.backgroundKey, elapsed, windowMs);
				onUpdate({ content: [text(tail)], details: { ...details, status: head, hint } });
			}, UPDATE_MS)
		: undefined;

	try {
		await Promise.race([task.waitExit(), promoteP]);
	} finally {
		clearTimeout(windowTimer);
		if (updater) clearInterval(updater);
		signal?.removeEventListener("abort", onAbort);
		rt.foreground.delete(toolCallId);
	}

	if (task.running && promoted) {
		rt.manager.promote(task);
		const why = promoted === "timeout" ? `after its ${humanMs(windowMs)} timeout` : "by the user";
		const tail = formatForModel(task.ring.recent(), task.rec.logPath, 20).text;
		return {
			content: [
				text(
					withNotes(
						`Still running as task ${task.rec.id} ("${task.rec.label}"), backgrounded ${why}.\n` +
							`${tail ? `Last 20 lines:\n${tail}\n` : ""}Full log: ${task.rec.logPath}\n` +
							"You will be notified when it ends; read more with task_output.",
						notes,
					),
				),
			],
			details: { ...details, status: "running" },
		};
	}

	const info = await task.waitExit();
	const raw = readRange(task.rec.logPath, 0);
	rt.manager.discardForeground(task);
	return finishedResult(raw, info, Date.now() - started, details, notes, signal?.aborted === true);
}

function finishedResult(
	raw: string,
	info: { status: string; exitCode?: number; signal?: string },
	wallMs: number,
	details: BashDetails,
	notes: string[],
	aborted: boolean,
): Result {
	const cleaned = cleanOutput(raw);
	let fullOutputPath: string | undefined;
	const f = formatForModel(raw, "");
	let out = f.text;
	if (f.truncated) {
		fullOutputPath = join(tmpdir(), `pi-bash-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.log`);
		try {
			writeFileSync(fullOutputPath, cleaned, { mode: 0o600 });
		} catch {
			fullOutputPath = undefined;
		}
		out = out.replace(/Full output: \]$/, `Full output: ${fullOutputPath ?? "(unavailable)"}]`);
	}
	const body = out || "(no output)";
	const append = (s: string) => withNotes(`${out ? `${out}\n\n` : ""}${s}`, notes);
	if (aborted) throw new Error(append("Command aborted"));
	const code = info.exitCode ?? (info.signal ? 128 : 1);
	const structuredContent = {
		output: cleaned,
		truncated: f.truncated,
		...(fullOutputPath ? { full_output_path: fullOutputPath } : {}),
		exit_code: code,
		wall_time_seconds: Math.round(wallMs / 100) / 10,
	};
	const d = { ...details, fullOutputPath, status: info.status, taskId: undefined };
	if (info.status !== "completed") {
		const why = info.signal ? `Command terminated by ${info.signal}` : `Command exited with code ${code}`;
		return { content: [text(append(why))], details: d, structuredContent, isError: true };
	}
	return { content: [text(withNotes(body, notes))], details: d, structuredContent };
}
