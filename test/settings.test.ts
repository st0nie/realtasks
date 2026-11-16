import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, pruneDefaults, userConfigPath, writeConfigFile } from "../src/config.ts";
import { Runtime } from "../src/runtime.ts";
import {
	formatDurationValue,
	formatSizeValue,
	parseDurationValue,
	parseSizeValue,
	ROWS,
	SettingsPanel,
	settingsSummary,
} from "../src/settings.ts";
import { keyIdProblem, planShortcut, shortcutProblem } from "../src/shortcuts.ts";
import { tmpDir, writeUserConfig } from "./helpers.ts";

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", esc: "\x1b", ctrlU: "\x15" };
const th = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const EDITOR = { "tui.editor.cursorLeft": ["left", "ctrl+b"], "app.tools.expand": "ctrl+o" } as never;

describe("setting values", () => {
	test("durations round-trip and accept loose input", () => {
		expect([30_000, 120_000, 5_400_000, 90_000, 3_600_000].map(formatDurationValue)).toEqual(["30s", "2m", "1h30m", "1m30s", "1h"]);
		expect(parseDurationValue("90")).toBe(90_000);
		expect(parseDurationValue("1h 30m")).toBe(5_400_000);
		expect(parseDurationValue("1.5h")).toBe(5_400_000);
		expect(parseDurationValue("2M")).toBe(120_000);
		expect(parseDurationValue("soon")).toBeUndefined();
		expect(parseDurationValue("5x")).toBeUndefined();
		for (const ms of [1000, 45_000, 600_000, 3_723_000]) expect(parseDurationValue(formatDurationValue(ms))).toBe(ms);
	});
	test("sizes round-trip; a bare number is megabytes", () => {
		expect([50 * 1024 ** 2, 1024 ** 3, 64 * 1024].map(formatSizeValue)).toEqual(["50 MB", "1 GB", "64 KB"]);
		expect(parseSizeValue("200")).toBe(200 * 1024 ** 2);
		expect(parseSizeValue("2 gb")).toBe(2 * 1024 ** 3);
		expect(parseSizeValue("1.5G")).toBe(1.5 * 1024 ** 3);
		expect(parseSizeValue("512 KB")).toBe(512 * 1024);
		expect(parseSizeValue("lots")).toBeUndefined();
	});
	test("summary lists every row and the log directory", () => {
		const s = settingsSummary(DEFAULTS, "/x/config.json");
		expect(s).toContain("realtasks settings (/x/config.json)");
		expect(s).toContain("Foreground window: 2m");
		expect(s).toContain("Log size limit: 50 MB");
		expect(s).toContain("Log retention: 7 days");
		expect(s).toContain("Background shortcut: ctrl+b");
		expect(s.split("\n")).toHaveLength(ROWS.length + 2);
	});
});

describe("shortcut keys", () => {
	test("key ids follow Pi's parser; keys that type text are refused", () => {
		for (const ok of ["ctrl+b", "ctrl+shift+b", "alt+t", "f6", "shift+down", "ctrl++", "super+k", "pageUp", "shift+tab"]) {
			expect(keyIdProblem(ok)).toBeUndefined();
		}
		expect(keyIdProblem("hyper+b")).toContain("Unknown modifier");
		expect(keyIdProblem("ctrl+ctrl+b")).toContain("Repeated modifier");
		expect(keyIdProblem("ctrl+bee")).toContain("Unknown key");
		expect(keyIdProblem("b")).toContain("types text");
		expect(keyIdProblem("shift+b")).toContain("types text");
		expect(keyIdProblem("space")).toContain("types text");
	});
	test("only the background key may share an editor key", () => {
		expect(planShortcut("background", "ctrl+b", EDITOR)).toEqual({ kind: "shared" });
		expect(planShortcut("manager", "ctrl+b", EDITOR)).toEqual({ kind: "clash", action: "tui.editor.cursorLeft" });
		expect(planShortcut("background", "ctrl+o", EDITOR)).toEqual({ kind: "clash", action: "app.tools.expand" });
		expect(planShortcut("background", "ctrl+shift+b", EDITOR)).toEqual({ kind: "free" });
		expect(shortcutProblem("background", "ctrl+b", EDITOR)).toBeUndefined();
		expect(shortcutProblem("manager", "off", EDITOR)).toBeUndefined();
		expect(shortcutProblem("background", "ctrl+o", EDITOR)).toContain("Pi's app.tools.expand");
	});
});

