// task_output, task_input, task_stop, task_list.

import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fileSize, formatForModel, readRange } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Task } from "../task.ts";
import { cleanOutput, decodeEscapes, encodeKeys, formatDuration, lastLines, lastNonEmptyLine } from "../text.ts";
import { FRAME_MS } from "../ui.ts";
import { callLine, humanMs, inputPreview, taskName, waitLine, type WaitDetails } from "./render.ts";

/** task_input collects output for at most this long; task_output waits have no cap. */
const MAX_INPUT_WAIT_MS = 600_000;

type R = AgentToolResult<Record<string, unknown> | undefined>;

function text(t: string): R {
	return { content: [{ type: "text", text: t }], details: undefined };
}

export function statusLine(t: Task, now = Date.now()): string {
	const r = t.rec;
	const dur = formatDuration((r.endedAt ?? now) - r.startedAt);
	const code = r.exitCode !== undefined ? ` exit=${r.exitCode}` : r.signal ? ` signal=${r.signal}` : "";
	return `${r.id} [${r.kind}] ${r.status}${code} ${dur}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(done, ms);
		function done() {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Wait for exit, a grep match in new output, or the deadline. Calls `tick`
 * about once a second (and on new output) so the UI can show progress.
 */
async function waitFor(
	t: Task,
	ms: number,
	re: RegExp | undefined,
	from: number,
	signal: AbortSignal | undefined,
	tick: (waitedMs: number) => void,
): Promise<WaitDetails["reason"]> {
	const started = Date.now();
	const deadline = started + Math.max(0, ms);
	let reason: WaitDetails["reason"] = "cap";
	while (t.running && Date.now() < deadline) {
		if (signal?.aborted) {
			reason = "abort";
			break;
		}
		t.poll();
		if (re && re.test(cleanOutput(readRange(t.rec.logPath, from)))) {
			reason = "grep";
			break;
		}
		tick(Date.now() - started);
		await Promise.race([t.waitOutput(), sleep(Math.min(1000, deadline - Date.now()), signal)]);
	}
	if (!t.running && reason === "cap") reason = "exit";
	t.poll();
	return reason;
}

export function registerTaskTools(rt: Runtime): void {
	const m = rt.manager;

	rt.pi.registerTool({
		name: "task_output",
		label: "task_output",
		description:
			"Read new output and status of a background task. Repeated calls return only output since the last read. " +
			"wait_ms blocks until the task exits, a grep match appears, or the wait expires (use it instead of sleep loops).",
		promptSnippet: "Read a background task's new output and status (wait_ms waits for exit or a grep match)",
		parameters: Type.Object({
			id: Type.String({ description: "Task id (or unique prefix)" }),
			wait_ms: Type.Optional(Type.Number({ description: "Max wait in ms, no upper limit (e.g. 3600000 = 1h); returns early on exit, grep match, or Esc" })),
			from: Type.Optional(
				Type.Union([Type.Literal("cursor"), Type.Literal("start"), Type.Number()], {
					description: "cursor (default: since last read), start, or a byte offset",
				}),
			),
			grep: Type.Optional(Type.String({ description: "Regex; only matching lines are returned" })),
			tail_lines: Type.Optional(Type.Number({ description: "Max lines returned (default 200)" })),
		}),
		renderCall(args, th) {
			const cap = typeof args.wait_ms === "number" && args.wait_ms > 0 ? `wait up to ${humanMs(args.wait_ms)}` : undefined;
			const grep = typeof args.grep === "string" ? `grep /${args.grep}/` : undefined;
			return callLine(th, "task_output", taskName(rt, args.id), [cap, grep].filter(Boolean).join(" · ") || undefined);
		},
		renderResult(result, opts, th, context) {
			const d = result.details as WaitDetails | undefined;
			// Own redraw timer while waiting: onUpdate only fires about once a second,
			// so the spinner and clock would stutter at 1 fps without it.
			const state = context.state as { frameTimer?: ReturnType<typeof setInterval> };
			const waiting = d?.phase === "waiting" && opts.isPartial;
			if (waiting && !state.frameTimer) {
				state.frameTimer = setInterval(() => context.invalidate(), FRAME_MS);
				state.frameTimer.unref();
			} else if (!waiting && state.frameTimer) {
				clearInterval(state.frameTimer);
				state.frameTimer = undefined;
			}
			if (d?.phase === "waiting" || (d?.phase === "done" && !opts.expanded)) return new Text(waitLine(d, th), 0, 0);
			const body = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			return new Text(th.fg("toolOutput", opts.expanded ? body : lastLines(body, 6)), 0, 0);
		},
		async execute(_id, p, signal, onUpdate, ctx) {
			rt.ctx = ctx;
			const t = m.resolve(p.id);
			const re = p.grep ? new RegExp(p.grep) : undefined;
			const start = p.from === "start" ? 0 : typeof p.from === "number" ? Math.max(0, p.from) : t.agentCursor;
			const capMs = Math.max(0, p.wait_ms ?? 0);
			const waitStart = Date.now();
			const base = { label: t.rec.label, id: t.rec.id, capMs };
			let reason: WaitDetails["reason"] = "none";
			if (capMs > 0 && t.running) {
				reason = await waitFor(t, capMs, re, start, signal, (waitedMs) =>
					onUpdate?.({
						content: [{ type: "text", text: "" }],
						details: {
							...base,
							phase: "waiting",
							waitedMs,
							startedAt: waitStart,
							last: lastNonEmptyLine(cleanOutput(t.ring.recent().slice(-2048))),
						},
					}),
				);
			} else {
				t.poll();
				if (!t.running) reason = "exit";
			}
			const end = fileSize(t.rec.logPath);
			const raw = readRange(t.rec.logPath, Math.min(start, end), end);
			t.agentCursor = end;
			m.reveal(t);
			m.persist(t);
			const tailLines = Math.max(1, Math.min(2000, p.tail_lines ?? 200));
			let body: string;
			let header = "";
			if (re) {
				const lines = cleanOutput(raw).split("\n");
				const hits = lines.filter((l) => re.test(l));
				header = `grep: ${hits.length} of ${lines.length} new lines match\n`;
				body = formatForModel(hits.join("\n"), t.rec.logPath, tailLines).text;
			} else {
				body = formatForModel(raw, t.rec.logPath, tailLines).text;
			}
			const r = t.rec;
			const out = [
				statusLine(t),
				`label: ${r.label}`,
				r.rewritten ? `command: ${r.requested} → ${r.executed}` : `command: ${r.executed}`,
				`${header}${body ? `output:\n${body}` : "output: (no new output)"}`,
				`cursor: ${end} · log: ${r.logPath}`,
			];
			return {
				content: [{ type: "text", text: out.join("\n") }],
				details: {
					...base,
					phase: "done",
					waitedMs: Date.now() - waitStart,
					reason,
					status: r.status,
					exitCode: r.exitCode,
					cursor: end,
				},
			};
		},
	});

	rt.pi.registerTool({
		name: "task_input",
		label: "task_input",
		description:
			"Send input to a task started with tty: true or stdin: true, then return the output produced in a short window. " +
			"text decodes C escapes (\\r enter, \\x03 Ctrl-C, \\x04 EOF, \\x1b[A up); keys accepts names like ctrl-c, enter, up, tab.",
		promptSnippet: "Write to an interactive task's stdin/PTY (text with escapes, or key names)",
		parameters: Type.Object({
			id: Type.String({ description: "Task id" }),
			text: Type.Optional(Type.String({ description: "Text to send; C escapes are decoded" })),
			keys: Type.Optional(Type.Array(Type.String(), { description: "Key names: enter, tab, up, ctrl-c, alt-x, …" })),
			eof: Type.Optional(Type.Boolean({ description: "Close stdin (pipe) or send Ctrl-D (PTY) after writing" })),
			wait_ms: Type.Optional(Type.Number({ description: "How long to collect output after writing (default 750)" })),
		}),
		renderCall(args, th) {
			return callLine(th, "task_input", taskName(rt, args.id), inputPreview(args.text, args.keys, args.eof) || undefined);
		},
		async execute(_id, p, signal, _u, ctx) {
			rt.ctx = ctx;
			const t = m.resolve(p.id);
			if (!t.running) throw new Error(`Task ${t.rec.id} is not running (${t.rec.status}).`);
			if (p.text === undefined && !p.keys?.length && !p.eof) throw new Error("Nothing to send: give text, keys, or eof.");
			t.poll();
			const before = fileSize(t.rec.logPath);
			let data = p.text !== undefined ? decodeEscapes(p.text) : "";
			if (p.keys?.length) data += encodeKeys(p.keys);
			if (data) t.write(data);
			if (p.eof) t.endInput();
			await sleep(Math.min(MAX_INPUT_WAIT_MS, Math.max(0, p.wait_ms ?? 750)), signal);
			t.poll();
			const end = fileSize(t.rec.logPath);
			const raw = readRange(t.rec.logPath, Math.min(before, end), end);
			t.agentCursor = end;
			m.reveal(t);
			m.persist(t);
			const body = formatForModel(raw, t.rec.logPath, 200).text;
			return {
				content: [{ type: "text", text: `${statusLine(t)}\n${body ? `output:\n${body}` : "output: (none yet)"}` }],
				details: { id: t.rec.id, status: t.rec.status },
			};
		},
	});

	rt.pi.registerTool({
		name: "task_stop",
		label: "task_stop",
		description: "Stop a task (or all running tasks): signal the process group, then SIGKILL after grace_ms.",
		promptSnippet: "Stop a background task or all of them",
		parameters: Type.Object({
			id: Type.String({ description: 'Task id, or "all"' }),
			signal: Type.Optional(Type.String({ description: "Signal name (default SIGTERM)" })),
			grace_ms: Type.Optional(Type.Number({ description: "Wait before SIGKILL (default 3000)" })),
		}),
		renderCall(args, th) {
			const sig = typeof args.signal === "string" && args.signal.toUpperCase() !== "SIGTERM" ? args.signal.toUpperCase() : undefined;
			return callLine(th, "task_stop", taskName(rt, args.id), sig);
		},
		async execute(_id, p, _s, _u, ctx) {
			rt.ctx = ctx;
			const targets = p.id === "all" ? m.list().filter((t) => t.running) : [m.resolve(p.id)];
			if (targets.length === 0) return text("No running tasks.");
			const sig = (p.signal ?? "SIGTERM").toUpperCase();
			if (!/^SIG[A-Z0-9]+$/.test(sig)) throw new Error(`Invalid signal: ${p.signal}`);
			const grace = Math.max(0, Math.min(60_000, p.grace_ms ?? 3000));
			const blocks: string[] = [];
			for (const t of targets) {
				// The agent learns the outcome here; no notification follows.
				m.markNotified(t.rec.id);
				if (t.running) t.stop(sig as NodeJS.Signals, grace);
			}
			await Promise.all(targets.map((t) => Promise.race([t.waitExit(), sleep(grace + 2000)])));
			for (const t of targets) {
				const tail = lastLines(cleanOutput(t.ring.recent()), 20).trimEnd();
				blocks.push(`${statusLine(t)}${t.running ? " (still exiting)" : ""}\n${tail || "(no output)"}\nlog: ${t.rec.logPath}`);
			}
			return text(blocks.join("\n\n"));
		},
	});

	rt.pi.registerTool({
		name: "task_list",
		label: "task_list",
		description: "List background tasks: id, kind, status, age, label, and whether the outcome is unread.",
		promptSnippet: "List background tasks",
		parameters: Type.Object({
			status: Type.Optional(
				Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("all")], { description: "Filter (default all)" }),
			),
		}),
		async execute(_id, p, _s, _u, ctx) {
			rt.ctx = ctx;
			const filter = p.status ?? "all";
			const rows = m
				.list()
				.filter((t) => filter === "all" || (filter === "running" ? t.running : !t.running))
				.map((t) => {
					const unread = !t.running && !t.rec.notified ? " *unread*" : "";
					return `${statusLine(t)} · ${t.rec.label}${unread}`;
				});
			return text(rows.length ? rows.join("\n") : "No tasks.");
		},
	});
}
