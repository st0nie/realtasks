// Task registry: spawn, persist, notify, re-adopt, stop.

import { rmSync } from "node:fs";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import type { TasksConfig, NotifyPolicy } from "./config.ts";
import { Notifier, type NotifierDeps, terminalBlock, terminalLevel, terminalSummary, signalBlock } from "./notify.ts";
import { handleTable, isSameProcess, pidStartTime, readExitFile, spawnTask } from "./proc.ts";
import { fileSize, readTail } from "./output.ts";
import { readRecords, taskPaths, writeRecord } from "./store.ts";
import { Task, type ExitInfo } from "./task.ts";
import { cleanOutput, lastNonEmptyLine, looksLikePrompt, newTaskId, oneLine } from "./text.ts";
import type { MonitorSpec, ReadySpec, TaskKind, TaskRecord, TaskStatus } from "./types.ts";

export interface StartOptions {
	kind: TaskKind;
	requested: string;
	executed: string;
	rewritten: boolean;
	label?: string;
	cwd: string;
	notify: NotifyPolicy;
	tty: boolean;
	stdin: boolean;
	keepAlive: boolean;
	timeoutMs?: number;
	ready?: ReadySpec;
	monitor?: MonitorSpec;
	toolCallId?: string;
	foreground: boolean;
	userStarted?: boolean;
	env?: NodeJS.ProcessEnv;
	argv?: string[];
}

export interface ManagerEvents {
	/** Something changed that the UI should redraw. */
	changed(): void;
	/** Monitor line hook (installed by the monitor tool). */
	monitorLine?(task: Task, line: string): void;
	/** Monitor exited: flush its pending events before the terminal notice. */
	monitorEnd?(task: Task): void;
	/** Task started or ended; mirrored into the transcript with pi.appendEntry. */
	lifecycle?(entry: LifecycleEntry): void;
}

export type LifecycleEntry =
	| { event: "started"; id: string; kind: TaskKind; label: string; command: string }
	| { event: "ended"; id: string; status: TaskStatus; exitCode?: number; signal?: string };

export class TaskManager {
	readonly tasks = new Map<string, Task>();
	readonly notifier: Notifier;
	cfg: TasksConfig;
	sessionId = "";
	private stallTimer: ReturnType<typeof setInterval> | undefined;
	private readonly events: ManagerEvents;
	private exitHook: (() => void) | undefined;

	constructor(cfg: TasksConfig, notifierDeps: Omit<NotifierDeps, "isNotified" | "markNotified">, events: ManagerEvents) {
		this.cfg = cfg;
		this.events = events;
		this.notifier = new Notifier({
			...notifierDeps,
			isNotified: (id) => this.tasks.get(id)?.rec.notified ?? true,
			markNotified: (id) => this.markNotified(id),
		});
	}

	// ── lifecycle ───────────────────────────────────────────────

	/** Bind to a session: re-adopt its running tasks and arm the stall check. */
	attach(sessionId: string): { adopted: Task[]; finished: Task[] } {
		this.sessionId = sessionId;
		const adopted: Task[] = [];
		const finished: Task[] = [];
		const handles = handleTable();
		for (const rec of readRecords(this.cfg.dir, sessionId)) {
			if (this.tasks.has(rec.id)) continue;
			if (rec.status !== "running") {
				// Terminal tasks stay listed for the session.
				const t = new Task(rec, {}, this.hooks(), this.cfg.maxLogBytes);
				this.tasks.set(rec.id, t);
				t.markDone(rec);
				continue;
			}
			const handle = handles.get(rec.id) ?? {};
			handles.delete(rec.id);
			const t = new Task({ ...rec, foreground: false }, handle, this.hooks(), this.cfg.maxLogBytes);
			t.agentCursor = rec.cursor ?? 0;
			this.tasks.set(rec.id, t);
			const alive = handle.child || handle.pty ? true : isSameProcess(rec.pid, rec.pidStart);
			if (alive) {
				t.start(fileSize(rec.logPath));
				// Re-seed the ring so previews and stall checks work immediately.
				t.ring.append(readTail(rec.logPath, 64 * 1024));
				adopted.push(t);
			} else {
				const code = readExitFile(rec.exitPath);
				// Passive: the agent may be on another topic now.
				t.rec.notify = t.rec.notify === "silent" ? "silent" : "passive";
				t.forceFinish(code !== undefined ? classifyCode(code) : { status: "lost" });
				finished.push(t);
			}
		}
		this.armStallCheck();
		this.installExitHook();
		this.events.changed();
		return { adopted, finished };
	}

