import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import realtasks from "../index.ts";
import { TaskManager } from "../src/manager.ts";
import { fileSize } from "../src/output.ts";
import { handleTable, isSameProcess, loadPty } from "../src/proc.ts";
import { fakeCtx, fakePi, testConfig, tmpDir, until, writeUserConfig } from "./helpers.ts";

type Res = { content: Array<{ text: string }>; details?: Record<string, unknown>; isError?: boolean };

const { dir, cleanup } = tmpDir();
const agentDir = writeUserConfig({ dir, defaultTimeoutMs: 1000 });
let env: ReturnType<typeof setup>;

function setup(sessionId = "s-int") {
	const f = fakePi();
	realtasks(f.pi as never);
	const c = fakeCtx(dir, sessionId, "print");
	const call = async (name: string, params: Record<string, unknown>, id = `call-${Math.random()}`) => {
		const tool = f.tools.get(name);
		if (!tool) throw new Error(`no tool ${name}`);
		return (await tool.execute(id, params, undefined, undefined, c.ctx)) as Res;
	};
	return { ...f, ...c, call };
}

beforeAll(async () => {
	env = setup();
	await env.emit("session_start", { type: "session_start", reason: "startup" }, env.ctx);
});
afterAll(async () => {
	await env.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, env.ctx);
	cleanup();
	rmSync(agentDir, { recursive: true, force: true });
});

const text = (r: Res) => r.content.map((c) => c.text).join("");
const taskId = (r: Res) => {
	const m = /task (b[0-9a-z]{7})/i.exec(text(r));
	if (!m) throw new Error(`no task id in: ${text(r)}`);
	return m[1];
};

