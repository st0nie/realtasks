// Task record shapes shared across modules.

import type { NotifyPolicy } from "./config.ts";

export type TaskKind = "shell" | "monitor";
export type TaskStatus = "running" | "completed" | "failed" | "timed_out" | "stopped" | "lost";

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "failed", "timed_out", "stopped", "lost"]);

export interface ReadySpec {
	pattern?: string;
	port?: number;
	url?: string;
	timeout_ms?: number;
}

export interface MonitorSpec {
	file?: string;
	filter?: string;
	maxEventsPerMin: number;
	persistent: boolean;
	timeoutMs: number;
}

/** Persisted to `<taskId>.json` on every state change. */
export interface TaskRecord {
	id: string;
	kind: TaskKind;
	label: string;
	/** Command as the model wrote it (before any rtk rewrite). */
	requested: string;
	/** Command that actually ran. */
	executed: string;
	/** Whether `executed` came from an rtk rewrite. */
	rewritten: boolean;
	cwd: string;
	pid: number;
	pgid: number;
	/** Opaque process start-time token used to guard against PID reuse. */
	pidStart: string;
	startedAt: number;
	endedAt?: number;
	status: TaskStatus;
	exitCode?: number;
	signal?: string;
	logPath: string;
	errPath?: string;
	exitPath: string;
	notify: NotifyPolicy;
	notified: boolean;
	tty: boolean;
	stdin: boolean;
	keepAlive: boolean;
	toolCallId?: string;
	sessionId: string;
	/** True while `bash` is still awaiting this process (not yet a task). */
	foreground: boolean;
	timeoutMs?: number;
	ready?: ReadySpec;
	monitor?: MonitorSpec;
	/** Set once a one-shot signal was sent. */
	signals?: { stall?: boolean; ready?: boolean; logCap?: boolean; flood?: boolean };
	/** Agent's task_output byte cursor into the current log file. */
	cursor?: number;
	/** Set when the user (not the agent) started it via /bg <cmd>. */
	userStarted?: boolean;
}
