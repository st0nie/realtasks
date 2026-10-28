// One live task: log tailing, exit detection, readiness, stop/timeout.

import { appendFileSync, ftruncateSync, openSync, closeSync, writeSync } from "node:fs";
import { connect } from "node:net";
import type { Handle } from "./proc.ts";
import { isSameProcess, killGroup, readExitFile } from "./proc.ts";
import { fileSize, OutputRing, readRange } from "./output.ts";
import { stripAnsi } from "./text.ts";
import type { ReadySpec, TaskRecord, TaskStatus } from "./types.ts";

export const TAIL_POLL_MS = 250;
export const LIVENESS_POLL_MS = 1000;

export interface ExitInfo {
	status: TaskStatus;
	exitCode?: number;
	signal?: string;
}

export interface ReadyResult {
	fired: "pattern" | "port" | "url" | "exit" | "timeout";
}

export interface TaskHooks {
	/** New log bytes (already appended to the ring). */
	onOutput(task: Task, chunk: string): void;
	onExit(task: Task, info: ExitInfo): void;
	/** Log grew past the cap and was rotated; `dropped` bytes were removed from the head. */
	onRotate(task: Task, dropped: number): void;
}

export class Task {
	rec: TaskRecord;
	handle: Handle;
	ring = new OutputRing();
	/** Bytes of the log consumed by the tailer (absolute offset in the current file). */
	tailOffset = 0;
	/** Agent's task_output cursor. */
	agentCursor = 0;
	/** Bytes removed from the log head by rotation; offsets are file-relative. */
	rotatedBytes = 0;
	lastOutputAt = Date.now();
	uiSeen = false;
	stopRequested = false;
	timedOut = false;
	floodStopped = false;
	/** Monitor line buffer: bytes after the last newline seen. */
	partialLine = "";
	private exitInfo: ExitInfo | undefined;
	private exitWaiters: Array<(i: ExitInfo) => void> = [];
	private outputWaiters: Array<() => void> = [];
	/** Intervals and timeouts; Node's clearInterval clears both. */
	private timers: NodeJS.Timeout[] = [];
	private killTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly hooks: TaskHooks;
	private readonly maxLogBytes: number;

	constructor(rec: TaskRecord, handle: Handle, hooks: TaskHooks, maxLogBytes: number) {
		this.rec = rec;
		this.handle = handle;
		this.hooks = hooks;
		this.maxLogBytes = maxLogBytes;
	}

	get running(): boolean {
		return this.exitInfo === undefined;
	}

	/** Start tailing and exit detection. `fromOffset` resumes a re-adopted task. */
	start(fromOffset = 0): void {
		this.tailOffset = fromOffset;
		const { child, pty } = this.handle;
		if (pty) {
			const d1 = pty.onData((d) => {
				try {
					appendFileSync(this.rec.logPath, d);
				} catch {
					/* log dir gone */
				}
			});
			const d2 = pty.onExit((e) => {
				const sig = e.signal ? String(e.signal) : undefined;
				this.finishFromCode(e.exitCode, sig);
			});
			this.handle.detach = () => {
				d1.dispose();
				d2.dispose();
			};
		} else if (child) {
			const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
				this.finishFromCode(code ?? undefined, signal ?? undefined);
			child.on("exit", onExit);
			this.handle.detach = () => child.off("exit", onExit);
			// Already exited before we attached (reload handoff race).
			if (child.exitCode !== null || child.signalCode !== null) {
				queueMicrotask(() => onExit(child.exitCode, child.signalCode));
			}
		} else {
			this.timers.push(setInterval(() => this.checkLiveness(), LIVENESS_POLL_MS));
		}
		this.timers.push(setInterval(() => this.poll(), TAIL_POLL_MS));
		for (const t of this.timers) t.unref();
		if (this.rec.timeoutMs) this.armTimeout(this.rec.timeoutMs - (Date.now() - this.rec.startedAt));
	}

	/** Detach listeners and timers; leave the process running (reload). */
	park(): Handle {
		this.stopTimers();
		this.handle.detach?.();
		this.handle.detach = undefined;
		return this.handle;
	}

	stopTimers(): void {
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		if (this.killTimer) clearTimeout(this.killTimer);
	}

