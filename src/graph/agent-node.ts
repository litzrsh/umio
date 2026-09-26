import type { AdrStore } from "../adr/store.js";
import {
  type AdrWorkflowOptions,
  adrToolsFor,
  loadAdrContext,
  resolveAdrOptions,
} from "../agents/adr-context.js";
import type { Agent } from "../agents/agent.js";
import type { KVStore } from "../cache/kv.js";
import type { ModelClient } from "../llm/types.js";
import type { ToolHooks } from "../tools/execute.js";
import type { JsonValue, NodeContext, NodeHandler } from "./types.js";

export interface AgentNodeOptions {
  llm: ModelClient;
  /** Shared state for the agent's tools. Must be durable (e.g. FileKVStore) if runs are resumed. */
  state?: KVStore;
  /** ADRs as binding context and tools; defaults to the config's `adr` section when `llm` is an `LLM`. */
  adr?: AdrStore | AdrWorkflowOptions | false;
  /** Recommended for long local calls: keeps bytes flowing and reports progress events. */
  stream?: boolean;
  hooks?: ToolHooks;
  /** Builds the agent's task. Default: {@link defaultTask}. */
  task?(context: NodeContext): string | Promise<string>;
}

/** What an agent node returns, and so what its successors see in `predecessors`. */
export interface AgentNodeOutput {
  [key: string]: JsonValue;
  text: string;
  usage: { [key: string]: number };
}

/**
 * A node handler that runs an agent. The agent, model client and state are
 * captured here, so nothing process-bound is checkpointed: pass a fresh
 * `agentNode(...)` in the definition you give to a later resume.
 *
 * The node's abort signal reaches the agent's model calls. Agent events and
 * ADR proposals are reported through `context.emit`. The output is
 * `{ text, usage }`.
 */
export function agentNode(agent: Agent, options: AgentNodeOptions): NodeHandler {
  const adr = resolveAdrOptions(options.adr, options.llm);
  return async (context) => {
    const task = await (options.task ?? defaultTask)(context);
    // Loaded per invocation; identical text across nodes keeps the provider's prompt cache warm.
    const adrContext = await loadAdrContext(adr);
    const result = await agent.run(task, {
      llm: options.llm,
      ...(adrContext && { context: [adrContext] }),
      extraTools: adrToolsFor(adr, (record) => {
        context.emit({ type: "adr-proposed", agent: agent.name, adr: record });
      }),
      ...(options.state && { state: options.state }),
      ...(options.hooks && { hooks: options.hooks }),
      ...(options.stream !== undefined && { stream: options.stream }),
      signal: context.signal,
      onEvent: (event) => context.emit({ type: "agent-event", agent: agent.name, event }),
    });
    const output: AgentNodeOutput = {
      text: result.text,
      usage: JSON.parse(JSON.stringify(result.usage)),
    };
    return output;
  };
}

/**
 * The run input as the task (strings as-is, anything else as JSON), followed by
 * the predecessors' results: an agent node's `text`, or other outputs as JSON.
 */
export function defaultTask(context: NodeContext): string {
  const input =
    typeof context.input === "string" ? context.input : JSON.stringify(context.input, null, 2);
  const results = Object.entries(context.predecessors).map(([nodeId, output]) => {
    const text =
      output !== null &&
      typeof output === "object" &&
      !Array.isArray(output) &&
      typeof output.text === "string"
        ? output.text
        : JSON.stringify(output, null, 2);
    return `<result node="${nodeId}">\n${text}\n</result>`;
  });
  return results.length > 0
    ? `${input}\n\nResults from previous steps:\n\n${results.join("\n\n")}`
    : input;
}
