# umio CLI — MVP specification

Status: implemented as the MVP described here. Library code stays usable without the CLI; everything terminal-specific lives in `src/cli/`.

## Goals

- A focused terminal conversation with a configured model and agent: streaming text, compact tool activity, explicit approval for tools that may change things.
- Graph workflow operations the runtime already supports: run, status, list, resume, cancel, recover. Never retry an uncertain node automatically, and always say that its side effects may have happened.
- Long local inference (2–3 hours without output) is normal, not an error: show elapsed time and a "still running" indicator. UI timers are presentation only; they never touch node timeouts, leases or requests.
- Legible without color; quiet and JSON output for scripts.

## Layers

| Layer | Files | Knows about the terminal? |
|---|---|---|
| Command parsing | `args.ts` (`node:util` `parseArgs`), `duration.ts` | No — pure, returns a typed command or a usage error |
| Session state | `session.ts` (operation state machine, chat transcript and cancel recovery), `activity.ts` (phase and elapsed time) | No — pure, time injected |
| Adapters | `chat.ts` (`Agent` + `LLM`), `graph.ts` (`WorkflowExecutor` + `FileCheckpointStore`), `config.ts` (discovery, `init`, summary), `doctor.ts` | No — they report through a `Presenter` interface |
| Presentation | `style.ts` (color and symbols), `format.ts` (pure string formatting at a given width), `explain.ts` (errors → message + hint), `terminal.ts` (status line, heartbeats, resize) | Yes |
| Interaction | `repl.ts` (interactive loop and keys), `app.ts` (dispatch, exit codes, signals), `main.ts` (bin entry) | Yes |

Dependencies: **none added.** `node:util` `parseArgs` parses arguments, `node:readline` handles line editing and history, and ANSI output is a few escape codes. A TUI framework (Ink, blessed) would add a React or large runtime for a line-oriented interface that does not need it.

## Commands

```
umio [chat]            interactive session (default when stdin/stdout are a TTY)
umio ask [prompt]      one-shot; prompt from the argument or stdin
umio init              write a starter umio.config.json for a local Ollama model
umio doctor            check config, models, providers, local servers, timeouts
umio config            show the resolved config (secrets masked)
umio models | tools    list model aliases | configured tools
umio graph run <module> [--input <text>|--input-file <f>] [--run-id <id>]
umio graph status <run-id>      nodes, owner, and nodes needing recovery
umio graph list [--needs-recovery]
umio graph resume <module> <run-id>
umio graph cancel <run-id>
umio graph recover <module> <run-id> <node-id> (--retry | --fail [msg] | --complete <json> | --complete-file <f>)
```

Global options: `--config <file>` (else `UMIO_CONFIG`, else `umio.config.json` in the working directory or a parent), `--model <alias>`, `--tools <a,b>` (toolsets; default all configured), `--yes` (approve every tool), `--store <dir>` (graph checkpoints; default `.umio/runs` next to the config), `--json`, `--quiet`, `--no-color`, `--heartbeat <duration>`, `--debug`, `-h/--help`, `-v/--version`.

A workflow module is an ES module whose default export is a `WorkflowDefinition` or a function `({ llm, config }) => WorkflowDefinition` (may be async). It must import `umio` from the same installation as the CLI (instances are shared through one ESM build).

Exit codes: 0 success; 1 error or failed run; 2 usage error; 3 run needs recovery; 130 cancelled.

## Main screens

**Chat.** A one-line banner (`umio 0.1.0 · model local (ollama, local) · tools: repo, misc · /help`), then a `›` prompt. A turn prints streamed text as it arrives. Tool activity is one line per call, indented: `⚙ read_file path=src/index.ts` while running, replaced by `✓ read_file 120ms · 1.2 kB` or `✗ read_file: <first line of error>`. A footer line after each turn: `· 12.3s · in 1.2k out 340 tokens`.

**Status line (TTY only).** While an operation runs and the cursor is at the start of a line, the last line shows `⠋ waiting for model · 1h 12m · no output yet — local models can take hours`. It is redrawn once a second, truncated to the terminal width, and cleared before any other output. After 60 s without output it says `still running · last output 14m ago`. Silence is never a failure; only the configured node/provider timeouts end work.

