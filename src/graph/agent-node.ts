import type { AdrStore } from "../adr/store.js";
import {
  type AdrWorkflowOptions,
  adrToolsFor,
  loadAdrContext,
  resolveAdrOptions,
} from "../agents/adr-context.js";
import type { Agent } from "../agents/agent.js";
import type { KVStore } from "../cache/kv.js";
import { LLM } from "../llm/client.js";
import type { ModelClient } from "../llm/types.js";
import { type SkillBinding, withSkills } from "../skills/agent.js";
import { skillManifest } from "../skills/catalog.js";
import type { ToolHooks } from "../tools/execute.js";
import { DEFAULT_NODE_TIMEOUT_MS } from "./executor.js";
import type { JsonValue, NodeContext, NodeHandler } from "./types.js";
import { emitWarnings, shortProviderTimeouts } from "./warnings.js";

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
  /**
   * Skills for this node, prepared afresh for each attempt. Explicit per node:
   * nothing is inherited from other nodes. Skill events are emitted as
   * `custom` node events named "skill", and the output gains `skills`, a
   * manifest of the documents and files used.
   *
   * Skill content is not checkpointed or checked on resume: pin the skill
   * packages and bump the graph `version` whenever they change.
   */
  skills?: SkillBinding;
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
 *
 * When `llm` is an `LLM` whose model runs on a local provider with a request
 * timeout below the default node timeout (3 h), a process warning is emitted
 * once: the provider, not the node timeout, would end long calls.
 */
export function agentNode(agent: Agent, options: AgentNodeOptions): NodeHandler {
  const adr = resolveAdrOptions(options.adr, options.llm);
  if (options.llm instanceof LLM) {
    const { config } = options.llm;
    emitWarnings(
      shortProviderTimeouts(config, DEFAULT_NODE_TIMEOUT_MS, [agent.model ?? config.defaultModel]),
    );
  }
  return async (context) => {
    const task = await (options.task ?? defaultTask)(context);
    // Loaded per invocation; identical text across nodes keeps the provider's prompt cache warm.
    const adrContext = await loadAdrContext(adr);
    const binding: SkillBinding | undefined = options.skills && {
      ...options.skills,
      onEvent: (event) => {
        options.skills?.onEvent?.(event);
        context.emit({ type: "custom", name: "skill", data: JSON.parse(JSON.stringify(event)) });
      },
    };
    const { options: runOptions, prepared } = await withSkills(
      agent,
      {
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
      },
      binding,
    );
    const result = await agent.run(task, runOptions);
    const output: AgentNodeOutput = {
      text: result.text,
      usage: JSON.parse(JSON.stringify(result.usage)),
      ...(prepared && { skills: JSON.parse(JSON.stringify(skillManifest(prepared.usage()))) }),
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
