// realtasks — background tasks for Pi.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands, registerShortcuts } from "./src/commands.ts";
import { NOTIFICATION_TYPE, type NotificationDetails } from "./src/notify.ts";
import { stashCommand } from "./src/rtk.ts";
import { Runtime } from "./src/runtime.ts";
import { sweepOld } from "./src/store.ts";
import { registerBash } from "./src/tools/bash.ts";
import { MonitorHub, registerMonitor } from "./src/tools/monitor.ts";
import { registerTaskTools } from "./src/tools/tasks.ts";
import { installDock, renderNotification } from "./src/ui.ts";

export const ENTRY_TYPE = "realtasks";

/** How long print/json mode keeps the run alive per settle check for wake tasks. */
const SETTLE_POLL_MS = 250;

export default function realtasks(pi: ExtensionAPI): void {
	const rt = new Runtime(pi);
	const hub = new MonitorHub(rt);

	registerBash(rt);
	registerTaskTools(rt);
	registerMonitor(rt, hub);
	registerCommands(pi, rt);

	let disposeDock: (() => void) | undefined;
	let shortcutsBound = false;
	let printWaitStarted = 0;

	rt.manager.setMonitorHooks(
		(t, line) => hub.line(t, line),
		(t) => hub.end(t),
	);
	rt.manager.setLifecycleHook((entry) => {
		try {
			pi.appendEntry(ENTRY_TYPE, entry);
		} catch {
			/* stale runtime during shutdown */
		}
	});

	pi.registerMessageRenderer<NotificationDetails>(NOTIFICATION_TYPE, (message, options, theme) =>
		renderNotification(
			message.details,
			typeof message.content === "string" ? message.content : message.content.map((c) => ("text" in c ? c.text : "")).join(""),
			options.expanded,
			theme,
		),
	);

	// rtk contract / recovery step 1: stash the command as this handler sees it.
	pi.on("tool_call", (event) => {
		if (event.toolName === "bash" && !event.parentToolCallId) {
			stashCommand(event.toolCallId, (event.input as { command?: unknown }).command);
		}
		return undefined;
	});

	pi.on("session_start", async (event, ctx) => {
		rt.ctx = ctx;
		const configWarnings = rt.loadConfig(ctx.cwd, ctx.isProjectTrusted());
		for (const w of configWarnings) {
			if (ctx.hasUI) ctx.ui.notify(w, "warning");
			else console.error(w);
		}
		if (!shortcutsBound && ctx.mode === "tui") {
			shortcutsBound = true;
			for (const w of registerShortcuts(pi, rt)) ctx.ui.notify(w, "warning");
		}
		const { adopted, finished } = rt.manager.attach(ctx.sessionManager.getSessionId());
		for (const t of adopted) if (t.rec.kind === "monitor") hub.track(t);
		if (adopted.length || finished.length) {
			pi.appendEntry(ENTRY_TYPE, {
				event: "readopted",
				reason: event.reason,
				running: adopted.map((t) => t.rec.id),
				finished: finished.map((t) => ({ id: t.rec.id, status: t.rec.status })),
			});
		}
		disposeDock?.();
		disposeDock = installDock(rt, ctx);
		void sweepOld(rt.cfg.dir, rt.cfg.logRetentionDays);
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		const running = rt.manager.list().filter((t) => t.running && !t.rec.keepAlive);
		if (running.length === 0 || ctx.mode !== "tui") return undefined;
		const ok = await ctx.ui.confirm(
			"Stop running tasks?",
			`${running.length} task${running.length === 1 ? "" : "s"} will be stopped: ${running.map((t) => t.rec.id).join(", ")}`,
		);
		return ok ? undefined : { cancel: true };
	});

	pi.on("session_shutdown", async (event) => {
		disposeDock?.();
		disposeDock = undefined;
		const reason = event.reason === "reload" ? "reload" : event.reason === "quit" ? "quit" : "switch";
		rt.manager.detach(reason);
		rt.foreground.clear();
	});

	pi.on("agent_start", () => {
		rt.busy = true;
		rt.settleContinued = false;
		printWaitStarted = 0;
	});

	pi.on("agent_end", () => {
		rt.busy = false;
	});

	// Wake notifications that would otherwise miss the run, and print-mode holding.
	pi.on("agent_before_settle", async (event, ctx) => {
		rt.ctx = ctx;
		const headless = ctx.mode === "print" || ctx.mode === "json";
		if (headless) {
			// Keep the run alive while wake tasks are still running, up to the cap.
			const waiting = () => rt.manager.list().some((t) => t.running && t.rec.notify === "wake");
			printWaitStarted ||= Date.now();
			while (waiting() && !rt.manager.notifier.hasHeldWake() && Date.now() - printWaitStarted < rt.cfg.printModeMaxWaitMs) {
				await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
				rt.manager.notifier.flush();
			}
		}
		rt.manager.notifier.flush();
		const msg = rt.manager.notifier.takeForSettle();
		if (!msg) return undefined;
		rt.settleContinued = true;
		// Compose with other handlers (goal plugins): keep their entries and continue flag.
		return {
			entries: [
				...event.entries,
				{ type: "custom_message", customType: NOTIFICATION_TYPE, content: msg.content, display: true, details: msg.details },
			],
			continue: true,
		};
	});

}

