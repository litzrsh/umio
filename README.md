# umio

> A TypeScript-first AI orchestration library for building multi-agent workflows with pre-built tools.

`umio` lets you assemble AI agents, give them tools, and coordinate them through type-safe workflows. It runs on cloud LLMs (Anthropic, OpenAI and other hosted APIs) and on local LLMs (Ollama, LM Studio, vLLM, llama.cpp) behind a single interface configured in JSON.

---

## Features

**Available now**

- **One interface for cloud and local models.** `LLM.generate()` and `LLM.stream()` take the same messages and tools whether the model is Claude, GPT or a local Llama.
- **JSON configuration.** Providers and model aliases live in `umio.config.json`. It is validated on load, and a JSON Schema gives editor autocomplete.
- **API keys stay out of the file.** `${ENV_VAR}` references are resolved from the environment, and only when a provider is actually used.
- **Type-safe tools.** `tool()` takes a Zod schema: the model sees the derived JSON Schema, and inputs are validated before your code runs.
- **Tool loop.** `runToolLoop()` calls the model, runs the tools it asks for, and feeds results back until it is done. Invalid input and tool failures go back to the model as errors it can correct.
- **Streaming** of text, tool calls and tool results.
- **Hooks** around every tool call for approval gates, logging or redaction.
- **Middleware** around every model call (rewrite requests, wrap results), with a built-in prompt translator.
- **Caching to cut token use.** Provider-side prompt caching for large, reused prompts and documents, plus a per-project response cache that answers repeated requests without calling the model.
- **Lossless replay.** Assistant messages keep the provider's native content, so Claude thinking blocks survive multi-turn tool loops.
- **ESM and CommonJS builds** with bundled type declarations.

- **Per-model harnesses.** A runtime profile per model (system preamble, middleware, tool-loop limits), declared in JSON.
- **Agents and workflows.** `Agent`s with a role and their own tools, chained in a sequential `Workflow` with state shared through a `KVStore`.
- **Architecture Decision Records** applied across a workflow. Every agent follows the accepted ADRs and can propose new ones for human review.
- **Skills.** Reusable, file-based instruction packages (`SKILL.md` plus reference files) that an agent applies for a task: activated explicitly or loaded by the model from a permitted list, with bounded, read-only file access. A skill never grants tools or permissions.

- **Built-in tools** for files, the web, command-line programs, SQL databases and utilities, each with safe defaults and configurable per project in JSON.

- **`umio` command-line interface.** Chat with a configured model and its tools, run one-shot prompts from scripts, check your setup with `umio doctor`, and run, inspect, cancel, resume and recover graph workflows. Built for multi-hour local calls.

- **Graph workflows.** Branches, parallel nodes and joins, bounded loops and human approval points, with retries, node timeouts, cancellation and observers. Every step is checkpointed, so a run survives a crash: completed nodes never re-run, and nodes whose outcome is unknown wait for an explicit recovery decision. Runs live in memory, in files, or in PostgreSQL for several processes and machines. Sized for local models where one call takes hours.

---

## Installation

The package is not published yet. Build from source:

```bash
npm install
npm run build
```

Requires Node.js 20 or newer.

This also builds the `umio` command (`dist/cli.js`, registered under `bin` in `package.json`). To use it from anywhere, run `npm link` in the repository; without linking, run `node dist/cli.js …`, or `npm run cli -- …` to run it from source.

---

## Command-line interface

The `umio` command is a thin layer over the library: the same config, `LLM`, `Agent` and `WorkflowExecutor`. It adds no dependencies. Arguments are parsed with `node:util`, line editing uses `node:readline`, and output uses a few ANSI escape codes.

### Getting started

```bash
umio init                    # writes umio.config.json for a local Ollama model (llama3.2)
ollama pull llama3.2
umio doctor                  # checks the config, the model, the server and the time limits
umio                         # interactive session
umio ask "What does this repository do?"
```

`umio init --local-model qwen3:8b` picks another model. The config is looked up in this order: `--config <file>`, `$UMIO_CONFIG`, then `umio.config.json` in the working directory or the nearest parent. Everything else in this README about `umio.config.json` applies unchanged.

### Interactive session

```
umio · model local (llama3.2, local) · tools: repo, misc · /help · Ctrl+D to exit
› Which files define the tool loop?
  ⚙ search_files query=runToolLoop
  ✓ search_files · 14ms · 1.2 kB
The tool loop lives in src/tools/loop.ts …
· 41s · in 1.8k out 212 tokens
```

- Model text streams as it arrives. Each tool call gets one line while it runs and one when it finishes (`✓`, `✗` with the first line of the error, or `–` when it was not run). `--verbose` adds result previews.
- Tools not marked read-only ask first: `[y]es [n]o [a]lways` (always means this tool, for the rest of the session). `--yes` approves everything.
- **Keys:** `Esc` or `Ctrl+C` cancel the running operation and never exit. On an idle prompt, `Ctrl+C` clears the line, and `Ctrl+D` or `/exit` exits.
- **Commands:** `/help`, `/model [alias]`, `/config`, `/session`, `/tools`, `/new` (fresh transcript), `/cancel`, `/exit`, and `/graph …`, which is the same as `umio graph …`.
- **Cancelling a turn never makes a tool run twice.** If no tool had run, the turn is undone and your message goes back on the prompt. If tools did run, the transcript keeps their results, a tool cut off mid-run is recorded as "outcome unknown", and your next message tells the model what already happened. Nothing is re-sent automatically.
- Sessions live in memory; `/new` or exiting discards them.

### Scripts and pipes

```bash
umio ask "Summarize CHANGELOG.md" > summary.txt
git diff | umio ask --tools none --json | jq -r .text
```

- `umio ask` reads the prompt from its arguments, or from stdin if there are none.
- Model text goes to stdout. Tool lines, heartbeats and errors go to stderr.
- `--json` prints one object: `text`, `stopReason`, `model`, `usage`, and `tools` (name, input, whether it errored, duration).
- `--quiet` prints only results and errors.
- `--no-color` (or `NO_COLOR=1`) gives plain text. Statuses always pair a symbol with a word (`✓ completed`, `? uncertain`), so no information depends on color, and `TERM=dumb` switches to ASCII symbols.
- Without a terminal, tools that may change things are declined unless you pass `--yes`.
- Exit codes: 0 ok, 1 error or failed run, 2 usage error, 3 run needs recovery, 130 cancelled.

`umio config`, `umio models` and `umio tools` show what is configured (`--json` for machines). Literal secrets are masked.