describe("bash override", () => {
	test("fast command: foreground result, no task left behind (flow 1)", async () => {
		const r = await env.call("bash", { command: "echo hello; echo err >&2" });
		expect(text(r)).toContain("hello");
		expect(text(r)).toContain("err");
		expect(r.isError).toBeFalsy();
		const list = await env.call("task_list", {});
		expect(text(list)).toBe("No tasks.");
	});

	test("foreground bash emits onUpdate once initially and only when output changes", async () => {
		const tool = env.tools.get("bash");
		if (!tool) throw new Error("no bash tool");
		const updates: Res[] = [];
		const r = (await tool.execute(
			"call-upd",
			{ command: "echo line1; sleep 0.7; echo line2" },
			undefined,
			(u: unknown) => updates.push(u as Res),
			env.ctx,
		)) as Res;
		expect(r.isError).toBeFalsy();
		// 1 initial empty update + at most 2 output updates (line1, then line1\nline2), not 250ms ticks.
		expect(updates.length).toBeGreaterThanOrEqual(2);
		expect(updates.length).toBeLessThanOrEqual(3);
		expect(updates[0].content).toEqual([]);
		expect(updates[0].details).toMatchObject({ windowMs: 1000 });
		expect(text(updates[updates.length - 1])).toContain("line1");
	});

	test("non-zero exit is an error result with the code", async () => {
		const r = await env.call("bash", { command: "echo out; exit 3" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("Command exited with code 3");
	});

	test("timeout backgrounds instead of killing; one notification on exit (flow 2 core)", async () => {
		const r = await env.call("bash", { command: "sleep 1.6; echo finished", timeout: 1 });
		expect(text(r)).toContain("backgrounded after its 1s timeout");
		expect(text(r)).toContain("Still running as task");
		const id = taskId(r);
		// Wait for exit without reading output (that would flip the latch).
		await until(() => readFileSync(join(dir, "s-int", `${id}.json`), "utf8").includes('"status": "completed"'), 6000);
		await new Promise((r) => setTimeout(r, 400));
		const settle = (await env.emit(
			"agent_before_settle",
			{ type: "agent_before_settle", entries: [], continue: false },
			env.ctx,
		)) as { entries: Array<{ content: string }>; continue: boolean };
		expect(settle.continue).toBe(true);
		expect(settle.entries[0].content).toContain(`id="${id}" status="completed" exit="0"`);
		expect(settle.entries[0].content).toContain("finished");
		const mine = env.entries.filter((e) => e.type === "realtasks" && (e.data as { id?: string }).id === id).map((e) => e.data);
		expect(mine).toEqual([
			expect.objectContaining({ event: "started", id, kind: "shell" }),
			expect.objectContaining({ event: "ended", id, status: "completed", exitCode: 0 }),
		]);
		const again = await env.emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false }, env.ctx);
		expect(again).toBeUndefined();
	});

	test("multiple tasks finishing >300ms apart during a busy turn coalesce into one turn_end message", async () => {
		const tui = fakeCtx(dir, "s-int", "tui");
		await env.emit("agent_start", { type: "agent_start" }, tui.ctx);
		try {
			const r1 = await env.call("bash", { command: "sleep 0.1; echo batch-one", run_in_background: true });
			const r2 = await env.call("bash", { command: "sleep 0.6; echo batch-two", run_in_background: true });
			const r3 = await env.call("bash", { command: "sleep 0.1; echo read-early", run_in_background: true });
			const id1 = taskId(r1);
			const id2 = taskId(r2);
			const id3 = taskId(r3);
			await until(
				() =>
					readFileSync(join(dir, "s-int", `${id1}.json`), "utf8").includes('"status": "completed"') &&
					readFileSync(join(dir, "s-int", `${id2}.json`), "utf8").includes('"status": "completed"') &&
					readFileSync(join(dir, "s-int", `${id3}.json`), "utf8").includes('"status": "completed"'),
				6000,
			);
			// Wait past the 300ms timer after the second task; while busy, no piecemeal steer messages are sent.
			await new Promise((r) => setTimeout(r, 400));
			expect(env.sent.length).toBe(0);
			// Reading id3 during the turn flips its latch before turn_end.
			await env.call("task_output", { id: id3 });
			const turnEnd = (await env.emit(
				"turn_end",
				{ type: "turn_end", outcome: "completed", entries: [], continue: false },
				tui.ctx,
			)) as { entries: Array<{ content: string; details: { items: Array<{ id: string }> } }>; continue: boolean };
			expect(turnEnd.continue).toBe(true);
			expect(turnEnd.entries.length).toBe(1);
			expect(turnEnd.entries[0].content).toContain(`id="${id1}"`);
			expect(turnEnd.entries[0].content).toContain("batch-one");
			expect(turnEnd.entries[0].content).toContain(`id="${id2}"`);
			expect(turnEnd.entries[0].content).toContain("batch-two");
			expect(turnEnd.entries[0].content).not.toContain(`id="${id3}"`);
			expect(turnEnd.entries[0].details.items.map((i) => i.id)).toEqual([id1, id2]);
			// Nothing left for agent_before_settle after turn_end already delivered them.
			const settle = await env.emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false }, tui.ctx);
			expect(settle).toBeUndefined();
		} finally {
			await env.emit("agent_end", { type: "agent_end" }, tui.ctx);
			await env.emit("agent_settled", { type: "agent_settled", aborted: false }, env.ctx);
		}
	});

	test("timeout is ignored with run_in_background; nothing kills on time", async () => {
		const r = await env.call("bash", { command: "sleep 1.5; echo ok", run_in_background: true, timeout: 1, notify: "silent" });
		const id = taskId(r);
		const out = await env.call("task_wait", { id, timeout_ms: 5000 });
		expect(text(out)).toContain("completed");
		expect(text(out)).not.toContain("timed_out");
	});
});


