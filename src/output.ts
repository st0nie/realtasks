// Log reading and model-facing output formatting.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";
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

/** 1-indexed inclusive line range; `last` undefined means to the end of the log. */
export interface LineRange {
	first: number;
	last?: number;
}

/** Parse a `lines` spec: "120-260", "120-" (to the end) or "120" (one line). */
export function parseLineRange(spec: string): LineRange {
	const m = /^\s*(\d+)\s*(-\s*(\d+)?)?\s*$/.exec(spec);
	const bad = () => new Error(`Bad lines range "${spec}": use "120-260", "120-" or "120" (1-indexed)`);
	if (!m) throw bad();
	const first = Number(m[1]);
	let last: number | undefined = first;
	if (m[3] !== undefined) last = Number(m[3]);
	else if (m[2]) last = undefined;
	if (first < 1 || (last !== undefined && last < first)) throw bad();
	return { first, last };
}

/**
 * Numbered lines `range` of a cleaned log, filtered by `re`, keeping at most
 * `maxLines` (and Pi's byte cap) from the start of the range. The footer names
 * the range to read next.
 */
export function formatLineRange(raw: string, range: LineRange, re: RegExp | undefined, maxLines: number): { header: string; text: string } {
	const all = cleanOutput(raw).split("\n");
	if (all.at(-1) === "") all.pop();
	const total = all.length;
	const want = `${range.first}-${range.last ?? ""}`;
	if (range.first > total) return { header: `lines: ${want} is past the end (log has ${total} lines)\n`, text: "" };
	const last = Math.min(range.last ?? total, total);
	let picked = all.slice(range.first - 1, last).map((l, i) => `${range.first + i}: ${l}`);
	let header = `lines: ${range.first}-${last} of ${total}`;
	if (re) {
		const hits = picked.filter((l) => re.test(l.slice(l.indexOf(": ") + 2)));
		header += ` · grep: ${hits.length} of ${picked.length} lines match`;
		picked = hits;
	}
	const t = truncateHead(picked.join("\n"), { maxLines: Math.min(maxLines, DEFAULT_MAX_LINES), maxBytes: DEFAULT_MAX_BYTES });
	if (!t.truncated) return { header: `${header}\n`, text: t.content };
	// A single line over the byte cap: show its start rather than nothing.
	const shown = Math.max(1, t.outputLines);
	const content = t.outputLines > 0 ? t.content : `${picked[0].slice(0, DEFAULT_MAX_BYTES)} [line truncated]`;
	const rest = range.last === undefined ? "" : String(last);
	const next = shown < picked.length ? `. Next: lines "${Number.parseInt(picked[shown], 10)}-${rest}"` : "";
	return { header: `${header}\n`, text: `${content}\n\n[Showing ${shown} of ${picked.length} lines${next}]` };
}
