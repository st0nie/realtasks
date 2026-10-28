// Process spawning, liveness, and signalling. Linux, macOS and Windows (Git Bash).

import { spawn, spawnSync, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, constants as fsc, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

export const IS_WINDOWS = process.platform === "win32";
import { createRequire } from "node:module";

export interface PtyLike {
	pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
	onData(cb: (d: string) => void): { dispose(): void };
	onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

/** Live handles for one task. Parked on globalThis across /reload. */
export interface Handle {
	child?: ChildProcess;
	pty?: PtyLike;
	/** Removes listeners installed by the runtime that currently owns the handle. */
	detach?: () => void;
}

const HANDLES_KEY = Symbol.for("realtasks.handles");
type G = typeof globalThis & { [HANDLES_KEY]?: Map<string, Handle> };
/** Table that survives module reloads within one Node process. */
export function handleTable(): Map<string, Handle> {
	const g = globalThis as G;
	g[HANDLES_KEY] ??= new Map();
	return g[HANDLES_KEY];
}

/** Wrapper writes the real exit code to $PI_TASK_EXIT, then exits with it. */
const WRAPPER = `"$PI_TASK_SHELL" -c "$PI_TASK_CMD"; c=$?; printf %s "$c" > "$PI_TASK_EXIT"; exit "$c"`;

/**
 * Windows: MSYS/Cygwin programs cannot write to the append-only handle Node
 * creates for O_APPEND, so bash reopens the log in append mode itself. Its
 * handle works for MSYS and native children and survives rotation.
 */
const WRAPPER_WIN =
	`if [ -n "$PI_TASK_ERR" ]; then exec >>"$PI_TASK_LOG" 2>>"$PI_TASK_ERR"; else exec >>"$PI_TASK_LOG" 2>&1; fi; ` +
	// $BASH, not Git's native bin/bash.exe launcher: an MSYS-to-MSYS spawn keeps
	// O_APPEND, so the command keeps writing at the end after rotation.
	`"$BASH" -c "$PI_TASK_CMD"; c=$?; printf %s "$c" > "$PI_TASK_EXIT"; exit "$c"`;

export interface SpawnOpts {
	id: string;
	command: string;
	shell: string;
	cwd: string;
	logPath: string;
	errPath?: string;
	exitPath: string;
	stdin: boolean;
	tty: boolean;
	env?: NodeJS.ProcessEnv;
	/** Direct argv (no shell), used by file monitors. */
	argv?: string[];
	cols?: number;
	rows?: number;
	/** PTY output sink (PTY mode writes the log itself). */
	onPtyData?: (d: string) => void;
}

export interface Spawned {
	pid: number;
	handle: Handle;
}

interface PtySpawnOptions {
	name: string;
	cols: number;
	rows: number;
	cwd: string;
	env: NodeJS.ProcessEnv;
}
let ptyModule: { spawn: (file: string, args: string[], opts: PtySpawnOptions) => PtyLike } | null | undefined;
export function loadPty(): typeof ptyModule {
	if (ptyModule !== undefined) return ptyModule;
	try {
		const req = createRequire(import.meta.url);
		ptyModule = req("@lydell/node-pty");
	} catch {
		ptyModule = null;
	}
	return ptyModule;
}

export function spawnTask(o: SpawnOpts): Spawned {
	mkdirSync(dirname(o.logPath), { recursive: true });
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...o.env,
		PI_TASK_ID: o.id,
		PI_TASK_CMD: o.command,
		PI_TASK_SHELL: o.shell,
		PI_TASK_EXIT: o.exitPath,
		...(IS_WINDOWS
			? {
					PI_TASK_LOG: o.logPath,
					PI_TASK_ERR: o.errPath ?? "",
					// PTY output is written by the runtime, so only pipe mode reopens the log.
					PI_TASK_WRAPPER: o.tty ? WRAPPER : WRAPPER_WIN,
				}
			: {}),
	};
	// Windows has no /bin/sh: the resolved bash (Git Bash, MSYS2, Cygwin) runs the wrapper itself.
	// The wrapper goes through the env: node-pty's command-line quoting garbles its nested quotes.
	const [file, args] = o.argv
		? [o.argv[0], o.argv.slice(1)]
		: IS_WINDOWS
			? [o.shell, ["-c", 'eval "$PI_TASK_WRAPPER"']]
			: ["/bin/sh", ["-c", WRAPPER]];

	if (o.tty) {
		// PTY output is appended by the runtime; create the log now so readers never see ENOENT.
		closeSync(openSync(o.logPath, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_APPEND, 0o600));
		const pty = loadPty();
		if (!pty) throw new Error("tty: true needs the optional dependency @lydell/node-pty, which is not installed.");
		const p = pty.spawn(file, args, {
			name: "xterm-256color",
			cols: o.cols ?? 120,
			rows: o.rows ?? 40,
			cwd: o.cwd,
			env: { ...env, TERM: "xterm-256color" },
		});
		return { pid: p.pid, handle: { pty: p } };
	}

	// Windows: no O_APPEND (see WRAPPER_WIN); this handle only catches wrapper errors before its exec.
	const flags = fsc.O_WRONLY | fsc.O_CREAT | (IS_WINDOWS && !o.argv ? 0 : fsc.O_APPEND);
	const outFd = openSync(o.logPath, flags, 0o600);
	let errFd = outFd;
	try {
		if (o.errPath) errFd = openSync(o.errPath, flags, 0o600);
	} catch (e) {
		closeSync(outFd);
		throw e;
	}
	let child: ChildProcess;
	try {
		child = spawn(file, args, {
			cwd: o.cwd,
			detached: true,
			windowsHide: true,
			stdio: [o.stdin ? "pipe" : "ignore", outFd, errFd],
			env: { ...env, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb" },
		});
	} finally {
		closeSync(outFd);
		if (errFd !== outFd) closeSync(errFd);
	}
	// Never let an async spawn error crash Pi.
	child.on("error", () => {});
	child.stdin?.on("error", () => {});
	if (!child.pid) throw new Error(`Failed to spawn: ${file}`);
	child.unref();
	return { pid: child.pid, handle: { child } };
}

function powershellPath(): string {
	return join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function startTimeArgs(pid: number): string[] {
	return [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
	];
}

/**
 * Opaque start-time token for PID-reuse checks; "" when unavailable.
 * On Windows this runs PowerShell (~300 ms): use pidStartTimeAsync after spawn.
 */
export function pidStartTime(pid: number): string {
	if (!(pid > 0)) return "";
	try {
		if (IS_WINDOWS) {
			return execFileSync(powershellPath(), startTimeArgs(pid), {
				encoding: "utf8",
				timeout: 10_000,
				windowsHide: true,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		}
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// Field 22 (starttime); fields after the last ')' start at field 3.
			const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			return rest[19] ?? "";
		}
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
	} catch {
		return "";
	}
}

export function isAlive(pid: number): boolean {
	if (!(pid > 0)) return false;
	try {
		process.kill(pid, 0);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	// A zombie still answers signal 0.
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** pidStartTime without blocking the event loop (Windows); synchronous elsewhere, where it is cheap. */
export function pidStartTimeAsync(pid: number): Promise<string> {
	if (!IS_WINDOWS || !(pid > 0)) return Promise.resolve(pidStartTime(pid));
	return new Promise((resolve) => {
		execFile(
			powershellPath(),
			startTimeArgs(pid),
			{ encoding: "utf8", timeout: 10_000, windowsHide: true },
			(err, stdout) => resolve(err ? "" : String(stdout).trim()),
		);
	});
}

/** Alive and still the same process we started. */
export function isSameProcess(pid: number, start: string): boolean {
	if (!isAlive(pid)) return false;
	return !start || pidStartTime(pid) === start;
}

/**
 * Periodic liveness check for a task whose identity was already verified at
 * re-adoption. Windows skips the (slow) start-time lookup.
 */
export function isStillRunning(pid: number, start: string): boolean {
	return IS_WINDOWS ? isAlive(pid) : isSameProcess(pid, start);
}

function taskkillPath(): string {
	return join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

/**
 * Prints the Windows pid of every MSYS process whose environment holds
 * PI_TASK_ID=$1. Builtins only (no forks), so it takes about 100 ms.
 */
const FIND_TASK_PROCS = `want="PI_TASK_ID=$1"
for d in /proc/[0-9]*; do
	[ "\${d#/proc/}" = "$$" ] && continue
	[ -r "$d/environ" ] || continue
	while IFS= read -r -d '' e; do
		if [ "$e" = "$want" ]; then
			read -r w < "$d/winpid" && echo "$w"
			break
		fi
	done < "$d/environ" 2>/dev/null
done`;

function scanArgs(taskId: string): { file: string; args: string[]; env: NodeJS.ProcessEnv } | undefined {
	let shell: string;
	try {
		shell = getShellConfig().shell;
	} catch {
		return undefined;
	}
	// The script travels in the env, like the task wrapper (no command-line quoting).
	return {
		file: shell,
		args: ["-c", 'eval "$PI_TASK_SCAN"', "realtasks-scan", taskId],
		env: { ...process.env, PI_TASK_SCAN: FIND_TASK_PROCS },
	};
}

function parsePids(out: string): string[] {
	return out.split(/\s+/).filter((s) => /^\d+$/.test(s));
}

function taskkillArgs(pids: string[]): string[] {
	return ["/F", "/T", ...pids.flatMap((p) => ["/PID", p])];
}

/**
 * Windows: force-kill the root and every MSYS process carrying the task's
 * PI_TASK_ID (/T adds native programs below them), then once more for anything
 * forked meanwhile. taskkill /T alone misses them: MSYS exec breaks the Windows
 * parent chain. Never graceful: taskkill without /F cannot end console programs,
 * and ending only the root orphans the rest.
 */
function killTaskWindows(pid: number, taskId: string | undefined, sync: boolean): void {
	const opts = { windowsHide: true } as const;
	const scan = taskId ? scanArgs(taskId) : undefined;
	if (sync) {
		try {
			for (let round = 0; round < 2; round++) {
				const found = scan
					? parsePids(
							spawnSync(scan.file, scan.args, { ...opts, env: scan.env, encoding: "utf8", timeout: 5000 }).stdout ?? "",
						)
					: [];
				const pids = round === 0 ? [String(pid), ...found] : found;
				if (pids.length === 0) break;
				spawnSync(taskkillPath(), taskkillArgs(pids), { ...opts, stdio: "ignore", timeout: 5000 });
			}
		} catch {
			/* gone */
		}
		return;
	}
	const kill = (pids: string[], then?: () => void) => {
		if (pids.length === 0) return then?.();
		try {
			const c = spawn(taskkillPath(), taskkillArgs(pids), { ...opts, stdio: "ignore" });
			c.once("error", () => then?.());
			c.once("exit", () => then?.());
		} catch {
			then?.();
		}
	};
	const find = (cb: (pids: string[]) => void) => {
		if (!scan) return cb([]);
		execFile(scan.file, scan.args, { ...opts, env: scan.env, encoding: "utf8", timeout: 5000 }, (_err, stdout) =>
			cb(parsePids(String(stdout ?? ""))),
		);
	};
	find((first) => kill([String(pid), ...first], () => find((second) => kill(second))));
}

/**
 * Signal a task's process group (Unix), or force-kill all of the task's
 * processes (Windows, any signal; `taskId` finds them). `sync` is for exit
 * paths, where async work never runs.
 */
export function killGroup(
	pgid: number,
	signal: NodeJS.Signals | number = "SIGTERM",
	sync = false,
	taskId?: string,
): void {
	if (!(pgid > 0)) return;
	if (IS_WINDOWS) {
		killTaskWindows(pgid, taskId, sync);
		return;
	}
	try {
		process.kill(-pgid, signal);
	} catch {
		try {
			process.kill(pgid, signal);
		} catch {
			/* already gone */
		}
	}
}

export function readExitFile(path: string): number | undefined {
	try {
		const t = readFileSync(path, "utf8").trim();
		if (!t) return undefined;
		const n = Number(t);
		return Number.isInteger(n) ? n : undefined;
	} catch {
		return undefined;
	}
}
