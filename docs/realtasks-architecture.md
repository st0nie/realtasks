# realtasks — Background Tasks for Pi

Oct 28, 2026 · @ston

## Summary

realtasks is one Pi extension that merges Claude Code's background model (fire, keep working, get told when it's done) with Codex's unified-exec model (yield after a window, then poll or drive the process via stdin/PTY). It overrides `bash`, adds four small task tools plus `monitor`, and stays fully compatible with rtk's Pi hooks.

**Goals**

- The agent never blocks on a long command and never needs `sleep` or polling loops to learn that something finished.
- Exactly one completion notification per task, suppressed if the agent already read the result.
- Interactive processes (REPLs, `ssh`, prompts, TUIs) can be driven, not just watched.
- Dev servers report "ready" instead of making the agent guess when to proceed.
- Tasks survive `/reload` (opt-in survive across process restart) without losing exit codes.
- rtk keeps compressing output for finite commands, and never breaks streaming ones.
- Small: no tmux, one optional native dep (PTY), under \~3k lines.

**Success criteria**: the seven acceptance flows in the Acceptance tests section pass on macOS and Linux with rtk installed and not installed.

## Prior art and gaps

Each existing plugin nails one half: patty has Claude Code's notifications but no stdin or PTY; pi-process has Codex-style stdin and PTY but makes the agent poll; pi-background-tasks is durable but has grown into a 5.5 MB multi-agent suite.

