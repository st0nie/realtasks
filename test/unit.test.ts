import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, mergeConfig, resolveConfig } from "../src/config.ts";
import { COALESCE_MS, IDLE_RUNNING_COALESCE_MS, Notifier, type NoticeItem, terminalBlock } from "../src/notify.ts";
import { commandFromBranch, recoverCommand, stashCommand } from "../src/rtk.ts";
import { findKeyConflict } from "../src/commands.ts";
import { formatLineRange, parseLineRange } from "../src/output.ts";
import {
	cleanOutput,
	collapseCR,
	decodeEscapes,
	encodeKeys,
	formatDuration,
	looksLikePrompt,
	newTaskId,
	stripAnsi,
} from "../src/text.ts";
import type { TaskRecord } from "../src/types.ts";

describe("text", () => {
	test("strips ANSI and control sequences", () => {
		expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok")).toBe("red ok");
	});
	test("collapses CR progress to final state", () => {
		expect(collapseCR("10%\r50%\r100%\nnext")).toBe("100%\nnext");
		expect(cleanOutput("a\r\nb")).toBe("a\nb");
	});
	test("decodes C escapes", () => {
		expect(decodeEscapes("print(2+2)\\r")).toBe("print(2+2)\r");
		expect(decodeEscapes("\\x03\\x04\\e[A\\u00e9\\\\")).toBe("\x03\x04\x1b[Aé\\");
		expect(decodeEscapes("\\101")).toBe("A");
	});
	test("encodes key names", () => {
		expect(encodeKeys(["ctrl-c", "enter", "up", "alt-x", "tab"])).toBe("\x03\r\x1b[A\x1bx\t");
		expect(() => encodeKeys(["nope-key"])).toThrow();
	});
	test("formats durations", () => {
		expect(formatDuration(4000)).toBe("4s");
		expect(formatDuration(252_000)).toBe("4m12s");
		expect(formatDuration(3_720_000)).toBe("1h02m");
	});
	test("prompt heuristic", () => {
		for (const s of ["Continue? ", "Overwrite (y/n)", "Password:", ">>> ", "[Y/n]"]) expect(looksLikePrompt(s)).toBe(true);
		for (const s of ["compiling...", "done", ""]) expect(looksLikePrompt(s)).toBe(false);
	});
	test("task ids are prefix + 7 base36", () => {
		expect(newTaskId("b")).toMatch(/^b[0-9a-z]{7}$/);
		expect(newTaskId("m")).toMatch(/^m[0-9a-z]{7}$/);
	});
});

describe("config", () => {
	test("defaults", () => {
		const c = resolveConfig(undefined);
		expect(c.defaultTimeoutMs).toBe(120_000);
		expect(c.maxTimeoutMs).toBe(600_000);
		expect(c.maxRunning).toBe(16);
		expect(c.defaultNotify).toBe("wake");
		expect(c.shortcuts).toEqual({ background: "ctrl+shift+b", manager: "shift+down" });
		expect(c.dir).toMatch(/tasks$/);
	});
	test("overrides and clamps", () => {
		const c = resolveConfig({ defaultTimeoutMs: 5, defaultNotify: "bogus", shortcuts: { background: "off" }, maxRunning: 2 });
		expect(c.defaultTimeoutMs).toBe(1000);
		expect(resolveConfig({ defaultTimeoutMs: 900_000 }).defaultTimeoutMs).toBe(600_000);
		expect(resolveConfig({ defaultTimeoutMs: 900_000, maxTimeoutMs: 1_200_000 }).defaultTimeoutMs).toBe(900_000);
		expect(resolveConfig({ steerPromotes: true, yieldMs: 5000 })).toEqual(resolveConfig(undefined));
		expect(c.defaultNotify).toBe(DEFAULTS.defaultNotify);
		expect(c.shortcuts.background).toBe("off");
		expect(c.shortcuts.manager).toBe("shift+down");
		expect(c.maxRunning).toBe(2);
	});
});