describe("task tools", () => {
	test("exit-file wrapper records real exit code; cursors return only new output (flow 6)", async () => {
		const r = await env.call("bash", { command: "echo one; sleep 0.4; echo two; exit 7", run_in_background: true });
		const id = taskId(r);
		const first = await env.call("task_wait", { id, timeout_ms: 3000, until: "one" });
		expect(text(first)).toContain("one");
		const second = await env.call("task_wait", { id, timeout_ms: 3000 });
		expect(text(second)).toContain("two");
		expect(text(second)).not.toContain("one\n");
		expect(text(second)).toContain("failed exit=7");
		const recFile = readFileSync(join(dir, "s-int", `${id}.exit`), "utf8");
		expect(recFile).toBe("7");
		// Read before flush → latch flipped, no notification for it.
		const settle = (await env.emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false }, env.ctx)) as
			| { entries: Array<{ content: string }> }
			| undefined;
		expect(settle?.entries.some((e) => e.content.includes(id)) ?? false).toBe(false);
	});

	test("from=start rereads; stdin input with eof", async () => {
		const r = await env.call("bash", { command: "cat", run_in_background: true, stdin: true, notify: "silent" });
		const id = taskId(r);
		const inp = await env.call("task_input", { id, text: "ping\\n", wait_ms: 300 });
		expect(text(inp)).toContain("ping");
		await env.call("task_input", { id, eof: true, wait_ms: 300 });
		await env.call("task_wait", { id, timeout_ms: 3000 });
		const out = await env.call("task_output", { id, from: "start" });
		expect(text(out)).toContain("ping");
		expect(text(out)).toContain("completed exit=0");
	});

	test("task_output never blocks on a running task", async () => {
		const r = await env.call("bash", { command: "sleep 30", run_in_background: true, notify: "silent" });
		const id = taskId(r);
		const t0 = Date.now();
		const out = await env.call("task_output", { id });
		expect(Date.now() - t0).toBeLessThan(500);
		expect(text(out)).toContain("running");
		expect(text(out)).toContain("output: (no new output)");
		expect(out.details).toMatchObject({ id, status: "running" });
		await env.call("task_stop", { id, grace_ms: 200 });
	});

	test("peek and lines leave the cursor and the notification alone (flow 8)", async () => {
		const r = await env.call("bash", { command: "printf 'a1\\nb2\\nerror c3\\nd4\\n'", run_in_background: true });
		const id = taskId(r);
		const json = join(dir, "s-int", `${id}.json`);
		await until(() => readFileSync(json, "utf8").includes('"status": "completed"'), 6000);
		const peek = await env.call("task_output", { id, peek: true });
		expect(text(peek)).toContain("completed exit=0");
		expect(text(peek)).toContain("b2");
		expect(text(peek)).toContain("cursor: 0 (unchanged by peek");
		const range = text(await env.call("task_output", { id, lines: "2-3" }));
		expect(range).toContain("lines: 2-3 of 4");
		expect(range).toContain("output:\n2: b2\n3: error c3\ncursor: 0");
		const hits = text(await env.call("task_output", { id, lines: "1-", grep: "error" }));
		expect(hits).toContain("grep: 1 of 4 lines match");
		expect(hits).toContain("output:\n3: error c3\ncursor: 0");
		const rec = JSON.parse(readFileSync(json, "utf8"));
		expect(rec.notified).toBe(false);
		expect(rec.cursor ?? 0).toBe(0);
		// The notification still arrives after the peeks.
		await new Promise((res) => setTimeout(res, 400));
		const settle = (await env.emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false }, env.ctx)) as
			| { entries: Array<{ content: string }> }
			| undefined;
		expect(settle?.entries.some((e) => e.content.includes(`id="${id}"`))).toBe(true);
		// A plain read still sees the output as new and moves the cursor.
		const plain = text(await env.call("task_output", { id }));
		expect(plain).toContain("output:\na1\nb2");
		expect(plain).not.toContain("unchanged by peek");
		expect(JSON.parse(readFileSync(json, "utf8")).cursor).toBeGreaterThan(0);
	});

	test("task_wait on several tasks returns on the first exit (flow 9)", async () => {
		const slow = taskId(await env.call("bash", { command: "echo slow-start; sleep 30", run_in_background: true, notify: "silent" }));
		const fast = taskId(await env.call("bash", { command: "sleep 0.5; echo fast-done", run_in_background: true, notify: "silent" }));
		const t0 = Date.now();
		const out = await env.call("task_wait", { id: [slow, fast, fast], timeout_ms: 10_000 });
		expect(Date.now() - t0).toBeLessThan(5000);
		const body = text(out);
		expect(body.startsWith(`woke on: ${fast} (exit)`)).toBe(true);
		// One block per task, in the given order, duplicates merged.
		expect(body.indexOf(`${slow} [shell] running`)).toBeGreaterThan(0);
		expect(body.indexOf(`${fast} [shell] completed exit=0`)).toBeGreaterThan(body.indexOf(`${slow} [shell] running`));
		expect(body.split(`label: `).length - 1).toBe(2);
		expect(body).toContain("slow-start");
		expect(body).toContain("fast-done");
		expect(out.details).toMatchObject({ phase: "done", reason: "exit", id: fast, status: "completed", exitCode: 0 });
		// task_wait consumed the output: a later read has nothing new.
		expect(text(await env.call("task_output", { id: slow }))).toContain("output: (no new output)");
		// A task that already ended makes the wait return at once.
		const t1 = Date.now();
		const again = await env.call("task_wait", { id: [slow, fast], timeout_ms: 10_000 });
		expect(Date.now() - t1).toBeLessThan(1000);
		expect(text(again).startsWith(`woke on: ${fast} (exit)`)).toBe(true);
		await env.call("task_stop", { id: slow, grace_ms: 200 });
	});

	test("task_wait until match, timeout, and running tasks", async () => {
		const a = taskId(await env.call("bash", { command: "sleep 30", run_in_background: true, notify: "silent" }));
		const b = taskId(await env.call("bash", { command: "sleep 0.3; echo READY now; sleep 30", run_in_background: true, notify: "silent" }));
		const out = await env.call("task_wait", { id: [a, b], timeout_ms: 10_000, until: "READY" });
		expect(text(out).startsWith(`woke on: ${b} (match)`)).toBe(true);
		expect(text(out)).toContain("READY now");
		expect(out.details).toMatchObject({ reason: "match", id: b, status: "running" });
		const t0 = Date.now();
		const timed = await env.call("task_wait", { id: a, timeout_ms: 300 });
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(text(timed)).toMatch(/^timed out after /);
		expect(text(timed)).toContain(`${a} [shell] running`);
		expect(timed.details).toMatchObject({ reason: "timeout", id: a });
		// Esc (the tool's abort signal) ends the wait; nothing else does.
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 200);
		const tool = env.tools.get("task_wait");
		const cancelled = (await tool?.execute("call-abort", { id: a, timeout_ms: 60_000 }, ac.signal, undefined, env.ctx)) as Res;
		expect(text(cancelled)).toMatch(/^cancelled after /);
		expect(cancelled.details).toMatchObject({ reason: "abort" });
		await env.call("task_stop", { id: "all", grace_ms: 200 });
	});
	test("task_input without stdin explains", async () => {
		const r = await env.call("bash", { command: "sleep 3", run_in_background: true, notify: "silent" });
		const id = taskId(r);
		await expect(env.call("task_input", { id, text: "x" })).rejects.toThrow(/no open input/);
		await env.call("task_stop", { id, grace_ms: 200 });
	});

	test("task_stop kills the process group", async () => {
		const r = await env.call("bash", { command: "sleep 30 & sleep 30; wait", run_in_background: true });
		const id = taskId(r);
		const s = await env.call("task_stop", { id, grace_ms: 500 });
		expect(text(s)).toContain("stopped");
	});

	test("task_stop also kills background children (whole group / tree)", async () => {
		const r = await env.call("bash", {
			command: "(while true; do echo tick; sleep 0.2; done) & wait",
			run_in_background: true,
			notify: "silent",
		});
		const id = taskId(r);
		await env.call("task_wait", { id, timeout_ms: 5000, until: "tick" });
		await env.call("task_stop", { id, grace_ms: 500 });
		const log = join(dir, "s-int", `${id}.log`);
		await new Promise((res) => setTimeout(res, 1000));
		const size = fileSize(log);
		await new Promise((res) => setTimeout(res, 1000));
		expect(fileSize(log)).toBe(size);
	});

	test("records the PID start time for re-adoption checks", async () => {
		const r = await env.call("bash", { command: "sleep 5", run_in_background: true, notify: "silent" });
		const id = taskId(r);
		const json = join(dir, "s-int", `${id}.json`);
		// Windows fills it in asynchronously (PowerShell).
		await until(() => JSON.parse(readFileSync(json, "utf8")).pidStart !== "", 10_000, 100);
		const rec = JSON.parse(readFileSync(json, "utf8"));
		expect(isSameProcess(rec.pid, rec.pidStart)).toBe(true);
		expect(isSameProcess(rec.pid, `${rec.pidStart}0`)).toBe(false);
		await env.call("task_stop", { id, grace_ms: 200 });
	}, 15_000);

	test("ready.pattern returns when the pattern appears (flow 3 core)", async () => {
		const r = await env.call("bash", {
			command: "echo booting; sleep 0.3; echo 'Listening on 3000'; sleep 5",
			ready: { pattern: "Listening on \\d+", timeout_ms: 5000 },
			notify: "silent",
		});
		expect(text(r)).toContain("is ready (pattern matched)");
		await env.call("task_stop", { id: taskId(r), grace_ms: 200 });
	});

	test("ready.port probes TCP", async () => {
		const port = 39000 + Math.floor(Math.random() * 1000);
		const r = await env.call("bash", {
			command: `exec bun -e "Bun.serve({port:${port},fetch(){return new Response('ok')}}); setTimeout(()=>{},60000)"`,
			ready: { port, timeout_ms: 10000 },
			notify: "silent",
		});
		expect(text(r)).toContain("is ready (port matched)");
		const r2 = await env.call("bash", { command: `curl -s http://127.0.0.1:${port}/` });
		expect(text(r2)).toContain("ok");
		await env.call("task_stop", { id: taskId(r), grace_ms: 300 });
	});

	test("ready: early exit is a failure", async () => {
		const r = await env.call("bash", { command: "echo nope; exit 2", ready: { pattern: "never" }, notify: "silent" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("exited before it was ready");
	});

	test("PTY: python REPL via task_input (flow 4, under Node)", async () => {
		if (!loadPty()) throw new Error("@lydell/node-pty is not installed");
		const d = tmpDir("realtasks-pty-");
		try {
			const p = Bun.spawnSync(["node", "--experimental-strip-types", "--no-warnings", "test/pty-node.ts", d.dir], {
				cwd: join(import.meta.dir, ".."),
				timeout: 30_000,
			});
			const out = `${p.stdout.toString()}${p.stderr.toString()}`;
			expect(out).toContain("PTY_OK");
		} finally {
			d.cleanup();
		}
	}, 35_000);
});

