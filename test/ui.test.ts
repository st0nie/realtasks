import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { TaskManager } from "../src/manager.ts";
import { Task } from "../src/task.ts";
import type { TaskRecord } from "../src/types.ts";
import { dockLines, FRAME_MS, LINGER_MS, SPINNER, spinnerFrame, statusCounts } from "../src/ui.ts";
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
		expect(s).toBe("✱1 ✓1 ✗1");
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