**Non-TTY.** No status line or spinner. Unless `--quiet`, a heartbeat line goes to stderr every `--heartbeat` (default 5m): `umio: still running · 1h 05m · waiting for model`. Model text goes to stdout; tool activity, heartbeats and diagnostics to stderr.

**Graph run.** One line per event (`▸ design started (attempt 1)`, `✓ design completed · 12m`, `↻ design retry at 12:04`, `? design uncertain (abandoned-timeout)`), a status line with running nodes and their elapsed times, then a node table and, if any, the recovery block.

**Recovery block.** For each uncertain node: reason, attempt, idempotency key, the sentence "Its handler may have run fully, partly or not at all; its side effects may have happened.", and the three explicit `umio graph recover` commands. Nothing is chosen for the user.

## Keyboard (interactive)

| Key | Idle | Running |
|---|---|---|
| Enter | send the line / run the command | — (input is not accepted; typing is ignored) |
| Esc | — | cancel the operation |
| Ctrl+C | clear the line; on an empty line, print how to exit | cancel the operation (again: "still cancelling…") — **never exits** |
| Ctrl+D | exit (empty line) | ignored, with a hint to cancel first |
| y / n / a | — | answer a tool approval: yes / no / always for this tool this session |

Slash commands: `/help`, `/model [alias]`, `/config`, `/session`, `/tools`, `/new`, `/cancel` (only reports that nothing runs, since input is closed while running), `/exit` (`/quit`), `/graph <subcommand …>` (same as `umio graph …`; runs in this session and is cancelled with Esc/Ctrl+C).

## Run-state presentation

- Chat operation states: `idle → running → (cancelling →) idle`. Exit is only accepted when idle.
- Cancelling a chat turn: if no tool ran, the transcript is restored to before the turn and the prompt is put back on the input line. If tools ran, the completed steps stay in the transcript, tools that were running are recorded as "outcome unknown", tools not yet started as "not run", and a note is prepended to the next message so the model knows what already happened. Nothing is re-sent automatically, so no tool runs twice because of a cancel.
- Graph statuses map to words and symbols that do not rely on color: `✓ completed`, `✗ failed`, `– cancelled`, `– skipped`, `? uncertain`, `▸ running`, `· pending`, `↻ pending (retry at …)`.
- `graph status` also reports ownership from the store: `owned by a live executor (lease valid for 22s)`, `interrupted — no live owner; resume it`, or `cancel requested`.

## Shutdown and signals

- `umio ask`: Ctrl+C cancels the turn (exit 130). A second Ctrl+C exits at once.
- `umio graph run/resume`: the first Ctrl+C calls `executor.cancel()` (an explicit, recorded cancel; nodes get the grace period). A second Ctrl+C exits immediately **without** finalizing: the run stays `running` in the store; `graph status` shows it as interrupted, and `graph resume` turns its running nodes into `uncertain` (never re-runs them silently). SIGTERM behaves like the second Ctrl+C.
- The status line is cleared and the cursor restored on every exit path.

## Error states

Each error prints one line `error: <what happened>` and one `hint: <what to do>`; `--debug` (or `UMIO_DEBUG=1`) adds the cause chain and stack.

| Situation | Hint |
|---|---|
| No config found | `umio init` or `--config <file>`; lists where it looked |
| Invalid JSON / schema errors | the file and each issue path |
| Unknown model alias | the configured aliases |
| Missing environment variable for a provider | the variable name and provider |
| Local server unreachable | the base URL and how to start it (`ollama serve`, LM Studio server) |
| Provider timeout / headers timeout | which limit fired, and the settings to raise |
| Provider timeout below intended node duration (doctor) | per-request vs per-node explanation, settings to change |
| Store locked by another process | the PID; the file store is single-process |
| Lease unavailable | the run is owned or its dead owner's lease has not expired yet; retry after ~30 s |
| Definition mismatch | the workflow module changed since the run started |
| Recovery not applicable | why (node not uncertain, output invalid) |

## Outside the MVP

Session persistence, multi-line editing, a full-screen layout, cross-process cancel with the file store (single-process), MCP, and a config editor.
