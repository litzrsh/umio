export const MAIN_HELP = `umio — chat with your configured models and run graph workflows

Usage
  umio [chat]                 interactive session (needs a terminal)
  umio ask [prompt]           one answer; reads the prompt from stdin if omitted
  umio init                   write a starter umio.config.json (local Ollama model)
  umio doctor                 check config, models, local servers and timeouts
  umio config                 show the resolved config (secrets masked)
  umio models                 list model aliases
  umio tools                  list configured tools
  umio graph <subcommand>     run and manage graph workflows (umio help graph)

Options
  -c, --config <file>     config file (default: $UMIO_CONFIG, else umio.config.json here or above)
  -m, --model <alias>     model alias (default: the config's defaultModel)
      --tools <a,b>       toolsets to offer (default: all configured; "none" for no tools)
  -y, --yes               run tools that may change things without asking
      --store <dir>       graph checkpoint directory (default: .umio/runs next to the config)
      --json              machine-readable output (ask, doctor, config, models, tools, graph)
  -q, --quiet             no progress, heartbeats or tool lines; results and errors only
      --no-color          plain output (also: NO_COLOR=1)
      --heartbeat <time>  "still running" interval when not in a terminal (default 5m)
      --verbose           show tool result previews
      --debug             show error causes and stacks (also: UMIO_DEBUG=1)
  -h, --help              help (umio help <command>)
  -v, --version           version

Exit codes: 0 ok · 1 error or failed run · 2 usage · 3 run needs recovery · 130 cancelled
`;

export const TOPICS: Record<string, string> = {
  chat: `umio chat — interactive session

Keys
  Enter          send
  Esc, Ctrl+C    cancel the running operation (never exits)
  Ctrl+C         on an idle prompt: clear the line
  Ctrl+D         exit (on an empty prompt, when nothing runs)
  y / n / a      answer a tool approval: yes / no / always for this tool

Commands
  /help  /model [alias]  /config  /session  /tools  /new  /cancel  /exit
  /graph <subcommand …>   same as \`umio graph …\`, cancelled with Esc

A model call to a local server may run for hours without output. The status
line shows the elapsed time; silence is not an error.
`,
  ask: `umio ask [prompt] — one answer, for scripts

The prompt is the arguments, or stdin when there are none. Model text goes to
stdout; tool activity and heartbeats to stderr. Tools not marked read-only are
declined unless --yes is given. --json prints one JSON object at the end:
{ "text", "stopReason", "model", "usage", "tools": [{ "name", "input", "isError", "durationMs" }] }
Ctrl+C cancels (exit 130).
`,
  init: `umio init [--local-model <name>] [--force] [--config <file>]

Writes a starter config with one local Ollama model (default llama3.2), read-only
file tools, and graph.maxConcurrency 1. Then run: umio doctor
`,
  doctor: `umio doctor [--model <alias>] [--node-timeout <duration>] [--json]

Checks the config, the model alias, provider credentials, that local servers
answer and list the configured models, and that no local provider ends a
request before --node-timeout (default 3h; "none" for no limit). Cloud APIs are
never called. Exit code 1 if any check fails.
`,
  graph: `umio graph — graph workflows

  umio graph run <module> [--input <text> | --input-file <file>] [--run-id <id>]
  umio graph status <run-id>
  umio graph list [--needs-recovery]
  umio graph resume <module> <run-id>
  umio graph cancel <run-id> [--wait [--timeout <duration>]]
  umio graph recover <module> <run-id> <node-id> --retry
  umio graph recover <module> <run-id> <node-id> --complete <json> | --complete-file <file>
  umio graph recover <module> <run-id> <node-id> --fail [--reason <text>]

<module> is an ES module whose default export is a WorkflowDefinition or a
function ({ llm, config }) => WorkflowDefinition. Runs are checkpointed in
--store (default .umio/runs next to the config); that store is single-process.
While another umio process holds it, status and list still work, cancel sends
a request (below), and resume and recover fail at once with a lock error.

cancel works from any terminal. If another umio process is driving the run, it
writes a cancel request file; that process picks it up within ~2 s, even during
a silent model call, and stops the run through its normal cancel path. The
reply says "recorded — not yet confirmed". --wait (up to --timeout, default
30s) waits until the run is seen to end: "Confirmed: … cancelled", or that it
ended otherwise first (exit 1). If the owner died, --wait finalizes the cancel
itself once its lease expires. Exit 0: recorded or confirmed; 1: not found,
not confirmed in time, or the run ended some other way.

Ctrl+C during run/resume cancels the run (recorded; nodes get a grace period).
A second Ctrl+C exits at once and leaves the run as it is: \`graph status\`
shows it as interrupted, and \`graph resume\` marks its running nodes uncertain.

Uncertain nodes are never retried automatically: their side effects may have
happened. Check them (see their idempotency key), then choose a recover action.
`,
};

export function helpFor(topic: string | undefined): string {
  if (!topic) return MAIN_HELP;
  const key = topic.startsWith("graph") ? "graph" : topic;
  return TOPICS[key] ?? MAIN_HELP;
}
