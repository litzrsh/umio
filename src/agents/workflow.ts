import { type Adr, AdrStore, DEFAULT_ADR_STATUSES } from "../adr/store.js";
import { adrTools } from "../adr/tools.js";
import type { KVStore } from "../cache/kv.js";
import { MemoryKVStore } from "../cache/memory.js";
import { UmioError } from "../errors.js";
import { LLM } from "../llm/client.js";
import type { ModelClient, Usage } from "../llm/types.js";
import type { ToolHooks } from "../tools/execute.js";
import { sumUsage, type ToolLoopEvent } from "../tools/loop.js";
import type { Agent, AgentResult } from "./agent.js";

export interface AdrWorkflowOptions {
  store: AdrStore;
  /** Statuses given to agents as binding context. Defaults to ["Accepted"]. */
  include?: string[];
  /** Give every agent list/read/propose ADR tools. Defaults to true. */
  tools?: boolean;
}

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

  async run(input = ""): Promise<WorkflowResult> {
    if (this.steps.length === 0) throw new UmioError("Workflow has no steps.");
    const { llm, hooks, stream, onEvent, signal } = this.options;
    const state = this.options.state ?? new MemoryKVStore();
    const adr = this.adrOptions();
    // Loaded once per run, so every step sees identical (cacheable) ADR context.
    const adrContext = adr
      ? await adr.store.context(adr.include ?? DEFAULT_ADR_STATUSES)
      : undefined;

    const outputs: Record<string, string> = {};
    const steps: WorkflowStepResult[] = [];
    const proposedAdrs: Adr[] = [];
    let previous = input;

    for (const step of this.steps) {
      const meta = { step: step.name, agent: step.agent.name };
      const stepInput = await this.stepInput(step, { input, previous, outputs, state });
      await onEvent?.({ type: "step-start", ...meta, input: stepInput });

      const extraTools =
        adr && adr.tools !== false
          ? adrTools(adr.store, {
              onPropose: async (record) => {
                proposedAdrs.push(record);
                await onEvent?.({ type: "adr-proposed", ...meta, adr: record });
              },
            })
          : [];
      const result = await step.agent.run(stepInput, {
        llm,
        ...(adrContext && { context: [adrContext] }),
        extraTools,
        state,
        ...(hooks && { hooks }),
        ...(stream !== undefined && { stream }),
        ...(signal && { signal }),
        ...(onEvent && { onEvent: (event) => onEvent({ type: "agent-event", ...meta, event }) }),
      });

      outputs[step.name] = result.text;
      previous = result.text;
      steps.push({ name: step.name, agent: step.agent.name, input: stepInput, result });
      await onEvent?.({ type: "step-finish", ...meta, result });
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

  private adrOptions(): AdrWorkflowOptions | undefined {
    const { adr, llm } = this.options;
    if (adr === false) return undefined;
    if (adr instanceof AdrStore) return { store: adr };
    if (adr) return adr;
    const configured = llm instanceof LLM ? llm.config.adr : undefined;
    if (!configured) return undefined;
    return {
      store: new AdrStore(configured.path),
      ...(configured.include && { include: configured.include }),
      ...(configured.tools !== undefined && { tools: configured.tools }),
    };
  }
}