describe("config file", () => {
	const write = (p: string, body: string) => {
		mkdirSync(join(p, ".."), { recursive: true });
		writeFileSync(p, body);
	};
	test("reads <agentDir>/realtasks/config.json; project applies only when trusted", () => {
		const agent = mkdtempSync(join(tmpdir(), "rt-cfg-agent-"));
		const proj = mkdtempSync(join(tmpdir(), "rt-cfg-proj-"));
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			expect(loadConfig(proj, false).config.defaultTimeoutMs).toBe(DEFAULTS.defaultTimeoutMs);
			write(join(agent, "realtasks", "config.json"), JSON.stringify({ defaultTimeoutMs: 5000, shortcuts: { manager: "off" } }));
			write(join(proj, ".pi", "realtasks", "config.json"), JSON.stringify({ defaultTimeoutMs: 9000, shortcuts: { background: "alt+b" } }));
			const untrusted = loadConfig(proj, false).config;
			expect(untrusted.defaultTimeoutMs).toBe(5000);
			expect(untrusted.shortcuts).toEqual({ background: "ctrl+shift+b", manager: "off" });
			const trusted = loadConfig(proj, true).config;
			expect(trusted.defaultTimeoutMs).toBe(9000);
			expect(trusted.shortcuts).toEqual({ background: "alt+b", manager: "off" });
			expect(trusted.dir).toBe(join(agent, "tasks"));
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			rmSync(agent, { recursive: true, force: true });
			rmSync(proj, { recursive: true, force: true });
		}
	});
	test("invalid JSON or non-object warns and falls back", () => {
		const agent = mkdtempSync(join(tmpdir(), "rt-cfg-bad-"));
		const prev = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agent;
		try {
			write(join(agent, "realtasks", "config.json"), "{ nope");
			let r = loadConfig(agent, false);
			expect(r.warnings[0]).toContain("not valid JSON");
			expect(r.config.defaultTimeoutMs).toBe(DEFAULTS.defaultTimeoutMs);
			write(join(agent, "realtasks", "config.json"), "[1]");
			r = loadConfig(agent, false);
			expect(r.warnings[0]).toContain("must contain a JSON object");
		} finally {
			if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prev;
			rmSync(agent, { recursive: true, force: true });
		}
	});
	test("mergeConfig merges shortcuts per key", () => {
		expect(mergeConfig({ a: 1, shortcuts: { x: 1 } }, { shortcuts: { y: 2 } })).toEqual({ a: 1, shortcuts: { x: 1, y: 2 } });
	});
});

describe("keybinding conflicts", () => {
	const resolved: Parameters<typeof findKeyConflict>[1] = {
		"tui.editor.cursorLeft": ["left", "ctrl+b"],
		"tui.altScreen.nextPrompt": ["ctrl+shift+down"],
		"app.tools.expand": "ctrl+o",
	};
	test("detects Pi bindings", () => {
		expect(findKeyConflict("ctrl+b", resolved)).toBe("tui.editor.cursorLeft");
		expect(findKeyConflict("CTRL+O", resolved)).toBe("app.tools.expand");
	});
	test("defaults are free", () => {
		expect(findKeyConflict("ctrl+shift+b", resolved)).toBeUndefined();
		expect(findKeyConflict("shift+down", resolved)).toBeUndefined();
	});
});

