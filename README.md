# realtasks

Background tasks for [Pi](https://pi.dev). You start a command, keep working, and get told once when it ends. It also drives interactive programs through stdin or a PTY.

realtasks overrides `bash` and adds `task_output`, `task_wait`, `task_input`, `task_stop`, `task_list` and `monitor`. It works with rtk's Pi hook and with goal plugins such as pi-codex-goal.

The full design is in [docs/realtasks-architecture.md](docs/realtasks-architecture.md).

## Install

```bash
pi install git:github.com/st0nie/realtasks
```

realtasks replaces `pi-patty-bg-tasks`. Both override `bash`, so remove patty first:

```bash
pi remove npm:pi-patty-bg-tasks
```

PTY mode (`tty: true`) needs the optional dependency `@lydell/node-pty`, which installs automatically where a prebuilt binary exists (Linux, macOS and Windows x64/arm64).

### Windows

realtasks runs on Linux, macOS and Windows. On Windows, tasks run in the same bash that Pi's built-in `bash` tool uses: [Git for Windows](https://git-scm.com/download/win), or MSYS2/Cygwin bash on PATH. `bash` itself does not need to be on PATH. The WSL launcher (`System32\bash.exe`) is not supported.

- Commands are bash commands, so MSYS path conversion applies. Write `cmd //c ver`, not `cmd /c ver`.
- `task_stop` and timeouts always force-kill every process of the task (Windows has no SIGTERM for console programs), so `grace_ms` has no effect.
- PTY mode uses ConPTY.

## How `bash` behaves

- `timeout` works like Claude Code's: it is the foreground window in seconds (default 120, max 600), not a kill switch. A command that finishes within it returns exactly like the built-in `bash`, and no task is created.
- A command still running when `timeout` ends is not killed. It becomes a task, and the agent gets the id and the last 20 lines, then one `<task-notification>` when the task ends. Stop a task with `task_stop`.
- `run_in_background: true` returns the id at once.
- `ready: {port | url | pattern}` waits until a server is ready, then returns. It implies background.
- `tty: true` or `stdin: true` lets `task_input` write to the process.
- `notify` sets the delivery policy. `wake` (the default) starts a turn, `passive` waits for the next turn, `silent` only shows a toast.
- `keep_alive: true` keeps the task running after Pi exits. It is re-adopted when the session resumes.

Output goes to `~/.pi/agent/tasks/<session>/<id>.log`. Logs rotate at 50 MB and are deleted after 7 days.

## Tools

| Tool | Purpose |
| --- | --- |
| `task_output` | New output since the last read. Never blocks. `grep` filters lines; `from: "start"` rereads from the beginning. `peek: true` looks without moving the cursor or using up the completion notification; `lines: "120-260"` reads numbered log lines (also a peek) |
| `task_wait` | Blocks until a task exits, its output matches `until`, or `timeout_ms` passes, then returns the new output. Takes an array of ids and returns when any of them is done. Use it only when there is nothing else to do; the completion notification already says when a task ends |
| `task_input` | Send `text` (C escapes such as `\r` and `\x03`) or `keys` (`ctrl-c`, `enter`, `up`), or `eof` |
| `task_stop` | SIGTERM the process group, then SIGKILL after `grace_ms` (Windows: force-kills all of the task's processes at once). Accepts an id or `all` |
| `task_list` | Ids, status, age, label, unread outcomes |
| `monitor` | Each stdout line of a command, or each new line of a file, matching `filter` becomes a `<task-event>`, batched every 2 s and rate-capped |

## TUI

- The dock above the editor draws running and just-finished tasks as a tree, with an animated star spinner for running ones:

  ```text
  ● Tasks (2 running · 1 done)
  ├─ ✱ bxomyvwe npm test · 42s │ test 31 ok
  ├─ ◉ mshcwo0p app errors · 12s │ ERROR boom 3
  └─ ✓ b2ywygi6 build · exit 0 · 8s
  ```

  Finished rows stay for 10 s. The status line shows the running count and unread finished counts (`✱2 ✓1 ✗1`).
- `ctrl+b` on an empty input, or `/bg`, sends running foreground commands to the background. A running `bash` row shows `ctrl+b to background · auto in 1m48s`. With text in the input, or with nothing running, `ctrl+b` stays Pi's cursor-left. A message you type meanwhile is queued, as in Claude Code, and does not touch the command.
- `shift+down` or `/tasks` opens the manager. It has the task list on the left and the selected task's log on the right:

  | Key | Action |
  | --- | --- |
  | `↑` `↓` | Select a task |
  | `shift+↑` `shift+↓` | Scroll the log one line |
  | `pgup` `pgdn` | Scroll one page |
  | `ctrl+u` `ctrl+d` | Scroll half a page |
  | `home` or `g`, `end` or `G` | Jump to the start or the end of the log |
  | `enter` | Pause or resume following the output |
  | `k` `i` `r` | Stop the task, send it input, restart it |
  | `c` `x` | Copy the log path, clear finished tasks |
  | `esc` or `q` | Close |

  Scrolling up pauses the view, so it holds still while the task keeps writing; scrolling back to the end follows the output again. In Pi's fullscreen mode the mouse wheel scrolls the log, or moves the selection over the list, and a click selects a task.
- `/bg <cmd>` starts a task yourself. Its completion never wakes the agent.
- `/tasks stop <id|all>` stops tasks. `/tasks clear` removes finished tasks the agent has already seen; `/tasks clear all` removes every finished task. `/tasks log <id>` shows a task's log path and last 20 lines.

Shortcuts never take over a key Pi already binds. `ctrl+b` is Pi's cursor-left, so realtasks shares it instead: it acts only when the input is empty and a foreground command is running. Any other setting that clashes with a Pi binding is skipped with a warning; a key Pi does not bind works whatever the input holds.

## Configuration

Config lives in `~/.pi/agent/realtasks/config.json` (optional; missing means defaults). A trusted project can override keys in `.pi/realtasks/config.json`. realtasks does not read Pi's `settings.json`.

```json
{
  "defaultTimeoutMs": 120000,
  "maxTimeoutMs": 600000,
  "maxRunning": 16,
  "maxLogBytes": 52428800,
  "logRetentionDays": 7,
  "stallSeconds": 45,
  "defaultNotify": "wake",
  "printModeMaxWaitMs": 600000,
  "rtkPassthroughFor": ["ready", "tty"],
  "shortcuts": { "background": "ctrl+b", "manager": "shift+down" }
}
```

Set a shortcut to `"off"` to disable it. Config changes take effect on `/reload`.

## Development

```bash
bun install
bun test          # unit + integration (the PTY test runs under node)
bunx tsc --noEmit
pi -e ./index.ts  # try it locally
```

Every behavior change edits the spec first, then the code.

## License

MIT
