// PTY scenario (acceptance flow 4), run under Node because node-pty needs it.
// Usage: node --experimental-strip-types test/pty-node.ts <tmpdir>
// Prints "PTY_OK" on success, otherwise an error and a non-zero exit.

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import realtasks from "../index.ts";
import { fakeCtx, fakePi, until, writeUserConfig } from "./helpers.ts";

type Res = { content: Array<{ text: string }> };

const dir = process.argv[2];
if (!dir) throw new Error("usage: pty-node.ts <dir>");
const agentDir = writeUserConfig({ dir });
const f = fakePi();
realtasks(f.pi as never);
const c = fakeCtx(dir, "s-pty", "print");
const call = async (name: string, params: Record<string, unknown>) =>
	(await f.tools.get(name)?.execute(`c-${Math.random()}`, params, undefined, undefined, c.ctx)) as Res;
const text = (r: Res) => r.content.map((x) => x.text).join("");

await f.emit("session_start", { type: "session_start", reason: "startup" }, c.ctx);
// Windows installs rarely provide python3.
const python = process.platform === "win32" ? "python" : "python3";
const r = await call("bash", { command: `${python} -q`, tty: true, run_in_background: true, notify: "silent" });
const id = /task (b[0-9a-z]{7})/i.exec(text(r))?.[1];
if (!id) throw new Error(`no id: ${text(r)}`);
await until(() => readFileSync(join(dir, "s-pty", `${id}.log`), "utf8").includes(">>>"), 8000);
const out = text(await call("task_input", { id, text: "print(2+2)\\r", wait_ms: 800 }));
if (!/\b4\b/.test(out)) throw new Error(`expected 4 in: ${out}`);
await call("task_input", { id, text: "\\x04", wait_ms: 300 });
const end = text(await call("task_output", { id, wait_ms: 5000 }));
if (!end.includes("completed exit=0")) throw new Error(`expected completed: ${end}`);
const stall = f.sent.some((s) => s.content.includes('signal="stall"'));
if (stall) throw new Error("unexpected stall warning");
await f.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, c.ctx);
rmSync(agentDir, { recursive: true, force: true });
console.log("PTY_OK");
process.exit(0);
