// monitor: each stdout line matching `filter` becomes an event for the agent.

import { Type } from "typebox";
import type { Runtime } from "../runtime.ts";
import type { Task } from "../task.ts";
import { eventBlock, signalBlock } from "../notify.ts";
import { stripAnsi } from "../text.ts";

export const BATCH_MS = 2000;
const MAX_LINE = 500;

interface MonitorState {
	re?: RegExp;
	lines: string[];
	dropped: number;
	timer?: ReturnType<typeof setTimeout>;
	/** Event timestamps within the last minute. */
	window: number[];
}

export class MonitorHub {
	private readonly rt: Runtime;
	private readonly states = new Map<string, MonitorState>();

	constructor(rt: Runtime) {
		this.rt = rt;
	}

	track(t: Task): void {
		const f = t.rec.monitor?.filter;
		this.states.set(t.rec.id, { re: f ? new RegExp(f) : undefined, lines: [], dropped: 0, window: [] });
	}

	/** Called for every complete output line of a monitor task. */
	line(t: Task, raw: string, now = Date.now()): void {
		let st = this.states.get(t.rec.id);
		if (!st) {
			// Re-adopted monitor: rebuild state from the record.
			this.track(t);
			st = this.states.get(t.rec.id);
			if (!st) return;
		}
		if (t.floodStopped) return;
		const line = stripAnsi(raw).replace(/\r$/, "");
		if (st.re && !st.re.test(line)) return;
		const cap = t.rec.monitor?.maxEventsPerMin ?? 20;
		st.window = st.window.filter((ts) => now - ts < 60_000);
		if (st.window.length >= cap) {
			this.flood(t, st, cap);
			return;
		}
		st.window.push(now);
		st.lines.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
		st.timer ??= setTimeout(() => this.flush(t.rec.id), BATCH_MS);
		st.timer.unref?.();
	}

	flush(id: string): void {
		const st = this.states.get(id);
		const t = this.rt.manager.get(id);
		if (!st || !t) return;
		if (st.timer) clearTimeout(st.timer);
		st.timer = undefined;
		if (st.lines.length === 0) return;
		const lines = st.lines;
		st.lines = [];
		this.rt.manager.notifier.queue({
			id,
			kind: "event",
			policy: t.rec.notify,
			block: eventBlock(id, t.rec.label, lines, st.dropped),
			summary: `${id} ${lines.length} event${lines.length === 1 ? "" : "s"} · ${t.rec.label}`,
			level: "info",
		});
		st.dropped = 0;
	}

	private flood(t: Task, st: MonitorState, cap: number): void {
		st.dropped++;
		if (t.floodStopped) return;
		this.flush(t.rec.id);
		t.floodStopped = true;
		const s = (t.rec.signals ??= {});
		s.flood = true;
		this.rt.manager.persist(t);
		this.rt.manager.notifier.queue({
			id: t.rec.id,
			kind: "signal",
			policy: "wake",
			block: signalBlock(
				t.rec.id,
				"flood",
				`Monitor "${t.rec.label}" exceeded ${cap} events/min and was stopped. Narrow the filter or raise max_events_per_min.`,
			),
			summary: `${t.rec.id} monitor flooded, stopped`,
			level: "warning",
		});
		t.kill("SIGTERM", 2000);
	}

	/** Flush remaining events before the terminal notification. */
	end(t: Task): void {
		this.flush(t.rec.id);
		const st = this.states.get(t.rec.id);
		if (st?.timer) clearTimeout(st.timer);
		this.states.delete(t.rec.id);
	}
}

export function registerMonitor(rt: Runtime, hub: MonitorHub): void {
	rt.pi.registerTool({
		name: "monitor",
		label: "monitor",
		description:
			"Streaming watch: each stdout line (matching filter) of a command, or each new line appended to a file, becomes an event delivered to you, batched every 2s. " +
			"Use for tail -f style streams and log watching; use bash for one-shot commands. Stop it with task_stop.",
		promptSnippet: "Watch a command's output or a file; matching lines arrive as batched <task-event> messages",
		promptGuidelines: [
			"Use monitor (not bash) for unbounded streams like `tail -f` or log watching. Pipe stages must flush per line (grep --line-buffered).",
		],
		parameters: Type.Object({
			description: Type.String({ description: "What is being watched; shown on every event" }),
			command: Type.Optional(Type.String({ description: "Shell command whose stdout lines are events" })),
			file: Type.Optional(Type.String({ description: "File to follow (new lines only), no shell involved" })),
			filter: Type.Optional(Type.String({ description: "Regex; only matching lines become events" })),
			timeout_ms: Type.Optional(Type.Number({ description: "Stop after this long (default 300000); ignored when persistent" })),
			persistent: Type.Optional(Type.Boolean({ description: "Run for the whole session" })),
			max_events_per_min: Type.Optional(Type.Number({ description: "Above this the monitor stops itself (default 20)" })),
			notify: Type.Optional(
				Type.Union([Type.Literal("wake"), Type.Literal("passive"), Type.Literal("silent")], {
					description: "Event delivery policy (default wake)",
				}),
			),
		}),
		async execute(toolCallId, p, _s, _u, ctx) {
			rt.ctx = ctx;
			const hasCommand = Boolean(p.command);
			const hasFile = Boolean(p.file);
			if (hasCommand === hasFile) throw new Error("Give exactly one of command or file.");
			// Validate the filter up front so a bad regex fails the call, not the stream.
			if (p.filter) new RegExp(p.filter);
			rt.manager.assertCapacity();
			const persistent = Boolean(p.persistent);
			const timeoutMs = persistent ? undefined : Math.max(1000, p.timeout_ms ?? 300_000);
			const cmd = p.command ?? `tail -n 0 -F ${p.file}`;
			const t = rt.manager.start({
				kind: "monitor",
				requested: cmd,
				executed: cmd,
				rewritten: false,
				label: p.description,
				cwd: ctx.cwd,
				notify: p.notify ?? "wake",
				tty: false,
				stdin: false,
				keepAlive: false,
				timeoutMs,
				toolCallId,
				foreground: false,
				argv: p.file ? ["tail", "-n", "0", "-F", p.file] : undefined,
				monitor: {
					file: p.file,
					filter: p.filter,
					maxEventsPerMin: Math.max(1, p.max_events_per_min ?? 20),
					persistent,
					timeoutMs: timeoutMs ?? 0,
				},
			});
			hub.track(t);
			const until = persistent ? "for the session" : `for ${Math.round((timeoutMs ?? 0) / 1000)}s`;
			return {
				content: [
					{
						type: "text",
						text:
							`Monitor ${t.rec.id} ("${t.rec.label}") watching ${p.file ? `file ${p.file}` : `$ ${cmd}`} ${until}.` +
							`${p.filter ? ` Filter: /${p.filter}/.` : ""} Events arrive as <task-event> messages; stderr goes to ${t.rec.errPath}.`,
					},
				],
				details: { taskId: t.rec.id },
			};
		},
	});
}
