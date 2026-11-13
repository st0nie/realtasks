import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { backgroundInput, registerShortcuts } from "../src/commands.ts";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { backgroundHint, foregroundWindowMs, registerBash } from "../src/tools/bash.ts";
import { humanMs, inputPreview, statusRow, waitLine } from "../src/tools/render.ts";

const th = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const base = { label: "npm test", id: "b7f3k9a2", capMs: 600_000 };

describe("render helpers", () => {
	test("humanMs never shows raw milliseconds for real caps", () => {
		expect(humanMs(600_000)).toBe("10m");
		expect(humanMs(5_000)).toBe("5s");
		expect(humanMs(1_500)).toBe("1.5s");
		expect(humanMs(3_600_000)).toBe("1h");
		expect(humanMs(90_000)).toBe("1m30s");
	});
	test("waiting line shows label, elapsed, cap and last output", () => {
		const l = waitLine({ ...base, phase: "waiting", waitedMs: 72_000, last: "test 31 ok" }, th, 0);
		expect(l).toBe("· waiting for npm test · 1m12s of 10m │ test 31 ok");
	});
	test("done lines say why the wait ended", () => {
		expect(waitLine({ ...base, phase: "done", waitedMs: 74_000, reason: "exit", status: "completed", exitCode: 0 }, th)).toBe(
			"✓ npm test completed exit 0 · waited 1m14s",
		);
		expect(waitLine({ ...base, phase: "done", waitedMs: 3_000, reason: "match" }, th)).toBe("✓ npm test output matched · waited 3s");
		expect(waitLine({ ...base, phase: "done", waitedMs: 600_000, reason: "timeout" }, th)).toBe("… still running · waited 10m00s (timeout)");
		expect(waitLine({ ...base, phase: "done", waitedMs: 4_000, reason: "abort" }, th)).toBe("■ wait cancelled · 4s");
	});
	test("collapsed task_output row is the task status", () => {
		expect(statusRow({ label: "npm test", id: "b7f3k9a2", status: "failed", exitCode: 1, cursor: 0 }, th)).toBe("· npm test failed exit 1");
		expect(statusRow({ label: "dev", id: "bgkrw0t2", status: "running", cursor: 10 }, th)).toBe("· dev running");
	});
	test("input preview", () => {
		expect(inputPreview("print(2+2)\\r", undefined, undefined)).toBe('"print(2+2)⏎"');
		expect(inputPreview(undefined, ["ctrl-c"], true)).toBe("keys ctrl-c + EOF");
	});
});