	/**
	 * Release the session. `reload` parks live handles for the next runtime;
	 * otherwise non-keep_alive tasks are stopped.
	 */
	detach(reason: "reload" | "quit" | "switch"): void {
		if (this.stallTimer) clearInterval(this.stallTimer);
		this.stallTimer = undefined;
		this.notifier.cancel();
		const handles = handleTable();
		for (const t of this.tasks.values()) {
			if (!t.running) continue;
			if (reason === "reload") {
				handles.set(t.rec.id, t.park());
				this.persist(t);
				continue;
			}
			if (t.rec.keepAlive) {
				t.park();
				this.persist(t);
				continue;
			}
			t.stop("SIGTERM", 0);
			// Record the stop now and quietly: this runtime is going away.
			t.rec.status = "stopped";
			t.rec.endedAt = Date.now();
			t.rec.notified = true;
			t.markDone(t.rec);
			this.persist(t);
			if (!t.rec.foreground) this.emitEnded(t);
		}
		this.tasks.clear();
		this.removeExitHook();
	}

	/** Synchronous kill of every non-keep_alive task (process exit). */
	private installExitHook(): void {
		if (this.exitHook) return;
		this.exitHook = () => {
			for (const t of this.tasks.values()) {
				if (!t.running || t.rec.keepAlive) continue;
				try {
					process.kill(-t.rec.pgid, "SIGKILL");
				} catch {
					/* gone */
				}
				t.rec.status = "stopped";
				t.rec.endedAt = Date.now();
				try {
					writeRecord(this.cfg.dir, t.rec);
				} catch {
					/* best effort */
				}
			}
		};
		process.on("exit", this.exitHook);
	}

	private removeExitHook(): void {
		if (!this.exitHook) return;
		process.off("exit", this.exitHook);
		this.exitHook = undefined;
	}

	/** Install monitor line/end hooks (the monitor hub is created after the manager). */
	setMonitorHooks(line: NonNullable<ManagerEvents["monitorLine"]>, end: NonNullable<ManagerEvents["monitorEnd"]>): void {
		this.events.monitorLine = line;
		this.events.monitorEnd = end;
	}

	/** Install the transcript mirror (set by the extension entry point). */
	setLifecycleHook(fn: NonNullable<ManagerEvents["lifecycle"]>): void {
		this.events.lifecycle = fn;
	}

	// ── spawning ────────────────────────────────────────────────

	runningCount(): number {
		let n = 0;
		for (const t of this.tasks.values()) if (t.running && !t.rec.foreground) n++;
		return n;
	}

	assertCapacity(): void {
		if (this.runningCount() < this.cfg.maxRunning) return;
		const list = [...this.tasks.values()]
			.filter((t) => t.running && !t.rec.foreground)
			.map((t) => `  ${t.rec.id} ${t.rec.label}`)
			.join("\n");
		throw new Error(
			`Too many running tasks (${this.cfg.maxRunning}). Stop one with task_stop first:\n${list}`,
		);
	}