describe("monitor", () => {
	test("file monitor: 3 errors → batched events (flow 7)", async () => {
		const log = join(dir, "app.log");
		writeFileSync(log, "");
		const r = await env.call("monitor", { file: log, filter: "ERROR", description: "app errors", timeout_ms: 8000 });
		const id = /Monitor (m[0-9a-z]{7})/.exec(text(r))?.[1];
		expect(id).toBeDefined();
		await new Promise((res) => setTimeout(res, 400));
		appendFileSync(log, "info a\nERROR one\nERROR two\nwarn\nERROR three\n");
		await new Promise((res) => setTimeout(res, 2800));
		const settle = (await env.emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false }, env.ctx)) as {
			entries: Array<{ content: string }>;
		};
		const body = settle.entries.map((e) => e.content).join("\n");
		expect(body).toContain(`<task-event id="${id}" count="3">`);
		expect(body).toContain("ERROR three");
		expect(body).not.toContain("warn");
		await env.call("task_stop", { id: id as string, grace_ms: 200 });
	});

	test("flood stop", async () => {
		const r = await env.call("monitor", {
			command: "for i in $(seq 1 50); do echo line$i; done; sleep 5",
			description: "flood",
			max_events_per_min: 5,
		});
		const id = /Monitor (m[0-9a-z]{7})/.exec(text(r))?.[1] as string;
		const out = await env.call("task_wait", { id, timeout_ms: 4000 });
		expect(text(out)).toContain("stopped");
	});
});

