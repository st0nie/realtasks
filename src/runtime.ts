// Per-extension-instance state shared by tools, UI, and lifecycle handlers.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveConfig, type TasksConfig } from "./config.ts";
import { TaskManager } from "./manager.ts";
import { NOTIFICATION_TYPE, type Mode } from "./notify.ts";
import type { Task } from "./task.ts";

/** A foreground `bash` call that can be promoted early. */
export interface ForegroundSlot {
	task: Task;
	promote(reason: "shortcut" | "steer"): void;
}

export class Runtime {
	readonly pi: ExtensionAPI;
	readonly manager: TaskManager;
	readonly foreground = new Map<string, ForegroundSlot>();
	ctx: ExtensionContext | undefined;
	busy = false;
	/** Wake continuation was requested once this settle; reset on agent_start. */
	settleContinued = false;
	private listeners = new Set<() => void>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.manager = new TaskManager(
			resolveConfig(undefined),
			{
				send: (content, details, opts) =>
					pi.sendMessage({ customType: NOTIFICATION_TYPE, content, display: true, details }, opts),
				toast: (msg, level) => {
					if (this.ctx?.hasUI) this.ctx.ui.notify(msg, level);
				},
				mode: () => (this.ctx?.mode ?? "print") as Mode,
				isBusy: () => this.busy,
			},
			{ changed: () => this.emitChange() },
		);
	}

	get cfg(): TasksConfig {
		return this.manager.cfg;
	}

	/** Read realtasks/config.json (user, then trusted project). Returns warnings to show. */
	loadConfig(cwd = process.cwd(), trusted = false): string[] {
		const { config, warnings } = loadConfig(cwd, trusted);
		this.manager.cfg = config;
		return warnings;
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	emitChange(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch {
				/* stale UI */
			}
		}
	}

	/** Promote every running foreground `bash`. Returns how many were promoted. */
	promoteAll(reason: "shortcut" | "steer"): number {
		const slots = [...this.foreground.values()];
		for (const s of slots) s.promote(reason);
		return slots.length;
	}
}