	start(o: StartOptions): Task {
		if (!this.sessionId) throw new Error("realtasks: no active session");
		const id = newTaskId(o.kind === "monitor" ? "m" : "b");
		const paths = taskPaths(this.cfg.dir, this.sessionId, id);
		const shell = getShellConfig().shell;
		const spawned = spawnTask({
			id,
			command: o.executed,
			shell,
			cwd: o.cwd,
			logPath: paths.log,
			errPath: o.kind === "monitor" ? paths.err : undefined,
			exitPath: paths.exit,
			stdin: o.stdin && !o.tty,
			tty: o.tty,
			env: o.env,
			argv: o.argv,
		});
		const rec: TaskRecord = {
			id,
			kind: o.kind,
			label: o.label?.trim() || oneLine(o.requested),
			requested: o.requested,
			executed: o.executed,
			rewritten: o.rewritten,
			cwd: o.cwd,
			pid: spawned.pid,
			pgid: spawned.pid,
			pidStart: pidStartTime(spawned.pid),
			startedAt: Date.now(),
			status: "running",
			logPath: paths.log,
			errPath: o.kind === "monitor" ? paths.err : undefined,
			exitPath: paths.exit,
			notify: o.notify,
			notified: false,
			tty: o.tty,
			stdin: o.stdin || o.tty,
			keepAlive: o.keepAlive,
			toolCallId: o.toolCallId,
			sessionId: this.sessionId,
			foreground: o.foreground,
			timeoutMs: o.timeoutMs,
			ready: o.ready,
			monitor: o.monitor,
			signals: {},
			userStarted: o.userStarted,
		};
		const t = new Task(rec, spawned.handle, this.hooks(), this.cfg.maxLogBytes);
		this.tasks.set(id, t);
		t.start(0);
		this.persist(t);
		if (!o.foreground) this.emitStarted(t);
		this.events.changed();
		return t;
	}

	/** A foreground command became a background task. */
	promote(t: Task): void {
		if (!t.rec.foreground) return;
		t.rec.foreground = false;
		this.emitStarted(t);
		this.persist(t);
		this.events.changed();
	}

	/**
	 * Foreground command finished inside the yield window: the bash result is
	 * the outcome, so no task exists. Remove it and its files.
	 */
	discardForeground(t: Task): void {
		t.rec.notified = true;
		this.tasks.delete(t.rec.id);
		const p = taskPaths(this.cfg.dir, t.rec.sessionId, t.rec.id);
		for (const f of [p.json, p.log, p.exit, p.err]) rmSync(f, { force: true });
		this.events.changed();
	}

	get(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	/** Look up by id or unique prefix. */
	resolve(id: string): Task {
		const exact = this.tasks.get(id);
		if (exact) return exact;
		const matches = [...this.tasks.values()].filter((t) => t.rec.id.startsWith(id));
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) throw new Error(`Ambiguous task id "${id}": ${matches.map((t) => t.rec.id).join(", ")}`);
		throw new Error(`No task "${id}". Known: ${[...this.tasks.keys()].join(", ") || "none"}`);
	}

	list(): Task[] {
		return [...this.tasks.values()].filter((t) => !t.rec.foreground).sort((a, b) => a.rec.startedAt - b.rec.startedAt);
	}

	foregroundTasks(): Task[] {
		return [...this.tasks.values()].filter((t) => t.rec.foreground && t.running);
	}

	clearFinished(): number {
		let n = 0;
		for (const [id, t] of this.tasks) {
			if (!t.running && !t.rec.foreground) {
				this.tasks.delete(id);
				n++;
			}
		}
		this.events.changed();
		return n;
	}

	markNotified(id: string): void {
		const t = this.tasks.get(id);
		if (!t || t.rec.notified) return;
		t.rec.notified = true;
		this.persist(t);
		this.events.changed();
	}

	/** Agent learned the terminal state (task_output, task_stop, bash result). */
	reveal(t: Task): void {
		if (!t.running) this.markNotified(t.rec.id);
	}

	persist(t: Task): void {
		t.rec.cursor = t.agentCursor;
		try {
			writeRecord(this.cfg.dir, t.rec);
		} catch {
			/* disk full or dir removed; in-memory state still works */
		}
	}

	// ── hooks ───────────────────────────────────────────────────

