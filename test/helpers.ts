// Fake ExtensionAPI / ctx and a temp task dir for unit tests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type TasksConfig } from "../src/config.ts";

export interface Sent {
	content: string;
	details: unknown;
	opts: unknown;
}

export function tmpDir(prefix = "realtasks-test-"): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dir: string, over: Record<string, unknown> = {}): TasksConfig {
	return resolveConfig({ dir, ...over });
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/**
 * Point PI_CODING_AGENT_DIR at a temp agent dir and write
 * <agentDir>/realtasks/config.json, the only place realtasks reads config.
 */
export function writeUserConfig(config: Record<string, unknown>): string {
	const agent = mkdtempSync(join(tmpdir(), "realtasks-agent-"));
	mkdirSync(join(agent, "realtasks"), { recursive: true });
	writeFileSync(join(agent, "realtasks", "config.json"), JSON.stringify(config));
	process.env.PI_CODING_AGENT_DIR = agent;
	return agent;
}

/** Minimal ExtensionAPI capturing registrations and sent messages. */
export function fakePi() {
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> } & Record<string, unknown>>();
	const handlers = new Map<string, Handler[]>();
	const sent: Sent[] = [];
	const userMessages: Array<{ content: unknown; opts: unknown }> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const shortcuts = new Map<string, unknown>();
	const pi = {
		registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => tools.set(t.name, t),
		registerCommand: (n: string, o: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(n, o),
		registerShortcut: (k: string, o: unknown) => shortcuts.set(k, o),
		registerMessageRenderer: () => {},
		on: (ev: string, h: Handler) => {
			const list = handlers.get(ev) ?? [];
			list.push(h);
			handlers.set(ev, list);
			return () => {};
		},
		sendMessage: (m: { content: string; details: unknown }, opts: unknown) => sent.push({ content: m.content, details: m.details, opts }),
		sendUserMessage: (content: unknown, opts: unknown) => userMessages.push({ content, opts }),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		getSettings: () => ({}),
	};
	const emit = async (ev: string, event: unknown, ctx: unknown) => {
		let last: unknown;
		for (const h of handlers.get(ev) ?? []) last = await h(event, ctx);
		return last;
	};
	return { pi, tools, handlers, sent, userMessages, entries, commands, shortcuts, emit };
}

/** Minimal tool/extension ctx. */
export function fakeCtx(cwd: string, sessionId = "sess1", mode: "tui" | "print" | "json" | "rpc" = "print") {
	const notes: Array<{ msg: string; level: string }> = [];
	let aborted = 0;
	const ctx = {
		cwd,
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [] as unknown[],
		},
		ui: {
			notify: (msg: string, level: string) => notes.push({ msg, level }),
			setWidget: () => {},
			setStatus: () => {},
			confirm: async () => true,
			theme: { fg: (_c: string, s: string) => s, bold: (s: string) => s },
		},
		abort: () => {
			aborted++;
		},
		isIdle: () => true,
		isProjectTrusted: () => false,
		signal: undefined,
	};
	return { ctx, notes, aborted: () => aborted };
}

export async function until(cond: () => boolean, ms = 5000, step = 20): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("until: timed out");
		await new Promise((r) => setTimeout(r, step));
	}
}