describe("rtk recovery", () => {
	const branch = [
		{
			type: "message",
			message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "git status" } }] },
		},
	];
	test("branch lookup finds the original", () => {
		expect(commandFromBranch(branch, "c1")).toBe("git status");
		expect(commandFromBranch(branch, "zz")).toBeUndefined();
	});
	test("stash wins when we ran before rtk", () => {
		stashCommand("s1", "ls -la");
		const r = recoverCommand("s1", "rtk ls -la", () => []);
		expect(r).toEqual({ requested: "ls -la", executed: "rtk ls -la", rewritten: true, known: true });
	});
	test("falls back to the branch when the stash saw the rewrite", () => {
		stashCommand("c1", "rtk git status");
		const r = recoverCommand("c1", "rtk git status", () => branch);
		expect(r.requested).toBe("git status");
		expect(r.rewritten).toBe(true);
	});
	test("no rewrite", () => {
		stashCommand("n1", "uname -a");
		expect(recoverCommand("n1", "uname -a", () => []).rewritten).toBe(false);
	});
	test("unknown original runs the rewrite and says so", () => {
		const r = recoverCommand("x9", "rtk cargo test", () => []);
		expect(r).toEqual({ requested: "rtk cargo test", executed: "rtk cargo test", rewritten: false, known: false });
	});
});

function rec(over: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id: "b1234567",
		kind: "shell",
		label: "npm test",
		requested: "npm test",
		executed: "npm test",
		rewritten: false,
		cwd: "/",
		pid: 1,
		pgid: 1,
		pidStart: "",
		startedAt: 0,
		endedAt: 252_000,
		status: "failed",
		exitCode: 1,
		logPath: "/tmp/x.log",
		exitPath: "/tmp/x.exit",
		notify: "wake",
		notified: false,
		tty: false,
		stdin: false,
		keepAlive: false,
		sessionId: "s",
		foreground: false,
		...over,
	};
}

describe("notification format", () => {
	test("terminal block shape", () => {
		const b = terminalBlock(rec(), "line1\nline2\n");
		expect(b).toStartWith('<task-notification id="b1234567" status="failed" exit="1" duration="4m12s">');
		expect(b).toContain("line2");
		expect(b).toContain("log: /tmp/x.log");
		expect(b).toEndWith("</task-notification>");
	});
	test("shows the rtk rewrite", () => {
		expect(terminalBlock(rec({ rewritten: true, executed: "rtk npm test" }), "")).toContain("npm test → rtk npm test");
	});
});

