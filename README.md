# umio

> A TypeScript-first AI orchestration library for building multi-agent workflows with pre-built tools.

`umio` lets you assemble AI agents, give them tools, and coordinate them through type-safe workflows. It runs on cloud LLMs (Anthropic, OpenAI and other hosted APIs) and on local LLMs (Ollama, LM Studio, vLLM, llama.cpp) behind a single interface configured in JSON.

> **Status:** early development, not published to npm. Phases 1-3 are complete: the core engine (LLM layer, tools, streaming, caching, middleware), agents with sequential and hierarchical workflows, and built-in tools. Graph workflows remain (see [Roadmap](#roadmap)).

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

- **Built-in tools** for files, the web, command-line programs, SQL databases and utilities, each with safe defaults and configurable per project in JSON.

**Planned**

- State-graph workflows.

---

## Installation

The package is not published yet. Build from source:

```bash
npm install
npm run build
```

Requires Node.js 20 or newer.

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

### Graph workflows (in progress)

`WorkflowExecutor` runs a directed acyclic graph of nodes: branches, parallel paths and joins. It is being built in phases (see `docs/work/umio-graph-workflow-plan.md`). **Runs are currently kept in memory only**; checkpoints, resumption, retries, timeouts and cancellation come in later phases.

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
run.status;               // "completed" | "failed"
run.nodes.merge?.output;  // { text, usage } from agentNode
```

**Definitions and validation**
- The graph is plain JSON. Handlers and predicates are registered by key, and `validateDefinition` runs before every run.
- Validation reports every problem at once: cycles, unknown nodes or handlers, unreachable nodes, invalid joins, non-JSON values.
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

**Failures**
- A handler error is recorded on the node, and the run resolves with status `failed`, not an exception.
- The other running nodes are aborted and recorded as `cancelled`, and nothing new starts.

**Outputs**
- Outputs must be JSON and at most `maxOutputBytes` (default 256 KiB; configurable per executor, per node, or in the config's `graph` section).
- For larger results, store the data yourself and return an `ArtifactRef` (`{ $artifact: { uri, sha256, bytes, mediaType? } }`). umio never reads or deletes artifacts; retention is yours, and `collectArtifactRefs(run)` lists them.

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
npm test             # vitest run
npm run schema       # regenerate schema/umio.config.schema.json from the Zod schema
npm run example -- local "Hello"   # call a model from ./umio.config.json
npm run example:tools -- local     # streaming tool loop (UMIO_CONFIG=path to use another config)
npm run example:workflow -- local  # two-agent workflow with ADRs
npm run example:project -- local   # agent answering questions about this repo with built-in tools
npm run example:graph -- local     # diamond review graph with a conditional branch
```

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