	private hooks() {
		return {
			onOutput: (task: Task, chunk: string) => {
				if (task.rec.kind === "monitor") {
					// Chunks may split a line: carry the partial tail to the next chunk.
					const parts = (task.partialLine + chunk).split("\n");
					task.partialLine = parts.pop() ?? "";
					for (const line of parts) if (line) this.events.monitorLine?.(task, line);
				}
				this.events.changed();
			},
			onExit: (task: Task, info: ExitInfo) => this.onExit(task, info),
			onRotate: (task: Task, dropped: number) => {
				const s = (task.rec.signals ??= {});
				if (s.logCap) return;
				s.logCap = true;
				this.persist(task);
				if (task.rec.foreground) return;
				this.notifier.queue({
					id: task.rec.id,
					kind: "signal",
					policy: "passive",
					block: signalBlock(
						task.rec.id,
						"log_cap",
						`Log passed ${Math.round(this.cfg.maxLogBytes / 1048576)} MB; dropped the oldest ${Math.round(dropped / 1024)} KB. The task keeps running.`,
					),
					summary: `${task.rec.id} log rotated`,
					level: "warning",
				});
			},
		};
	}

	private onExit(t: Task, info: ExitInfo): void {
		if (t.rec.kind === "monitor") {
			if (t.partialLine) this.events.monitorLine?.(t, t.partialLine);
			t.partialLine = "";
			this.events.monitorEnd?.(t);
		}
		t.rec.status = info.status;
		t.rec.exitCode = info.exitCode;
		t.rec.signal = info.signal;
		t.rec.endedAt = Date.now();
		this.persist(t);
		this.events.changed();
		// Foreground commands report through the bash result instead.
		if (t.rec.foreground) return;
		this.emitEnded(t);
		if (t.rec.notified) return;
		this.notifier.queue({
			id: t.rec.id,
			kind: "terminal",
			policy: t.rec.userStarted ? "silent" : t.rec.notify,
			block: terminalBlock(t.rec, t.ring.recent()),
			summary: terminalSummary(t.rec),
			level: terminalLevel(t.rec),
		});
	}

	private emitStarted(t: Task): void {
		const r = t.rec;
		this.events.lifecycle?.({ event: "started", id: r.id, kind: r.kind, label: r.label, command: r.executed });
	}

	private emitEnded(t: Task): void {
		const r = t.rec;
		this.events.lifecycle?.({ event: "ended", id: r.id, status: r.status, exitCode: r.exitCode, signal: r.signal });
	}

	// ── stall detection ─────────────────────────────────────────

	private armStallCheck(): void {
		if (this.stallTimer) return;
		this.stallTimer = setInterval(() => this.checkStalls(), 5000);
		this.stallTimer.unref();
	}

	checkStalls(now = Date.now()): void {
		for (const t of this.tasks.values()) {
			const r = t.rec;
			if (!t.running || r.foreground || r.tty || r.rewritten || r.kind !== "shell" || r.signals?.stall) continue;
			if (now - t.lastOutputAt < this.cfg.stallSeconds * 1000) continue;
			const last = lastNonEmptyLine(cleanOutput(t.ring.recent()));
			if (!looksLikePrompt(last)) continue;
			(r.signals ??= {}).stall = true;
			this.persist(t);
			const hint = t.hasInput
				? `Answer with task_input id="${r.id}", or stop it with task_stop.`
				: `It has no stdin; stop it with task_stop and rerun non-interactively (or with stdin: true / tty: true).`;
			this.notifier.queue({
				id: r.id,
				kind: "signal",
				policy: "passive",
				block: signalBlock(r.id, "stall", `No output for ${this.cfg.stallSeconds}s; last line looks like a prompt:\n${last}\n${hint}`),
				summary: `${r.id} may be waiting for input`,
				level: "warning",
			});
		}
	}
}

export function classifyCode(code: number): ExitInfo {
	return code === 0 ? { status: "completed", exitCode: 0 } : { status: "failed", exitCode: code };
}
