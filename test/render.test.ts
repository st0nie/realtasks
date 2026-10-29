import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { registerShortcuts } from "../src/commands.ts";
import { resolveConfig } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import { backgroundHint, foregroundWindowMs } from "../src/tools/bash.ts";
import { humanMs, inputPreview, waitLine } from "../src/tools/render.ts";

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
		expect(waitLine({ ...base, phase: "done", waitedMs: 3_000, reason: "grep" }, th)).toBe("✓ grep matched · waited 3s");
		expect(waitLine({ ...base, phase: "done", waitedMs: 600_000, reason: "cap" }, th)).toBe("… still running · waited 10m00s (cap)");
	});
	test("input preview", () => {
		expect(inputPreview("print(2+2)\\r", undefined, undefined)).toBe('"print(2+2)⏎"');
		expect(inputPreview(undefined, ["ctrl-c"], true)).toBe("keys ctrl-c + EOF");
	});
});

describe("foreground bash hint and window", () => {
	test("hint waits 2 s, counts down to the timeout, names the key only when bound", () => {
		expect(backgroundHint("ctrl+shift+b", 1_000, 120_000)).toBeUndefined();
		expect(backgroundHint("ctrl+shift+b", 12_000, 120_000)).toBe("ctrl+shift+b to background · auto in 1m48s");
		expect(backgroundHint(undefined, 12_000, 120_000)).toBe("backgrounds in 1m48s");
		expect(backgroundHint("ctrl+shift+b", 119_900, 120_000)).toBe("ctrl+shift+b to background · auto in 1s");
	});
	test("timeout seconds become the window; default and clamps follow Claude Code", () => {
		expect(foregroundWindowMs(undefined, 120_000, 600_000)).toBe(120_000);
		expect(foregroundWindowMs(300, 120_000, 600_000)).toBe(300_000);
		expect(foregroundWindowMs(3600, 120_000, 600_000)).toBe(600_000);
		expect(foregroundWindowMs(0.1, 120_000, 600_000)).toBe(1000);
		expect(foregroundWindowMs(-5, 120_000, 600_000)).toBe(120_000);
	});
	test("backgroundKey is set only when the shortcut registers", () => {
		const mk = (background: string) => {
			const rt = new Runtime({ registerShortcut: () => {} } as never);
			rt.manager.cfg = resolveConfig({ shortcuts: { background } });
			return rt;
		};
		const ok = mk("ctrl+shift+b");
		registerShortcuts(ok.pi, ok, {});
		expect(ok.backgroundKey).toBe("ctrl+shift+b");
		const off = mk("off");
		registerShortcuts(off.pi, off, {});
		expect(off.backgroundKey).toBeUndefined();
		const clash = mk("ctrl+b");
		expect(registerShortcuts(clash.pi, clash, { "tui.editor.cursorLeft": ["ctrl+b"] })[0]).toContain("not registered");
		expect(clash.backgroundKey).toBeUndefined();
	});
});
