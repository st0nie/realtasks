// Slash commands (/bg, /tasks) and shortcuts.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type KeyId } from "@earendil-works/pi-tui";
import type { Runtime } from "./runtime.ts";
import type { Task } from "./task.ts";
import { decodeEscapes } from "./text.ts";
import { TasksOverlay, type ManagerAction } from "./ui.ts";

/** User-started task (/bg <cmd>, restart): silent, never wakes the agent. */
export function startUserTask(rt: Runtime, ctx: ExtensionContext, cmd: string, from?: Task): Task {
	rt.manager.assertCapacity();
	return rt.manager.start({
		kind: "shell",
		requested: from?.rec.requested ?? cmd,
		executed: cmd,
		rewritten: from?.rec.rewritten ?? false,
		label: from?.rec.label,
		cwd: from?.rec.cwd ?? ctx.cwd,
		notify: "silent",
		tty: from?.rec.tty ?? false,
		stdin: from?.rec.stdin ?? false,
		keepAlive: false,
		foreground: false,
		userStarted: true,
	});
}

export function promoteShortcut(rt: Runtime, ctx: ExtensionContext): void {
	const n = rt.promoteAll("shortcut");
	if (n > 0) ctx.ui.notify(`Backgrounded ${n} command${n === 1 ? "" : "s"}`, "info");
	else ctx.ui.notify("No running foreground command to background.", "warning");
}

export async function openManager(rt: Runtime, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(rt.manager.list().map((t) => `${t.rec.id} ${t.rec.status} ${t.rec.label}`).join("\n") || "No tasks.", "info");
		return;
	}
	const action = await ctx.ui.custom<ManagerAction>(
		(tui, theme, _kb, done) => new TasksOverlay(rt, tui, theme, done),
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
	);
	if (!action) return;
	const t = rt.manager.get(action.id);
	if (!t) return;
	if (action.type === "input") {
		const text = await ctx.ui.input(`Input for ${t.rec.id}`, "text (\\r enter, \\x03 ctrl-c, \\x04 eof)");
		if (text === undefined) return;
		try {
			t.write(decodeEscapes(text));
		} catch (e) {
			ctx.ui.notify((e as Error).message, "error");
		}
	} else if (action.type === "restart") {
		if (t.running) {
			t.stop();
			await Promise.race([t.waitExit(), new Promise((r) => setTimeout(r, 5000))]);
		}
		try {
			const n = startUserTask(rt, ctx, t.rec.executed, t);
			ctx.ui.notify(`Restarted as ${n.rec.id}`, "info");
		} catch (e) {
			ctx.ui.notify((e as Error).message, "error");
		}
	}
}

export function registerCommands(pi: ExtensionAPI, rt: Runtime): void {
	pi.registerCommand("bg", {
		description: "Background running foreground commands, or start `/bg <cmd>` as a task",
		handler: async (args, ctx) => {
			const cmd = args.trim();
			if (!cmd) return promoteShortcut(rt, ctx);
			try {
				const t = startUserTask(rt, ctx, cmd);
				ctx.ui.notify(`Started ${t.rec.id}: ${cmd}`, "info");
			} catch (e) {
				ctx.ui.notify((e as Error).message, "error");
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "Open the task manager, or `/tasks stop <id|all>`",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) return [{ value: "stop ", label: "stop" }].filter((i) => i.value.startsWith(prefix));
			if (parts[0] !== "stop") return null;
			const ids = ["all", ...rt.manager.list().filter((t) => t.running).map((t) => t.rec.id)];
			return ids.filter((id) => id.startsWith(parts[1] ?? "")).map((id) => ({ value: `stop ${id}`, label: id }));
		},
		handler: async (args, ctx) => {
			const [sub, id] = args.trim().split(/\s+/);
			if (!sub) return openManager(rt, ctx);
			if (sub !== "stop" || !id) {
				ctx.ui.notify("Usage: /tasks  or  /tasks stop <id|all>", "warning");
				return;
			}
			try {
				const targets = id === "all" ? rt.manager.list().filter((t) => t.running) : [rt.manager.resolve(id)];
				for (const t of targets) t.stop();
				ctx.ui.notify(targets.length ? `Stopping ${targets.map((t) => t.rec.id).join(", ")}` : "No running tasks.", "info");
			} catch (e) {
				ctx.ui.notify((e as Error).message, "error");
			}
		},
	});
}

type ResolvedBindings = Record<string, KeyId | KeyId[] | undefined>;

/** Pi action already bound to `key` (defaults merged with keybindings.json), if any. */
export function findKeyConflict(key: string, resolved: ResolvedBindings): string | undefined {
	const k = key.toLowerCase();
	for (const [action, keys] of Object.entries(resolved)) {
		const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
		if (list.some((x) => x.toLowerCase() === k)) return action;
	}
	return undefined;
}

/**
 * Pi's resolved bindings. In the TUI, Pi installs its full manager (app and
 * editor defaults plus keybindings.json) with setKeybindings() before
 * session_start, so call this from session_start, not at load.
 */
export function piBindings(): ResolvedBindings {
	try {
		return getKeybindings().getResolvedBindings() as ResolvedBindings;
	} catch {
		return {};
	}
}

/**
 * Called from session_start (Pi reads extension shortcuts right after it), so
 * remapping takes effect on /reload. "off" disables a binding; a key Pi
 * already uses is skipped with a warning.
 */
export function registerShortcuts(pi: ExtensionAPI, rt: Runtime, resolved: ResolvedBindings = piBindings()): string[] {
	const warnings: string[] = [];
	const bind = (setting: "background" | "manager", description: string, run: (ctx: ExtensionContext) => void) => {
		const key = rt.cfg.shortcuts[setting];
		if (key === "off") return;
		const clash = findKeyConflict(key, resolved);
		if (clash) {
			warnings.push(
				`realtasks: shortcut ${key} is Pi's ${clash}; not registered. Set tasks.shortcuts.${setting} to another key or "off".`,
			);
			return;
		}
		pi.registerShortcut(key as KeyId, {
			description,
			handler: (ctx) => {
				if (ctx.mode === "tui") run(ctx);
			},
		});
	};
	bind("background", "Background running foreground commands (realtasks)", (ctx) => promoteShortcut(rt, ctx));
	bind("manager", "Open the task manager (realtasks)", (ctx) => void openManager(rt, ctx));
	return warnings;
}