Skills (see [Skills](#skills)) apply to `ask` and chat:

```bash
umio skills                             # validate the configured roots; list permitted skills
umio skills show code-review            # its instructions and SHA-256 digest
git diff | umio ask --skill code-review "Review this change"   # repeat --skill for more
umio ask --no-skills "…"                # no skill instructions or tools this time
```

`--skill` replaces the configured `activate` list but can only name skills in `include`; `--skill` with `--no-skills` is a usage error. The skill tools are read-only, so they never ask for confirmation, and `--tools` still controls ordinary tools. In chat the catalog is loaded once per session and prepared again every turn.

### Long-running local models

A local model can spend two or three hours on one request before it produces any text, and umio treats that as normal:

- In a terminal, a status line shows the elapsed time: `⠼ waiting for model · 1h 12m · no output yet — still running`. After a minute without output it says when output last arrived.
- Without a terminal, a heartbeat line (`umio: still running · …`) goes to stderr every 5 minutes (`--heartbeat 1m` to change it; `--quiet` turns it off).
- These displays run on their own UI timer. They never end, time out or retry anything. Only the configured provider and node timeouts can end a call, and lease renewal runs on its own timer.

**The graph node timeout (3 h by default) covers the whole node attempt.** For an agent node that is the entire agent run, including every model call and every tool call. An agent that makes three 2-hour local requests needs a per-node `timeoutMs` of at least 6 h, or `null`. Keep the provider's `timeoutMs` and transport timeouts sized for one request. See [Time limits for long local runs](#local-providers).

`umio doctor --node-timeout 6h` checks that no local provider ends a request before that duration, and explains when that is expected.

### Graph workflows from the command line

A workflow module is an ES module whose default export is a `WorkflowDefinition`, or a function that receives the CLI's model client and config:

```js
// review.workflow.mjs (see examples/review.workflow.mjs)
import { Agent, agentNode } from "umio";

export default ({ llm }) => ({
  graph: {
    id: "review", version: "1", entry: ["draft"],
    nodes: [{ id: "draft", handler: "draft", timeoutMs: 6 * 60 * 60 * 1000 }],
    edges: [],
  },
  handlers: {
    draft: agentNode(new Agent({ name: "Writer", role: "Drafts replies." }), { llm, stream: true }),
  },
  predicates: {},
});
```

```bash
umio graph run review.workflow.mjs --input "Store uploads on local disk?"   # prints the run ID and a node table
umio graph status <run-id>             # nodes, attempts, owner, and nodes needing recovery
umio graph list [--needs-recovery]
umio graph cancel <run-id> [--wait]    # from any terminal; see below
umio graph approvals [<run-id>]        # approval requests waiting for a decision, with their context
umio graph approve <run-id> <node-id> [--comment "…"]   # or: reject
umio graph resume review.workflow.mjs <run-id>
umio graph recover review.workflow.mjs <run-id> <node-id> --retry
umio graph recover review.workflow.mjs <run-id> <node-id> --complete '{"text":"…"}'
umio graph recover review.workflow.mjs <run-id> <node-id> --fail --reason "charged twice; refunded"
umio graph migrate                     # once, for a PostgreSQL store
```

Exit codes for `run`, `resume` and `status`: 0 completed (or still running), 1 failed, 3 needs recovery, 4 paused for an approval, 130 cancelled.

- **Where runs are kept:** by default in `.umio/runs` next to the config (`--store <dir>` to change it), using the experimental `FileCheckpointStore`. Only one process writes it at a time. While another `umio` process holds it, `status`, `list` and `approvals` still work, `cancel`, `approve` and `reject` send a request file (below), and `resume` and `recover` fail immediately with a lock error that names the process. They do not wait; run them again once that process has finished.
- **PostgreSQL instead:** set `graph.checkpoint` in the config (or pass `--store postgres://…`), install the driver with `npm install pg`, and create the tables once with `umio graph migrate`. Every command then works while other processes, on any machine, drive runs in the same database:

  ```json
  "graph": {
    "maxConcurrency": 1,
    "checkpoint": { "type": "postgres", "connectionString": "${DATABASE_URL}", "schema": "umio" }
  }
  ```

  Output never shows database credentials: `status`, `list`, `migrate` and `umio config` mask the URL's password and every credential query parameter (`password`, `sslpassword`, …), and hide a connection string they cannot parse; the driver still receives the original. A missing table is reported with the `migrate` hint. `list` and `approvals` read every matching run, however many there are.
- **Approvals:** a run whose only remaining work waits for a person is `paused` (exit code 4), and no process owns it. `run`, `status` and `approvals` show each waiting request: its title and description, when it was asked, the run input and the outputs it concerns, and the exact `approve`/`reject` commands. A decision is recorded, never applied, by the command ("Approval recorded … not yet applied"): the process driving the run applies it within ~2 s, and a paused run applies it on `umio graph resume`. The first decision per request wins; a later, different one exits 1 with the decision that stands. `--by` defaults to your user name. These approvals are unrelated to chat's `y`/`n` confirmation before a tool runs.
- **Cancelling from another terminal:** `umio graph cancel <run-id>` writes a small cancel-request file next to the run (atomically). It never writes the run's checkpoint or lease. The process driving the run checks for requests every ~2 s on its own timer, so it notices even during a silent multi-hour model call. It then cancels through its executor's normal, fenced path: running nodes are aborted and given their grace period, and the run is recorded `cancelled`.
  - **The reply distinguishes recorded from confirmed.** Without `--wait`, the command returns as soon as the request is stored: "Cancel request recorded — not yet confirmed". With `--wait` (up to `--timeout`, default 30 s), it watches the run until it ends: "Confirmed: run … is cancelled", or it reports that the run finished some other way first (exit 1), or that it is not confirmed yet (exit 1, and the request stays recorded).
  - `graph status` shows a request the owner has not picked up yet ("cancel requested 3s ago by pid …, not yet picked up by the owner"), and `--json` reports it as `cancelRequest: "pending" | "recorded" | "none"`.
  - Repeated cancels are idempotent (`already-requested`).
  - A request for a run that has already finished is refused (`already-terminal`). One that arrives just as the run completes is discarded; the run stays `completed`.
  - A request is tied to one run instance, so a leftover request never cancels a later run that reuses the ID.
  - If the owner crashes before applying a request, the request is kept. `cancel --wait` finalizes the run itself once the dead owner's lease expires, and otherwise the next `resume` honors it. Either way, the node that was running becomes `uncertain`.
  - When no other process holds the store, `cancel` goes through the executor's `cancel()` directly.
- **Ctrl+C during `run` or `resume`:** the first press cancels the run explicitly. The cancel is recorded, and running nodes get their grace period. A second press exits at once without finalizing. `graph status` then shows the run as interrupted, and `graph resume` marks its running nodes uncertain instead of running them again. SIGTERM behaves like the second press.
- **Nodes needing recovery:** `status` and `run` list every `uncertain` node with its reason, attempt and idempotency key, say plainly that its side effects may have happened, and print the three explicit `recover` commands. umio never picks one, and never retries an uncertain node automatically.
- The module must import `umio` from the same installation as the command (run the CLI with `npx umio` in the project that depends on it), so both share one copy of the library.
- The module must be `.mjs`/`.js` ESM. A `.ts` module needs Node's type stripping (Node 22.18 or newer).
- `--model <alias>` becomes the default model for agents that don't name one.

---

## Configuration

Copy the example and edit it:

```bash
cp umio.config.example.json umio.config.json
```

```json
{
  "$schema": "./schema/umio.config.schema.json",
  "defaultModel": "smart",
  "providers": {
    "anthropic": { "type": "anthropic", "apiKey": "${ANTHROPIC_API_KEY}" },
    "openai": { "type": "openai", "apiKey": "${OPENAI_API_KEY}" },
    "ollama": { "type": "ollama", "baseURL": "${OLLAMA_BASE_URL:-http://localhost:11434/v1}" },
    "lmstudio": { "type": "openai-compatible", "baseURL": "http://localhost:1234/v1" }
  },
  "models": {
    "smart": {
      "provider": "anthropic",
      "model": "claude-opus-5",
      "maxTokens": 16000,
      "promptCache": true,
      "options": { "output_config": { "effort": "high" } }
    },
    "local": { "provider": "ollama", "model": "llama3.2" }
  },
  "responseCache": { "store": "file", "path": ".umio/cache", "ttlSeconds": 86400 }
}
```

### Providers

| `type` | For | Required fields | Notes |
|---|---|---|---|
| `anthropic` | Claude | none | Without `apiKey`, the SDK resolves `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile. |
| `openai` | OpenAI | none | Without `apiKey`, reads `OPENAI_API_KEY`. |
| `ollama` | Local Ollama | none | `baseURL` defaults to `http://localhost:11434/v1`. |
| `openai-compatible` | LM Studio, vLLM, llama.cpp, OpenRouter, Groq and others | `baseURL` | `apiKey` is optional; most local servers ignore it. |

All provider types accept `baseURL`, `timeoutMs`, `maxRetries`, `local`, `maxConcurrentRequests` and `transport`. Retries use exponential backoff and apply to connection errors (timeouts included), 408, 409, 429 and 5xx responses.

### Local providers

Local models on modest hardware can take hours on a single request. Providers classified as **local** get defaults sized for that. Any value you set explicitly wins.

| Setting | Local default | Otherwise |
|---|---|---|
| `timeoutMs`: from sending a request to its response headers | 3 h 5 min (just above the graph node timeout) | SDK default (10 min) |
| `maxRetries` | `0`: a retry would repeat hours of inference | SDK default (2) |
| `transport.headersTimeoutMs` / `transport.bodyTimeoutMs`: Node's own `fetch` limits | equal to `timeoutMs` | undici defaults (300 s each) |
| `maxConcurrentRequests` | `1` | unlimited |

**What counts as local:**
- `ollama` is always local.
- `openai-compatible` is local when its `baseURL` host is `localhost` or a loopback or private IP address (checked from the URL alone, with no DNS lookup).
- `openai` and `anthropic` are not local.

Set `"local": true` or `false` to override the classification. Hosted gateways such as OpenRouter or Groq configured as `openai-compatible` are not local, so they keep their retries.

**Why these defaults:**
- The SDK timeout only runs until response headers arrive. For a non-streaming request, a local server sends headers only when generation finishes, so the whole generation has to fit inside it.
- Node's `fetch` has separate 300-second limits for headers and for the gap between body chunks. Without raising them, a long prompt prefill or a long non-streaming call fails after 5 minutes whatever `timeoutMs` says. umio raises them with a dedicated undici dispatcher.

**`maxConcurrentRequests`** caps the requests a provider has in flight at once, per `LLM` instance:
- **Queueing:** waiting calls are served in order. A waiting call has not been sent yet, so its HTTP timeouts have not started.
- **Coverage:** every model call counts, including parallel tool calls, agents delegating through `asTool()`, and model calls made by middleware.
- **Cache:** response-cache hits do not take a slot.
- **Streaming:** a streaming call keeps its slot until the stream finishes, or until you stop reading it.
- **Aborts:** a call aborted while waiting is never sent.
- **Scope:** separate `LLM` instances or processes do not share the limit, and the server's own queue (e.g. `OLLAMA_NUM_PARALLEL`) still applies behind it.
- **Deadlock risk:** while you are consuming a stream, don't make another call to the same provider when its limit is 1. The second call waits for the stream's slot, and the stream never finishes.

`llm.requestStats()` reports in-flight and waiting requests per provider.

**Behavior change for existing configs:** local providers now default to no retries and one request at a time. To restore the previous behavior, set `maxRetries` and `maxConcurrentRequests` explicitly.

**Time limits for long local runs.** Each layer limits something different, and they are sized so that the graph node timeout is what ends a long call:

| Limit | What it limits | Default |
|---|---|---|
| Node timeout (`graph.nodeTimeoutMs`, per-node `timeoutMs`) | One graph node attempt, wall clock, including time spent waiting for a request slot. For an agent node that is the **whole agent run**: every model call and tool call | 3 h |
| Provider `timeoutMs` | One HTTP request, from sending it to its response headers | Local: 3 h 5 min |
| `transport.headersTimeoutMs` / `bodyTimeoutMs` | Node's `fetch`: time to headers, and gaps between body chunks | Local: equal to `timeoutMs` |
| Inactivity timeout (per-node `inactivityTimeoutMs`) | Time without progress events | Off |
| Lease (`graph.leaseTtlMs`, renewed every `leaseRenewIntervalMs`) | Proof that the executor process is alive; not a limit on node duration | 30 s, renewed every 10 s |
| Tool-loop `maxSteps`, built-in tool timeouts | Model calls per loop; one tool call | Unchanged |

- **Multi-turn agents need a longer node timeout.** The 3 h default fits one long local request, but an agent node makes a model call per tool-loop step, and on modest hardware a single request can itself take 2–3 hours. Give such nodes their own limit, and leave the provider and transport timeouts sized for **one** request:

  ```typescript
  nodes: [
    // Up to ~4 model calls of up to 3 h each, plus tool calls.
    { id: "implement", handler: "implement", timeoutMs: 12 * 60 * 60 * 1000 },
    // No node limit: each request is still bounded by the provider's timeoutMs
    // and transport timeouts, and the loop by maxSteps; cancel() still works.
    { id: "review", handler: "review", timeoutMs: null },
  ],
  ```

  Prefer per-node `timeoutMs` over raising `graph.nodeTimeoutMs` for every node. A higher `graph.nodeTimeoutMs` also triggers the warning below unless the provider's `timeoutMs` is raised to match, which is only needed if one request can really take that long.
- `WorkflowExecutor.fromConfig()` and `agentNode()` emit a process warning (`UMIO_PROVIDER_TIMEOUT_BELOW_NODE_TIMEOUT`) when a local provider's request timeout is below the node timeout, since the provider would then end long calls first.
- Recommended for one local model: `stream: true` on agent nodes (bytes keep flowing and progress is reported), and `"graph": { "maxConcurrency": 1 }`, so graph nodes don't wait behind each other's calls and use up their node timeouts.
- Avoid CPU-bound work inside handlers. Inference runs in the model server, but a JavaScript event loop blocked for more than about 20 s misses lease renewals, and the run is then taken away from the executor.

### Models

Code refers to models by **alias** (the keys under `models`), so switching a workload from a cloud model to a local one is a config change.

- `provider`: a key from `providers`.
- `model`: the model ID as the provider knows it.
- `maxTokens`: output cap. For Anthropic it defaults to 16000. For OpenAI-compatible servers it is sent only when set, because servers such as vLLM reject caps larger than the remaining context.
- `options`: provider-native request fields merged into every request, e.g. `output_config`, `thinking` or `betas` for Anthropic, and `temperature` or `reasoning_effort` for OpenAI-compatible servers. Setting `betas` routes Anthropic requests through the beta Messages endpoint.
- `promptCache`: `true` (5-minute TTL) or `{ "ttl": "1h" }`. Enables provider-side prompt caching; see [Caching](#caching).
- `responseCache`: set to `false` to exclude this model from the response cache.
- `harness`: the name of an entry in `harnesses`, or an inline harness; see [Harnesses](#harnesses).

### Environment variables

Any string value can use `${VAR}` or `${VAR:-fallback}`. A missing variable without a fallback is an error. Inside `providers`, it is reported only when that provider is first used, so a machine with only Ollama can load a config that also lists cloud providers.

---

## Usage

```typescript
import { LLM } from "umio";

const llm = await LLM.fromFile(); // ./umio.config.json

const result = await llm.generate({
  model: "local", // alias; omit to use defaultModel
  system: "Answer in one sentence.",
  messages: [{ role: "user", content: "What is an AI agent?" }],
});

console.log(result.text, result.finishReason, result.usage);
```

### Streaming

```typescript
for await (const event of llm.stream({ messages: [{ role: "user", content: "Tell me a story." }] })) {
  if (event.type === "text-delta") process.stdout.write(event.text);
  if (event.type === "finish") console.log("\n", event.result.usage);
}
```

Events are `text-delta`, `tool-call` (emitted once the call's arguments are complete) and a final `finish` carrying the same result `generate()` returns.

---

## Tools

### Defining tools

```typescript
import { z } from "zod";
import { tool } from "umio";

const getWeather = tool({
  name: "get_weather",
  description: "Returns the current weather for a city.",
  parameters: z.object({
    city: z.string().describe("City name, e.g. Seoul"),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  annotations: { readOnly: true, openWorld: true },
  execute: async ({ city, unit }, { signal }) => fetchWeather(city, unit, signal),
});
```

- `parameters` must be a `z.object()`. `.describe()` texts reach the model.
- `execute` receives validated input (defaults applied) and a context with the `toolCallId`, the request's abort `signal` and the conversation so far.
- The return value is sent to the model as-is if it is a string, otherwise as JSON. Override this with `toModelOutput(output)`.
- `annotations` (`readOnly`, `destructive`, `idempotent`, `openWorld`) mirror MCP tool annotations. umio does not enforce them; hooks and, later, agent permission policies read them.

### Running the tool loop

```typescript
import { LLM, runToolLoop } from "umio";

const llm = await LLM.fromFile();
const result = await runToolLoop(llm, {
  model: "local",
  messages: [{ role: "user", content: "Is it warmer in Seoul or Busan?" }],
  tools: [getWeather],
  maxSteps: 10, // model calls; the default
  stream: true,
  onEvent: (event) => {
    if (event.type === "text-delta") process.stdout.write(event.text);
    if (event.type === "tool-result") console.error(event.execution.call.name, event.execution.result.content);
  },
});

result.text;       // final answer
result.messages;   // full history, ready to continue the conversation
result.steps;      // each model call with its tool executions
result.usage;      // token usage summed over all steps
result.stopReason; // "done", or "max-steps" if the model still wanted tools
```

The loop:
- Runs the tool calls from one model turn concurrently and sends all results back in one message.
- Turns unknown tools, invalid input and thrown errors into `isError` results, so the model can retry. Only an abort (via `signal`) or an error thrown by a hook stops the loop.
- Answers every tool call, even on the last allowed step, so `messages` is always valid to continue from.

### Hooks

```typescript
await runToolLoop(llm, {
  messages,
  tools,
  hooks: {
    // Return a result to skip execution.
    beforeToolCall: async (call, tool) =>
      tool?.annotations?.destructive && !(await confirm(call))
        ? { content: "The user declined this action.", isError: true }
        : undefined,
    // Inspect or replace every result, including failures.
    afterToolCall: (execution) => {
      log(execution.call.name, execution.durationMs, execution.error);
      return undefined; // keep the result
    },
  },
});
```

### Toolsets

`Toolset` is a collection with unique names. Use `pick()` and `omit()` to give a component a restricted view of the same tools; both throw on unknown names to catch typos.

```typescript
import { Toolset } from "umio";

const all = new Toolset([getWeather, searchDocs, deleteFile]);
const readOnly = all.omit(["delete_file"]);
```

### Combining hooks and limiting output

`composeHooks()` merges independent hook sets. `limitToolOutput()` condenses oversized tool results (keeping the start and the end) before they reach the model. That matters because tool results are resent on every later step of a loop.

```typescript
import { composeHooks, limitToolOutput } from "umio";

hooks: composeHooks(approvalHooks, loggingHooks, limitToolOutput({ maxChars: 8000 })),
```

`beforeToolCall` hooks run in order until one returns an override. `afterToolCall` hooks each see the result as replaced by the ones before. An output condenser such as RTK or a custom summarizer plugs in the same way, as an `afterToolCall` hook.

### Extending

- **Custom tools without Zod:** implement the `Tool` interface directly (`name`, `description`, `inputSchema`, `parseInput`, `execute`). This is also the adapter point for tools from other sources, such as MCP servers.
- **Running tools yourself:** `executeToolCall()` and `executeToolCalls()` apply the same validation, error handling and hooks outside the loop.
- **Other model clients:** `runToolLoop()` depends only on the `ModelClient` interface (`generate` and `stream`). `LLM` implements it, and tests can pass a scripted fake.

---

## Harnesses

Models differ in what they need. A small local model may need tighter instructions, fewer tool-loop steps and shorter tool output than a frontier model. A harness is that runtime profile. It is applied automatically on every call to the model, including calls from agents and workflows.

```json
"models": {
  "local": { "provider": "ollama", "model": "llama3.2", "harness": "local-agent" },
  "smart": { "provider": "anthropic", "model": "claude-opus-5", "harness": { "system": "Think carefully." } }
},
"harnesses": {
  "local-agent": {
    "system": "You run on a small local model. Be concise and use tools only when needed.",
    "middleware": [{ "use": "promptTranslator", "model": "local", "responseLanguage": "Korean" }],
    "toolLoop": { "maxSteps": 6, "maxToolOutputChars": 4000 }
  }
}
```

| Field | Effect |
|---|---|
| `system` | Prepended to every system prompt sent to the model. Keep it static: it is the start of the prompt, where changes break prompt caching. |
| `middleware` | Middleware for this model only, declared by name: `use` picks the factory, and the other keys are its options. The built-in is `promptTranslator`. Register your own with `new LLM(config, { middlewareFactories: { name: (options) => middleware } })`. Unknown names fail at startup. |
| `toolLoop.maxSteps` | Default `maxSteps` for tool loops and agents on this model. |
| `toolLoop.maxToolOutputChars` | Tool results longer than this are condensed (`limitToolOutput`) before the model sees them. |

Explicit options win over harness defaults: `maxSteps` passed to `runToolLoop` or to an `Agent` overrides the harness value. Harness middleware runs inside the global middleware. `llm.harness(alias)` returns a model's resolved harness.

---

## Agents and workflows

### Agents

```typescript
import { Agent } from "umio";

const researcher = new Agent({
  name: "Researcher",
  role: "Gathers and summarizes up-to-date information on a given topic.",
  instructions: "Cite a source for every claim.",
  model: "smart",            // alias; defaults to defaultModel
  tools: [webSearch],        // the only tools this agent may use
});

const result = await researcher.run("AI trends in 2026", { llm });
result.text; // plus messages, steps and usage, as from runToolLoop
```

An agent's system prompt is its name, role and instructions. Shared context from a workflow (such as ADRs) goes before it. Tools receive the agent's name and the workflow state in their context (`context.agent`, `context.state`).

### Workflows

```typescript
import { Workflow } from "umio";

const run = await new Workflow({ llm })
  .step(researcher)                  // input: the run input
  .step(writer)                      // input: the previous step's output
  .step(editor, {
    input: ({ input, outputs }) => `Topic: ${input}\nDraft:\n${outputs.Writer}`,
  })
  .run("AI trends in 2026");

run.output;       // last step's text
run.outputs;      // by step name
run.usage;        // summed over all steps
run.proposedAdrs; // ADRs proposed during the run
```

- A step's `input` is a string, or a function of `{ input, previous, outputs, state }`. By default it is the previous step's output.
- `state` is a `KVStore` shared by step inputs and tools (default: a fresh in-memory store). Pass a `FileKVStore` to keep it across runs.
- `onEvent` receives `step-start`, `step-finish`, `adr-proposed` and every agent event (`agent-event`: text deltas when `stream: true`, tool results, step boundaries).
- `hooks`, `stream` and `signal` apply to every step.

### Hierarchical delegation

`agent.asTool()` turns an agent into a tool, so a coordinator can decide which specialist to ask:

```typescript
const coordinator = new Agent({
  name: "Coordinator",
  role: "Breaks the task down and delegates to specialists.",
  tools: [researcher.asTool({ llm }), writer.asTool({ llm })], // ask_researcher, ask_writer
});
```

The specialist runs its own tool loop with only its own tools, sees only the delegated `task` (not the coordinator's conversation), and returns its final answer. Shared state and the abort signal pass through. Pass `context` (e.g. ADR text) in the `asTool` options to give specialists the same binding context.

### Architecture Decision Records

ADRs apply to the whole workflow. Configure the directory once:

```json
"adr": { "path": "docs/adr" }
```

Or pass `adr: new AdrStore("docs/adr")` (or `{ store, include, tools }`) to a `Workflow`. Pass `adr: false` to turn it off. For every step of a run:

- **Accepted ADRs are binding context.** They are loaded once per run and placed first in every agent's system prompt, identical across agents and marked for prompt caching, so the provider reuses the cached prefix from agent to agent. `include` selects other statuses (default `["Accepted"]`).
- **Agents get ADR tools:** `list_adrs`, `read_adr` and `propose_adr`. Turn them off with `"tools": false`.
- **Proposals need a human.** `propose_adr` writes a new `NNNN-title.md` with status `Proposed`, in Nygard format: title, date, Status, Context, Decision, Consequences. It never becomes binding context until someone changes its status to `Accepted`. Proposals are listed in `run.proposedAdrs` and reported as `adr-proposed` events.

Files are read as `NNNN-*.md`. The status comes from a `## Status` section or a `Status:` line, so existing ADR collections work as they are. `AdrStore` can also be used on its own: `list()`, `get(n)`, `withStatus()`, `context()`, `propose()`.

---

### Skills

A skill is a directory with a `SKILL.md` and optional text files. The design, and what is deferred, is in `docs/design/umio-skills-design.md`.

```text
skills/
  code-review/
    SKILL.md
    references/checklist.md
```

```markdown
---
name: code-review
description: Review code changes for correctness and missing regression tests.
---

Inspect the changed behavior and its callers before proposing a fix.
Read references/checklist.md when checking test coverage.
```

- **Format.** YAML frontmatter with exactly `name` (lowercase words joined by hyphens, at most 64 characters, equal to the directory name) and `description` (at most 1,024 characters), then a nonempty Markdown body. Duplicate keys, other fields, custom tags and aliases are rejected.
- **Discovery.** `loadSkillCatalog({ roots, baseDir })` scans only the given roots, one level deep, in a deterministic order. Relative roots resolve against `baseDir`; nothing is loaded from your home directory or parent directories. Invalid packages, and names that appear in two roots, become `catalog.diagnostics` (file, field, message); `list()` shows the valid ones, and `prepare()` refuses to run until there are none.
- **Selection.** `catalog.prepare({ include, activate?, allowModelSelection? })` makes the context and tools for **one** agent run.
  - `include` is the permitted subset; an empty list permits nothing.
  - `activate` puts those skills' instructions into the system prompt before the first model call.
  - With `allowModelSelection`, the other permitted skills are listed by name and description, and the model may load one with `skills_load({ name })`. The body arrives as a tool result; the system prompt and toolset never change mid-run.
  - Unknown names, and activation outside `include`, fail before any model call.
- **Resources.** `skills_read({ name, path })` returns a UTF-8 text file of an **active** skill, relative to its directory. Absolute paths, `..`, symbolic links, directories and binary files are refused, as is a file that changed since it was first read in the run. Scripts are only text to the model: running one needs a command tool you configured, with its usual allowlist and confirmation.
- **Limits** (bytes; they bound I/O and prompt growth, not tokens): 100 catalog entries, 64 KiB per `SKILL.md`, 128 KiB per file, 256 KiB of prompt per preparation, 1 MiB returned per run, repeats included. Nothing is truncated: an oversized preparation rejects with `SkillLimitError`, and an oversized read is an error result the model can react to.
- **Prompt order.** Your context (ADRs), then the skills section, then the agent's role and standing instructions. The skills section tells the model that skills cannot grant tools or permissions; the tools it actually has are what enforces that.
- **Identity.** Each skill has the SHA-256 `digest` of its `SKILL.md`. A document that changes after the catalog was loaded is refused (`SkillChangedError`); load a new catalog to pick it up. `prepared.usage()` (immutable) lists the documents and files used, with digests; `skillManifest(usage)` turns that into JSON, and `catalog.verify(manifest)` checks that the content is unchanged.

```typescript
import { Agent, loadSkillCatalog, withSkills } from "umio";

const catalog = await loadSkillCatalog({ roots: ["./skills"], baseDir: process.cwd() });
const reviewer = new Agent({ name: "Reviewer", role: "Reviews changes." });

// One preparation per run: activation, read budget and usage are never shared.
const { options, prepared } = await withSkills(
  reviewer,
  { llm, context: sharedContext, hooks, signal },
  { catalog, selection: { include: ["code-review"], activate: ["code-review"] } },
);
const result = await reviewer.run(task, options);
prepared?.usage();   // [{ name: "code-review", documentDigest, resources: [{ path, digest }] }]
```

`withSkills` adds the skill context after your `context` and the tools after your `extraTools`, and rejects an agent tool named `skills_load` or `skills_read`. Without a binding it returns the options unchanged. `catalog.prepare()` gives you the same `context` and `tools` if you compose them yourself.

**In workflows and graph nodes**
- `new Workflow({ …, skills: { catalog, selection } })` applies a binding to every step; `step(agent, { skills })` replaces it for one step, and `skills: false` removes it. Selections are never merged. Each step gets a fresh preparation, and `result.steps[i].skills` holds its manifest.
- `agentNode(agent, { …, skills: { catalog, selection } })` binds skills to one graph node, prepared per attempt. Skill events arrive as `custom` node events named `"skill"`, and the node's output gains `skills` (the manifest).
- A delegated agent (`agent.asTool`) gets no skills from its parent.
- Durable runs do not check skill content on resume yet. Pin your skill packages and bump the graph `version` whenever they change; the manifest in a node's output records what it used.
- `binding.onEvent` (or `prepare(…, { onEvent })`) reports preparations, loads and reads with names, digests, paths, sizes and outcomes, never document bodies. A throwing callback changes nothing.

**Configuration**

```json
"skills": {
  "roots": ["./skills"],
  "include": ["code-review", "test-design"],
  "activate": ["code-review"],
  "allowModelSelection": false,
  "limits": { "maxReadBytes": 524288 }
}
```

`include` is required (it may be empty). `activate` must be a subset of it. Roots resolve against the config file's directory. `skillsFromConfig(config, { activate? })` returns the binding (or `undefined` without a `skills` section), which is what the CLI uses. See `examples/skills.ts` and `examples/skills/` (`npm run example:skills -- local`).

### Graph workflows

`WorkflowExecutor` runs a directed acyclic graph of nodes: branches, parallel paths and joins, with retries, timeouts and cancellation. Every change to a run is checkpointed to a `CheckpointStore`, and an interrupted run can be resumed by another process. The design and its invariants are in `docs/work/umio-graph-workflow-plan.md`.

```typescript
import { agentNode, WorkflowExecutor, type WorkflowDefinition } from "umio";

const definition: WorkflowDefinition = {
  graph: {
    id: "architecture-review",
    version: "1",                       // bump when node behavior changes
    entry: ["research"],
    nodes: [
      { id: "research", handler: "research" },
      { id: "design", handler: "design" },
      { id: "security", handler: "security" },
      { id: "merge", handler: "merge" },   // join "all" by default
    ],
    edges: [
      { from: "research", to: "design" },
      { from: "research", to: "security", when: "flagsRisk" },
      { from: "design", to: "merge" },
      { from: "security", to: "merge" },
    ],
  },
  handlers: {
    research: agentNode(researcher, { llm }),
    design: agentNode(designer, { llm }),
    security: agentNode(securityReviewer, { llm }),
    merge: agentNode(editor, { llm }),
  },
  predicates: { flagsRisk: (output) => /RISK: yes/i.test((output as { text: string }).text) },
};

const run = await WorkflowExecutor.fromConfig(llm.config).run(definition, "Review this plan: …");
run.status;               // "completed" | "failed" | "cancelled" | "needs-recovery" | "paused"
run.nodes.merge?.output;  // { text, usage } from agentNode
```

**Definitions and validation**
- The graph is plain JSON. Handlers and predicates are registered by key, and `validateDefinition` runs before every run.
- Validation reports every problem at once: cycles, unknown nodes or handlers, unreachable nodes, invalid joins, non-JSON values. Cycles are always rejected; repeat work with an explicit, bounded loop node (below).
- A node is a **task** (`handler`), an **approval** (`approval`) or a **loop** (`loop`). `retry`, `timeoutMs`, `inactivityTimeoutMs` and `recovery` apply to task nodes only.
- Each run records the definition's `version` and a `definitionHash`.

**Handlers**
- A handler receives the run `input`, the outputs of its active `predecessors`, an abort `signal`, and a stable `idempotencyKey`. It returns JSON.
- `agentNode(agent, { llm, … })` runs an agent as a node. Its default task is the run input followed by the predecessors' results.

**Branches and joins**
- An edge with `when` is active only if its predicate returns true. Predicates are pure, synchronous and evaluated once, and the decision is recorded.
- Nodes whose incoming edges are all inactive are **skipped**, transitively.
- `join: "all"` (default) waits for every active incoming edge. `join: "any"` runs once, on the first predecessor to complete, and that choice never changes.

**Concurrency**
- `maxConcurrency` limits how many nodes run at once. Settings apply in this order, highest first: the run option, the constructor option, the config's `graph.maxConcurrency`, then the default of 4.
- Use `1` for a single local model.
- It does not limit model calls made inside a node; the provider's `maxConcurrentRequests` does.

**Failures and retries**
- A handler error is recorded on the node, and the run resolves with status `failed`, not an exception.
- The other running nodes are aborted and recorded as `cancelled`, and nothing new starts.
- A node with `retry: { maxAttempts, initialDelayMs, maxDelayMs?, multiplier? }` is retried after **retryable** errors: `GraphNodeError` with `retryable: true`, an `LLMError` the provider marked retryable, or a timeout. The wait is random between 0 and `initialDelayMs × multiplier^(attempt − 1)` (full jitter; `multiplier` defaults to 2, capped by `maxDelayMs`). Other nodes keep running meanwhile, and the wait is checkpointed, so a resumed run honors it.
- The default is one attempt. Every attempt receives the same `idempotencyKey`.

**Time limits**
- Each attempt has a wall-clock **node timeout**: 3 h by default (`nodeTimeoutMs` on the executor or in the config's `graph` section), `timeoutMs` per node, `null` for none. `context.deadline` tells the handler when it ends.
- The node timeout covers the **entire attempt**. For `agentNode` that is the whole agent run: every model request, tool call and wait for a request slot. A multi-turn agent on a slow local model needs a per-node `timeoutMs` well above 3 h, or `null` (see [Time limits for long local runs](#local-providers)).
- `inactivityTimeoutMs` (per node, off by default) limits the time between progress events (`context.emit`, which `agentNode` calls for every agent event). Keep it off or generous for local models: a long prompt prefill emits nothing.
- On expiry the attempt's `signal` aborts and the attempt fails with a retryable `timeout` error; a result that arrives after that is discarded.
- **A handler that ignores its signal** is given `cancelGraceMs` (10 s) to stop, then **abandoned**: its node becomes `uncertain` (see below), because umio cannot know what it did, and nothing new starts. The run parks as `needs-recovery` once the other running nodes finish. JavaScript cannot be stopped from outside, so the abandoned promise keeps running in the background and its result is ignored. Handlers doing long work must honor `context.signal`.
- The lease and the cancel poll run on their own timers, so none of these limits depends on whether the model is producing output.

**Cancellation**
- `executor.cancel(runId)` works from any executor sharing the store, and returns a `CancelAck`:
  - `requested`: recorded; the live owner notices within 2 s (`cancelPollIntervalMs`), aborts running nodes and ends the run `cancelled`;
  - `cancelled`: nobody owned the run (its owner crashed and its lease expired, or it was parked), so this call finalized it; nodes left running become `uncertain`;
  - `already-terminal` or `not-found`.
- Aborting `GraphRunOptions.signal` cancels the run the same way.
- A request is checked before each node's attempt is recorded and again right after, before its handler starts. If it arrives while that record is being written, the handler never runs: the node is recorded `cancelled` (its attempt counted), not `uncertain`.
- Nodes that stop within `cancelGraceMs` are recorded `cancelled`; the others are abandoned and become `uncertain`. The run is `cancelled` either way, and `run()` resolves without waiting for abandoned handlers.
- A failure and a cancel never both apply: whichever the executor processes first decides the run's status.

**Observers**
- `run(definition, input, { observer, onObserverError })` delivers events in order: `run-start`/`run-resume`, `node-start`, `node-event` (from `context.emit`), `node-retry`, `node-waiting` (an approval request), `loop-iteration`, `node-finish` (with its status, including `skipped`), `run-cancel-requested`, then `run-finish`, `run-needs-recovery` or `run-paused`.
- Delivery is queued: the scheduler never waits for the observer, and an observer that throws or hangs changes neither the run nor its timing. Errors go to `onObserverError`.
- When the run ends, its status is persisted and its lease released first; then `run()` waits at most `observerDrainTimeoutMs` (5 s) for queued events. Events not delivered by then are dropped, never the status.

**Outputs**
- Outputs must be JSON and at most `maxOutputBytes` (default 256 KiB; configurable per executor, per node, or in the config's `graph` section).
- An output that fails these checks is not a plain failure: the handler has returned, so its side effects happened. The node becomes `uncertain` with `uncertainReason: "invalid-output"` and the check's error (`output-too-large` or `output-not-json`), and the run parks as `needs-recovery` once other running nodes finish. It is never retried automatically, even with `recovery: "retry"`. Store the result, then `recoverNode(…, { type: "complete", output: artifactRef })` and `resume()`; or `retry` if re-running is safe, or `fail`. (If the run was already failing or being cancelled, it still ends that way, with the node left `uncertain`.)
- For larger results, store the data yourself and return an `ArtifactRef` (`{ $artifact: { uri, sha256, bytes, mediaType? } }`). umio never reads or deletes artifacts; retention is yours, and `collectArtifactRefs(run)` lists them.

**Checkpoints and leases**
- Pass `store` to the executor; the default is an in-memory `MemoryCheckpointStore` per executor. A node's attempt is recorded before its handler runs, and its successors start only after its result is recorded.
- The executor holds a **lease** on each run it owns (30 s, renewed every 10 s on its own timer), so a model call that is silent for hours never looks like a dead executor. Every write is a compare-and-swap fenced by that lease: once another owner could have taken over, the old one cannot write.
- If the lease is lost, the executor aborts running nodes, writes nothing more and rejects with `LeaseLostError`. A write that conflicts under a valid lease rejects with `CheckpointConflictError`.
- Custom stores implement `CheckpointStore` and should pass the contract suite in `test/checkpoint-contract.ts`. umio never claims exactly-once execution: use `idempotencyKey` to deduplicate side effects.
- `FileCheckpointStore.open({ dir })` keeps runs on disk so they survive a restart. It is **experimental and single-process only**: never share its directory between processes. It refuses to open a directory another live process is using. Other processes can still read runs with `FileCheckpointStore.snapshot()`/`snapshots()`, ask the holder to cancel one with `FileCheckpointStore.submitCancelRequest(dir, runId)`, and record an approval decision with `FileCheckpointStore.submitDecision(dir, runId, decision)`. Both write separate control files (a decision file is created exclusively, so the first wins), which the holder applies on its next poll; they never write the run itself. For several processes, use `PostgresCheckpointStore`.

**Approvals (durable pause)**
- An approval node records a request (`title`, `description`, and which predecessors' outputs it concerns) with a random `requestId`, and the node is `waiting`. No code runs for it.
- Other branches keep running. Once only a decision can move the run on (nothing running, ready or scheduled for retry), the run is written `paused`, its lease is released and `run()` resolves; the process can exit. No timeout applies to the wait.
- `executor.pendingApprovals(runId)` returns each waiting request with the run input, the context outputs and any decision recorded but not yet applied. `pendingApprovalsOf(record, decisions)` does the same from a record.
- `executor.approve(runId, target, { decidedBy?, comment? })` and `reject(…)` work from any process sharing the store; `target` is the node's checkpoint ID or the request ID. The store keeps the **first decision per request** (atomic insert-if-absent); a later call returns `already-decided` with the winning decision. Other outcomes: `recorded`, `not-pending`, `already-terminal`, `not-found`.
- A recorded decision is applied to the run once, by whoever owns it: the live owner within `cancelPollIntervalMs` (2 s), or `resume()` of a `paused` run (which otherwise returns `paused` again without writing). The node's waiting state and the decision's effect are one write, so a crash never applies it twice; completed nodes, including the side effects after the approval, never re-run.
- **Approval** completes the node with `{ approved: true, requestId, decidedAt, decidedBy?, comment? }` and its successors run. **Rejection** by default fails the node (`approval-rejected`, with the comment) and so the run. With `approval: { onReject: "continue" }` the node completes with `approved: false` instead, and its outgoing edges decide what runs next; every one of them must then have a `when` predicate, so a rejection cannot pass through unguarded.
- `cancel()` of a paused run finalizes it (`cancelled`); waiting requests are closed and can no longer be decided. A run that fails or is cancelled closes its waiting requests too.
- Stores keep decisions through the optional `recordDecision`/`loadDecisions` methods; the memory, file and PostgreSQL stores have them, and approval workflows are refused on a store without them.

```typescript
const definition: WorkflowDefinition = {
  graph: {
    id: "release", version: "1", entry: ["plan"],
    nodes: [
      { id: "plan", handler: "plan" },
      { id: "approve", approval: { title: "Deploy to production?", description: "Runs the migration." } },
      { id: "deploy", handler: "deploy" },   // uses context.idempotencyKey for its side effect
    ],
    edges: [{ from: "plan", to: "approve" }, { from: "approve", to: "deploy" }],
  },
  handlers: { plan, deploy },
  predicates: {},
};
let run = await executor.run(definition, input, { runId: "release-42" });   // → "paused"
// Later, any process:
await executor.approve("release-42", "approve", { decidedBy: "ana", comment: "go" });
run = await executor.resume(definition, "release-42");                        // → "completed"
```

**Loops**
- A loop node runs a `body` (a small DAG of its own: `nodes`, `edges`, `entry`) once per iteration. After each iteration its `until` predicate receives the iteration's output (the outputs of the body's exit nodes, by body node ID) and the run input; `true` ends the loop. `maxIterations` (1–10 000) is required. If `until` still fails then, the loop node fails with `loop-exhausted`, or completes with `exhausted: true` under `onExhausted: "complete"`.
- The loop node's output is `{ iterations, exhausted, outputs }` (the last iteration's output); its successors receive it like any predecessor output, and it is checked against the loop node's `maxOutputBytes`. A result that is too large parks the loop node as `uncertain` (`invalid-output`); `recoverNode` can `complete` it with an `ArtifactRef` (retrying a loop node is refused, since its iterations already ran).
- Every iteration's nodes are recorded under their own ID, `<loop>#<n>/<node>` (e.g. `refine#2/draft`), which is also their `context.nodeId` and makes their `idempotencyKey` distinct per iteration. Handlers get `context.loop: { id, iteration, previous }`, where `previous` is the prior iteration's output; body entry nodes receive the loop node's predecessors.
- The `until` result is recorded on the loop node (`loop.decisions`) in the same write that creates the next iteration's nodes, so recovery can neither skip nor repeat an iteration; an iteration that finished just before a crash is decided on resume from its recorded outputs (`until` must be pure).
- Inside an iteration the usual rules apply per node: retries (attempts count per iteration), timeouts, joins and conditional edges, output limits, and `uncertain` nodes, which are recovered under their iteration ID (`recoverNode(…, "refine#2/draft", …)`). A failing body node fails the loop node (`loop-body-failed`) and the run; a cancel stops the running body node and cancels the loop node.
- Approval nodes may sit in a body, which gives "revise until approved": `onReject: "continue"` and `until: (out) => out.review.approved`. Each iteration asks again with a new request.
- Loops cannot nest, and body edges stay inside the body; the outer graph connects to the loop node.

```typescript
{
  id: "refine",
  loop: {
    body: {
      entry: ["draft"],
      nodes: [{ id: "draft", handler: "draft" }, { id: "check", handler: "check" }],
      edges: [{ from: "draft", to: "check" }],
    },
    until: "goodEnough",          // predicates.goodEnough = (out) => out.check.score >= 8
    maxIterations: 5,
  },
}
```

**PostgreSQL checkpoint store**
- `PostgresCheckpointStore` lets executors in several processes or on several machines share runs. It takes any client with `query(text, values)` returning `{ rows }`; a `pg.Pool` works as is (`npm install pg`; umio lists it as an optional peer dependency).
- Correctness rests on the database only: every write is a single `UPDATE … WHERE` that checks the lease token, owner, expiry (by the database clock) and revision on the row it locks; fencing tokens come from one sequence, so they only grow, even across deleted and re-created runs; cancel requests are a flag and decisions a table keyed per request, writable by anyone without a lease.
- Create the tables once: `PostgresCheckpointStore.migrate(pool, { schema?, tablePrefix? })` (idempotent, under an advisory lock), or run `postgresSchemaSql()` with your migration tool. Records are stored as `json`, verbatim.
- `store.snapshot(runId)` reads one run with its lease, cancel and decision state. `store.listRuns({ status?, awaitingApproval?, limit?, after? })` returns one page (default 200, newest first, ties by run ID) with a `next` cursor; filters run in the database, so no matching run is hidden behind newer ones. `store.snapshots(filter)` reads every page. Paging is stable on data that does not change; runs updated during a traversal move to the front.

```typescript
import pg from "pg";
import { PostgresCheckpointStore, WorkflowExecutor } from "umio";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await PostgresCheckpointStore.migrate(pool);
const executor = WorkflowExecutor.fromConfig(llm.config, { store: new PostgresCheckpointStore({ client: pool }) });
```

**Checkpoint format**
- Runs whose definition has only task nodes are written as `schemaVersion: 1`, as before, so earlier umio versions can still read them. Runs with approval or loop nodes are written as `schemaVersion: 2` (adding the `paused` and `waiting` statuses and the `approval`/`loop` node fields); earlier versions refuse them with `CheckpointSchemaError` rather than misread them. This version reads both; nothing is migrated in place.

**Resuming after a crash**
- `executor.resume(definition, runId)` continues a run whose process died. Pass the same definition (graph ID, `version`, structure) with fresh handlers; a mismatch rejects with `DefinitionMismatchError`.
- The dead process's lease must expire first (up to 30 s after its last renewal); until then `resume()` rejects with `LeaseUnavailableError`.
- Completed nodes never run again. A node that was running when the process died has an unknown outcome: its side effects may or may not have happened. It becomes **`uncertain`**, and the run parks as **`needs-recovery`** without starting anything.
- Decide what happened (look up the effect by `idempotencyKey`), then call `executor.recoverNode(definition, runId, nodeId, action)` and `resume()` again:
  - `{ type: "retry" }` runs the node again, with the same idempotency key;
  - `{ type: "complete", output }` records it as completed with that output;
  - `{ type: "fail", message? }` fails the node and the run.
- Nodes with idempotent handlers can opt in to automatic recovery with `recovery: "retry"` and `retry: { maxAttempts: 2, … }` or more: they are retried on resume while attempts remain.
- A pending cancel request wins: `resume()` and `recoverNode()` then end the run `cancelled`.

```typescript
const store = await FileCheckpointStore.open({ dir: ".umio/runs" });
const executor = WorkflowExecutor.fromConfig(llm.config, { store });
let run = await executor.resume(definition, runId);
if (run.status === "needs-recovery") {
  for (const node of Object.values(run.nodes).filter((n) => n.status === "uncertain")) {
    await executor.recoverNode(definition, runId, node.nodeId, { type: "retry" });
  }
  run = await executor.resume(definition, runId);
}
```

The sequential `Workflow` above runs on the same executor internally, with unchanged behavior.

---

## Built-in tools

Each group is a function returning ordinary `Tool`s, so they combine with toolsets, hooks, harnesses and agents like any other tool.

| Group | Tools | Safety defaults |
|---|---|---|
| `fileTools({ root })` | `read_file`, `list_directory`, `search_files`, `write_file`, `edit_file` | Confined to `root`. `..`, absolute paths and symlinks leading outside are refused. `.env`, `.env.*` and `.git` are denied (`deny`). `readOnly: true` drops the write tools. `edit_file` needs a unique exact match. |
| `webTools()` | `fetch_url` | Only http(s). Loopback, private, link-local and metadata addresses are blocked, re-checked on every redirect (`allowPrivateNetwork` to lift). Optional `allowedDomains`. HTML is converted to text. Text content only; size-capped. |
| `shellTools({ allow })` | `run_command` | Programs must be in `allow` (required). Runs without a shell, so `;`, `\|` and `$()` are passed literally. Timeout and output cap. |
| `commandTool({ command, parameters, args })` | one tool per program | The program is fixed and the model supplies only arguments. The safest way to expose a CLI. |
| `sqlTools({ execute })` | `sql_query`, `describe_schema` | Works with any driver through your `execute` function. Read-only by default (a single SELECT/WITH/EXPLAIN/SHOW). Row cap. |
| `utilityTools()` | `current_time`, `calculate` | `calculate` uses its own parser, never `eval`. |

```typescript
import { Agent, commandTool, fileTools, sqlTools, webTools } from "umio";
import { z } from "zod";

const codeSearch = commandTool({
  name: "code_search",
  description: "Semantic search over this repository.",
  command: "graft",
  parameters: z.object({ query: z.string() }),
  args: ({ query }) => ["ask", query],
  annotations: { readOnly: true },
});

const db = sqlTools({
  dialect: "PostgreSQL",
  execute: (sql, params) => pool.query(sql, params).then((r) => r.rows),
});

const engineer = new Agent({
  name: "Engineer",
  role: "Investigates and fixes issues in this project.",
  tools: [...fileTools({ root: "." }), ...webTools(), codeSearch, ...db],
});
```

The read-only SQL check guards against mistakes, but it is not a security boundary. Connect with a database user that has only the permissions the agent should have. Likewise, an allowlisted program can still do whatever its arguments allow (`npm run` executes scripts). Gate risky calls with a `beforeToolCall` hook; `write_file`, `edit_file` and `run_command` carry `destructive: true` annotations for that purpose.

### Toolsets in the config

Declare project toolsets in `umio.config.json`. Relative paths (`root`, `cwd`) resolve against the config file's directory, and default to it when omitted:

```json
"tools": {
  "repo": { "use": "files", "root": ".", "readOnly": true },
  "docs": { "use": "files", "root": "docs" },
  "web": { "use": "web", "allowedDomains": ["developer.mozilla.org"] },
  "cli": { "use": "shell", "allow": ["git", "npm"] },
  "misc": { "use": "utilities" }
}
```

```typescript
import { createToolsets } from "umio";

const toolsets = createToolsets(llm.config); // { repo: Toolset, docs: Toolset, ... }
const reviewer = new Agent({ name: "Reviewer", role: "...", tools: toolsets.repo });
```

Options are validated when the toolsets are created, and errors name the toolset (`tools.cli: ...`). SQL tools need a driver function, so they are created in code. To add your own group, register it and pass the registry:

```typescript
const registry = defaultToolRegistry().register({
  name: "tickets",
  description: "Issue tracker access.",
  options: z.object({ project: z.string() }),
  create: ({ project }) => ticketTools(project),
});
createToolsets(llm.config, registry);
```

---

## Middleware

Middleware wraps every model call made through `LLM`, for both `generate()` and `stream()`, including the calls made inside `runToolLoop()`. The call path is: middleware (first registered = outermost) → response cache → provider.

```typescript
import { LLM, type Middleware } from "umio";

const timing: Middleware = {
  name: "timing",
  async wrapGenerate({ request, next, context }) {
    const started = Date.now();
    const result = await next(request);
    console.log(`${context.modelAlias}: ${Date.now() - started}ms`);
    return result;
  },
};

const llm = await LLM.fromFile(undefined, { middleware: [timing] });
llm.use(anotherMiddleware); // appended as the innermost layer
```

Each hook is optional:

| Hook | Use it to |
|---|---|
| `transformRequest(request, context)` | Rewrite the request: translate, compress or inject context, redact. The response cache sits inside the middleware, so cache keys reflect the rewrite. |
| `wrapGenerate({ request, next, context })` | Wrap the call: post-process results, retry, short-circuit, measure. |
| `wrapStream({ request, next, context })` | Wrap streaming calls event by event. Without it, a middleware with `wrapGenerate` still applies to streams: its result is replayed as one text delta. |

`context` carries `modelAlias`, `providerName` and `providerType`, plus `context.generate()`. That calls another model with the response cache on and middleware off, so a middleware can use a model without recursing into itself.

### Prompt translator

```typescript
import { promptTranslator } from "umio";

llm.use(
  promptTranslator({
    model: "local",              // alias of the translating model, e.g. a free local one
    to: "English",               // what the main model receives (default)
    responseLanguage: "Korean",  // translate final answers back; omit to keep them as written
  }),
);
```

- Only user messages are translated. System prompts, tool results and assistant turns are left alone, and `cache` flags are kept.
- By default, text is translated only if it contains non-ASCII characters (suited to translating into English). Pass `shouldTranslate` for other languages.
- Translations are remembered in-process, so a growing conversation is not re-translated each turn. With a response cache configured, they are also reused across runs.
- With `responseLanguage`, only final answers are translated. Streaming calls then deliver the translated answer as one delta.
- If a translation does not complete, the call fails instead of sending untranslated text.
- **Cost:** the translator adds a model call per new user text, plus one per answer when translating back. It pays off when the translating model is local or much cheaper than the main one.

### Integrating external tools

Tools such as graft (a code-graph index) or RTK (a command-output condenser) are CLIs. They fit into umio at three points:
- As a `tool()` the model calls, e.g. a `graft ask` wrapper that returns relevant code.
- As middleware that injects their output into the request.
- As an `afterToolCall` hook that condenses tool output.

---

## Caching

Large projects send the same instructions and documents over and over. umio has two layers to avoid paying for them each time.

### Prompt caching (provider side)

Providers can reuse the work done on a prompt prefix they have seen recently. Cached input is billed at a fraction of the normal price and processed faster. It is a **byte-exact prefix match** over tools, then system prompt, then messages, so any change invalidates everything after it.

| Provider | What umio does |
|---|---|
| Anthropic | Adds cache breakpoints. With `promptCache` on, it caches the system prompt and the growing conversation (the recommended setup for agent loops), and every part marked `cache: true`. Cache writes cost more than normal input (1.25× for 5 minutes, 2× for 1 hour); reads cost far less. |
| OpenAI, Ollama, vLLM, llama.cpp, LM Studio | Nothing to configure: these cache matching prefixes automatically. `cache` flags are ignored. |

For many prompts over the same documents, mark the end of the shared part. Without a marker the cache entry would end after each unique question and never be read back:

```typescript
const shared = { type: "text", text: projectDocs, cache: true } as const;

for (const question of questions) {
  await llm.generate({
    system: "Answer from the documents.", // keep it identical across requests
    messages: [{ role: "user", content: [shared, { type: "text", text: question }] }],
  });
}
```

To keep prefixes cacheable:
- Keep `system` identical across requests. Put timestamps, user names and other per-request context in `messages`.
- Keep the tool set the same within a conversation. Toolsets send definitions sorted by name, so their order is always stable.
- Stay on one model within a conversation: caches are per model.
- Check `usage.cacheReadTokens` and `usage.cacheWriteTokens` to confirm hits.

Anthropic allows 4 breakpoints per request. If more parts are flagged, umio drops the earliest flags first; later breakpoints still cover that prefix. Prefixes shorter than the model's minimum (512 tokens on Claude Opus 5) are not cached.

### Response cache (umio side)

An exact-match cache in front of the model: a request identical in everything sent to the provider gets the stored response, and costs no tokens.

```json
"responseCache": { "store": "file", "path": ".umio/cache", "ttlSeconds": 86400 }
```

- `store`: `"file"` persists across runs in a per-project directory. A relative `path` resolves against the config file's directory. `"memory"` lasts for the process (`maxEntries` caps it; default 1000, least recently used evicted first).
- Only complete responses (finish reason `stop` or `tool-calls`) are stored.
- Hits return `cached: true` with zero `usage`, and work without the provider's API key.
- Bypass it per request with `responseCache: false`, or per model with `"responseCache": false`.
- Pass `responseCacheStore` to `new LLM(config, { ... })` to use another backend (any `KVStore`: `get`, `set`, `delete`, `clear`).

A hit replays the model's earlier answer, which suits repeated analysis of unchanged inputs and repeatable development runs. In a tool loop, only model turns are replayed; tools always run, and their fresh results change later requests. Turn it off for prompts where you want a new answer each time.

---

## Results and errors

`generate()` resolves to:

| Field | Contents |
|---|---|
| `message` | The assistant message, ready to append to the history. |
| `text` | The text parts, concatenated. |
| `toolCalls` | Normalized tool calls. `input` is parsed JSON, or the raw string if the model emitted invalid JSON. |
| `finishReason` | `stop`, `length`, `tool-calls`, `refusal`, `content-filter` or `other`. |
| `rawFinishReason` | The provider's own stop reason. |
| `usage` | Token counts, including cache reads and writes where reported. |
| `model` | The model ID the provider reports. |
| `raw` | The provider's full response. |
| `cached` | `true` when served from the response cache. |

Failures throw one of these errors:
- `ConfigError`: bad or missing config, unknown alias, or unset environment variable.
- `LLMError`: the provider call failed. It carries `provider`, `status` and `retryable`.

## Custom providers

Pass a `providerFactory` to `new LLM(config, { providerFactory })` to add a provider type or stub providers in tests. Any object that implements `LLMProvider` (`type` and `generate()`, optionally `stream()`) works. Without `stream()`, `LLM.stream()` falls back to `generate()` and emits the whole text at once.

---

## Development

```bash
npm run build        # tsup → dist/ (ESM + CJS + .d.ts)
npm run typecheck    # tsc --noEmit
npm run lint         # biome check (npm run format to auto-fix)
npm test             # vitest run (the PostgreSQL store's contract suite runs on PGlite, in process)
npm run test:postgres  # multi-client and multi-process tests against a real server (UMIO_TEST_POSTGRES_URL)
npm run schema       # regenerate schema/umio.config.schema.json from the Zod schema
npm run example -- local "Hello"   # call a model from ./umio.config.json
npm run example:tools -- local     # streaming tool loop (UMIO_CONFIG=path to use another config)
npm run example:workflow -- local  # two-agent workflow with ADRs
npm run example:project -- local   # agent answering questions about this repo with built-in tools
npm run example:graph -- local     # diamond review graph with a conditional branch
npm run example:skills -- local    # skills: explicit activation, then model selection
```

For `test:postgres`, start the server in `docker-compose.yml` first with `docker compose up -d --wait` (stop it with `docker compose down`). The default URL is `postgres://umio:umio@localhost:55432/umio`; set `UMIO_POSTGRES_PORT` to publish another host port, and point `UMIO_TEST_POSTGRES_URL` at it.

Run a single test file or test name:

```bash
npx vitest run test/openai.test.ts
npx vitest run -t "maps refusals"
```

---

## Technology stack

- **Language:** TypeScript (pinned to 6.x: tsup cannot generate declarations with the native TypeScript 7 compiler).
- **LLM access:** the official SDKs. `@anthropic-ai/sdk` serves Claude. `openai` serves OpenAI and every OpenAI-compatible local server.
- **Validation:** Zod.
- **Build:** tsup (esbuild) for dual ESM/CJS output.
- **Tests and lint:** Vitest and Biome.