describe("config file writes", () => {
	test("pruneDefaults keeps changed and unknown keys only", () => {
		expect(
			pruneDefaults({
				defaultTimeoutMs: 120_000,
				maxRunning: 4,
				rtkPassthroughFor: ["tty", "ready"],
				shortcuts: { background: "ctrl+b", manager: "f6" },
				dir: "/logs",
				extra: true,
			}),
		).toEqual({ maxRunning: 4, shortcuts: { manager: "f6" }, dir: "/logs", extra: true });
		expect(pruneDefaults({ rtkPassthroughFor: ["ready"], shortcuts: { background: "ctrl+b" } })).toEqual({ rtkPassthroughFor: ["ready"] });
	});
	test("writeConfigFile creates the directory and leaves no temp file", () => {
		const { dir, cleanup } = tmpDir();
		try {
			const path = join(dir, "a", "b", "config.json");
			writeConfigFile(path, { maxRunning: 4 });
			writeConfigFile(path, { maxRunning: 8 });
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ maxRunning: 8 });
			expect(readdirSync(join(dir, "a", "b"))).toEqual(["config.json"]);
		} finally {
			cleanup();
		}
	});
});

describe("/tasks settings panel", () => {
	let agent = "";
	beforeAll(() => initTheme());
	afterEach(() => {
		if (agent) rmSync(agent, { recursive: true, force: true });
		delete process.env.PI_CODING_AGENT_DIR;
	});

	function open(config: Record<string, unknown> = {}, opts: { cwd?: string; trusted?: boolean } = {}) {
		agent = writeUserConfig(config);
		const rt = new Runtime({} as never);
		rt.loadConfig(opts.cwd ?? agent, opts.trusted ?? false);
		let closed = 0;
		const panel = new SettingsPanel({
			rt,
			tui: { requestRender: () => {}, terminal: { rows: 40, columns: 120 } } as never,
			theme: th,
			cwd: opts.cwd ?? agent,
			trusted: opts.trusted ?? false,
			resolved: EDITOR,
			done: () => closed++,
		});
		const press = (...keys: string[]) => keys.forEach((k) => panel.handleInput(k));
		return {
			rt,
			panel,
			press,
			type: (text: string) => press(...text),
			/** Move from the first row to `id`. */
			goto: (id: string) => press(...Array<string>(ROWS.findIndex((r) => r.id === id)).fill(KEY.down)),
			// Plain text: no colors, no cursor markers.
			text: () =>
				panel
					.render(120)
					.join("\n")
					.replace(/\x1b\[[0-9;]*m|\x1b_[^\x07]*\x07/g, ""),
			file: () => JSON.parse(readFileSync(userConfigPath(), "utf8")) as Record<string, unknown>,
			closed: () => closed,
		};
	}

	test("shows every row with the user's values and the config path", () => {
		const p = open({ maxRunning: 4, logRetentionDays: 0 });
		const text = p.text();
		expect(text).toContain(`realtasks settings (${userConfigPath()})`);
		for (const row of ROWS) expect(text).toContain(row.label);
		expect(text).toContain("keep forever");
		expect(text).toMatch(/Running task limit\s+4/);
		p.press(KEY.esc);
		expect(p.closed()).toBe(1);
	});

	test("a cycled row saves at once and reloads the config", () => {
		const p = open({ extra: "kept" });
		p.goto("defaultNotify");
		p.press(KEY.enter);
		expect(p.file()).toEqual({ extra: "kept", defaultNotify: "passive" });
		expect(p.rt.cfg.defaultNotify).toBe("passive");
		// Back to the default: the key leaves the file.
		p.press(KEY.enter, KEY.enter);
		expect(p.file()).toEqual({ extra: "kept" });
		expect(p.rt.cfg.defaultNotify).toBe("wake");
	});

	test("rtk rows toggle one feature of rtkPassthroughFor", () => {
		const p = open();
		p.goto("rtk.tty");
		p.press(KEY.enter);
		expect(p.file()).toEqual({ rtkPassthroughFor: ["ready"] });
		expect(p.rt.cfg.rtkPassthroughFor).toEqual(["ready"]);
		p.press(KEY.enter);
		expect(p.file()).toEqual({});
	});

	test("a preset from the submenu is saved; the default is marked", () => {
		const p = open();
		p.press(KEY.enter);
		expect(p.text()).toContain("2m (default)");
		// Presets: 30s 1m 2m 5m 10m; the current value (2m) is selected.
		p.press(KEY.down, KEY.enter);
		expect(p.file()).toEqual({ defaultTimeoutMs: 300_000 });
		expect(p.rt.cfg.defaultTimeoutMs).toBe(300_000);
		expect(p.text()).toMatch(/Foreground window\s+5m/);
	});

	test("a custom value is parsed, checked against the other window, then saved", () => {
		const p = open({ maxTimeoutMs: 300_000 });
		// Presets: 30s 1m 2m 5m 10m, then Custom…; the current value (2m) is selected.
		p.press(KEY.enter, KEY.down, KEY.down, KEY.down);
		expect(p.text()).toContain("→ Custom…");
		p.press(KEY.enter, KEY.ctrlU);
		p.type("20m");
		p.press(KEY.enter);
		expect(p.text()).toContain("Longer than the longest foreground window (5m).");
		expect(existsSync(userConfigPath()) && p.file()).toEqual({ maxTimeoutMs: 300_000 });
		p.press(KEY.ctrlU);
		p.type("soon");
		p.press(KEY.enter);
		expect(p.text()).toContain("Enter a duration such as 90s, 5m or 1h30m.");
		p.press(KEY.ctrlU);
		p.type("1m30s");
		p.press(KEY.enter);
		expect(p.file()).toEqual({ maxTimeoutMs: 300_000, defaultTimeoutMs: 90_000 });
		expect(p.text()).toMatch(/Foreground window\s+1m30s/);
	});

	test("shortcuts are checked with Pi's bindings and against each other", () => {
		const p = open();
		p.goto("shortcuts.manager");
		// Presets: shift+down off, then Custom….
		p.press(KEY.enter, KEY.down, KEY.down, KEY.enter);
		expect(p.text()).toContain("> shift+down");
		p.press(KEY.ctrlU);
		p.type("ctrl+o");
		p.press(KEY.enter);
		expect(p.text()).toContain("ctrl+o is Pi's app.tools.expand");
		p.press(KEY.ctrlU);
		p.type("ctrl+b");
		p.press(KEY.enter);
		expect(p.text()).toContain("ctrl+b is already the background shortcut.");
		p.press(KEY.ctrlU);
		p.type("f6");
		p.press(KEY.enter);
		expect(p.file()).toEqual({ shortcuts: { manager: "f6" } });
		expect(p.rt.cfg.shortcuts).toEqual({ background: "ctrl+b", manager: "f6" });
	});

	test("an invalid user file is never overwritten", () => {
		const p = open();
		writeFileSync(userConfigPath(), "{ broken");
		p.goto("defaultNotify");
		p.press(KEY.enter);
		expect(readFileSync(userConfigPath(), "utf8")).toBe("{ broken");
		expect(p.text()).toContain("is not valid JSON");
		expect(p.text()).toMatch(/Default notification\s+wake/);
	});

	test("a trusted project override is named in the row description", () => {
		const { dir, cleanup } = tmpDir();
		try {
			mkdirSync(join(dir, ".pi", "realtasks"), { recursive: true });
			writeFileSync(join(dir, ".pi", "realtasks", "config.json"), JSON.stringify({ maxRunning: 2 }));
			const p = open({ maxRunning: 8 }, { cwd: dir, trusted: true });
			p.goto("maxRunning");
			expect(p.text()).toMatch(/Running task limit\s+8/);
			expect(p.text()).toContain("In effect: 2, set by the project");
			expect(p.rt.cfg.maxRunning).toBe(2);
		} finally {
			cleanup();
		}
	});
});
