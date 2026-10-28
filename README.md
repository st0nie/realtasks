# realtasks

Background tasks for [Pi](https://pi.dev). You start a command, keep working, and get told once when it ends. It also drives interactive programs through stdin or a PTY.

realtasks overrides `bash` and adds `task_output`, `task_input`, `task_stop`, `task_list` and `monitor`. It works with rtk's Pi hook and with goal plugins such as pi-codex-goal.

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

- A command that finishes within `yield_ms` (default 30 s) returns exactly like the built-in `bash`. No task is created.
- A command still running at the end of the window becomes a task. The agent gets the id and the last 20 lines, then one `<task-notification>` when the task ends.
- `run_in_background: true` returns the id at once.
- `ready: {port | url | pattern}` waits until a server is ready, then returns. It implies background.
- `tty: true` or `stdin: true` lets `task_input` write to the process.
- `timeout` (seconds) kills the task and ends it as `timed_out`.
- `notify` sets the delivery policy. `wake` (the default) starts a turn, `passive` waits for the next turn, `silent` only shows a toast.
- `keep_alive: true` keeps the task running after Pi exits. It is re-adopted when the session resumes.

Output goes to `~/.pi/agent/tasks/<session>/<id>.log`. Logs rotate at 50 MB and are deleted after 7 days.

## Tools

| Tool | Purpose |
| --- | --- |
| `task_output` | New output since the last read. `wait_ms` waits for exit or a `grep` match. `from: "start"` rereads from the beginning |
| `task_input` | Send `text` (C escapes such as `\r` and `\x03`) or `keys` (`ctrl-c`, `enter`, `up`), or `eof` |
| `task_stop` | SIGTERM the process group, then SIGKILL after `grace_ms` (Windows: force-kills all of the task's processes at once). Accepts an id or `all` |
| `task_list` | Ids, status, age, label, unread outcomes |
| `monitor` | Each stdout line of a command, or each new line of a file, matching `filter` becomes a `<task-event>`, batched every 2 s and rate-capped |

## TUI

- The dock above the editor draws running and just-finished tasks as a tree, with an animated star spinner for running ones:

  ```
  ● Tasks (2 running · 1 done)
  ├─ ✱ bxomyvwe npm test · 42s │ test 31 ok
  ├─ ◉ mshcwo0p app errors · 12s │ ERROR boom 3
  └─ ✓ b2ywygi6 build · exit 0 · 8s
  ```

  Finished rows stay for 10 s. The status line shows the running count and unread finished counts (`✱2 ✓1 ✗1`).
- `ctrl+shift+b` or `/bg` sends running foreground commands to the background. Typing a message while one runs does the same.
- `shift+down` or `/tasks` opens the manager. Its keys are `k` stop, `i` input, `r` restart, `c` copy log path, `x` clear finished, and `enter` follow.
- `/bg <cmd>` starts a task yourself. Its completion never wakes the agent.
- `/tasks stop <id|all>` stops tasks. `/tasks clear` removes finished tasks the agent has already seen; `/tasks clear all` removes every finished task. `/tasks log <id>` shows a task's log path and last 20 lines.

Shortcuts never take a key Pi already binds (`ctrl+b`, for example, is cursor-left). A conflicting setting is skipped with a warning.

## Configuration

Config lives in `~/.pi/agent/realtasks/config.json` (optional; missing means defaults). A trusted project can override keys in `.pi/realtasks/config.json`. realtasks does not read Pi's `settings.json`.

```json
{
  "yieldMs": 30000,
  "maxRunning": 16,
  "maxLogBytes": 52428800,
  "logRetentionDays": 7,
  "stallSeconds": 45,
  "defaultNotify": "wake",
  "printModeMaxWaitMs": 600000,
  "steerPromotes": true,
  "rtkPassthroughFor": ["ready", "tty"],
  "shortcuts": { "background": "ctrl+shift+b", "manager": "shift+down" }
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
