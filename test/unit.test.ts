import { describe, expect, test } from "bun:test";
import { resolveConfig, DEFAULTS } from "../src/config.ts";
import { Notifier, type NoticeItem, terminalBlock } from "../src/notify.ts";
import { commandFromBranch, recoverCommand, stashCommand } from "../src/rtk.ts";
import { findKeyConflict } from "../src/commands.ts";
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
		expect(c.yieldMs).toBe(30_000);
		expect(c.maxRunning).toBe(16);
		expect(c.defaultNotify).toBe("wake");
		expect(c.shortcuts).toEqual({ background: "ctrl+shift+b", manager: "shift+down" });
		expect(c.dir).toMatch(/tasks$/);
	});
	test("overrides and clamps", () => {
		const c = resolveConfig({ yieldMs: 5, defaultNotify: "bogus", shortcuts: { background: "off" }, maxRunning: 2 });
		expect(c.yieldMs).toBe(1000);
		expect(c.defaultNotify).toBe(DEFAULTS.defaultNotify);
		expect(c.shortcuts.background).toBe("off");
		expect(c.shortcuts.manager).toBe("shift+down");
		expect(c.maxRunning).toBe(2);
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

function makeNotifier(mode: "tui" | "print" = "tui", busy = false) {
	const sent: Array<{ content: string; opts: unknown }> = [];
	const notified = new Set<string>();
	const timers: Array<() => void> = [];
	const n = new Notifier({
		send: (content, _d, opts) => sent.push({ content, opts }),
		toast: () => {},
		mode: () => mode,
		isBusy: () => busy,
		isNotified: (id) => notified.has(id),
		markNotified: (id) => notified.add(id),
		setTimer: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimer: () => {},
	});
	const fire = () => timers.splice(0).forEach((f) => f());
	return { n, sent, notified, fire };
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
	test("delivery map: streaming wake steers, passive is next turn", () => {
		const { n, sent, fire } = makeNotifier("tui", true);
		n.queue(item("a", "wake"));
		n.queue(item("b", "passive"));
		n.queue(item("s", "silent"));
		fire();
		expect(sent.map((s) => s.opts)).toEqual([{ deliverAs: "steer" }, { deliverAs: "nextTurn" }]);
		expect(sent.some((s) => s.content.includes('id="s"'))).toBe(false);
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
