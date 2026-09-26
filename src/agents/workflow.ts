import type { Adr, AdrStore } from "../adr/store.js";
import type { KVStore } from "../cache/kv.js";
import { MemoryKVStore } from "../cache/memory.js";
import { UmioError } from "../errors.js";
import { WorkflowExecutor } from "../graph/executor.js";
import type { JsonValue, NodeHandler, WorkflowDefinition } from "../graph/types.js";
import type { ModelClient, Usage } from "../llm/types.js";
import type { ToolHooks } from "../tools/execute.js";
import { sumUsage, type ToolLoopEvent } from "../tools/loop.js";
import {
  type AdrWorkflowOptions,
  adrToolsFor,
  loadAdrContext,
  resolveAdrOptions,
} from "./adr-context.js";
import type { Agent, AgentResult } from "./agent.js";

export type { AdrWorkflowOptions } from "./adr-context.js";

export interface WorkflowOptions {
  llm: ModelClient;
  /**
   * Architecture Decision Records applied to every step. Defaults to the
   * config's `adr` section when `llm` is an `LLM`; pass false to disable.
   */
  adr?: AdrStore | AdrWorkflowOptions | false;
  /** Shared state for the run, visible to step inputs and tools. Defaults to a fresh in-memory store. */
  state?: KVStore;
  /** Tool hooks applied to every agent. */
  hooks?: ToolHooks;
  stream?: boolean;
  onEvent?(event: WorkflowEvent): void | Promise<void>;
  signal?: AbortSignal;
}

export interface StepContext {
  /** The input given to `run()`. */
  input: string;
  /** Output of the previous step (the run input for the first step). */
  previous: string;
  /** Outputs of completed steps, by step name. */
  outputs: Readonly<Record<string, string>>;
  state: KVStore;
}

export interface StepOptions {
  /** Unique step name. Defaults to the agent's name. */
  name?: string;
  /** The task for the agent. Defaults to the previous step's output. */
  input?: string | ((context: StepContext) => string | Promise<string>);
}

export interface WorkflowStepResult {
  name: string;
  agent: string;
  input: string;
  result: AgentResult;
}

export interface WorkflowResult {
  /** Output of the last step. */
  output: string;
  outputs: Record<string, string>;
  steps: WorkflowStepResult[];
  /** Token usage summed over all steps. */
  usage: Usage;
  /** ADRs proposed by agents during the run, awaiting human review. */
  proposedAdrs: Adr[];
  state: KVStore;
}

export type WorkflowEvent =
  | { type: "step-start"; step: string; agent: string; input: string }
  | { type: "agent-event"; step: string; agent: string; event: ToolLoopEvent }
  | { type: "step-finish"; step: string; agent: string; result: AgentResult }
  | { type: "adr-proposed"; step: string; agent: string; adr: Adr };

interface Step {
  name: string;
  agent: Agent;
  input: StepOptions["input"];
}

/** Runs agents one after another, each building on the previous output. */
export class Workflow {
  private readonly steps: Step[] = [];

  constructor(private readonly options: WorkflowOptions) {}

  step(agent: Agent, options: StepOptions = {}): this {
    const name = options.name ?? agent.name;
    if (this.steps.some((step) => step.name === name)) {
      throw new UmioError(`Duplicate step name "${name}". Pass { name } to tell the steps apart.`);
    }
    this.steps.push({ name, agent, input: options.input });
    return this;
  }

  /**
   * Runs the steps in order. Internally the steps become a `step-0 → step-1 → …`
   * graph run by the workflow executor; the observable behavior (event order,
   * awaited callbacks, original errors, abort handling, result shape) is pinned
   * by test/workflow-compat.test.ts.
   */
  async run(input = ""): Promise<WorkflowResult> {
    if (this.steps.length === 0) throw new UmioError("Workflow has no steps.");
    const { llm, hooks, stream, onEvent, signal } = this.options;
    const state = this.options.state ?? new MemoryKVStore();
    const adr = resolveAdrOptions(this.options.adr, llm);
    // Loaded once per run, so every step sees identical (cacheable) ADR context.
    const adrContext = await loadAdrContext(adr);

    const outputs: Record<string, string> = {};
    const steps: WorkflowStepResult[] = [];
    const proposedAdrs: Adr[] = [];
    let previous = input;
    // The executor records failures as data; the original error is re-thrown from here.
    let failure: { error: unknown } | undefined;

    const handlers: Record<string, NodeHandler> = {};
    this.steps.forEach((step, index) => {
      handlers[nodeId(index)] = async (): Promise<JsonValue> => {
        try {
          const meta = { step: step.name, agent: step.agent.name };
          const stepInput = await this.stepInput(step, { input, previous, outputs, state });
          await onEvent?.({ type: "step-start", ...meta, input: stepInput });

          const result = await step.agent.run(stepInput, {
            llm,
            ...(adrContext && { context: [adrContext] }),
            extraTools: adrToolsFor(adr, async (record) => {
              proposedAdrs.push(record);
              await onEvent?.({ type: "adr-proposed", ...meta, adr: record });
            }),
            state,
            ...(hooks && { hooks }),
            ...(stream !== undefined && { stream }),
            // The signal reaches agents only, never the executor: an abort surfaces
            // as the error of the model call it interrupts, as before.
            ...(signal && { signal }),
            ...(onEvent && {
              onEvent: (event) => onEvent({ type: "agent-event", ...meta, event }),
            }),
          });

          outputs[step.name] = result.text;
          previous = result.text;
          steps.push({ name: step.name, agent: step.agent.name, input: stepInput, result });
          await onEvent?.({ type: "step-finish", ...meta, result });
          // Only JSON is checkpointed; the full AgentResult stays in `steps`.
          return { text: result.text, usage: JSON.parse(JSON.stringify(result.usage)) };
        } catch (error) {
          failure ??= { error };
          throw error;
        }
      };
    });

    const record = await new WorkflowExecutor({ maxConcurrency: 1 }).run(
      sequentialDefinition(this.steps.length, handlers),
      input,
    );
    if (record.status !== "completed") {
      throw failure?.error ?? new UmioError(record.error?.message ?? `Workflow ${record.status}.`);
    }

    return {
      output: previous,
      outputs,
      steps,
      usage: sumUsage(steps.map((step) => step.result.usage)),
      proposedAdrs,
      state,
    };
  }

  private async stepInput(step: Step, context: StepContext): Promise<string> {
    if (step.input === undefined) return context.previous;
    return typeof step.input === "string" ? step.input : step.input(context);
  }
}

/** Node IDs are positional: step names are free text and may contain characters node IDs reject. */
function nodeId(index: number): string {
  return `step-${index}`;
}

/** A chain `step-0 → step-1 → …` with no node timeout (the sequential API never had one). */
function sequentialDefinition(
  count: number,
  handlers: Record<string, NodeHandler>,
): WorkflowDefinition {
  const ids = Array.from({ length: count }, (_, index) => nodeId(index));
  return {
    graph: {
      id: "umio.sequential-workflow",
      version: "1",
      nodes: ids.map((id) => ({ id, handler: id, timeoutMs: null })),
      edges: ids.slice(1).map((id, index) => ({ from: ids[index] as string, to: id })),
      entry: [ids[0] as string],
    },
    handlers,
    predicates: {},
  };
}
