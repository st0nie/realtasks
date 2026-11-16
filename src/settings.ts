// /tasks settings: a settings panel over <agentDir>/realtasks/config.json.

import { DynamicBorder, getSelectListTheme, getSettingsListTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	SelectList,
	SettingsList,
	type Component,
	type Focusable,
	type SelectItem,
	type SettingItem,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
	mergeConfig,
	MINIMUMS,
	projectConfigPath,
	pruneDefaults,
	readConfigFile,
	resolveConfig,
	userConfigPath,
	writeConfigFile,
	type TasksConfig,
} from "./config.ts";
import type { Runtime } from "./runtime.ts";
import { piBindings, shortcutProblem, type ResolvedBindings, type ShortcutSetting } from "./shortcuts.ts";

type Raw = Record<string, unknown>;

// ── value codecs ───────────────────────────────────────────────
// Every codec round-trips what its parser produces: parse(format(n)) === n.

interface Codec {
	format(n: number): string;
	parse(text: string): number | undefined;
	/** What a custom value looks like, for the input placeholder and errors. */
	hint: string;
}

const DURATION_UNITS = [
	["h", 3_600_000],
	["m", 60_000],
	["s", 1000],
] as const;

/** `1h30m`, `2m`, `45s`, `1m30s`; under a second as `500ms`. */
export function formatDurationValue(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	let rest = Math.round(ms / 1000) * 1000;
	let out = "";
	for (const [unit, size] of DURATION_UNITS) {
		const n = Math.floor(rest / size);
		if (n > 0) out += `${n}${unit}`;
		rest -= n * size;
	}
	return out;
}

/** `90s`, `5m`, `1h30m`, `1.5h` or a bare number of seconds, rounded to whole seconds. */
export function parseDurationValue(text: string): number | undefined {
	const t = text.trim().toLowerCase().replaceAll(" ", "");
	if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t)) * 1000;
	if (!/^(\d+(\.\d+)?[hms])+$/.test(t)) return undefined;
	let ms = 0;
	for (const m of t.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
		ms += Number(m[1]) * (DURATION_UNITS.find(([u]) => u === m[2])?.[1] ?? 0);
	}
	return Math.round(ms / 1000) * 1000;
}

function durationCodec(zero?: string): Codec {
	return {
		format: (ms) => (ms === 0 && zero ? zero : formatDurationValue(ms)),
		parse: (text) => (zero && text.trim().toLowerCase() === zero ? 0 : parseDurationValue(text)),
		hint: "a duration such as 90s, 5m or 1h30m",
	};
}

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/** `1 GB`, `50 MB`, or whole kilobytes when the size is not a whole number of megabytes. */
export function formatSizeValue(bytes: number): string {
	if (bytes >= GB && bytes % GB === 0) return `${bytes / GB} GB`;
	if (bytes % MB === 0) return `${bytes / MB} MB`;
	return `${Math.round(bytes / KB)} KB`;
}

/** `200 MB`, `2 GB`, `512 KB`, or a bare number of megabytes, rounded to whole kilobytes. */
export function parseSizeValue(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)\s*(kb|k|mb|m|gb|g)?$/i.exec(text.trim());
	if (!m) return undefined;
	const unit = (m[2] ?? "mb").toLowerCase()[0];
	let size = MB;
	if (unit === "g") size = GB;
	else if (unit === "k") size = KB;
	return Math.round((Number(m[1]) * size) / KB) * KB;
}

const sizeCodec: Codec = { format: formatSizeValue, parse: parseSizeValue, hint: "a size such as 200 MB or 2 GB" };

const secondsCodec: Codec = {
	format: (s) => formatDurationValue(s * 1000),
	parse: (text) => {
		const ms = parseDurationValue(text);
		return ms === undefined ? undefined : ms / 1000;
	},
	hint: "a duration such as 30s or 2m",
};

const FOREVER = "keep forever";
const daysCodec: Codec = {
	format: (n) => {
		if (n === 0) return FOREVER;
		return n === 1 ? "1 day" : `${n} days`;
	},
	parse: (text) => {
		const t = text.trim().toLowerCase();
		if (t === FOREVER || t === "forever") return 0;
		const m = /^(\d+(?:\.\d+)?)\s*(d|days?)?$/.exec(t);
		return m ? Number(m[1]) : undefined;
	},
	hint: "a number of days, or 0 to keep logs forever",
};

