import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import realtasks from "../index.ts";
import { handleTable, loadPty } from "../src/proc.ts";
import { fakeCtx, fakePi, tmpDir, until } from "./helpers.ts";

type Res = { content: Array<{ text: string }>; details?: Record<string, unknown>; isError?: boolean };

const { dir, cleanup } = tmpDir();
let env: ReturnType<typeof setup>;

function setup(sessionId = "s-int") {
	const f = fakePi({ tasks: { dir, yieldMs: 1000 } });
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

	test("non-zero exit is an error result with the code", async () => {
		const r = await env.call("bash", { command: "echo out; exit 3" });
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("Command exited with code 3");
	});

	test("yield promotes; one notification on exit (flow 2 core)", async () => {
		const r = await env.call("bash", { command: "sleep 1.6; echo finished", yield_ms: 1000 });
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
		const again = await env.emit("agent_before_settle", { type: "agent_before_settle", entries: [], continue: false }, env.ctx);
		expect(again).toBeUndefined();
	});

	test("timeout ends as timed_out", async () => {
		const r = await env.call("bash", { command: "sleep 5", run_in_background: true, timeout: 1, notify: "silent" });
		const id = taskId(r);
		const out = await env.call("task_output", { id, wait_ms: 5000 });
		expect(text(out)).toContain("timed_out");
	});
});


describe("task tools", () => {
	test("exit-file wrapper records real exit code; cursors return only new output (flow 6)", async () => {
		const r = await env.call("bash", { command: "echo one; sleep 0.4; echo two; exit 7", run_in_background: true });
		const id = taskId(r);
		const first = await env.call("task_output", { id, wait_ms: 3000, grep: "one" });
		expect(text(first)).toContain("one");
		const second = await env.call("task_output", { id, wait_ms: 3000 });
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
		const out = await env.call("task_output", { id, wait_ms: 3000, from: "start" });
		expect(text(out)).toContain("ping");
		expect(text(out)).toContain("completed exit=0");
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
		const out = await env.call("task_output", { id, wait_ms: 4000 });
		expect(text(out)).toContain("stopped");
	});
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
		const out = await fresh.call("task_output", { id, wait_ms: 5000 });
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

describe("steering", () => {
	test("typing during a foreground bash promotes it and resubmits", async () => {
		const p = env.call("bash", { command: "sleep 2; echo done", yield_ms: 60000 });
		await until(() => (env.handlers.get("input")?.length ?? 0) > 0, 1000);
		await new Promise((r) => setTimeout(r, 200));
		const res = await env.emit("input", { type: "input", text: "hey", source: "interactive" }, env.ctx);
		expect(res).toEqual({ action: "handled" });
		const r = await p;
		expect(text(r)).toContain("because the user sent a message");
		expect(env.aborted()).toBe(1);
		expect(env.userMessages[0]).toEqual({ content: "hey", opts: { deliverAs: "followUp" } });
		const ext = await env.emit("input", { type: "input", text: "goal", source: "extension" }, env.ctx);
		expect(ext).toEqual({ action: "continue" });
	});
});
