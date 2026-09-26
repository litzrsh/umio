/**
 * Provider-neutral message and request types. Adapters in `providers/` translate
 * these to and from each provider's native API.
 */

export interface TextPart {
  type: "text";
  text: string;
  /**
   * Marks the end of a stable prefix worth caching on the provider side, e.g.
   * a large document reused across many prompts. Everything up to and including
   * this part becomes a cache entry. Anthropic honors it as a cache breakpoint;
   * OpenAI and local servers cache prefixes automatically and ignore it.
   */
  cache?: boolean;
}

export interface ToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  /** Parsed JSON arguments. If a model emits invalid JSON, this is the raw string. */
  input: unknown;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface UserMessage {
  role: "user";
  content: string | TextPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | (TextPart | ToolCallPart)[];
  /**
   * Native response content, replayed verbatim when the next request goes to a
   * provider of the same type. This preserves blocks the neutral format can't
   * express (e.g. Claude thinking blocks, which must be sent back unchanged).
   * When present and the provider type matches, it takes precedence over `content`.
   */
  providerData?: { providerType: string; content: unknown };
}

/** Results for the tool calls in the preceding assistant message. Send all of them in one message. */
export interface ToolMessage {
  role: "tool";
  content: ToolResultPart[];
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
}

export type FinishReason =
  | "stop"
  | "length"
  | "tool-calls"
  | "refusal"
  | "content-filter"
  | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface GenerateRequest {
  /** Model alias from the config. Defaults to `defaultModel`. */
  model?: string;
  /**
   * Keep this identical across requests: it sits near the start of the prompt,
   * so any change (a timestamp, a user name) invalidates the provider's prompt
   * cache for everything after it. Put per-request context in `messages`.
   * Parts are concatenated in order; mark a large stable part with `cache`.
   */
  system?: string | TextPart[];
  messages: Message[];
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "none";
  /** Overrides the model's configured `maxTokens`. */
  maxTokens?: number;
  /** Set to false to bypass the response cache for this request (no read, no write). */
  responseCache?: boolean;
  signal?: AbortSignal;
}

export interface GenerateResult {
  /** Append this to the conversation history as-is. */
  message: AssistantMessage;
  /** Concatenated text parts. */
  text: string;
  toolCalls: ToolCallPart[];
  finishReason: FinishReason;
  /** The provider's own stop/finish reason, for cases `finishReason` flattens. */
  rawFinishReason: string | null;
  usage: Usage;
  /** Model ID reported by the provider. */
  model: string;
  raw: unknown;
  /** True when served from umio's response cache; `usage` is then zero because no tokens were spent. */
  cached?: boolean;
}

export type PromptCacheTTL = "5m" | "1h";

/** A request with the model alias resolved to a concrete model and its settings. */
export interface ProviderRequest extends Omit<GenerateRequest, "model" | "responseCache"> {
  model: string;
  /** Set when the model config enables prompt caching. */
  promptCache?: { ttl: PromptCacheTTL };
  /** Unset when neither the request nor the model config gives one; adapters apply their own default. */
  maxTokens?: number;
  options?: Record<string, unknown>;
}

/**
 * Incremental output from a streaming request. A stream always ends with
 * exactly one `finish` event carrying the same result `generate()` would return.
 */
export type StreamEvent =
  | { type: "text-delta"; text: string }
  /** Emitted once a tool call's arguments are complete. */
  | { type: "tool-call"; toolCall: ToolCallPart }
  | { type: "finish"; result: GenerateResult };

export interface LLMProvider {
  /** Provider type, e.g. "anthropic". Matched against `AssistantMessage.providerData`. */
  readonly type: string;
  generate(request: ProviderRequest): Promise<GenerateResult>;
  /** Optional: without it, `LLM.stream()` falls back to `generate()` and emits the whole text at once. */
  stream?(request: ProviderRequest): AsyncIterable<StreamEvent>;
}

export interface ToolLoopDefaults {
  maxSteps?: number;
  maxToolOutputChars?: number;
}

/** The model-calling surface the tool loop and agents depend on. `LLM` implements it. */
export interface ModelClient {
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
  /** Per-model tool-loop defaults (from the model's harness). Optional. */
  loopDefaults?(model?: string): ToolLoopDefaults | undefined;
}