| Plugin | Model | Agent learns of completion by | Stdin / PTY | Survives reload | Main gap |
| --- | --- | --- | --- | --- | --- |
| [pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) | Claude Code: auto-bg at 120s, `bash_bg`, `jobs`, `monitor`, `agent_bg` | `<task-notification>` steered mid-turn, exactly-once | No | No, in-memory; shutdown kills all | Can't drive interactive processes; logs in `/tmp`; blocks `sleep` heuristically |
| [pi-background-tasks](https://pi.dev/packages/pi-background-tasks?type=extension) (ismailsaleekh) | `bg_run` plus delegated agents, attestation, Fusion | Durable notification with follow-up wake | No | Opt-in `surviveReload` for plain shells | Very large surface; shell tasks are a small part |
| [pi-process](https://github.com/LiboShen/pi-process) | OpenClaw/Codex-ish: auto-bg after `yieldMs` (10s), `process` tool | Polling (`process poll`) | Yes, `write` + optional node-pty | No, in-memory with TTL | No push notifications; agent burns turns polling |
| [pi-unified-exec](https://pi.dev/packages/pi-unified-exec) | Faithful Codex port: `exec_command` + `write_stdin` | Polling with long empty-poll waits | Yes, control bytes and PTY | No | Replaces `bash` name, so rtk hooks keyed on `bash` stop firing |

What we take: patty's exactly-once notification latch and cooperative steering; pi-process's stdin and PTY; unified-exec's yield window and control-byte escapes; pi-background-tasks' durable completion. What we drop: subagents, `sleep` blocking, polling as the primary path.

## Core model

Every `bash` call spawns the same detached process; it only becomes a task if it is still running when the yield window ends, or is promoted early.

```
bash(command) ── spawn detached, output → <id>.log
   │
   ├─ run_in_background ───────────────────────────────► task (return id; ready? wait first)
   │
   └─ await exit, up to yield_ms
        ├─ exits in window ────────────────────────────► normal bash result, no task
        └─ still running / ctrl+shift+b / user types ──► promoted to task (return id + tail)
```

Promotion moves nothing: the process was already detached and writing to its log, so `bash` simply stops awaiting it and returns the task id.

- **Kinds**: `shell` (from `bash`) and `monitor`. IDs are a kind prefix plus 8 base36 chars: `b7f3k9a2`, `m2x81a0k`.
- **States**: `running` → `completed` (exit 0) · `failed` (non-zero exit or signal) · `timed_out` · `stopped` (by `task_stop` or the user) · `lost` (re-adoption found it dead with no exit code).
- **Record**: id, kind, label, `requested` and `executed` command (plus `rewritten`), cwd, pid, pgid, PID start time, started and ended at, status, exit code or signal, log path (and `.err`/`.exit` paths), `notify`, `notified`, `tty`, `stdin`, `keep_alive`, toolCallId, sessionId, `foreground`, `timeout`, `ready`, monitor spec, the agent's `task_output` cursor, and the one-shot signal flags. Written to `<taskId>.json` on every state change, so a re-adopted task keeps its cursor and never repeats a one-shot signal.

## Agent tool surface

Six tools. `bash` keeps the built-in name and its `command`/`timeout` params so other extensions (rtk, permission gates) keep working; everything new is an optional param.

### bash (override)

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `command` | string | required | Unchanged from built-in |
| `timeout` | seconds | none | Hard kill. Distinct from yield: a timed-out task ends with status `timed_out` |
| `description` | string | derived | 3–8 word label for UI and notifications (Claude Code's `description`) |
| `run_in_background` | bool | false | Return a task id immediately |
| `yield_ms` | ms | 30000 | Foreground attachment window; still running at the end → promoted to a task. Clamped 1000–600000 |
| `ready` | `{pattern?, port?, url?, timeout_ms?}` | none | Implies `run_in_background`. Blocks until ready, exit, or `timeout_ms` (default 60000); then returns the task id. If it timed out waiting, a later match sends the one-shot `ready` signal |
| `tty` | bool | false | Allocate a PTY (needs optional node-pty) |
| `stdin` | bool | false | Keep a stdin pipe open so `task_input` can write to it (implied by `tty`) |
| `notify` | `wake` / `passive` / `silent` | `wake` | Completion delivery policy (see Notifications) |
| `keep_alive` | bool | false | Survive Pi exit; re-adopted next session |
| `rtk` | `auto` / `off` | `auto` | `off` runs the command as the model wrote it, undoing the rtk hook's rewrite (see rtk section) |

Result when the command finishes in the window: identical to built-in `bash` (same truncation, same `details` shape, same `structuredContent`). No task is created: its record, log and exit file are deleted, and the full output (when truncated) is copied to a temp file like the built-in. When promoted: `Still running as task b7f3k9a2 ("npm test"). Last 20 lines: … Full log: <path>. You will be notified when it ends; read more with task_output.`

### task\_output

Read new output and status. Replaces polling loops: `wait_ms` blocks until the task exits, a `grep` match appears, or the wait expires.

| Param | Default | Notes |
| --- | --- | --- |
| `id` | required |  |
| `wait_ms` | 0 | Max 600000; returns early on exit or match |
| `from` | `cursor` | `cursor` (since this tool last read), `start`, or a byte offset |
| `grep` | none | Regex; only matching lines returned, with counts |
| `tail_lines` | 200 | Cap on lines returned |

Returns status, exit code or signal, duration, new output, next cursor, log path. Reading a terminal task marks it notified.

### task\_input

Write to stdin or the PTY, then return output produced in a short window. `text` decodes C escapes (`\x03` Ctrl-C, `\x04` EOF, `\x1b[A` up, `\r`); `keys` accepts names like `ctrl-c`, `enter`, `up`. Params: `id`, `text?`, `keys?`, `eof?`, `wait_ms` (default 750).

### task\_stop

`id` or `"all"`, `signal` (default `SIGTERM`), `grace_ms` (default 3000, then `SIGKILL` to the whole process group). Returns the final 20 lines and marks the task notified.

### task\_list

`status` filter (`running`, `done`, `all`). One line per task: id, kind, status, age, label, unread flag.

### monitor

Streaming watch: each stdout line that matches `filter` becomes an event delivered to the agent. Params: `command` or `file` (follows a file without a shell), `filter` regex, `description` (required), `timeout_ms` (default 300000), `persistent`, `max_events_per_min` (default 20; above it the monitor auto-stops and says so).

## Notifications

Every task ends with exactly one `<task-notification>`, unless the agent already learned the outcome. This is the core of the Claude Code feel and the main thing pi-process lacks.

**Exactly-once latch.** Each task has `notified: boolean`. It flips to true when the notification is sent, or when `task_output`, `task_stop` or a promoted `bash` result reveals the terminal state. A pending notification whose task flips first is dropped.

**Message shape** (custom message, `customType: "task-notification"`, rendered compactly in the TUI):

```
<task-notification id="b7f3k9a2" status="failed" exit="1" duration="4m12s">
npm test — 3 failed, 211 passed
…last 15 lines…
log: ~/.pi/agent/tasks/<session>/b7f3k9a2.log
</task-notification>
```

Completed tasks get a status line plus a short tail; failed and timed-out tasks get a longer tail (40 lines). The message never instructs the agent to act; it informs.

**Delivery mapping onto Pi's `sendMessage`**

| Agent state | `notify: wake` (default) | `notify: passive` | `notify: silent` |
| --- | --- | --- | --- |
| Streaming, mid-run | `deliverAs: "steer"`, lands at the next tool boundary | `deliverAs: "nextTurn"` | UI toast only |
| Idle | `triggerTurn: true`, agent reacts | `deliverAs: "nextTurn"` | UI toast only |
| About to settle (`agent_before_settle`) | Returns `continue: true` once if a wake notification is queued | Nothing | Nothing |
| Print / JSON mode | Held at `agent_before_settle` until running `wake` tasks finish, capped by `printModeMaxWaitMs` | Dropped | Dropped |

**Coalescing.** Terminal events arriving within 300 ms of each other go out as one message with one block per task. Monitor events are batched per monitor every 2 s.

**Goal-plugin compatibility** (pi-codex-goal and similar continuation drivers):

- `agent_before_settle` and `turn_end` handlers compose: realtasks only ever sets `continue: true` (once per queued wake notification) and passes through the `entries` and `continue` it received, so it never cancels another plugin's continuation.
- Notifications use `customType: "task-notification"` and never `sendUserMessage`, so goal plugins that parse user prompts (for example continuation markers) never see them as user input.
- The `input` handler for cooperative steering ignores `source: "extension"` input and only acts while a foreground `bash` is running. Goal continuations arrive as extension messages and pass through untouched.
- Tool names stay distinct (`bash`, `task_*`, `monitor`); realtasks registers no `goal` or `*_goal` tools and no `/goal` command.
- An aborted turn caused by cooperative steering resubmits the user's text with `sendUserMessage(..., { deliverAs: "followUp" })`, the same path a typed message takes, so goal accounting sees a normal user turn.

**Other one-shot signals** (each at most once per task, all `passive`):

- Stall: no output for 45 s, not a PTY, not rtk-rewritten, and the last line looks like a prompt (`?`, `(y/n)`, `Password:`, `>`). Suggests `task_input` or `task_stop`.
- Ready: when `ready` matches after the `bash` call already returned (only if it timed out waiting).
- Log cap reached: output past `maxLogBytes` is dropped from the log head and the agent is told once.

## Output and logs

Full output always goes to disk; the model only ever sees bounded slices.

- **Location**: `~/.pi/agent/tasks/<sessionId>/<taskId>.log` (respects `PI_CODING_AGENT_DIR`), not `/tmp`, so logs survive reboots and are found again on resume. A sibling `<taskId>.json` holds the task record; `<taskId>.exit` holds the exit code (see Process management).
- **Capture**: stdout and stderr are both written to the log fd by the child directly (no Node pipe in the hot path for pipe mode). PTY mode reads from the PTY and appends. Stdout and stderr are interleaved in pipe mode; monitors keep stderr in a separate `.err` file so it never counts as an event.
- **In-memory buffer**: a head + tail ring per task (first 4 KB, last 64 KB) for previews, the dock and notifications without touching disk.
- **Cursors**: `task_output` keeps a byte offset per task for the agent, so repeated reads return only new output. The UI has its own cursor and never moves the agent's.
- **Model-facing text**: ANSI and control sequences stripped, carriage-return progress bars collapsed to their final state, then truncated with Pi's own `truncateHead`/`truncateTail` helpers (same limits as built-in `bash`) and a footer pointing at the full log.
- **Caps**: `maxLogBytes` per task (default 50 MB). Past it, the log is rotated to keep the last half and the agent is told once; the task is never killed for being chatty, except monitors that exceed their event rate.
- **Retention**: terminal tasks stay listed for the session; logs older than `logRetentionDays` (default 7) are swept on `session_start`, in the background.

## Process management

Every task runs detached in its own process group with output going straight to a file, so it does not depend on Pi staying alive. That one choice makes promotion, reload and re-adoption cheap.

**Spawn**

- Same shell the built-in `bash` uses, run through a tiny wrapper: `sh -c '<shell> -c "$PI_TASK_CMD"; printf %s $? > "$PI_TASK_EXIT"'`. The exit file is what lets a re-adopted task report its real exit code.
- `detached: true` (new process group), stdio = `['ignore' | 'pipe', logFd, logFd]`. The log is opened `O_APPEND` so rotation can truncate it safely. Stdin is a pipe only when `bash` is called with `stdin: true` (default false, so a stray `cat` never hangs on an open pipe); PTY mode (`tty: true`) uses node-pty instead.
- Live output is read by polling the log size every 250 ms, the same path for fresh and re-adopted tasks.
- Env: inherited, plus `PI_TASK_ID`, and in pipe mode `PAGER=cat`, `GIT_PAGER=cat`, `TERM=dumb` so pagers never hang a task.
- Foreground and background are the same spawn. "Foreground" only means `bash` is still awaiting it, so promotion moves nothing; it just stops awaiting.
- Completion is the child's `exit` event (not `close`), so a daemonized grandchild holding the log fd cannot keep a task alive.
- Concurrency cap: `maxRunning` (default 16). Over it, `bash` with `run_in_background` errors with the list of running tasks.

**Stopping**

- `SIGTERM` to the process group (`process.kill(-pgid)`), then `SIGKILL` after `grace_ms`. Windows: `taskkill /T`, then `/F`.
- Esc during a foreground `bash` kills it (user cancel). Ctrl+Shift+B, a typed message, or the yield window ending promote it instead. Same split as Claude Code.
- `timeout` kills and ends the task as `timed_out`, never as `failed`.

**Readiness** (`ready` on `bash`)

- `pattern`: regex on live output (ANSI-stripped).
- `port`: TCP connect to 127.0.0.1 and ::1 every 250 ms.
- `url`: HTTP GET, any status below 500 counts.
- Result reports which condition fired and the output so far; an early exit returns as a normal failure.

**Lifetime**

| Event | Pipe-mode task | PTY task | `keep_alive` task |
| --- | --- | --- | --- |
| `/reload` (`session_shutdown` then `session_start`) | Re-adopted with its stdin pipe | Re-adopted with its PTY | Re-adopted |
| Switch to another session | Stopped; TUI asks first if any are running | Stopped | Keeps running, re-adopted when that session resumes |
| Pi process exits | Killed in a synchronous `process.on("exit")` handler | Killed | Keeps running |

**Reload handoff**: `/reload` keeps the same Node process, so live handles (stdin pipe, PTY, `ChildProcess`) are parked in a `globalThis[Symbol.for("realtasks.handles")]` table on `session_shutdown` with reason `reload` and picked up by the new runtime. Only raw handles cross the boundary, never objects built by the old module code, so new code always rebuilds its own task state from the `<taskId>.json` records.

**Re-adoption** on `session_start`: read `<taskId>.json` records for this session; for each `running` one, confirm the PID is alive and its start time matches the record (guards against PID reuse; Linux reads `/proc/<pid>/stat`, macOS `ps -o lstart=`), then resume tailing the log and polling liveness every 1 s. Dead with an exit file → finalized and notified (`passive`, since the agent may be on another topic). Dead without one → `lost`. The registry is also mirrored with `pi.appendEntry("realtasks", …)` so the transcript shows when tasks started and ended across reloads: `{event: "started", id, kind, label, command}` when a task is created or a foreground command is promoted, `{event: "ended", id, status, exitCode?, signal?}` when a task ends, and `{event: "readopted", reason, running, finished}` after re-adoption. Foreground commands that finish inside the yield window are not tasks and get no entries. These entries are not sent to the model.

Windows is not supported.

## rtk compatibility (official Pi hook)

Target: rtk's own Pi extension, [hooks/pi/rtk.ts](https://raw.githubusercontent.com/rtk-ai/rtk/develop/hooks/pi/rtk.ts), installed by `rtk init --agent pi` to `~/.pi/agent/extensions/rtk.ts` (or `.pi/extensions/rtk.ts`), shipped from [RTK 0.42](https://github.com/rtk-ai/rtk/pull/1741). realtasks ships no rtk logic of its own; it keeps the hook's contract intact and protects the cases where a rewrite would break a background task.

**What the hook does** (from its source):

- Listens on `tool_call`; acts only when `event.toolName === "bash"`.
- Skips empty commands, commands already starting with ` rtk  `, and runs where `RTK_DISABLED=1` is set in Pi's own environment.
- Runs `rtk rewrite <cmd>` via `pi.exec` with a 2 s timeout; exit 0 or 3 with stdout → replaces `event.input.command` in place; anything else passes through (fail-open).
- Probes `rtk --version` at load; missing or older than 0.23 → disabled, status line says why.

**Contracts realtasks must keep**

1. The override is registered under the exact name `bash`, so the hook fires. Never rename it to `exec_command` (pi-unified-exec's choice, which silently disables rtk).
2. The command is read from `params.command` inside `execute()`, after all `tool_call` handlers ran. Never cache it from an earlier event.
3. `command` stays a plain string param; extra params (`run_in_background`, `ready`, `tty`, …) live alongside it and are untouched by the hook.
4. `task_output`, `task_input`, `task_stop`, `task_list` and `monitor` have other tool names, so the hook never rewrites them. `monitor` is the right tool for `tail -f`-style streams for that reason.
5. Logs, notifications and the dock show the command that actually ran. Pi's transcript renders the original call, so the task record stores both `requested` and `executed` and the UI shows `git status → rtk git status` when they differ.

**Where a rewrite hurts, and the fix**

rtk filters condense output, and some only emit once the wrapped command exits. That is ideal for finite commands, but harmful when realtasks needs live bytes:

| Case | Problem with the rewritten command | realtasks behavior |
| --- | --- | --- |
| Finite foreground or `run_in_background` (tests, builds, `git log`) | None; compressed output is the point | Run as rewritten |
| `ready` set (dev servers) | Ready pattern may never appear in live output | Run the original command |
| `tty: true` (REPLs, prompts) | rtk sits between the PTY and the program | Run the original command |
| Stall detector on a rewritten task | Silence is expected while rtk buffers | Detector disabled for rewritten tasks |
| Explicit `rtk: "off"` | Model or user wants raw output | Run the original command |

**Recovering the original command** (the hook mutates in place, so `execute()` only sees the rewrite):

1. realtasks registers its own `tool_call` handler that stashes `event.input.command` by `toolCallId`. If it loads before rtk.ts, this is the original.
2. Otherwise, read the original arguments of that `toolCallId` from the assistant message in `ctx.sessionManager.getBranch()`; the transcript keeps the model's unmodified call.
3. If neither is available, run the rewritten command and say so in the result.

Step 2 needs a spike to confirm the assistant message is on the branch before tools execute. If it is, step 1 becomes a fast path only.

**Not in scope**: the official hook doesn't cover user `!cmd`, so neither does realtasks' `/bg <cmd>`. realtasks never sets `RTK_DISABLED` and never shells out to `rtk` itself.

## User UX

The user sees what is running at a glance and can take over any task without asking the agent.

- **Foreground `bash` rendering**: live tail via `onUpdate` (last 8 lines), elapsed time, and a dim hint after 2 s: `ctrl+shift+b to background`. Shows `requested → executed` when the rtk hook rewrote the command.
- **Task tool rendering** (`renderCall`/`renderResult` on `task_output`, `task_input`, `task_stop`, `monitor`): calls name the task by label, never by bare id, and show durations in human units, never raw milliseconds. Examples: `task_output npm test (b7f3k9a2) · wait up to 10m`, `task_input python REPL (bdw9czz1) · "print(2+2)⏎"`, `task_stop dev server (bgkrw0t2)`, `task_stop all running tasks`. An unknown id falls back to the id alone. While `task_output` waits, its row shows a live line updated every second, `✳ waiting for npm test · 1m12s of 10m │ test 31 ok`, with the spinner, the elapsed wait, the cap, and the task's latest output line (sent through `onUpdate`, so it is visible but costs no model tokens). When it returns, the row shows why: `✓ npm test completed exit 0 · waited 1m14s`, `grep matched · waited 3s`, or `still running · waited 10m (cap)`. The model-facing parameter stays `wait_ms` for API stability; only the display changes.
- **Dock** (`ctx.ui.setWidget`, above the editor), drawn as a tree in the style of rpiv-todo and Claude Code's background tasks:

  ```
  ● Tasks (2 running · 1 done)
  ├─ ✳ bxomyvwe npm test · 42s │ test 31 ok
  ├─ ◉ mshcwo0p app errors · 12s │ ERROR boom 3
  └─ ✓ b2ywygi6 build · exit 0 · 8s
  ```

  The heading is `●` in the accent color while anything runs, `○` dim otherwise. Each row has a status glyph, the id (dim), the label, the elapsed or total time, and for running tasks the latest output line after a dim `│`. Running shell and PTY tasks show an animated star spinner in the style of Claude Code (`·✢✳✶✻✽` played forward then back, one frame per 120 ms). It is deliberately not Pi's braille spinner, so task activity looks different from Pi's own "Working" indicator. Running monitors pulse between `◉` and `◎`. Finished tasks stay for 10 s after they end with `✓` (completed), `✗` (failed, timed out), `■` (stopped) or `?` (lost), then drop out. At most 5 task rows; the rest collapse into `└─ +N more · /tasks`. The last row uses `└─`, and one blank line follows the panel so it does not touch the editor. The dock is hidden when nothing is running or lingering, and the animation timer runs only while the dock is shown. The status line carries the spinner frame and the running count (`✳2`) plus `✓2 ✗1` counts for unread finished tasks.
- **`/tasks` manager** (`ctx.ui.custom` overlay): list on the left, live log on the right. Keys: `↑↓` select, `enter` toggle follow, `pgup`/`pgdn` scroll, `k` stop, `i` send input (prompts for text, C escapes decoded), `r` restart with the same command, `c` copy log path, `x` clear finished, `esc` close. Restart stops the task if it is running, then starts a new user task (as `/bg <cmd>`) with the same executed command, cwd, `tty` and `stdin`; the new task gets a new id. Opening the manager marks finished tasks as seen by the user (clears the `✓`/`✗` status counts) without touching the agent's `notified` latch.
- **Cooperative steering**: typing a message while a foreground `bash` runs promotes it to a task, aborts the turn and delivers the message as a fresh user turn (patty's behavior, Claude Code parity). Opt-out via `steerPromotes: false`.

| Shortcut / command | Action |
| --- | --- |
| `ctrl+shift+b` | Promote all running foreground commands to tasks |
| `shift+down` | Open `/tasks` |
| `/bg` | Same as `ctrl+shift+b` (for tmux without extended keys) |
| `/bg <cmd>` | User starts a task directly; output goes to the log, not the model context. Its completion is a UI toast only (`silent`), so it never wakes the agent |
| `/tasks` | Open the manager |
| `/tasks stop <id or all>` | Stop from the command line |
| `/tasks clear [all]` | Remove finished tasks from the list, the dock and the status counts. Their logs stay on disk until the retention sweep. A finished task whose outcome the agent has not read yet is kept unless `all` is given (tasks the agent is never told about, `/bg <cmd>` tasks and `notify: "silent"` tasks, do not count as unread and are always cleared); `all` also marks those as read, so no notification for them is sent later. Running tasks are never touched (stop them first). Reports how many were cleared and how many unread ones were kept |
| `/tasks log <id>` | Print the task's log path and its last 20 lines as a UI notice (no model context) |

**No conflicts with Pi's keybindings.** realtasks never takes a key Pi binds by default (for example `ctrl+b` is cursor-left, `ctrl+shift+up`/`down` jump between prompts) or one the user bound in `keybindings.json`. The defaults `ctrl+shift+b` and `shift+down` are unbound in Pi. At load, each configured shortcut is checked against Pi's resolved keybindings (`getKeybindings().getResolvedBindings()`, which merges defaults and user bindings); a clashing shortcut is not registered and a warning names the Pi action it would shadow and the `shortcuts.*` key in `realtasks/config.json` to change. `/bg` and `/tasks` always remain available. Every shortcut is remappable in that config, and `off` disables it.

Non-TUI modes: tools and notifications behave the same; dock, overlay and shortcuts are skipped (`ctx.mode !== "tui"`); RPC clients get notifications through `ctx.ui.notify` where supported.

## Configuration

All keys live in `<agentDir>/realtasks/config.json` (default `~/.pi/agent/realtasks/config.json`; `PI_CODING_AGENT_DIR` moves it). A trusted project can override keys in `.pi/realtasks/config.json`; project values apply only when `ctx.isProjectTrusted()` is true. The file is optional; a missing file means defaults. Invalid JSON or a non-object top level is reported once with a warning and that file is ignored; invalid individual values fall back to their defaults. Config is read at `session_start`, so edits take effect on `/reload`. realtasks does not read Pi's `settings.json`.

| Key | Default | Meaning |
| --- | --- | --- |
| `yieldMs` | 30000 | Default foreground window before promotion |
| `maxRunning` | 16 | Concurrent running tasks |
| `maxLogBytes` | 52428800 | Per-task log cap before rotation (50 MB) |
| `logRetentionDays` | 7 | Sweep age for old logs |
| `stallSeconds` | 45 | Silence before the prompt-looking stall check |
| `defaultNotify` | `wake` | Policy when `bash` omits `notify` |
| `printModeMaxWaitMs` | 600000 | How long print/JSON mode waits for `wake` tasks |
| `steerPromotes` | true | Typing during a foreground command promotes it |
| `rtkPassthroughFor` | `["ready", "tty"]` | Task features that run the original command instead of the rtk rewrite |
| `shortcuts.background` | `ctrl+shift+b` | Promote shortcut; `off` disables |
| `shortcuts.manager` | `shift+down` | Manager shortcut; `off` disables |
| `dir` | `<agentDir>/tasks` | Log and record root |

## Phasing and non-goals

Ship the Claude Code core first; Codex-style interaction and durability follow once the core is stable.

1. **v0.1 Core**: `bash` override with yield and `run_in_background`, `task_output` (with `wait_ms`), `task_stop`, `task_list`, exactly-once notifications, disk logs, dock, `ctrl+shift+b`, rtk contracts 1–5 with original-command recovery.
2. **v0.2 Interaction**: `task_input`, `tty` via optional `@lydell/node-pty`, `ready`, stall detection, cooperative steering, `/tasks` overlay.
3. **v0.3 Durability**: re-adoption across `/reload`, `keep_alive`, print-mode settle handling, log retention.
4. **v0.4 Streams**: `monitor` (command and file sources), event batching and flood stop.

**Non-goals**: background subagents (`agent_bg`), WebSocket monitors, tmux or any external process manager, blocking `sleep` commands, shipping rtk rewrite logic, Windows PTY.

## Acceptance tests

Each flow is an agent-driven prompt run twice: with `rtk init --agent pi` installed and without. Unit tests cover the registry, latch, cursors and wrapper with a fake `ExtensionAPI`.

| # | Prompt to the agent | Pass when |
| --- | --- | --- |
| 1 | "Run `uname -a`" | One `bash` call, foreground result, no task created |
| 2 | "Run the test suite" (takes \~2 min) | Promoted at 30 s; agent keeps working; one `<task-notification>` arrives; no `task_output` polling loop; with rtk, the executed command is `rtk …` and the notification shows compressed output |
| 3 | "Start the dev server and check the homepage" | `bash` with `run_in_background` + `ready.port` returns once the port opens; the original command runs even with rtk installed; `curl` follows |
| 4 | "Start `python3` with a tty, compute 2+2, then exit" | `task_input` sends `print(2+2)\r`, output shows `4`, `\x04` ends it, no stall warning |
| 5 | "Run `sleep 20 && false` in the background, then `/reload`" | Task is re-adopted after reload and finishes as `failed`, exit 1, notified once |
| 6 | Agent reads a finished task with `task_output` before the notification flushes | No notification is sent for that task |
| 7 | Monitor `grep --line-buffered ERROR` on a log that gets 3 errors | Three events, batched, monitor not rewritten by rtk |

## Decisions

Resolved from the original open questions:

- Default yield window: 30 s.
- Name: `realtasks` (npm package and extension name). It replaces `pi-patty-bg-tasks`; both override `bash`, so only one may be installed.
- Session switch stops pipe-mode tasks (TUI asks first); `keep_alive` tasks keep running.
- `monitor` ships (v0.4 scope is in).
- Linux and macOS only. Windows is out of scope for now.
- rtk original-command recovery uses both step 1 (own `tool_call` stash) and step 2 (assistant message on the branch); Pi persists the assistant message at `message_end`, before tool execution starts.

## Development

- Bun for development: `bun install`, `bun test`, `bunx tsc --noEmit`.
- Pi runs extensions on Node. `@lydell/node-pty` does not work under the Bun runtime (the child exits at once), so the PTY test runs its scenario in a `node --experimental-strip-types` subprocess (`test/pty-node.ts`); everything else runs in `bun test`.
- Every change edits this spec first, then the code.