describe("log rotation", () => {
	test("keeps the last half and the task keeps appending after the cut", async () => {
		const d = tmpDir("realtasks-rot-");
		const m = new TaskManager(
			testConfig(d.dir, { maxLogBytes: 65536 }),
			{ send: () => {}, toast: () => {}, mode: () => "print", isBusy: () => false },
			{ changed: () => {} },
		);
		try {
			m.attach("s-rot");
			const t = m.start({
				kind: "shell",
				requested: "x",
				executed:
					'for i in $(seq 1 4000); do echo "line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done; sleep 1; echo after-rotate',
				rewritten: false,
				cwd: d.dir,
				notify: "silent",
				tty: false,
				stdin: false,
				keepAlive: false,
				foreground: false,
			});
			// Task timers are unref'd; poll with a ref'd timer so the test loop stays alive.
			await until(() => !t.running, 15_000, 100);
			const info = await t.waitExit();
			expect(info.status).toBe("completed");
			const body = readFileSync(t.rec.logPath, "utf8");
			expect(t.rec.signals?.logCap).toBe(true);
			expect(body.length).toBeLessThan(65536);
			expect(body).not.toContain("\0");
			expect(body).toContain("line 4000 ");
			expect(body.endsWith("after-rotate\n")).toBe(true);
		} finally {
			m.detach("quit");
			d.cleanup();
		}
	}, 20_000);
});