	/** Read new log bytes now. */
	poll(): void {
		const path = this.rec.logPath;
		let size = fileSize(path);
		if (size > this.maxLogBytes) size = this.rotate(size);
		if (size < this.tailOffset) this.tailOffset = size;
		if (size === this.tailOffset) return;
		const chunk = readRange(path, this.tailOffset, size);
		this.tailOffset = size;
		if (!chunk) return;
		this.lastOutputAt = Date.now();
		this.ring.append(chunk);
		this.hooks.onOutput(this, chunk);
		const w = this.outputWaiters;
		this.outputWaiters = [];
		for (const f of w) f();
	}

	/** Keep the last half of the log; shift every offset accordingly. */
	private rotate(size: number): number {
		const keep = Math.floor(this.maxLogBytes / 2);
		const dropped = size - keep;
		const tail = Buffer.from(readRange(this.rec.logPath, dropped, size), "utf8");
		try {
			const fd = openSync(this.rec.logPath, "r+");
			try {
				ftruncateSync(fd, 0);
				writeSync(fd, tail, 0, tail.length, 0);
			} finally {
				closeSync(fd);
			}
		} catch {
			return size;
		}
		this.rotatedBytes += dropped;
		this.tailOffset = Math.max(0, this.tailOffset - dropped);
		this.agentCursor = Math.max(0, this.agentCursor - dropped);
		this.hooks.onRotate(this, dropped);
		return fileSize(this.rec.logPath);
	}

	private checkLiveness(): void {
		if (!this.running) return;
		if (isSameProcess(this.rec.pid, this.rec.pidStart)) return;
		const code = readExitFile(this.rec.exitPath);
		if (code !== undefined) this.finish(this.classify(code, undefined));
		else this.finish({ status: this.stopRequested ? "stopped" : this.timedOut ? "timed_out" : "lost" });
	}

	private finishFromCode(code: number | undefined, signal: string | undefined): void {
		const fileCode = readExitFile(this.rec.exitPath);
		this.finish(this.classify(fileCode ?? code, fileCode !== undefined ? undefined : signal));
	}

	private classify(code: number | undefined, signal: string | undefined): ExitInfo {
		if (this.timedOut) return { status: "timed_out", exitCode: code, signal };
		if (this.stopRequested || this.floodStopped) return { status: "stopped", exitCode: code, signal };
		if (signal) return { status: "failed", signal };
		if (code === 0) return { status: "completed", exitCode: 0 };
		return { status: "failed", exitCode: code };
	}

	private finish(info: ExitInfo): void {
		if (!this.running) return;
		this.poll();
		this.exitInfo = info;
		this.stopTimers();
		this.handle.detach?.();
		this.hooks.onExit(this, info);
		const w = this.exitWaiters;
		this.exitWaiters = [];
		for (const f of w) f(info);
		const o = this.outputWaiters;
		this.outputWaiters = [];
		for (const f of o) f();
	}

	/** Finish now with a known outcome (re-adoption found it dead); runs hooks once. */
	forceFinish(info: ExitInfo): void {
		this.finish(info);
	}

	/** Mark terminal from a stored record without running hooks (listing only, or quiet stop). */
	markDone(rec: Pick<TaskRecord, "status" | "exitCode" | "signal">): void {
		if (!this.running) return;
		this.exitInfo = { status: rec.status, exitCode: rec.exitCode, signal: rec.signal };
		this.stopTimers();
		this.handle.detach?.();
		this.handle.detach = undefined;
		const w = this.exitWaiters;
		this.exitWaiters = [];
		for (const f of w) f(this.exitInfo);
		const o = this.outputWaiters;
		this.outputWaiters = [];
		for (const f of o) f();
	}

	waitExit(): Promise<ExitInfo> {
		if (this.exitInfo) return Promise.resolve(this.exitInfo);
		return new Promise((r) => this.exitWaiters.push(r));
	}

	/** Resolves on the next output chunk or exit. */
	waitOutput(): Promise<void> {
		if (!this.running) return Promise.resolve();
		return new Promise((r) => this.outputWaiters.push(r));
	}

