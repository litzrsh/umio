/**
 * Adapter from a chat turn to the library's `Agent`: one turn is one tool
 * loop over the session transcript. Reports through `ChatView`, so it has no
 * terminal code, and never re-sends a turn by itself.
 */
import { Agent } from "../agents/agent.js";
import type { GenerateResult, ModelClient, ToolCallPart } from "../llm/types.js";
import { type SkillBinding, withSkills } from "../skills/agent.js";
import type { ToolCallOverride, ToolExecution } from "../tools/execute.js";
import type { ToolLoopResult } from "../tools/loop.js";
import type { Tool } from "../tools/tool.js";
import type { CancelledTurn, ChatSession } from "./session.js";

export const CHAT_AGENT_ROLE =
  "A helpful assistant working with the user in their terminal. Use the available tools when they help, and say briefly what you did.";

export type Approval = "yes" | "no" | "always";

export interface ChatView {
  /** A model call has been sent; nothing received yet. */
  waiting(): void;
  text(delta: string): void;
  modelFinished(result: GenerateResult): void;
  toolStarted(call: ToolCallPart): void;
  toolFinished(execution: ToolExecution): void;
}

export interface ChatTurnOptions {
  readonly llm: ModelClient;
  readonly tools: readonly Tool[];
  readonly signal: AbortSignal;
  readonly view: ChatView;
  /** Approve every call without asking. */
  readonly autoApprove: boolean;
  /**
   * Asks the user about a call to a tool that is not marked read-only. Absent
   * (non-interactive without --yes): such calls are declined.
   */
  readonly approve?: (call: ToolCallPart, tool: Tool) => Promise<Approval>;
  /**
   * Skills, prepared afresh for this turn: activation is never carried over
   * from earlier turns, though skill text they loaded stays in the transcript.
   */
  readonly skills?: SkillBinding;
}

export type ChatTurnOutcome =
  | { readonly status: "completed"; readonly result: ToolLoopResult }
  | {
      readonly status: "cancelled" | "failed";
      readonly error: unknown;
      readonly interruption: CancelledTurn;
    };

export async function runChatTurn(
  session: ChatSession,
  prompt: string,
  options: ChatTurnOptions,
): Promise<ChatTurnOutcome> {
  const { view, signal } = options;
  const turn = session.beginTurn(prompt);
  const agent = new Agent({
    name: "umio",
    role: CHAT_AGENT_ROLE,
    model: session.model,
    tools: options.tools,
  });
  // Parallel tool calls are approved one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.catch(() => {});
    return result;
  };

  const decide = async (call: ToolCallPart, tool: Tool): Promise<ToolCallOverride | undefined> => {
    if (
      options.autoApprove ||
      tool.annotations?.readOnly ||
      session.alwaysApproved.has(tool.name)
    ) {
      return undefined;
    }
    if (!options.approve) {
      return {
        content: `Declined: ${tool.name} may change things, and this non-interactive session was not started with --yes.`,
        isError: true,
      };
    }
    const choice = await options.approve(call, tool);
    if (choice === "always") session.alwaysApproved.add(tool.name);
    return choice === "no"
      ? { content: "The user declined this tool call.", isError: true }
      : undefined;
  };

  view.waiting();
  try {
    const { options: runOptions } = await withSkills(
      agent,
      {
        llm: options.llm,
        stream: true,
        signal,
        hooks: {
          beforeToolCall: (call, tool) =>
            serial(async () => {
              if (!tool) return undefined; // the loop reports unknown tools to the model
              if (signal.aborted)
                return { content: "Not run: the turn was cancelled.", isError: true };
              const override = await decide(call, tool);
              if (!override) {
                turn.toolStarted(call.id);
                view.toolStarted(call);
              }
              return override;
            }),
        },
        onEvent: (event) => {
          switch (event.type) {
            case "text-delta":
              view.text(event.text);
              break;
            case "finish":
              turn.modelFinished(event.result);
              view.modelFinished(event.result);
              break;
            case "tool-result":
              turn.toolFinished(event.execution);
              view.toolFinished(event.execution);
              break;
            case "step-finish":
              if (event.step.toolExecutions.length > 0) view.waiting(); // the next model call
              break;
          }
        },
      },
      options.skills,
    );
    const result = await agent.run([...turn.base, turn.userMessage], runOptions);
    session.completeTurn(result);
    return { status: "completed", result };
  } catch (error) {
    const status = signal.aborted ? "cancelled" : "failed";
    return { status, error, interruption: session.interruptTurn(turn, status) };
  }
}
