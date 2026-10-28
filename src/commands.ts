// Slash commands (/bg, /tasks) and shortcuts.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type KeyId } from "@earendil-works/pi-tui";
import type { Runtime } from "./runtime.ts";
import type { Task } from "./task.ts";
import { readTail } from "./output.ts";
import { cleanOutput, decodeEscapes, lastLines } from "./text.ts";
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

	const USAGE = "Usage: /tasks · /tasks stop <id|all> · /tasks clear [all] · /tasks log <id>";
	const SUBS = ["stop", "clear", "log"];
	pi.registerCommand("tasks", {
		description: "Open the task manager, or /tasks stop <id|all> · clear [all] · log <id>",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				return SUBS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: `${s} `, label: s }));
			}
			const [sub, arg = ""] = parts;
			let options: string[];
			if (sub === "stop") options = ["all", ...rt.manager.list().filter((t) => t.running).map((t) => t.rec.id)];
			else if (sub === "clear") options = ["all"];
			else if (sub === "log") options = rt.manager.list().map((t) => t.rec.id);
			else return null;
			return options.filter((o) => o.startsWith(arg)).map((o) => ({ value: `${sub} ${o}`, label: o }));
		},
		handler: async (args, ctx) => {
			const [sub, arg] = args.trim().split(/\s+/);
			if (!sub) return openManager(rt, ctx);
			try {
				if (sub === "stop" && arg) {
					const targets = arg === "all" ? rt.manager.list().filter((t) => t.running) : [rt.manager.resolve(arg)];
					for (const t of targets) t.stop();
					ctx.ui.notify(targets.length ? `Stopping ${targets.map((t) => t.rec.id).join(", ")}` : "No running tasks.", "info");
				} else if (sub === "clear" && (arg === undefined || arg === "all")) {
					const { cleared, keptUnread } = rt.manager.clearFinished(arg === "all");
					const kept = keptUnread ? ` Kept ${keptUnread} the agent has not read yet; use /tasks clear all to drop them too.` : "";
					ctx.ui.notify(`Cleared ${cleared} finished task${cleared === 1 ? "" : "s"}.${kept}`, "info");
				} else if (sub === "log" && arg) {
					const t = rt.manager.resolve(arg);
					const tail = lastLines(cleanOutput(readTail(t.rec.logPath, 64 * 1024)), 20).trimEnd();
					ctx.ui.notify(`${t.rec.id} ${t.rec.status} · ${t.rec.logPath}\n${tail || "(no output)"}`, "info");
				} else {
					ctx.ui.notify(USAGE, "warning");
				}
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
