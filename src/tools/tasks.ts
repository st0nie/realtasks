// task_output, task_wait, task_input, task_stop, task_list.

import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fileSize, formatForModel, formatLineRange, type LineRange, parseLineRange, readRange } from "../output.ts";
import type { Runtime } from "../runtime.ts";
import type { Task } from "../task.ts";
import { cleanOutput, decodeEscapes, encodeKeys, formatDuration, lastLines, lastNonEmptyLine, userRegex } from "../text.ts";
import { FRAME_MS } from "../ui.ts";
import { callLine, humanMs, inputPreview, type ReadDetails, statusRow, taskName, waitLine, type WaitDetails } from "./render.ts";

/** task_input collects output for at most this long; task_wait waits have no cap. */
const MAX_INPUT_WAIT_MS = 600_000;

type R = AgentToolResult<Record<string, unknown> | undefined>;

function text(t: string): R {
	return { content: [{ type: "text", text: t }], details: undefined };
}

function statusLine(t: Task, now = Date.now()): string {
	const r = t.rec;
	const dur = formatDuration((r.endedAt ?? now) - r.startedAt);
	let code = "";
	if (r.exitCode !== undefined) code = ` exit=${r.exitCode}`;
	else if (r.signal) code = ` signal=${r.signal}`;
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
 * Wait until any task exits, `until` matches one's output after the agent's
 * cursor, or the deadline. Calls `tick` about once a second (and on new output)
 * so the UI can show progress. `on` is the task the wait ended on.
 */
async function waitFor(
	tasks: Task[],
	ms: number,
	until: RegExp | undefined,
	signal: AbortSignal | undefined,
	tick: (waitedMs: number) => void,
): Promise<{ reason: NonNullable<WaitDetails["reason"]>; on?: Task }> {
	const started = Date.now();
	const deadline = started + Math.max(0, ms);
	while (tasks.every((t) => t.running) && Date.now() < deadline) {
		if (signal?.aborted) return { reason: "abort" };
		for (const t of tasks) {
			t.poll();
			if (until?.test(cleanOutput(readRange(t.rec.logPath, t.agentCursor)))) return { reason: "match", on: t };
		}
		tick(Date.now() - started);
		await Promise.race([...tasks.map((t) => t.waitOutput()), sleep(Math.min(1000, deadline - Date.now()), signal)]);
	}
	const ended = tasks.find((t) => !t.running);
	return ended ? { reason: "exit", on: ended } : { reason: "timeout" };
}

export function registerTaskTools(rt: Runtime): void {
	const m = rt.manager;

	/**
	 * One task's status and output in the model-facing format. Reads from
	 * `from` to the end of the log (or the numbered `range`). Unless `peek`, the
	 * agent's cursor moves to the end and a terminal task counts as notified.
	 */
	function readTask(t: Task, o: { from: number; re?: RegExp; range?: LineRange; peek: boolean; tailLines: number }): string {
		const r = t.rec;
		const end = fileSize(r.logPath);
		let header = "";
		let body: string;
		if (o.range) {
			({ header, text: body } = formatLineRange(readRange(r.logPath, 0, end), o.range, o.re, o.tailLines));
		} else {
			const raw = readRange(r.logPath, Math.min(o.from, end), end);
			if (o.re) {
				const re = o.re;
				const lines = cleanOutput(raw).split("\n");
				const hits = lines.filter((l) => re.test(l));
				header = `grep: ${hits.length} of ${lines.length} lines match\n`;
				body = formatForModel(hits.join("\n"), r.logPath, o.tailLines).text;
			} else {
				body = formatForModel(raw, r.logPath, o.tailLines).text;
			}
		}
		if (!o.peek) {
			t.agentCursor = end;
			m.reveal(t);
			m.persist(t);
		}
		const empty = o.range ? "output: (no lines)" : "output: (no new output)";
		const cursor = o.peek ? `cursor: ${t.agentCursor} (unchanged by peek; log end ${end})` : `cursor: ${end}`;
		return [
			statusLine(t),
			`label: ${r.label}`,
			r.rewritten ? `command: ${r.requested} → ${r.executed}` : `command: ${r.executed}`,
			`${header}${body ? `output:\n${body}` : empty}`,
			`${cursor} · log: ${r.logPath}`,
		].join("\n");
	}

	const tailLimit = (n: number | undefined) => Math.max(1, Math.min(2000, n ?? 200));

	rt.pi.registerTool({
		name: "task_output",
		label: "task_output",
		description:
			"Read a background task's output and status. Never blocks. Repeated calls return only output since the last read. " +
			"peek: true only looks: the read cursor stays and the completion notification still arrives. " +
			"lines reads numbered lines of the whole log (also a peek). To block until a task ends, use task_wait.",
		promptSnippet: "Read a background task's output and status; never blocks (peek/lines look without side effects)",
		parameters: Type.Object({
			id: Type.String({ description: "Task id (or unique prefix)" }),
			from: Type.Optional(
				Type.Union([Type.Literal("cursor"), Type.Literal("start"), Type.Number()], {
					description: "cursor (default: since last read), start, or a byte offset",
				}),
			),
			grep: Type.Optional(Type.String({ description: "Regex; only matching lines are returned" })),
			tail_lines: Type.Optional(Type.Number({ description: "Max lines returned (default 200)" })),
			peek: Type.Optional(Type.Boolean({ description: "Look without moving the read cursor or using up the completion notification" })),
			lines: Type.Optional(
				Type.String({ description: 'Numbered line range of the whole log: "120-260", "120-" (to the end) or "120"; implies peek, ignores from' }),
			),
		}),
		renderCall(args, th) {
			let mode: string | undefined;
			if (typeof args.lines === "string") mode = `lines ${args.lines}`;
			else if (args.peek === true) mode = "peek";
			const grep = typeof args.grep === "string" ? `grep /${args.grep}/` : undefined;
			return callLine(th, "task_output", taskName(rt, args.id), [mode, grep].filter(Boolean).join(" · ") || undefined);
		},
		renderResult(result, opts, th) {
			const d = result.details as ReadDetails | undefined;
			if (d && !opts.expanded) return new Text(statusRow(d, th), 0, 0);
			const body = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			return new Text(th.fg("toolOutput", opts.expanded ? body : lastLines(body, 6)), 0, 0);
		},
		async execute(_id, p, _signal, _onUpdate, ctx) {
			rt.ctx = ctx;
			const t = m.resolve(p.id);
			const range = p.lines === undefined ? undefined : parseLineRange(p.lines);
			t.poll();
			let from = t.agentCursor;
			if (p.from === "start") from = 0;
			else if (typeof p.from === "number") from = Math.max(0, p.from);
			const peek = p.peek === true || range !== undefined;
			const out = readTask(t, { from, re: p.grep ? userRegex(p.grep) : undefined, range, peek, tailLines: tailLimit(p.tail_lines) });
			const r = t.rec;
			const details: ReadDetails = { label: r.label, id: r.id, status: r.status, exitCode: r.exitCode, cursor: t.agentCursor };
			return { content: [{ type: "text", text: out }], details };
		},
	});

	rt.pi.registerTool({
		name: "task_wait",
		label: "task_wait",
		description:
			"Block until a background task exits, its output matches `until`, or timeout_ms passes; then return its status and new output (like task_output). " +
			"With several ids, returns as soon as any of them is done. Last resort: only when nothing else is left to do. " +
			"The completion notification already tells you when a task ends, and monitor reports matching lines without blocking.",
		promptSnippet: "Block until a task exits or its output matches; only when nothing else is left to do",
		parameters: Type.Object({
			id: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
				description: "Task id (or unique prefix), or an array of ids (returns when any is done)",
			}),
			timeout_ms: Type.Number({ description: "Max wait in ms, no upper limit (e.g. 3600000 = 1h); returns early on exit, match, or Esc" }),
			until: Type.Optional(Type.String({ description: "Regex; a match in a task's new output ends the wait" })),
			tail_lines: Type.Optional(Type.Number({ description: "Max output lines returned per task (default 200)" })),
		}),
		renderCall(args, th) {
			const ids: unknown[] = Array.isArray(args.id) ? args.id : [args.id];
			const cap = typeof args.timeout_ms === "number" ? `up to ${humanMs(Math.max(0, args.timeout_ms))}` : undefined;
			const until = typeof args.until === "string" ? `until /${args.until}/` : undefined;
			const names = ids.map((id) => taskName(rt, id)).join(", ");
			return callLine(th, "task_wait", names, [cap, until].filter(Boolean).join(" · ") || undefined);
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
			if (d && (d.phase === "waiting" || !opts.expanded)) return new Text(waitLine(d, th), 0, 0);
			const body = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			return new Text(th.fg("toolOutput", opts.expanded ? body : lastLines(body, 6)), 0, 0);
		},
		async execute(_id, p, signal, onUpdate, ctx) {
			rt.ctx = ctx;
			const tasks = [...new Set((Array.isArray(p.id) ? p.id : [p.id]).map((id) => m.resolve(id)))];
			if (tasks.length === 0) throw new Error("task_wait needs at least one task id");
			const capMs = Math.max(0, p.timeout_ms);
			const waitStart = Date.now();
			const labels = tasks.map((t) => t.rec.label).join(", ");
			const ids = tasks.map((t) => t.rec.id).join(", ");
			const { reason, on } = await waitFor(tasks, capMs, p.until ? userRegex(p.until) : undefined, signal, (waitedMs) => {
				const live = tasks.find((t) => t.running) ?? tasks[0];
				onUpdate?.({
					content: [{ type: "text", text: "" }],
					details: {
						phase: "waiting",
						label: labels,
						id: ids,
						capMs,
						waitedMs,
						startedAt: waitStart,
						last: lastNonEmptyLine(cleanOutput(live.ring.recent().slice(-2048))),
					} satisfies WaitDetails,
				});
			});
			const waitedMs = Date.now() - waitStart;
			for (const t of tasks) t.poll();
			let head = `timed out after ${formatDuration(waitedMs)}`;
			if (on) head = `woke on: ${on.rec.id} (${reason})`;
			else if (reason === "abort") head = `cancelled after ${formatDuration(waitedMs)}`;
			const tailLines = tailLimit(p.tail_lines);
			const blocks = tasks.map((t) => readTask(t, { from: t.agentCursor, peek: false, tailLines }));
			const main = (on ?? tasks[0]).rec;
			const details: WaitDetails = {
				phase: "done",
				label: on ? main.label : labels,
				id: main.id,
				capMs,
				waitedMs,
				reason,
				status: main.status,
				exitCode: main.exitCode,
			};
			return { content: [{ type: "text", text: [head, ...blocks].join("\n\n") }], details };
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
