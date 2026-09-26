export const MAIN_HELP = `umio — chat with your configured models and run graph workflows

Usage
  umio [chat]                 interactive session (needs a terminal)
  umio ask [prompt]           one answer; reads the prompt from stdin if omitted
  umio init                   write a starter umio.config.json (local Ollama model)
  umio doctor                 check config, models, local servers and timeouts
  umio config                 show the resolved config (secrets masked)
  umio models                 list model aliases
  umio tools                  list configured tools
  umio skills [list]          validate and list the skills the config permits
  umio skills show <name>     a permitted skill's instructions and digest
  umio graph <subcommand>     run and manage graph workflows (umio help graph)

Options
  -c, --config <file>     config file (default: $UMIO_CONFIG, else umio.config.json here or above)
  -m, --model <alias>     model alias (default: the config's defaultModel)
      --tools <a,b>       toolsets to offer (default: all configured; "none" for no tools)
  -y, --yes               run tools that may change things without asking
      --skill <name>      activate a permitted skill (repeatable; replaces the configured activation)
      --no-skills         no skill instructions or skill tools for this run
      --store <dir|url>   graph checkpoint store: a directory, or a postgres:// URL
                          (default: graph.checkpoint in the config, else .umio/runs next to it)
      --json              machine-readable output (ask, doctor, config, models, tools, graph)
  -q, --quiet             no progress, heartbeats or tool lines; results and errors only
      --no-color          plain output (also: NO_COLOR=1)
      --heartbeat <time>  "still running" interval when not in a terminal (default 5m)
      --verbose           show tool result previews
      --debug             show error causes and stacks (also: UMIO_DEBUG=1)
  -h, --help              help (umio help <command>)
  -v, --version           version

Exit codes: 0 ok · 1 error or failed run · 2 usage · 3 run needs recovery
            4 run paused for an approval · 130 cancelled
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
  ask: `umio ask [prompt] [--skill <name>…] [--no-skills] — one answer, for scripts

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
  skills: `umio skills — reusable agent instructions

  umio skills [list]         validate the configured roots; list permitted skills
  umio skills show <name>    a permitted skill's instructions and SHA-256 digest
  umio ask --skill <name> "…"   activate a skill for this run (repeat for more)
  umio ask --no-skills "…"      run without skills

A skill is a directory with a SKILL.md (YAML frontmatter with name and
description, then Markdown instructions) and optional text files. Configure
them in umio.config.json:

  "skills": { "roots": ["./skills"], "include": ["code-review"],
              "activate": ["code-review"], "allowModelSelection": false }

Only skills listed in include can be used; --skill chooses among them but
never adds one. Activated skills go into the system prompt; with
allowModelSelection the model sees the other permitted skills' summaries and
may load one with skills_load. skills_read reads a file of an active skill.
Both tools are read-only. A skill never grants tools, permissions or approvals:
scripts it mentions run only through a tool you configured, with its usual
confirmation. In chat, skills are prepared afresh every turn.
`,
  graph: `umio graph — graph workflows

  umio graph run <module> [--input <text> | --input-file <file>] [--run-id <id>]
  umio graph status <run-id>
  umio graph list [--needs-recovery]
  umio graph resume <module> <run-id>
  umio graph cancel <run-id> [--wait [--timeout <duration>]]
  umio graph approvals [<run-id>]
  umio graph approve <run-id> <node-id> [--comment <text>] [--by <name>]
  umio graph reject <run-id> <node-id> [--comment <text>] [--by <name>]
  umio graph recover <module> <run-id> <node-id> --retry
  umio graph recover <module> <run-id> <node-id> --complete <json> | --complete-file <file>
  umio graph recover <module> <run-id> <node-id> --fail [--reason <text>]
  umio graph migrate            create the PostgreSQL tables (once)

<module> is an ES module whose default export is a WorkflowDefinition or a
function ({ llm, config }) => WorkflowDefinition.

Stores. By default runs are checkpointed in .umio/runs next to the config (or
--store <dir>); that file store is single-process. While another umio process
holds it, status, list and approvals still work, cancel/approve/reject send a
request file that process applies (below), and resume and recover fail at once
with a lock error. With "graph": { "checkpoint": { "type": "postgres",
"connectionString": "..." } } in the config (or --store postgres://...), runs
live in PostgreSQL: any number of processes and machines can share them, and
every command works while another process drives a run. It needs the \`pg\`
package (npm install pg) and \`umio graph migrate\` once.

Approvals. An approval node pauses its branch until a person decides. When
nothing else can run, the run is "paused" (exit 4) and no process owns it.
\`graph approvals\` shows each waiting request with the run input and the
outputs it is about; \`approve\`/\`reject\` record a decision (the first one
per request wins; --by defaults to your user name). A decision is "recorded —
not yet applied": the process driving the run applies it within ~2 s, and a
paused run applies it when you \`graph resume\` it. A rejection fails the run,
unless the node says onReject "continue" (the workflow then routes it).
Approvals are separate from chat's y/n tool confirmations.

Loops. A loop node repeats its body until its condition holds, at most
maxIterations times. Each iteration's nodes appear as <loop>#<n>/<node>, e.g.
refine#2/draft; use that ID with recover.

cancel works from any terminal and says "recorded — not yet confirmed" until
the run is seen to end. --wait (up to --timeout, default 30s) waits for it:
"Confirmed: … cancelled", or that it ended otherwise first (exit 1). If the
owner died, --wait finalizes the cancel itself once its lease expires.

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
