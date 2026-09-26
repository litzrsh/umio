/**
 * Session state for the CLI, independent of the terminal: whether an
 * operation is running, the chat transcript, and what a cancelled turn leaves
 * behind. Pure apart from the AbortController it hands out.
 */
import type { GenerateResult, Message, ToolCallPart, ToolResultPart, Usage } from "../llm/types.js";
import type { ToolExecution } from "../tools/execute.js";
import type { ToolLoopResult } from "../tools/loop.js";

export type OperationKind = "chat" | "graph";

/**
 * At most one operation at a time: `idle → running → (cancelling →) idle`.
 * Cancelling aborts the operation's signal; it never exits the application.
 */
export class OperationGate {
  private current:
    | { kind: OperationKind; controller: AbortController; cancelling: boolean }
    | undefined;

  get state(): "idle" | "running" | "cancelling" {
    if (!this.current) return "idle";
    return this.current.cancelling ? "cancelling" : "running";
  }

  get kind(): OperationKind | undefined {
    return this.current?.kind;
  }

  /** Starts an operation; throws if one is already running. */
  begin(kind: OperationKind): AbortSignal {
    if (this.current) throw new Error(`An operation (${this.current.kind}) is already running.`);
    this.current = { kind, controller: new AbortController(), cancelling: false };
    return this.current.controller.signal;
  }

  /** Requests cancellation of the running operation. */
  cancel(): "cancelling" | "already-cancelling" | "idle" {
    if (!this.current) return "idle";
    if (this.current.cancelling) return "already-cancelling";
    this.current.cancelling = true;
    this.current.controller.abort(new Error("Cancelled by the user."));
    return "cancelling";
  }

  end(): void {
    this.current = undefined;
  }

  /** Whether exiting is allowed now: only when nothing runs. */
  canExit(): boolean {
    return this.current === undefined;
  }
}

export type ToolStatus = "pending" | "running" | "done" | "not-run";

interface StepRecord {
  message: GenerateResult["message"];
  calls: ToolCallPart[];
  started: Set<string>;
  results: Map<string, ToolExecution>;
}

/** What one chat turn did so far, from the tool loop's events. */
export class TurnRecorder {
  private readonly steps: StepRecord[] = [];

  constructor(
    /** The transcript before this turn. */
    readonly base: readonly Message[],
    /** What the user typed. */
    readonly prompt: string,
    /** The user message sent (the prompt, possibly with a note about a cancelled turn). */
    readonly userMessage: Message,
  ) {}

  /** A model call finished; its tool calls (if any) are about to run. */
  modelFinished(result: GenerateResult): void {
    this.steps.push({
      message: result.message,
      calls: result.toolCalls,
      started: new Set(),
      results: new Map(),
    });
  }

  toolStarted(callId: string): void {
    this.steps.at(-1)?.started.add(callId);
  }

  toolFinished(execution: ToolExecution): void {
    this.steps.at(-1)?.results.set(execution.call.id, execution);
  }

  /** Every tool call of this turn with what is known about it. */
  tools(): { call: ToolCallPart; status: ToolStatus; execution?: ToolExecution }[] {
    return this.steps.flatMap((step) =>
      step.calls.map((call) => {
        const execution = step.results.get(call.id);
        if (execution) return { call, status: execution.executed ? "done" : "not-run", execution };
        return { call, status: step.started.has(call.id) ? "running" : "pending" };
      }),
    );
  }

  /** Whether any tool may have had an effect (finished, or started without finishing). */
  hasToolEffects(): boolean {
    return this.tools().some((tool) => tool.status === "done" || tool.status === "running");
  }

  /**
   * The transcript up to the interruption, valid to continue: each finished
   * model call, and a result for every tool call it made. Tools interrupted
   * while running are reported as having an unknown outcome; tools never
   * started are reported as not run.
   */
  partialMessages(): Message[] {
    const messages: Message[] = [...this.base, this.userMessage];
    for (const step of this.steps) {
      messages.push(step.message);
      if (step.calls.length === 0) continue;
      const content: ToolResultPart[] = step.calls.map((call) => {
        const execution = step.results.get(call.id);
        if (execution) return execution.result;
        return {
          type: "tool-result",
          toolCallId: call.id,
          content: step.started.has(call.id)
            ? "Interrupted: the user cancelled while this tool was running. Its outcome is unknown; it may have had effects."
            : "Not run: the user cancelled the turn before this tool started.",
          isError: true,
        };
      });
      messages.push({ role: "tool", content });
    }
    return messages;
  }
}

export interface CancelledTurn {
  /** Set when nothing ran: the prompt goes back to the input line and the transcript is unchanged. */
  readonly restoredPrompt?: string;
  /** Tools that finished or were interrupted, so the user can see what may have happened. */
  readonly affected: { call: ToolCallPart; status: ToolStatus }[];
}

/** A chat conversation. Only mutated between operations. */
export class ChatSession {
  id: string;
  startedAt: number;
  model: string;
  messages: Message[] = [];
  turns = 0;
  usage: Usage = { inputTokens: 0, outputTokens: 0 };
  /** Prepended to the next user message after a turn was cancelled with tool effects. */
  pendingNote: string | undefined;
  /** Tools the user approved for the rest of this session ("always"). */
  readonly alwaysApproved = new Set<string>();

  constructor(model: string, now: number, id: string) {
    this.model = model;
    this.startedAt = now;
    this.id = id;
  }

  /** Starts over: empty transcript, usage and approvals. */
  reset(now: number, id: string): void {
    this.id = id;
    this.startedAt = now;
    this.messages = [];
    this.turns = 0;
    this.usage = { inputTokens: 0, outputTokens: 0 };
    this.pendingNote = undefined;
    this.alwaysApproved.clear();
  }

  beginTurn(prompt: string): TurnRecorder {
    const text = this.pendingNote ? `${this.pendingNote}\n\n${prompt}` : prompt;
    return new TurnRecorder([...this.messages], prompt, { role: "user", content: text });
  }

  completeTurn(result: ToolLoopResult): void {
    this.messages = result.messages;
    this.turns += 1;
    this.pendingNote = undefined;
    this.usage = {
      inputTokens: this.usage.inputTokens + result.usage.inputTokens,
      outputTokens: this.usage.outputTokens + result.usage.outputTokens,
    };
  }

  /**
   * After a cancel or an error. Without tool effects the turn is undone and
   * its prompt handed back. With them, the partial transcript is kept and the
   * next message tells the model what already happened, so nothing is re-run
   * because the turn was repeated from scratch.
   */
  interruptTurn(turn: TurnRecorder, reason: "cancelled" | "failed"): CancelledTurn {
    const affected = turn
      .tools()
      .filter((tool) => tool.status === "done" || tool.status === "running")
      .map(({ call, status }) => ({ call, status }));
    if (!turn.hasToolEffects()) return { restoredPrompt: turn.prompt, affected };
    this.messages = turn.partialMessages();
    this.turns += 1;
    const list = affected
      .map(
        (tool) =>
          `${tool.call.name} (${tool.status === "done" ? "completed" : "interrupted, outcome unknown"})`,
      )
      .join(", ");
    this.pendingNote = `[Note from umio: the previous request was ${reason === "cancelled" ? "cancelled by the user" : "stopped by an error"} before you answered. Tools that already ran: ${list}. Do not repeat them unless the user asks.]`;
    return { affected };
  }
}
