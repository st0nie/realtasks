// On-disk layout: <dir>/<sessionId>/<taskId>.{json,log,exit,err}.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TaskRecord } from "./types.ts";

export interface TaskPaths {
	json: string;
	log: string;
	exit: string;
	err: string;
}

export function sessionDir(root: string, sessionId: string): string {
	return join(root, sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

export function taskPaths(root: string, sessionId: string, id: string): TaskPaths {
	const d = sessionDir(root, sessionId);
	return { json: join(d, `${id}.json`), log: join(d, `${id}.log`), exit: join(d, `${id}.exit`), err: join(d, `${id}.err`) };
}

/** Atomic write of a task record. */
export function writeRecord(root: string, rec: TaskRecord): void {
	const p = taskPaths(root, rec.sessionId, rec.id).json;
	mkdirSync(sessionDir(root, rec.sessionId), { recursive: true });
	const tmp = `${p}.tmp`;
	writeFileSync(tmp, JSON.stringify(rec, null, 1), { mode: 0o600 });
	renameSync(tmp, p);
}

export function readRecords(root: string, sessionId: string): TaskRecord[] {
	const d = sessionDir(root, sessionId);
	let names: string[];
	try {
		names = readdirSync(d);
	} catch {
		return [];
	}
	const out: TaskRecord[] = [];
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		try {
			const rec = JSON.parse(readFileSync(join(d, n), "utf8")) as TaskRecord;
			if (rec && typeof rec.id === "string" && typeof rec.pid === "number") out.push(rec);
		} catch {
			/* skip corrupt record */
		}
	}
	return out.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Delete task files older than `days` across all sessions, skipping records
 * still marked running. Never rejects.
 */
export async function sweepOld(root: string, days: number, now = Date.now()): Promise<number> {
	if (!(days > 0)) return 0;
	const cutoff = now - days * 86_400_000;
	let removed = 0;
	try {
		for (const s of await readdir(root)) {
			const d = join(root, s);
			let files: string[];
			try {
				files = await readdir(d);
			} catch {
				continue;
			}
			const running = new Set<string>();
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				try {
					const rec = JSON.parse(readFileSync(join(d, f), "utf8")) as TaskRecord;
					if (rec.status === "running") running.add(rec.id);
				} catch {
					/* treat as not running */
				}
			}
			let kept = 0;
			for (const f of files) {
				const id = f.split(".")[0];
				const p = join(d, f);
				try {
					if (!running.has(id) && (await stat(p)).mtimeMs < cutoff) {
						await rm(p, { force: true });
						removed++;
					} else kept++;
				} catch {
					kept++;
				}
			}
			if (kept === 0) await rm(d, { recursive: true, force: true }).catch(() => {});
		}
	} catch {
		/* root missing */
	}
	return removed;
}
