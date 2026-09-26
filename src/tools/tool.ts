import { z } from "zod";
import type { KVStore } from "../cache/kv.js";
import { UmioError } from "../errors.js";
import type { Message } from "../llm/types.js";

/** Passed to every `execute()` call. New fields are added here as agents and workflows land. */
export interface ToolContext {
  toolCallId: string;
  /** Aborts with the surrounding request; long-running tools should honor it. */
  signal?: AbortSignal;
  /** The conversation so far, ending with the assistant message that made this call. */
  messages: readonly Message[];
  /** Name of the agent making the call, when running inside an agent. */
  agent?: string;
  /** State shared across the agents of a workflow run. */
  state?: KVStore;
}

/**
 * Behavior hints, mirroring MCP tool annotations. umio does not enforce them;
 * hooks (e.g. an approval gate) and future agent permission policies read them.
 */
export interface ToolAnnotations {
  /** The tool does not modify its environment. */
  readOnly?: boolean;
  /** The tool may perform destructive updates. Only meaningful when not read-only. */
  destructive?: boolean;
  /** Calling repeatedly with the same input has no additional effect. */
  idempotent?: boolean;
  /** The tool interacts with external entities (network, third-party services). */
  openWorld?: boolean;
}

export type InputParseResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * An executable tool. `tool()` builds one from a Zod schema; anything else that
 * satisfies this interface works too (e.g. an adapter wrapping MCP server tools).
 */
export interface Tool<Input = unknown, Output = unknown> {
  /** Unique within a toolset. Letters, digits, `_` and `-`, at most 64 characters. */
  readonly name: string;
  /** What the tool does and when to use it. The model relies on this to choose tools. */
  readonly description: string;
  /** JSON Schema (type "object") for the input, sent to the model. */
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: ToolAnnotations;
  /** Validates model-produced input before `execute()` runs. */
  parseInput(input: unknown): InputParseResult<Input>;
  execute(input: Input, context: ToolContext): Output | Promise<Output>;
  /** Converts the output into the text the model sees. Defaults to {@link formatToolOutput}. */
  toModelOutput?(output: Output): string;
}

export interface ToolConfig<Schema extends z.ZodType, Output> {
  name: string;
  description: string;
  /** A `z.object(...)` describing the input. Field `.describe()` texts reach the model. */
  parameters: Schema;
  execute(input: z.output<Schema>, context: ToolContext): Output | Promise<Output>;
  toModelOutput?(output: Output): string;
  annotations?: ToolAnnotations;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Defines a tool whose input is described and validated by a Zod object schema. */
export function tool<Schema extends z.ZodType, Output>(
  config: ToolConfig<Schema, Output>,
): Tool<z.output<Schema>, Output> {
  assertToolName(config.name);
  const { $schema: _, ...inputSchema } = z.toJSONSchema(config.parameters, { io: "input" });
  if (inputSchema.type !== "object") {
    throw new UmioError(`Tool "${config.name}": parameters must be a z.object() schema.`);
  }

  return {
    name: config.name,
    description: config.description,
    inputSchema,
    ...(config.annotations && { annotations: config.annotations }),
    parseInput(input) {
      const result = config.parameters.safeParse(input);
      return result.success
        ? { success: true, data: result.data }
        : { success: false, error: z.prettifyError(result.error) };
    },
    execute: config.execute,
    ...(config.toModelOutput && { toModelOutput: config.toModelOutput }),
  };
}

export function assertToolName(name: string): void {
  if (!TOOL_NAME.test(name)) {
    throw new UmioError(
      `Invalid tool name "${name}": use 1-64 letters, digits, "_" or "-" (provider APIs reject others).`,
    );
  }
}

/** Default output formatting: strings pass through, everything else becomes JSON. */
export function formatToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "(no output)";
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output); // circular structures, BigInt
  }
}