function makeNotifier(mode: "tui" | "print" = "tui", initialBusy = false, initialRunningWake = false) {
	let busy = initialBusy;
	let runningWake = initialRunningWake;
	const sent: Array<{ content: string; opts: unknown }> = [];
	const toasts: string[] = [];
	const notified = new Set<string>();
	const timers = new Map<number, { fn: () => void; ms: number }>();
	let nextId = 1;
	const n = new Notifier({
		send: (content, _d, opts) => sent.push({ content, opts }),
		toast: (msg) => toasts.push(msg),
		mode: () => mode,
		isBusy: () => busy,
		hasRunningWake: () => runningWake,
		isNotified: (id) => notified.has(id),
		markNotified: (id) => notified.add(id),
		setTimer: (fn, ms) => {
			const id = nextId++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimer: (id) => {
			timers.delete(id as number);
		},
	});
	const fire = () => {
		const fns = [...timers.values()].map((t) => t.fn);
		timers.clear();
		for (const f of fns) f();
	};
	return {
		n,
		sent,
		toasts,
		notified,
		timers,
		fire,
		setBusy: (b: boolean) => {
			busy = b;
		},
		setRunningWake: (r: boolean) => {
			runningWake = r;
		},
	};
}

const item = (id: string, policy: NoticeItem["policy"] = "wake"): NoticeItem => ({
	id,
	kind: "terminal",
	policy,
	block: `<task-notification id="${id}">`,
	summary: id,
	level: "info",
});

describe("notifier latch", () => {
	test("coalesces terminal events into one message", () => {
		const { n, sent, fire } = makeNotifier();
		n.queue(item("a"));
		n.queue(item("b"));
		fire();
		expect(sent.length).toBe(1);
		expect(sent[0].content).toContain('id="a"');
		expect(sent[0].content).toContain('id="b"');
		expect(sent[0].opts).toEqual({ triggerTurn: true });
	});
	test("exactly once: duplicates and already-read tasks are dropped", () => {
		const { n, sent, notified, fire } = makeNotifier();
		n.queue(item("a"));
		n.queue(item("a"));
		n.queue(item("c"));
		notified.add("c"); // agent read c via task_output before flush
		fire();
		expect(sent.length).toBe(1);
		expect(sent[0].content.match(/id="a"/g)?.length).toBe(1);
		expect(sent[0].content).not.toContain('id="c"');
		n.queue(item("a"));
		fire();
		expect(sent.length).toBe(1);
	});
	test("delivery map: busy holds wake across multiple timers for boundary, passive is nextTurn", () => {
		const { n, sent, toasts, notified, fire } = makeNotifier("tui", true);
		n.queue(item("a1", "wake"));
		fire(); // first 300ms window expires mid-turn
		n.queue(item("a2", "wake"));
		n.queue(item("b", "passive"));
		n.queue(item("s", "silent"));
		fire(); // second 300ms window expires mid-turn
		// Passive goes to nextTurn; wake items are held (not steered one-by-one)
		expect(sent.map((s) => s.opts)).toEqual([{ deliverAs: "nextTurn" }]);
		expect(sent.some((s) => s.content.includes('id="s"'))).toBe(false);
		expect(toasts).toEqual(["s", "b"]);
		expect(notified.has("a1")).toBe(false);
		expect(notified.has("a2")).toBe(false);
		// At turn_end / settle boundary, both wake items arrive together in one message
		const msg = n.takeForSettle();
		expect(msg?.content).toContain('id="a1"');
		expect(msg?.content).toContain('id="a2"');
		expect(msg?.details.items.map((i) => i.id)).toEqual(["a1", "a2"]);
		expect(notified.has("a1")).toBe(true);
		expect(notified.has("a2")).toBe(true);
		expect(toasts).toEqual(["s", "b", "a1", "a2"]);
		expect(n.takeForSettle()).toBeUndefined();
	});
	test("busy wake item read during the turn before boundary is suppressed", () => {
		const { n, notified, fire } = makeNotifier("tui", true);
		n.queue(item("a", "wake"));
		fire(); // moved to held mid-turn
		n.queue(item("b", "wake"));
		notified.add("a"); // agent read "a" via task_output during the same turn
		const msg = n.takeForSettle();
		expect(msg?.content).not.toContain('id="a"');
		expect(msg?.content).toContain('id="b"');
	});
	test("held wake items flush with triggerTurn once session settles idle after abort", () => {
		const { n, sent, setBusy, fire } = makeNotifier("tui", true);
		n.queue(item("a", "wake"));
		fire();
		n.queue(item("b", "wake"));
		fire();
		expect(sent.length).toBe(0);
		setBusy(false);
		n.flush();
		expect(sent.length).toBe(1);
		expect(sent[0].opts).toEqual({ triggerTurn: true });
		expect(sent[0].content).toContain('id="a"');
		expect(sent[0].content).toContain('id="b"');
	});
	test("adaptive idle coalescing: widens window while sibling wake runs, shortens when last finishes", () => {
		const { n, sent, timers, setRunningWake, fire } = makeNotifier("tui", false, true);
		n.queue(item("a", "wake"));
		expect([...timers.values()].map((t) => t.ms)).toEqual([IDLE_RUNNING_COALESCE_MS]);
		// Last running wake task finishes: timer shortens to COALESCE_MS
		setRunningWake(false);
		n.queue(item("b", "wake"));
		expect([...timers.values()].map((t) => t.ms)).toEqual([COALESCE_MS]);
		fire();
		expect(sent.length).toBe(1);
		expect(sent[0].content).toContain('id="a"');
		expect(sent[0].content).toContain('id="b"');
	});
	test("print mode holds wake for settle, drops passive", () => {
		const { n, sent, notified, fire } = makeNotifier("print");
		n.queue(item("a", "wake"));
		n.queue(item("p", "passive"));
		fire();
		expect(sent.length).toBe(0);
		expect(n.hasHeldWake()).toBe(true);
		const msg = n.takeForSettle();
		expect(msg?.content).toContain('id="a"');
		expect(notified.has("a")).toBe(true);
		expect(n.takeForSettle()).toBeUndefined();
	});
	test("failed send re-queues", () => {
		let fail = true;
		const notified = new Set<string>();
		const sent: string[] = [];
		const n = new Notifier({
			send: (c) => {
				if (fail) throw new Error("stale");
				sent.push(c);
			},
			toast: () => {},
			mode: () => "tui",
			isBusy: () => false,
			isNotified: (id) => notified.has(id),
			markNotified: (id) => notified.add(id),
			setTimer: () => 1,
			clearTimer: () => {},
		});
		n.queue(item("a"));
		n.flush();
		expect(notified.has("a")).toBe(false);
		fail = false;
		n.flush();
		expect(sent.length).toBe(1);
		expect(notified.has("a")).toBe(true);
	});
});

describe("lines ranges (task_output lines)", () => {
	test("parse", () => {
		expect(parseLineRange("120-260")).toEqual({ first: 120, last: 260 });
		expect(parseLineRange(" 120 - ")).toEqual({ first: 120, last: undefined });
		expect(parseLineRange("7")).toEqual({ first: 7, last: 7 });
		for (const bad of ["0", "0-3", "5-3", "abc", "-5", "1-2-3", ""]) expect(() => parseLineRange(bad)).toThrow(/Bad lines range/);
	});
	test("numbered slice of the cleaned log", () => {
		const r = formatLineRange("a\r\nb\n\x1b[31mc\x1b[0m\nd\n", { first: 2, last: 3 }, undefined, 200);
		expect(r).toEqual({ header: "lines: 2-3 of 4\n", text: "2: b\n3: c" });
		expect(formatLineRange("a\nb", { first: 2 }, undefined, 200).text).toBe("2: b");
		expect(formatLineRange("a\nb\n", { first: 1, last: 99 }, undefined, 200).header).toBe("lines: 1-2 of 2\n");
	});
	test("grep filters inside the range and keeps line numbers", () => {
		const r = formatLineRange("ok 1\nerror: x\nok 2\nerror: y\n", { first: 1 }, /error/, 200);
		expect(r.header).toBe("lines: 1-4 of 4 · grep: 2 of 4 lines match\n");
		expect(r.text).toBe("2: error: x\n4: error: y");
		// The regex sees the log line, not the number prefix.
		expect(formatLineRange("x\ny\n", { first: 1 }, /^y/, 200).text).toBe("2: y");
	});
	test("keeps the start of the range and names the next range", () => {
		const log = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");
		const closed = formatLineRange(log, { first: 2, last: 9 }, undefined, 3);
		expect(closed.text).toBe('2: L2\n3: L3\n4: L4\n\n[Showing 3 of 8 lines. Next: lines "5-9"]');
		const open = formatLineRange(log, { first: 2 }, undefined, 3);
		expect(open.text.endsWith('[Showing 3 of 9 lines. Next: lines "5-"]')).toBe(true);
		const grep = formatLineRange(log, { first: 1 }, /L[13579]$/, 2);
		expect(grep.text).toBe('1: L1\n3: L3\n\n[Showing 2 of 5 lines. Next: lines "5-"]');
	});
	test("past the end and empty logs", () => {
		expect(formatLineRange("a\nb\n", { first: 5 }, undefined, 200)).toEqual({ header: "lines: 5- is past the end (log has 2 lines)\n", text: "" });
		expect(formatLineRange("", { first: 1, last: 1 }, undefined, 200).header).toBe("lines: 1-1 is past the end (log has 0 lines)\n");
	});
});
