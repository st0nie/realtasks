import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TaskManager } from "../src/manager.ts";
import { Task } from "../src/task.ts";
import type { TaskRecord } from "../src/types.ts";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component } from "@earendil-works/pi-tui";
import { NOTIFICATION_TYPE, type NotificationDetails, terminalBlock, terminalDetail, terminalLevel, terminalSummary } from "../src/notify.ts";
import { Runtime } from "../src/runtime.ts";
import {
	dockLines,
	FRAME_MS,
	LINGER_MS,
	type ManagerAction,
	type NotificationMessage,
	renderNotification,
	SPINNER,
	spinnerFrame,
	statusCounts,
	TasksOverlay,
} from "../src/ui.ts";
import { testConfig, tmpDir } from "./helpers.ts";

const th = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const hooks = { onOutput: () => {}, onExit: () => {}, onRotate: () => {} };

function rec(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
	return {
		id,
		kind: "shell",
		label: id,
		requested: "x",
		executed: "x",
		rewritten: false,
		cwd: "/",
		pid: 1,
		pgid: 1,
		pidStart: "",
		startedAt: 0,
		status: "running",
		logPath: "/dev/null",
		exitPath: "/dev/null",
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

function task(id: string, over: Partial<TaskRecord> = {}, out = ""): Task {
	const t = new Task(rec(id, over), {}, hooks, 1 << 20);
	if (out) t.ring.append(out);
	if (over.status && over.status !== "running") t.markDone(t.rec);
	return t;
}

describe("spinner", () => {
	test("uses star frames, never Pi's braille spinner", () => {
		expect(SPINNER).toEqual(["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"]);
		expect(SPINNER.join("")).not.toMatch(/[\u2800-\u28ff]/);
		// No emoji characters: terminals may draw them double-width in color (\u2733 on Windows Terminal).
		expect(SPINNER.join("")).not.toMatch(/\p{Emoji}/u);
	});
	test("advances one frame per FRAME_MS and loops", () => {
		expect(spinnerFrame(0)).toBe("·");
		expect(spinnerFrame(FRAME_MS)).toBe("✢");
		expect(spinnerFrame(FRAME_MS * SPINNER.length)).toBe("·");
	});
});

describe("dock", () => {
	test("tree layout: heading, ├─ rows, └─ last row, trailing blank", () => {
		const now = 42_000;
		const lines = dockLines(
			[
				task("bxomyvwe", { label: "npm test" }, "test 30 ok\ntest 31 ok\n"),
				task("mshcwo0p", { kind: "monitor", label: "app errors" }),
				task("b2ywygi6", { label: "build", status: "completed", exitCode: 0, startedAt: 30_000, endedAt: 38_000 }),
			],
			th,
			200,
			now,
		);
		expect(lines[0]).toBe("● Tasks (2 running · 1 done)");
		expect(lines[1]).toBe(`├─ ${spinnerFrame(now)} bxomyvwe npm test · 42s │ test 31 ok`);
		expect(lines[2]).toMatch(/^├─ [◉◎] mshcwo0p app errors · 42s$/);
		expect(lines[3]).toBe("└─ ✓ b2ywygi6 build · exit 0 · 8s");
		expect(lines[4]).toBe("");
	});
	test("finished tasks linger 10 s, then the dock hides", () => {
		const done = task("bdone001", { status: "failed", exitCode: 1, endedAt: 1000 });
		expect(dockLines([done], th, 100, 1000 + LINGER_MS - 1)[0]).toBe("○ Tasks (1 done)");
		expect(dockLines([done], th, 100, 1000 + LINGER_MS + 1)).toEqual([]);
	});
	test("more than 5 rows collapse into +N more", () => {
		const many = Array.from({ length: 7 }, (_, i) => task(`b000000${i}`));
		const lines = dockLines(many, th, 100, 0);
		expect(lines.filter((l) => l.startsWith("├─")).length).toBe(5);
		expect(lines.at(-2)).toBe("└─ +2 more · /tasks");
	});
	test("foreground commands are not shown", () => {
		expect(dockLines([task("bfg00001", { foreground: true })], th, 100, 0)).toEqual([]);
	});
	test("status line: spinner + running count, unread counts", () => {
		const s = statusCounts(
			[task("b1"), task("b2", { status: "completed", exitCode: 0 }), task("b3", { status: "failed", exitCode: 2 })],
			th,
			FRAME_MS * 2,
		);
		expect(s).toBe("✱ 1 ✓ 1 ✗ 1");
	});
});

describe("/tasks clear", () => {
	test("keeps unread finished tasks unless all; never touches running ones", () => {
		const { dir, cleanup } = tmpDir();
		try {
			const m = new TaskManager(
				testConfig(dir),
				{ send: () => {}, toast: () => {}, mode: () => "print", isBusy: () => false },
				{ changed: () => {} },
			);
			m.sessionId = "s";
			const running = task("brun0001");
			const read = task("bread001", { status: "completed", exitCode: 0, notified: true });
			const unread = task("bunrd001", { status: "failed", exitCode: 1 });
			const userBg = task("buser001", { status: "failed", exitCode: 4, userStarted: true, notify: "silent" });
			for (const t of [running, read, unread, userBg]) m.tasks.set(t.rec.id, t);

			expect(m.clearFinished()).toEqual({ cleared: 2, keptUnread: 1 });
			expect([...m.tasks.keys()].sort()).toEqual(["brun0001", "bunrd001"]);

			expect(m.clearFinished(true)).toEqual({ cleared: 1, keptUnread: 0 });
			expect([...m.tasks.keys()]).toEqual(["brun0001"]);
			expect(unread.rec.notified).toBe(true);
		} finally {
			cleanup();
		}
	});
});

describe("/tasks manager", () => {
	const KEY = {
		up: "\x1b[A",
		down: "\x1b[B",
		shiftUp: "\x1b[1;2A",
		shiftDown: "\x1b[1;2B",
		pageUp: "\x1b[5~",
		pageDown: "\x1b[6~",
		home: "\x1b[H",
		enter: "\r",
		ctrlD: "\x04",
		esc: "\x1b",
	};
	const WIDTH = 100;
	const numbered = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}\n`).join("");

	/** Overlay over `tasks` in a terminal of `rows` rows; 30 rows leave 23 body rows and a 20-line log pane. */
	function open(tasks: Task[], rows = 30) {
		const rt = new Runtime({} as never);
		for (const t of tasks) rt.manager.tasks.set(t.rec.id, t);
		const closed: ManagerAction[] = [];
		const tui = { requestRender: () => {}, terminal: { rows } };
		const overlay = new TasksOverlay(rt, tui as never, th, new KeybindingsManager(TUI_KEYBINDINGS), (a) => closed.push(a));
		const body = () => overlay.render(WIDTH).slice(2, -2);
		return {
			rt,
			overlay,
			closed,
			press: (...keys: string[]) => keys.forEach((k) => overlay.handleInput(k)),
			title: () => overlay.render(WIDTH)[1],
			/** Log lines shown, below the three task header rows. */
			log: () =>
				body()
					.slice(3)
					.map((l) => l.split("│")[2].trim())
					.filter(Boolean),
			list: () => body().map((l) => l.split("│")[1].trim()),
			mouse: (type: "wheel" | "click", x: number, y: number, wheelDelta?: number) =>
				overlay.handleMouse({ type, button: type === "click" ? "left" : "none", x, y, screenX: x, screenY: y, width: WIDTH, height: 27, shift: false, alt: false, ctrl: false, wheelDelta }),
		};
	}

	test("frame, footer included, fits in the 90% of the terminal Pi leaves an overlay", () => {
		for (const rows of [20, 24, 30, 35, 50]) {
			const m = open([task("brun0001")], rows);
			const lines = m.overlay.render(WIDTH);
			expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.9));
			expect(lines.at(-1)).toMatch(/^╰─+╯$/);
			expect(lines.at(-2)).toContain("pg scroll");
			m.overlay.dispose();
		}
		const wide = open([task("brun0001")]);
		expect(wide.overlay.render(140).at(-2)).toContain("shift+↑↓ pgup pgdn scroll · enter follow");
		wide.overlay.dispose();
	});

	test("log scrolling is clamped to the log; reaching the end resumes follow", () => {
		const m = open([task("brun0001", {}, numbered(1, 100))]);
		expect(m.title()).toContain("following");
		expect(m.log()).toEqual(numbered(81, 100).trimEnd().split("\n"));

		m.press(KEY.pageUp);
		expect(m.title()).toContain("paused · lines 62-81 of 100");
		// Far more presses than the log has pages stop at the first line.
		m.press(...Array<string>(10).fill(KEY.pageUp));
		expect(m.title()).toContain("lines 1-20 of 100");
		m.press(KEY.pageDown);
		expect(m.title()).toContain("lines 20-39 of 100");

		m.press(KEY.home, KEY.shiftDown);
		expect(m.title()).toContain("lines 2-21 of 100");
		m.press(KEY.shiftUp, KEY.shiftUp, KEY.ctrlD);
		expect(m.title()).toContain("lines 11-30 of 100");
		m.press("g");
		expect(m.log()[0]).toBe("line 1");

		m.press("G");
		expect(m.title()).toContain("following");
		expect(m.log().at(-1)).toBe("line 100");
		// Scrolling down at the end stays in follow mode.
		m.press(KEY.pageDown, KEY.shiftDown);
		expect(m.title()).toContain("following");
		m.overlay.dispose();
	});

	test("a paused view holds still while the task writes; follow shows the live end", () => {
		const t = task("brun0001", {}, numbered(1, 100));
		const m = open([t]);
		m.press(KEY.shiftUp);
		t.ring.append(numbered(101, 150));
		expect(m.title()).toContain("paused · lines 80-99 of 100");
		m.press(KEY.shiftDown);
		expect(m.title()).toContain("following");
		expect(m.log().at(-1)).toBe("line 150");

		// enter pauses in place, enter again resumes.
		m.press(KEY.enter);
		t.ring.append(numbered(151, 160));
		expect(m.title()).toContain("paused · lines 131-150 of 150");
		m.press(KEY.enter);
		expect(m.log().at(-1)).toBe("line 160");

		// A log shorter than the pane cannot scroll, but enter still pauses it.
		const short = open([task("bshort01", {}, "only\n")]);
		short.press(KEY.pageUp);
		expect(short.title()).toContain("following");
		short.press(KEY.enter);
		expect(short.title()).toContain("paused · lines 1-1 of 1");
		m.overlay.dispose();
		short.overlay.dispose();
	});

	test("the list scrolls with the selection, which stays on its task when the list changes", () => {
		const id = (i: number) => `b${String(i).padStart(7, "0")}`;
		const m = open(Array.from({ length: 40 }, (_, i) => task(id(i), { startedAt: i }, `out ${i}\n`)));
		const selected = () => m.list().filter((l) => l.startsWith("▶"));
		// Newest first: row 0 is task 39.
		expect(selected()).toHaveLength(1);
		expect(selected()[0].endsWith(` ${id(39)} ${id(39)}`)).toBe(true);
		expect(m.list()[0]).toBe(selected()[0]);

		m.press(...Array<string>(30).fill(KEY.down));
		expect(selected()[0]).toContain(id(9));
		expect(m.list().at(-1)).toContain(id(9));
		expect(m.log()).toEqual(["out 9"]);

		// A task started meanwhile lands on top; the selection does not slide to its neighbour.
		const added = task(id(99), { startedAt: 99 });
		m.rt.manager.tasks.set(added.rec.id, added);
		expect(selected()[0]).toContain(id(9));

		m.press(...Array<string>(60).fill(KEY.up));
		expect(selected()[0]).toContain(id(99));
		expect(m.list()[0]).toContain(id(99));
		m.press(...Array<string>(60).fill(KEY.down));
		expect(selected()[0]).toContain(id(0));

		// Selecting another task resumes follow.
		m.press(KEY.enter, KEY.up);
		expect(m.title()).toContain("following");
		m.overlay.dispose();
	});

	test("mouse: wheel scrolls the log or moves the selection, a click selects a row", () => {
		const m = open([task("bold0001", { startedAt: 1 }, numbered(1, 100)), task("bnew0001", { startedAt: 2 }, numbered(1, 100))]);
		const selected = () => m.list().find((l) => l.startsWith("▶"));
		m.overlay.render(WIDTH);
		expect(m.mouse("wheel", 60, 10, -3)).toEqual({ handled: true });
		expect(m.title()).toContain("paused · lines 78-97 of 100");
		m.mouse("wheel", 60, 10, 50);
		expect(m.title()).toContain("following");

		expect(selected()).toContain("bnew0001");
		m.mouse("wheel", 5, 10, 1);
		expect(selected()).toContain("bold0001");
		// Row 0 of the body is y = 2, below the border and the title.
		expect(m.mouse("click", 5, 2)).toEqual({ handled: true });
		expect(selected()).toContain("bnew0001");
		// Empty rows and the log pane take no click.
		expect(m.mouse("click", 5, 8)).toBeUndefined();
		expect(m.mouse("click", 60, 2)).toBeUndefined();
		m.overlay.dispose();
	});

	test("esc and q close", () => {
		for (const key of [KEY.esc, "q"]) {
			const m = open([task("brun0001")]);
			m.press(key);
			expect(m.closed).toEqual([undefined]);
		}
	});
});

describe("notification card", () => {
	const bgTheme = { ...th, bg: (c: string, s: string) => `[${c}]${s}` } as unknown as Theme;
	const hint = (_k: string, d: string) => `ctrl+o ${d}`;
	const opts = (expanded: boolean) => ({ expanded, outputPad: 1, keyHint: hint });
	const message = (details: NotificationDetails, content: string): NotificationMessage => ({
		role: "custom",
		customType: NOTIFICATION_TYPE,
		content,
		display: true,
		details,
		timestamp: 0,
	});
	const notice = (r: TaskRecord, tail: string) =>
		message(
			{
				items: [
					{
						id: r.id,
						kind: "terminal",
						summary: terminalSummary(r),
						level: terminalLevel(r),
						label: r.label,
						detail: terminalDetail(r),
					},
				],
			},
			terminalBlock(r, tail),
		);
	const render = (r: TaskRecord, tail: string, expanded: boolean) =>
		renderNotification(notice(r, tail), opts(expanded), bgTheme)
			.render(120)
			.map((l) => l.trimEnd());
	const click = (card: Component, y: number, button: "left" | "right" = "left") =>
		card.handleMouse?.({ type: "click", button, x: 0, y, screenX: 0, screenY: y, width: 120, height: 20, shift: false, alt: false, ctrl: false });
	const tail = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
	const done = rec("bdone001", { label: "npm test", executed: "npm test", status: "completed", exitCode: 0, startedAt: 0, endedAt: 4000 });

	test("collapsed: custom-message background, header and a 5-line preview", () => {
		const lines = render(done, tail, false);
		expect(lines.every((l) => l.includes("[customMessageBg]"))).toBe(true);
		const text = lines.map((l) => l.replaceAll("[customMessageBg]", "")).join("\n");
		expect(text).toContain("✓ task npm test (bdone001) · completed exit 0 · 4s");
		expect(text).toContain("... (3 earlier lines, ctrl+o to expand)");
		expect(text).toContain("line 8");
		expect(text).not.toContain("line 3");
		expect(text).not.toContain("log:");
	});
	test("expanded: command, whole tail and log path", () => {
		const text = render(done, tail, true).join("\n");
		expect(text).toContain("$ npm test");
		expect(text).toContain("line 1");
		expect(text).toContain("log: /dev/null");
		expect(text).not.toContain("to expand");
	});
	test("failed task shows error mark on the custom-message background", () => {
		const failed = { ...done, status: "failed" as const, exitCode: 1 };
		const lines = render(failed, "boom", false);
		expect(lines[0]).toContain("[customMessageBg]");
		expect(lines.join("\n")).toContain("✗ task npm test");
	});
	test("older notices without label fall back to the summary", () => {
		const card = renderNotification(
			message(
				{ items: [{ id: "bold0001", kind: "terminal", summary: "bold0001 completed exit 0 2s · build", level: "info" }] },
				'<task-notification id="bold0001">\nbuild — $ make\nok\nlog: /x.log\n</task-notification>',
			),
			opts(false),
			bgTheme,
		);
		const text = card.render(120).join("\n");
		expect(text).toContain("✓ task bold0001 completed exit 0 2s · build");
		expect(text).toContain("ok");
	});
	test("left click toggles one card, also on its padding row; other buttons do nothing", () => {
		const msg = notice(done, tail);
		const card = renderNotification(msg, opts(false), bgTheme);
		const text = () => card.render(120).join("\n");
		expect(text()).not.toContain("line 1");
		expect(click(card, 0, "right")).toBeUndefined();
		expect(click(card, 0)).toMatchObject({ handled: true });
		expect(text()).toContain("line 1");
		expect(text()).toContain("log: /dev/null");
		click(card, 3);
		expect(text()).not.toContain("line 1");
		// another card of the same task is untouched
		expect(render(done, tail, false).join("\n")).not.toContain("line 1");
	});
	test("a click survives re-renders until the global expand state changes", () => {
		const msg = notice(done, tail);
		click(renderNotification(msg, opts(false), bgTheme), 0);
		// Pi rebuilds the card (resize, theme): the click still holds
		expect(renderNotification(msg, opts(false), bgTheme).render(120).join("\n")).toContain("line 1");
		// ctrl+o expands everything, then collapses everything: the click is gone
		expect(renderNotification(msg, opts(true), bgTheme).render(120).join("\n")).toContain("line 1");
		expect(renderNotification(msg, opts(false), bgTheme).render(120).join("\n")).not.toContain("line 1");
	});
});