describe("reload re-adoption (flow 5)", () => {
	test("running task survives session_shutdown(reload) and finishes in the new runtime", async () => {
		const r = await env.call("bash", { command: "sleep 1.2; false", run_in_background: true });
		const id = taskId(r);
		await env.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, env.ctx);
		expect(handleTable().has(id)).toBe(true);
		const fresh = setup();
		await fresh.emit("session_start", { type: "session_start", reason: "reload" }, fresh.ctx);
		expect(handleTable().has(id)).toBe(false);
		const out = await fresh.call("task_wait", { id, timeout_ms: 5000 });
		expect(text(out)).toContain("failed exit=1");
		env = fresh;
	});

	test("dead task with exit file is finalized; without one it is lost", async () => {
		const sid = "s-dead";
		const d = join(dir, sid);
		const base = {
			kind: "shell",
			label: "x",
			requested: "x",
			executed: "x",
			rewritten: false,
			cwd: dir,
			pid: 999_999,
			pgid: 999_999,
			pidStart: "nope",
			startedAt: Date.now() - 1000,
			status: "running",
			notify: "wake",
			notified: false,
			tty: false,
			stdin: false,
			keepAlive: false,
			sessionId: sid,
			foreground: false,
		};
		const { mkdirSync } = await import("node:fs");
		mkdirSync(d, { recursive: true });
		for (const [id, code] of [
			["bdead001", "0"],
			["bdead002", ""],
		]) {
			writeFileSync(join(d, `${id}.log`), "out\n");
			if (code) writeFileSync(join(d, `${id}.exit`), code);
			writeFileSync(
				join(d, `${id}.json`),
				JSON.stringify({ ...base, id, logPath: join(d, `${id}.log`), exitPath: join(d, `${id}.exit`) }),
			);
		}
		const f = setup(sid);
		await f.emit("session_start", { type: "session_start", reason: "resume" }, f.ctx);
		const list = text(await f.call("task_list", {}));
		expect(list).toContain("bdead001 [shell] completed exit=0");
		expect(list).toContain("bdead002 [shell] lost");
		expect(f.entries.some((e) => e.type === "realtasks")).toBe(true);
		await f.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, f.ctx);
	});

	test("quit stops tasks", async () => {
		const r = await env.call("bash", { command: "sleep 30", run_in_background: true });
		const id = taskId(r);
		await env.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, env.ctx);
		const rec = JSON.parse(readFileSync(join(dir, "s-int", `${id}.json`), "utf8"));
		expect(rec.status).toBe("stopped");
		env = setup();
		await env.emit("session_start", { type: "session_start", reason: "startup" }, env.ctx);
		expect(existsSync(join(dir, "s-int"))).toBe(true);
	});
});

describe("typing during a foreground bash", () => {
	test("registers no input handler, so Pi queues the message and the command runs on", async () => {
		const r = await env.call("bash", { command: "sleep 0.3; echo done", timeout: 60 });
		expect(env.handlers.get("input")?.length ?? 0).toBe(0);
		expect(text(r)).toContain("done");
		expect(env.aborted()).toBe(0);
	});
});
