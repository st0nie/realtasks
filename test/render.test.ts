import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { humanMs, inputPreview, waitLine } from "../src/tools/render.ts";

const th = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as unknown as Theme;
const base = { label: "npm test", id: "b7f3k9a2", capMs: 600_000 };

describe("render helpers", () => {
	test("humanMs never shows raw milliseconds for real caps", () => {
		expect(humanMs(600_000)).toBe("10m");
		expect(humanMs(5_000)).toBe("5s");
		expect(humanMs(1_500)).toBe("1.5s");
		expect(humanMs(3_600_000)).toBe("1h");
		expect(humanMs(90_000)).toBe("1m30s");
	});
	test("waiting line shows label, elapsed, cap and last output", () => {
		const l = waitLine({ ...base, phase: "waiting", waitedMs: 72_000, last: "test 31 ok" }, th, 0);
		expect(l).toBe("· waiting for npm test · 1m12s of 10m │ test 31 ok");
	});
	test("done lines say why the wait ended", () => {
		expect(waitLine({ ...base, phase: "done", waitedMs: 74_000, reason: "exit", status: "completed", exitCode: 0 }, th)).toBe(
			"✓ npm test completed exit 0 · waited 1m14s",
		);
		expect(waitLine({ ...base, phase: "done", waitedMs: 3_000, reason: "grep" }, th)).toBe("✓ grep matched · waited 3s");
		expect(waitLine({ ...base, phase: "done", waitedMs: 600_000, reason: "cap" }, th)).toBe("… still running · waited 10m00s (cap)");
	});
	test("input preview", () => {
		expect(inputPreview("print(2+2)\\r", undefined, undefined)).toBe('"print(2+2)⏎"');
		expect(inputPreview(undefined, ["ctrl-c"], true)).toBe("keys ctrl-c + EOF");
	});
});