	/** SIGTERM (or `signal`) the group, SIGKILL after `graceMs`. */
	kill(signal: NodeJS.Signals = "SIGTERM", graceMs = 3000): void {
		if (!this.running) return;
		killGroup(this.rec.pgid, signal);
		if (this.handle.pty) {
			try {
				this.handle.pty.kill(signal);
			} catch {
				/* gone */
			}
		}
		if (this.killTimer) clearTimeout(this.killTimer);
		this.killTimer = setTimeout(() => {
			if (this.running) killGroup(this.rec.pgid, "SIGKILL");
		}, graceMs);
		this.killTimer.unref();
	}

	stop(signal: NodeJS.Signals = "SIGTERM", graceMs = 3000): void {
		this.stopRequested = true;
		this.kill(signal, graceMs);
	}

	armTimeout(ms: number): void {
		const t = setTimeout(
			() => {
				if (!this.running) return;
				this.timedOut = true;
				this.kill("SIGTERM", 3000);
			},
			Math.max(0, ms),
		);
		t.unref();
		this.timers.push(t);
	}

	/** Write to stdin pipe or PTY. */
	write(data: string): void {
		const { child, pty } = this.handle;
		if (pty) return pty.write(data);
		if (child?.stdin && !child.stdin.destroyed && child.stdin.writable) {
			child.stdin.write(data);
			return;
		}
		throw new Error(
			`Task ${this.rec.id} has no open input. Start it with \`stdin: true\` or \`tty: true\` to send input.`,
		);
	}

	/** Close stdin (pipe) or send EOF (PTY). */
	endInput(): void {
		const { child, pty } = this.handle;
		if (pty) return pty.write("\x04");
		if (child?.stdin && !child.stdin.destroyed) {
			child.stdin.end();
			return;
		}
		throw new Error(`Task ${this.rec.id} has no open input.`);
	}

	get hasInput(): boolean {
		const { child, pty } = this.handle;
		return Boolean(pty || (child?.stdin && !child.stdin.destroyed && child.stdin.writable));
	}

	/** Wait until a readiness condition fires, the task exits, or the timeout passes. */
	waitReady(spec: ReadySpec, signal?: AbortSignal): Promise<ReadyResult> {
		const timeoutMs = spec.timeout_ms ?? 60_000;
		const re = spec.pattern ? new RegExp(spec.pattern, "m") : undefined;
		return new Promise((resolve) => {
			let done = false;
			const timers: Array<ReturnType<typeof setTimeout>> = [];
			const finish = (fired: ReadyResult["fired"]) => {
				if (done) return;
				done = true;
				for (const t of timers) clearTimeout(t);
				signal?.removeEventListener("abort", onAbort);
				resolve({ fired });
			};
			const onAbort = () => finish("timeout");
			signal?.addEventListener("abort", onAbort, { once: true });
			if (re) {
				const check = () => {
					if (done) return;
					if (re.test(stripAnsi(this.ring.recent()))) return finish("pattern");
					if (!this.running) return;
					void this.waitOutput().then(check);
				};
				check();
			}
			void this.waitExit().then(() => {
				// Give pattern a last look at the final output before reporting exit.
				if (re && re.test(stripAnsi(this.ring.recent()))) finish("pattern");
				else finish("exit");
			});
			if (spec.port !== undefined) {
				const port = spec.port;
				const probe = () => {
					if (done) return;
					void probePort(port).then((ok) => {
						if (ok) finish("port");
						else if (!done) timers.push(setTimeout(probe, 250));
					});
				};
				probe();
			}
			if (spec.url) {
				const url = spec.url;
				const probe = () => {
					if (done) return;
					void probeUrl(url).then((ok) => {
						if (ok) finish("url");
						else if (!done) timers.push(setTimeout(probe, 250));
					});
				};
				probe();
			}
			timers.push(setTimeout(() => finish("timeout"), timeoutMs));
		});
	}
}

function probeHost(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const s = connect({ host, port, timeout: 500 });
		const end = (ok: boolean) => {
			s.destroy();
			resolve(ok);
		};
		s.once("connect", () => end(true));
		s.once("error", () => end(false));
		s.once("timeout", () => end(false));
	});
}

export async function probePort(port: number): Promise<boolean> {
	const [a, b] = await Promise.all([probeHost("127.0.0.1", port), probeHost("::1", port)]);
	return a || b;
}

export async function probeUrl(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
		await res.body?.cancel().catch(() => {});
		return res.status < 500;
	} catch {
		return false;
	}
}