const countCodec: Codec = {
	format: (n) => String(n),
	parse: (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined),
	hint: "a whole number",
};

// ── rows ───────────────────────────────────────────────────────

/** One setting: how it shows, which values it offers, how it is checked and written. */
interface Row {
	id: string;
	label: string;
	description: string;
	show(c: TasksConfig): string;
	/** Values `enter` cycles through, for rows without a submenu. */
	cycle?: string[];
	/** Submenu values; a row with presets also offers a custom value. */
	presets?: string[];
	placeholder?: string;
	parseCustom?(text: string): { value: string } | { error: string };
	/** Why `value` is refused given the user's config, or undefined. */
	check?(value: string, user: TasksConfig, resolved: ResolvedBindings): string | undefined;
	write(raw: Raw, value: string, user: TasksConfig): void;
	/** The project file sets this row's key. */
	inProject(project: Raw): boolean;
}

type NumberKey = "defaultTimeoutMs" | "maxTimeoutMs" | "maxRunning" | "maxLogBytes" | "logRetentionDays" | "stallSeconds" | "printModeMaxWaitMs";

function isObject(v: unknown): v is Raw {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberRow(o: {
	key: NumberKey;
	label: string;
	description: string;
	codec: Codec;
	presets: number[];
	min: number;
	limit?: (n: number, user: TasksConfig) => string | undefined;
}): Row {
	const { key, codec } = o;
	return {
		id: key,
		label: o.label,
		description: o.description,
		show: (c) => codec.format(c[key]),
		presets: o.presets.map((n) => codec.format(n)),
		placeholder: codec.hint,
		parseCustom: (text) => {
			const n = codec.parse(text);
			return n === undefined ? { error: `Enter ${codec.hint}.` } : { value: codec.format(n) };
		},
		check: (value, user) => {
			const n = codec.parse(value);
			if (n === undefined) return `Enter ${codec.hint}.`;
			if (n < o.min) return `Must be at least ${codec.format(o.min)}.`;
			return o.limit?.(n, user);
		},
		write: (raw, value) => {
			raw[key] = codec.parse(value);
		},
		inProject: (p) => key in p,
	};
}

function rtkRow(feature: "ready" | "tty", description: string): Row {
	return {
		id: `rtk.${feature}`,
		label: `Original command with ${feature}`,
		description,
		show: (c) => String(c.rtkPassthroughFor.includes(feature)),
		cycle: ["true", "false"],
		write: (raw, value, user) => {
			const list = user.rtkPassthroughFor.filter((f) => f !== feature);
			if (value === "true") list.push(feature);
			raw.rtkPassthroughFor = list;
		},
		inProject: (p) => "rtkPassthroughFor" in p,
	};
}

function shortcutRow(setting: ShortcutSetting, label: string, description: string, presets: string[]): Row {
	const other: ShortcutSetting = setting === "background" ? "manager" : "background";
	return {
		id: `shortcuts.${setting}`,
		label,
		description,
		show: (c) => c.shortcuts[setting],
		presets,
		placeholder: 'a Pi key id such as ctrl+shift+b or alt+t, or "off"',
		parseCustom: (text) => (text.trim() ? { value: text.trim() } : { error: 'Enter a key id, or "off".' }),
		check: (value, user, resolved) => {
			if (value !== "off" && value.toLowerCase() === user.shortcuts[other].toLowerCase()) return `${value} is already the ${other} shortcut.`;
			return shortcutProblem(setting, value, resolved);
		},
		write: (raw, value) => {
			raw.shortcuts = { ...(isObject(raw.shortcuts) ? raw.shortcuts : {}), [setting]: value };
		},
		inProject: (p) => isObject(p.shortcuts) && setting in p.shortcuts,
	};
}

export const ROWS: Row[] = [
	numberRow({
		key: "defaultTimeoutMs",
		label: "Foreground window",
		description: "How long a bash call without timeout runs in the foreground before it moves to the background",
		codec: durationCodec(),
		presets: [30_000, 60_000, 120_000, 300_000, 600_000],
		min: MINIMUMS.timeoutMs,
		limit: (n, user) => (n > user.maxTimeoutMs ? `Longer than the longest foreground window (${formatDurationValue(user.maxTimeoutMs)}).` : undefined),
	}),
	numberRow({
		key: "maxTimeoutMs",
		label: "Longest foreground window",
		description: "Upper limit for the timeout a bash call may ask for",
		codec: durationCodec(),
		presets: [120_000, 300_000, 600_000, 1_800_000, 3_600_000],
		min: MINIMUMS.timeoutMs,
		limit: (n, user) => (n < user.defaultTimeoutMs ? `Shorter than the foreground window (${formatDurationValue(user.defaultTimeoutMs)}).` : undefined),
	}),
	{
		id: "defaultNotify",
		label: "Default notification",
		description: "What a task does when it ends, if bash did not say: wake the agent, wait for its next turn, or stay silent",
		show: (c) => c.defaultNotify,
		cycle: ["wake", "passive", "silent"],
		write: (raw, value) => {
			raw.defaultNotify = value;
		},
		inProject: (p) => "defaultNotify" in p,
	},
	numberRow({
		key: "maxRunning",
		label: "Running task limit",
		description: "How many tasks may run at once; starting one more is refused",
		codec: countCodec,
		presets: [4, 8, 16, 32, 64],
		min: MINIMUMS.maxRunning,
	}),
	numberRow({
		key: "stallSeconds",
		label: "Stall check after",
		description: "Silence before a task whose last line looks like a prompt is reported as waiting for input",
		codec: secondsCodec,
		presets: [15, 30, 45, 60, 120, 300],
		min: MINIMUMS.stallSeconds,
	}),
	numberRow({
		key: "maxLogBytes",
		label: "Log size limit",
		description: "Size at which a task's log rotates",
		codec: sizeCodec,
		presets: [10 * MB, 50 * MB, 100 * MB, 500 * MB, GB],
		min: MINIMUMS.maxLogBytes,
	}),
	numberRow({
		key: "logRetentionDays",
		label: "Log retention",
		description: "Age at which logs of finished tasks are deleted, across all sessions",
		codec: daysCodec,
		presets: [0, 1, 3, 7, 14, 30],
		min: MINIMUMS.logRetentionDays,
	}),
	numberRow({
		key: "printModeMaxWaitMs",
		label: "Print mode wait",
		description: "How long print and JSON mode keep running for tasks that wake the agent",
		codec: durationCodec("no wait"),
		presets: [0, 60_000, 300_000, 600_000, 1_800_000, 3_600_000],
		min: MINIMUMS.printModeMaxWaitMs,
	}),
	rtkRow("ready", "Run the original command instead of the rtk rewrite when bash waits for a ready pattern"),
	rtkRow("tty", "Run the original command instead of the rtk rewrite when bash runs in a terminal (tty)"),
	shortcutRow("background", "Background shortcut", "Sends running foreground commands to the background; an editor key such as ctrl+b acts only on an empty input", [
		"ctrl+b",
		"ctrl+shift+b",
		"off",
	]),
	shortcutRow("manager", "Manager shortcut", "Opens the /tasks manager", ["shift+down", "off"]),
];

/** The effective config and the user file, for `/tasks settings` outside the TUI. */
export function settingsSummary(cfg: TasksConfig, path: string): string {
	const lines = ROWS.map((r) => `${r.label}: ${r.show(cfg)}`);
	return [`realtasks settings (${path})`, ...lines, `Log directory: ${cfg.dir}`].join("\n");
}

// ── panel ──────────────────────────────────────────────────────

const CUSTOM = "\u0000custom";

/** Submenu for a row with presets: pick one, or type a custom value. */
class ChoiceSubmenu implements Component {
	readonly capturesViewportInput = true;
	private readonly list: SelectList;
	private input: Input | undefined;
	private error = "";
	private readonly title: string;
	private readonly th: Theme;
	private readonly tui: TUI;
	private readonly row: Row;
	private readonly accept: (value: string) => string | undefined;
	private readonly setInput: (input: Input | undefined) => void;
	private readonly done: (value?: string) => void;

	constructor(o: {
		row: Row;
		current: string;
		defaultValue: string;
		theme: Theme;
		tui: TUI;
		accept: (value: string) => string | undefined;
		setInput: (input: Input | undefined) => void;
		done: (value?: string) => void;
	}) {
		this.row = o.row;
		this.title = o.row.label;
		this.th = o.theme;
		this.tui = o.tui;
		this.accept = o.accept;
		this.setInput = o.setInput;
		this.done = (value) => {
			o.setInput(undefined);
			o.done(value);
		};
		const items: SelectItem[] = (o.row.presets ?? []).map((v) => ({ value: v, label: v === o.defaultValue ? `${v} (default)` : v }));
		items.push({ value: CUSTOM, label: o.row.presets?.includes(o.current) ? "Custom…" : `Custom… (${o.current})` });
		this.list = new SelectList(items, items.length, getSelectListTheme());
		const at = items.findIndex((i) => i.value === o.current);
		this.list.setSelectedIndex(at >= 0 ? at : items.length - 1);
		this.list.onSelect = (item) => (item.value === CUSTOM ? this.openInput(o.current) : this.pick(item.value));
		this.list.onCancel = () => this.done(undefined);
	}

	private pick(value: string): void {
		const problem = this.accept(value);
		if (problem) {
			this.error = problem;
			this.tui.requestRender();
			return;
		}
		this.done(value);
	}

	private openInput(current: string): void {
		const input = new Input({ prompt: "  > ", placeholder: this.row.placeholder });
		input.setValue(current);
		// setValue keeps the cursor at 0; start at the end, as an edit field does.
		input.handleInput("\x1b[F");
		input.onSubmit = (text) => {
			const parsed = this.row.parseCustom?.(text) ?? { value: text.trim() };
			if ("error" in parsed) {
				this.error = parsed.error;
				this.tui.requestRender();
				return;
			}
			this.pick(parsed.value);
		};
		input.onEscape = () => {
			this.input = undefined;
			this.error = "";
			this.setInput(undefined);
			this.tui.requestRender();
		};
		this.error = "";
		this.input = input;
		this.setInput(input);
		this.tui.requestRender();
	}

	invalidate(): void {
		this.list.invalidate();
		this.input?.invalidate();
	}

	render(width: number): string[] {
		const th = this.th;
		const lines = [`  ${th.fg("accent", th.bold(this.title))}`, ""];
		lines.push(...(this.input ? this.input.render(width) : this.list.render(width)));
		if (this.error) lines.push(`  ${th.fg("error", this.error)}`);
		lines.push("", `  ${th.fg("dim", this.input ? "enter apply · esc back" : "↑↓ move · enter select · esc cancel")}`);
		return lines;
	}

	handleInput(data: string): void {
		if (!this.input) this.error = "";
		if (this.input) this.input.handleInput(data);
		else this.list.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// The list starts below the title and a blank line.
		const local = { ...event, y: event.y - 2 };
		return this.input ? this.input.handleMouse(local) : this.list.handleMouse(local);
	}
}

export interface SettingsPanelOptions {
	rt: Runtime;
	tui: TUI;
	theme: Theme;
	cwd: string;
	trusted: boolean;
	/** Pi's resolved keybindings, for the shortcut conflict check. */
	resolved?: ResolvedBindings;
	done: () => void;
}

/** Rows above the settings list: the top border, the title and a blank line. */
const HEADER_ROWS = 3;

export class SettingsPanel implements Component, Focusable {
	readonly capturesViewportInput = true;
	private readonly container = new Container();
	private readonly list: SettingsList;
	private readonly o: SettingsPanelOptions;
	private readonly path = userConfigPath();
	private user: TasksConfig;
	private error = "";
	private focusedValue = false;
	private activeInput: Input | undefined;

	constructor(o: SettingsPanelOptions) {
		this.o = o;
		const th = o.theme;
		const resolved = o.resolved ?? piBindings();
		this.user = resolveConfig(readConfigFile(this.path).raw);
		const defaults = resolveConfig({});
		const project = o.trusted ? readConfigFile(projectConfigPath(o.cwd)).raw : {};
		const effective = o.trusted ? resolveConfig(mergeConfig(readConfigFile(this.path).raw, project)) : this.user;

		const setInput = (input: Input | undefined) => {
			if (this.activeInput && this.activeInput !== input) this.activeInput.focused = false;
			this.activeInput = input;
			if (input) input.focused = this.focusedValue;
		};
		const items: SettingItem[] = ROWS.map((row) => {
			const note = row.inProject(project) ? ` In effect: ${row.show(effective)}, set by the project (.pi/realtasks/config.json).` : "";
			const item: SettingItem = { id: row.id, label: row.label, description: `${row.description}.${note}`, currentValue: row.show(this.user) };
			if (row.cycle) item.values = row.cycle;
			else {
				item.submenu = (current, done) =>
					new ChoiceSubmenu({
						row,
						current,
						defaultValue: row.show(defaults),
						theme: th,
						tui: o.tui,
						accept: (value) => row.check?.(value, this.user, resolved),
						setInput,
						done,
					});
			}
			return item;
		});

		this.container.addChild(new DynamicBorder());
		this.container.addChild({
			render: () => [`  ${th.fg("accent", th.bold("realtasks settings"))} ${th.fg("dim", `(${this.path})`)}`, ""],
			invalidate: () => {},
		});
		this.list = new SettingsList(
			items,
			items.length,
			getSettingsListTheme(),
			(id, value) => this.apply(id, value),
			() => {
				setInput(undefined);
				o.done();
			},
		);
		this.container.addChild(this.list);
		this.container.addChild({
			render: () => (this.error ? ["", `  ${th.fg("error", this.error)}`] : []),
			invalidate: () => {},
		});
		this.container.addChild(new DynamicBorder());
	}

	/** Save one change to the user file and reload the config. Every row then shows the saved value. */
	private apply(id: string, value: string): void {
		const row = ROWS.find((r) => r.id === id);
		if (!row) return;
		this.error = "";
		const file = readConfigFile(this.path);
		if (file.warning) {
			this.error = `${file.warning} Not saved.`;
		} else {
			const raw: Raw = structuredClone(file.raw);
			row.write(raw, value, resolveConfig(raw));
			const pruned = pruneDefaults(raw);
			try {
				writeConfigFile(this.path, pruned);
				this.user = resolveConfig(pruned);
				this.o.rt.loadConfig(this.o.cwd, this.o.trusted);
			} catch (e) {
				this.error = `Could not save ${this.path}: ${(e as Error).message}`;
			}
		}
		for (const r of ROWS) this.list.updateValue(r.id, r.show(this.user));
		this.o.tui.requestRender();
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		this.focusedValue = value;
		if (this.activeInput) this.activeInput.focused = value;
	}

	invalidate(): void {
		this.container.invalidate();
	}

	render(width: number): string[] {
		return this.container.render(width);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
		this.o.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const result = this.list.handleMouse({ ...event, y: event.y - HEADER_ROWS });
		this.o.tui.requestRender();
		return result;
	}
}

/** `/tasks settings`: the panel in the TUI, a summary elsewhere. */
export async function openSettings(rt: Runtime, ctx: ExtensionContext): Promise<void> {
	const path = userConfigPath();
	if (ctx.mode !== "tui") {
		ctx.ui.notify(settingsSummary(rt.cfg, path), "info");
		return;
	}
	const file = readConfigFile(path);
	if (file.warning) {
		ctx.ui.notify(`${file.warning} Fix the file to use /tasks settings.`, "error");
		return;
	}
	const before = { ...rt.cfg.shortcuts };
	rt.panelOpen = true;
	try {
		await ctx.ui.custom<void>((tui, theme, _kb, done) =>
			new SettingsPanel({ rt, tui, theme, cwd: ctx.cwd, trusted: ctx.isProjectTrusted(), done: () => done(undefined) }),
		);
	} finally {
		rt.panelOpen = false;
	}
	const after = rt.cfg.shortcuts;
	if (before.background !== after.background || before.manager !== after.manager) {
		ctx.ui.notify("Shortcut changes take effect after /reload.", "info");
	}
}