describe("foreground bash hint and window", () => {
	test("hint waits 2 s, counts down to the timeout, names the key only when bound", () => {
		expect(backgroundHint("ctrl+b", 1_000, 120_000)).toBeUndefined();
		expect(backgroundHint("ctrl+b", 12_000, 120_000)).toBe("ctrl+b to background · auto in 1m48s");
		expect(backgroundHint(undefined, 12_000, 120_000)).toBe("backgrounds in 1m48s");
		expect(backgroundHint("ctrl+b", 119_900, 120_000)).toBe("ctrl+b to background · auto in 1s");
	});
	test("timeout seconds become the window; default and clamps follow Claude Code", () => {
		expect(foregroundWindowMs(undefined, 120_000, 600_000)).toBe(120_000);
		expect(foregroundWindowMs(300, 120_000, 600_000)).toBe(300_000);
		expect(foregroundWindowMs(3600, 120_000, 600_000)).toBe(600_000);
		expect(foregroundWindowMs(0.1, 120_000, 600_000)).toBe(1000);
		expect(foregroundWindowMs(-5, 120_000, 600_000)).toBe(120_000);
	});
	test("shortcut registration: free keys register, editor keys are shared, other clashes warn", () => {
		const mk = (shortcuts: Record<string, string>) => {
			const registered: string[] = [];
			const rt = new Runtime({ registerShortcut: (key: string) => registered.push(key) } as never);
			rt.manager.cfg = resolveConfig({ shortcuts: { manager: "off", ...shortcuts } });
			return { rt, registered };
		};
		const editor = { "tui.editor.cursorLeft": ["left", "ctrl+b"] as never };

		const free = mk({ background: "ctrl+shift+b" });
		expect(registerShortcuts(free.rt.pi, free.rt, editor)).toEqual([]);
		expect(free.registered).toEqual(["ctrl+shift+b"]);
		expect([free.rt.backgroundKey, free.rt.backgroundGated]).toEqual(["ctrl+shift+b", false]);

		const off = mk({ background: "off" });
		registerShortcuts(off.rt.pi, off.rt, editor);
		expect(off.rt.backgroundKey).toBeUndefined();

		// The default: ctrl+b is cursor-left, so it is shared through the input listener, not registered.
		const shared = mk({});
		expect(registerShortcuts(shared.rt.pi, shared.rt, editor)).toEqual([]);
		expect(shared.registered).toEqual([]);
		expect([shared.rt.backgroundKey, shared.rt.backgroundGated]).toEqual(["ctrl+b", true]);

		const app = mk({ background: "ctrl+o" });
		expect(registerShortcuts(app.rt.pi, app.rt, { "app.tools.expand": "ctrl+o" })[0]).toContain("Pi's app.tools.expand; not registered");
		expect([app.rt.backgroundKey, app.rt.backgroundGated]).toEqual([undefined, false]);

		const both = mk({});
		expect(registerShortcuts(both.rt.pi, both.rt, { ...editor, "app.custom": "ctrl+b" })[0]).toContain("not registered");
		expect(both.rt.backgroundKey).toBeUndefined();

		// Only the background key is shared; the manager never takes an editor key.
		const manager = mk({ background: "off", manager: "ctrl+b" });
		expect(registerShortcuts(manager.rt.pi, manager.rt, editor)[0]).toContain("shortcuts.manager");
		expect(manager.registered).toEqual([]);
	});
	test("shared ctrl+b backgrounds only on an empty input, with a foreground command, manager closed", () => {
		const rt = new Runtime({} as never);
		let text = "";
		let promoted = 0;
		const notes: string[] = [];
		const ctx = { ui: { getEditorText: () => text, notify: (m: string) => notes.push(m) } };
		const input = backgroundInput(rt, ctx as never, "Ctrl+B");
		const run = () => {
			rt.foreground.set("call1", {
				task: {} as never,
				promote: () => {
					promoted++;
					rt.foreground.delete("call1");
				},
			});
		};
		const CTRL_B = "\x02";

		// Nothing running: the key stays cursor-left, silently.
		expect(input(CTRL_B)).toBeUndefined();
		run();
		text = "draft";
		expect(input(CTRL_B)).toBeUndefined();
		text = "";
		rt.managerOpen = true;
		expect(input(CTRL_B)).toBeUndefined();
		rt.managerOpen = false;
		// Other keys and the kitty key release of ctrl+b pass through.
		expect(input("b")).toBeUndefined();
		expect(input("\x1b[98;5:3u")).toBeUndefined();
		expect([promoted, notes]).toEqual([0, []]);

		expect(input(CTRL_B)).toEqual({ consume: true });
		expect([promoted, notes]).toEqual([1, ["Backgrounded 1 command"]]);
		// Promoted: nothing is left in the foreground, so the next press is cursor-left again.
		expect(input(CTRL_B)).toBeUndefined();
	});
	test("renderResult computes hint from context.state.startedAt and windowMs on partial results", () => {
		initTheme();
		let registered: { renderResult?: (...args: never[]) => { render(w: number): string[] } } | undefined;
		const rt = new Runtime({
			registerTool: (def: never) => {
				registered = def;
			},
		} as never);
		rt.backgroundKey = "ctrl+b";
		registerBash(rt);
		const render = registered?.renderResult;
		expect(render).toBeDefined();
		const state: { startedAt?: number; interval?: ReturnType<typeof setInterval> } = {
			startedAt: Date.now() - 12_000,
		};
		try {
			const c = render!(
				{ content: [], details: { windowMs: 120_000 } } as never,
				{ expanded: false, isPartial: true } as never,
				th as never,
				{ state, showImages: false, isError: false, executionStarted: true, invalidate: () => {} } as never,
			);
			const out = c.render(120).join("\n");
			expect(out).toContain("ctrl+b to background · auto in 1m48s");
		} finally {
			if (state.interval) clearInterval(state.interval);
		}
	});
});
