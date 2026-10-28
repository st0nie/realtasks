// Log reading and model-facing output formatting.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { cleanOutput } from "./text.ts";

export const HEAD_BYTES = 4 * 1024;
export const TAIL_BYTES = 64 * 1024;

export function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

/** Read bytes [start, end) of a file as UTF-8. Missing file → "". */
export function readRange(path: string, start: number, end?: number): string {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return "";
	}
	try {
		const stop = end ?? statSync(path).size;
		const len = Math.max(0, stop - start);
		if (len === 0) return "";
		const buf = Buffer.allocUnsafe(len);
		const n = readSync(fd, buf, 0, len, start);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** Last `bytes` of a file. */
export function readTail(path: string, bytes: number): string {
	const size = fileSize(path);
	return readRange(path, Math.max(0, size - bytes), size);
}

/** Head (first 4 KB) + tail (last 64 KB) in-memory view of a task's output. */
export class OutputRing {
	head = "";
	tail = "";
	append(chunk: string): void {
		if (this.head.length < HEAD_BYTES) this.head += chunk.slice(0, HEAD_BYTES - this.head.length);
		this.tail += chunk;
		if (this.tail.length > TAIL_BYTES * 2) this.tail = this.tail.slice(-TAIL_BYTES);
	}
	recent(): string {
		return this.tail.length > TAIL_BYTES ? this.tail.slice(-TAIL_BYTES) : this.tail;
	}
}

export interface Formatted {
	text: string;
	truncated: boolean;
}

/** Clean and tail-truncate with Pi's built-in bash limits; footer points at the log. */
export function formatForModel(raw: string, logPath: string, maxLines = DEFAULT_MAX_LINES): Formatted {
	const cleaned = cleanOutput(raw);
	const t = truncateTail(cleaned, { maxLines: Math.min(maxLines, DEFAULT_MAX_LINES), maxBytes: DEFAULT_MAX_BYTES });
	if (!t.truncated) return { text: t.content, truncated: false };
	const start = t.totalLines - t.outputLines + 1;
	return {
		text: `${t.content}\n\n[Showing lines ${start}-${t.totalLines} of ${t.totalLines}. Full output: ${logPath}]`,
		truncated: true,
	};
}
