// Config from <agentDir>/realtasks/config.json, overridable per trusted project
// in .pi/realtasks/config.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type NotifyPolicy = "wake" | "passive" | "silent";

export interface TasksConfig {
	/** Foreground window for `bash` without `timeout` (Claude Code's BASH_DEFAULT_TIMEOUT_MS). */
	defaultTimeoutMs: number;
	/** Upper clamp for `timeout` (Claude Code's BASH_MAX_TIMEOUT_MS). */
	maxTimeoutMs: number;
	maxRunning: number;
	maxLogBytes: number;
	logRetentionDays: number;
	stallSeconds: number;
	defaultNotify: NotifyPolicy;
	printModeMaxWaitMs: number;
	rtkPassthroughFor: string[];
	shortcuts: { background: string; manager: string };
	dir: string;
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export const DEFAULTS: TasksConfig = {
	defaultTimeoutMs: 120_000,
	maxTimeoutMs: 600_000,
	maxRunning: 16,
	maxLogBytes: 50 * 1024 * 1024,
	logRetentionDays: 7,
	stallSeconds: 45,
	defaultNotify: "wake",
	printModeMaxWaitMs: 600_000,
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
	const maxTimeoutMs = Math.max(1000, num(r.maxTimeoutMs, DEFAULTS.maxTimeoutMs));
	return {
		defaultTimeoutMs: Math.min(maxTimeoutMs, Math.max(1000, num(r.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs))),
		maxTimeoutMs,
		maxRunning: num(r.maxRunning, DEFAULTS.maxRunning, 1),
		maxLogBytes: num(r.maxLogBytes, DEFAULTS.maxLogBytes, 64 * 1024),
		logRetentionDays: num(r.logRetentionDays, DEFAULTS.logRetentionDays),
		stallSeconds: num(r.stallSeconds, DEFAULTS.stallSeconds, 1),
		defaultNotify:
			notify === "wake" || notify === "passive" || notify === "silent" ? notify : DEFAULTS.defaultNotify,
		printModeMaxWaitMs: num(r.printModeMaxWaitMs, DEFAULTS.printModeMaxWaitMs),
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

export function userConfigPath(): string {
	return join(agentDir(), "realtasks", "config.json");
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "realtasks", "config.json");
}

/** Read one config file. Missing → {}; invalid JSON or non-object → warning and {}. */
export function readConfigFile(path: string): { raw: Record<string, unknown>; warning?: string } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { raw: {} };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { raw: parsed as Record<string, unknown> };
		return { raw: {}, warning: `realtasks: ${path} must contain a JSON object; ignored.` };
	} catch (e) {
		return { raw: {}, warning: `realtasks: ${path} is not valid JSON (${(e as Error).message}); ignored.` };
	}
}

/** Project keys override user keys; `shortcuts` merges per key. */
export function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base, ...over };
	const a = base.shortcuts;
	const b = over.shortcuts;
	if (a && typeof a === "object" && b && typeof b === "object") out.shortcuts = { ...a, ...b };
	return out;
}

/** Load user config, then the project override when the project is trusted. */
export function loadConfig(cwd: string, trusted: boolean): { config: TasksConfig; warnings: string[] } {
	const warnings: string[] = [];
	const user = readConfigFile(userConfigPath());
	if (user.warning) warnings.push(user.warning);
	let raw = user.raw;
	if (trusted) {
		const proj = readConfigFile(projectConfigPath(cwd));
		if (proj.warning) warnings.push(proj.warning);
		raw = mergeConfig(raw, proj.raw);
	}
	return { config: resolveConfig(raw), warnings };
}
