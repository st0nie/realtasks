// Process spawning, liveness, and signalling. Linux and macOS only.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, constants as fsc, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
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
	};
	const [file, args] = o.argv ? [o.argv[0], o.argv.slice(1)] : ["/bin/sh", ["-c", WRAPPER]];

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

	const flags = fsc.O_WRONLY | fsc.O_CREAT | fsc.O_APPEND;
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

/** Opaque start-time token for PID-reuse checks; "" when unavailable. */
export function pidStartTime(pid: number): string {
	if (!(pid > 0)) return "";
	try {
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

/** Alive and still the same process we started. */
export function isSameProcess(pid: number, start: string): boolean {
	if (!isAlive(pid)) return false;
	return !start || pidStartTime(pid) === start;
}

export function killGroup(pgid: number, signal: NodeJS.Signals | number = "SIGTERM"): void {
	if (!(pgid > 0)) return;
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
