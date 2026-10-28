// Settings under `tasks` in ~/.pi/agent/settings.json, overridable per project.

import { join } from "node:path";
import { homedir } from "node:os";

export type NotifyPolicy = "wake" | "passive" | "silent";

export interface TasksConfig {
	yieldMs: number;
	maxRunning: number;
	maxLogBytes: number;
	logRetentionDays: number;
	stallSeconds: number;
	defaultNotify: NotifyPolicy;
	printModeMaxWaitMs: number;
	steerPromotes: boolean;
	rtkPassthroughFor: string[];
	shortcuts: { background: string; manager: string };
	dir: string;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export const DEFAULTS: TasksConfig = {
	yieldMs: 30_000,
	maxRunning: 16,
	maxLogBytes: 50 * 1024 * 1024,
	logRetentionDays: 7,
	stallSeconds: 45,
	defaultNotify: "wake",
	printModeMaxWaitMs: 600_000,
	steerPromotes: true,
	rtkPassthroughFor: ["ready", "tty"],
	shortcuts: { background: "ctrl+shift+b", manager: "shift+down" },
	dir: "",
};

function num(v: unknown, d: number, min = 0): number {
	return typeof v === "number" && Number.isFinite(v) && v >= min ? v : d;
}

/** Merge a raw `tasks` settings object over defaults. Unknown/invalid values fall back. */
export function resolveConfig(raw: unknown): TasksConfig {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const sc = (r.shortcuts && typeof r.shortcuts === "object" ? r.shortcuts : {}) as Record<string, unknown>;
	const notify = r.defaultNotify;
	return {
		yieldMs: Math.min(600_000, Math.max(1000, num(r.yieldMs, DEFAULTS.yieldMs))),
		maxRunning: num(r.maxRunning, DEFAULTS.maxRunning, 1),
		maxLogBytes: num(r.maxLogBytes, DEFAULTS.maxLogBytes, 64 * 1024),
		logRetentionDays: num(r.logRetentionDays, DEFAULTS.logRetentionDays),
		stallSeconds: num(r.stallSeconds, DEFAULTS.stallSeconds, 1),
		defaultNotify:
			notify === "wake" || notify === "passive" || notify === "silent" ? notify : DEFAULTS.defaultNotify,
		printModeMaxWaitMs: num(r.printModeMaxWaitMs, DEFAULTS.printModeMaxWaitMs),
		steerPromotes: typeof r.steerPromotes === "boolean" ? r.steerPromotes : DEFAULTS.steerPromotes,
		rtkPassthroughFor: Array.isArray(r.rtkPassthroughFor)
			? r.rtkPassthroughFor.filter((x): x is string => typeof x === "string")
			: DEFAULTS.rtkPassthroughFor,
		shortcuts: {
			background: typeof sc.background === "string" ? sc.background : DEFAULTS.shortcuts.background,
			manager: typeof sc.manager === "string" ? sc.manager : DEFAULTS.shortcuts.manager,
		},
		dir: typeof r.dir === "string" && r.dir ? r.dir : join(agentDir(), "tasks"),
	};
}
