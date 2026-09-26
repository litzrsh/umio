import { z } from "zod";
import type { KVStore } from "../cache/kv.js";
import type { Message, ModelClient, TextPart } from "../llm/types.js";
import type { ToolHooks } from "../tools/execute.js";
import { runToolLoop, type ToolLoopEvent, type ToolLoopResult } from "../tools/loop.js";
import { type Tool, tool } from "../tools/tool.js";
import { Toolset } from "../tools/toolset.js";

export interface AgentConfig {
  /** Identifies the agent in workflows, events and tool contexts. */
  name: string;
  /** What the agent is responsible for. Becomes the core of its system prompt. */
  role: string;
  /** Further standing instructions: style, constraints, output format. */
  instructions?: string;
  /** Model alias from the config. Defaults to the config's `defaultModel`. */
  model?: string;
  /** The tools this agent may use. Other tools are never offered to it. */
  tools?: Iterable<Tool>;
  /** Overrides the model harness's `maxSteps`. */
  maxSteps?: number;
}

export interface AgentRunOptions {
  llm: ModelClient;
  /**
   * Shared system-prompt sections placed before the agent's own role, such as
   * ADRs. Workflows pass the same sections to every agent, so providers can
   * reuse the cached prefix across agents.
   */
  context?: string[];
  /** Tools added for this run (e.g. ADR tools), on top of the agent's own. */
  extraTools?: Iterable<Tool>;
  state?: KVStore;
  hooks?: ToolHooks;
  stream?: boolean;
  onEvent?(event: ToolLoopEvent): void | Promise<void>;
  signal?: AbortSignal;
}

export type AgentResult = ToolLoopResult;

export interface AgentToolOptions extends Omit<AgentRunOptions, "state" | "signal"> {
  /** Tool name. Defaults to "ask_<agent name>". */
  name?: string;
  /** Defaults to the agent's role. */
  description?: string;
}

/** A model with a role, instructions and a restricted set of tools. */
export class Agent {
  readonly name: string;
  readonly role: string;
  readonly instructions: string | undefined;
  readonly model: string | undefined;
  readonly tools: Toolset;
  readonly maxSteps: number | undefined;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.role = config.role;
    this.instructions = config.instructions;
    this.model = config.model;
    this.tools = new Toolset(config.tools ?? []);
    this.maxSteps = config.maxSteps;
  }

  /** Runs the agent on a task (or a conversation to continue) until it answers. */
  run(input: string | Message[], options: AgentRunOptions): Promise<AgentResult> {
    const messages: Message[] =
      typeof input === "string" ? [{ role: "user", content: input }] : input;
    const tools = new Toolset([...this.tools, ...(options.extraTools ?? [])]);

    return runToolLoop(options.llm, {
      ...(this.model && { model: this.model }),
      system: this.system(options.context ?? []),
      messages,
      tools,
      ...(this.maxSteps !== undefined && { maxSteps: this.maxSteps }),
      ...(options.stream !== undefined && { stream: options.stream }),
      ...(options.onEvent && { onEvent: options.onEvent }),
      ...(options.hooks && { hooks: options.hooks }),
      ...(options.signal && { signal: options.signal }),
      toolContext: { agent: this.name, ...(options.state && { state: options.state }) },
    });
  }

  /**
   * Exposes the agent as a tool, so another agent can delegate to it:
   * hierarchical workflows where a coordinator decides which specialist to
   * ask. The sub-agent runs its own tool loop with its own tools and returns
   * its final answer. Shared state and the abort signal pass through from the
   * calling tool's context.
   */
  asTool(options: AgentToolOptions): Tool {
    const { name, description, ...runOptions } = options;
    return tool({
      name: name ?? `ask_${this.name.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase()}`.slice(0, 64),
      description: description ?? `Delegates a task to ${this.name}: ${this.role}`,
      parameters: z.object({
        task: z
          .string()
          .min(1)
          .describe(
            `A complete, self-contained task for ${this.name}; it cannot see your conversation.`,
          ),
      }),
      execute: async ({ task }, context) => {
        const result = await this.run(task, {
          ...runOptions,
          ...(context.state && { state: context.state }),
          ...(context.signal && { signal: context.signal }),
        });
        return result.text || `(${this.name} returned no text; stop reason: ${result.stopReason})`;
      },
    });
  }

  /** Shared context first (stable, cache-marked), then the agent's own role. */
  private system(context: string[]): TextPart[] {
    const shared = context.map(
      (text, index): TextPart => ({
        type: "text",
        text,
        ...(index === context.length - 1 && { cache: true }),
      }),
    );
    const own = [`You are ${this.name}. ${this.role}`, this.instructions]
      .filter(Boolean)
      .join("\n\n");
    return [...shared, { type: "text", text: own }];
  }
}
