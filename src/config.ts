// Config from <agentDir>/realtasks/config.json, overridable per trusted project
// in .pi/realtasks/config.json.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
	shortcuts: { background: "ctrl+b", manager: "shift+down" },
	dir: "",
};

/** Smallest accepted values; anything lower falls back to the default (`resolveConfig`) or is refused (`/tasks settings`). */
export const MINIMUMS = {
	timeoutMs: 1000,
	maxRunning: 1,
	maxLogBytes: 64 * 1024,
	logRetentionDays: 0,
	stallSeconds: 1,
	printModeMaxWaitMs: 0,
} as const;

function num(v: unknown, d: number, min = 0): number {
	return typeof v === "number" && Number.isFinite(v) && v >= min ? v : d;
}

/** Merge a raw `tasks` settings object over defaults. Unknown/invalid values fall back. */
export function resolveConfig(raw: unknown): TasksConfig {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const sc = (r.shortcuts && typeof r.shortcuts === "object" ? r.shortcuts : {}) as Record<string, unknown>;
	const notify = r.defaultNotify;
	const maxTimeoutMs = Math.max(MINIMUMS.timeoutMs, num(r.maxTimeoutMs, DEFAULTS.maxTimeoutMs));
	return {
		defaultTimeoutMs: Math.min(maxTimeoutMs, Math.max(MINIMUMS.timeoutMs, num(r.defaultTimeoutMs, DEFAULTS.defaultTimeoutMs))),
		maxTimeoutMs,
		maxRunning: num(r.maxRunning, DEFAULTS.maxRunning, MINIMUMS.maxRunning),
		maxLogBytes: num(r.maxLogBytes, DEFAULTS.maxLogBytes, MINIMUMS.maxLogBytes),
		logRetentionDays: num(r.logRetentionDays, DEFAULTS.logRetentionDays, MINIMUMS.logRetentionDays),
		stallSeconds: num(r.stallSeconds, DEFAULTS.stallSeconds, MINIMUMS.stallSeconds),
		defaultNotify:
			notify === "wake" || notify === "passive" || notify === "silent" ? notify : DEFAULTS.defaultNotify,
		printModeMaxWaitMs: num(r.printModeMaxWaitMs, DEFAULTS.printModeMaxWaitMs, MINIMUMS.printModeMaxWaitMs),
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

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Drop keys whose value equals the default, so a saved file holds only what the
 * user changed. `shortcuts` is pruned per key; keys realtasks does not know stay.
 */
export function pruneDefaults(raw: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === "shortcuts" && value && typeof value === "object" && !Array.isArray(value)) {
			const sc = Object.fromEntries(
				Object.entries(value).filter(([k, v]) => !(k in DEFAULTS.shortcuts) || v !== DEFAULTS.shortcuts[k as keyof TasksConfig["shortcuts"]]),
			);
			if (Object.keys(sc).length > 0) out.shortcuts = sc;
			continue;
		}
		if (key === "rtkPassthroughFor" && Array.isArray(value)) {
			const asSet = (a: unknown[]) => JSON.stringify([...new Set(a.map(String))].toSorted((x, y) => x.localeCompare(y)));
			if (asSet(value) !== asSet(DEFAULTS.rtkPassthroughFor)) out[key] = value;
			continue;
		}
		if (key in DEFAULTS && key !== "dir" && sameJson(value, DEFAULTS[key as keyof TasksConfig])) continue;
		out[key] = value;
	}
	return out;
}

/** Replace a config file atomically: write a sibling temp file, then rename it over the target. */
export function writeConfigFile(path: string, raw: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}
