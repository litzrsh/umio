import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages";
import type { AnthropicProviderConfig } from "../../config/schema.js";
import { isRetryableStatus, LLMError } from "../../errors.js";
import { effectiveProviderSettings } from "../local.js";
import { transportFetchOptions } from "../transport.js";
import type {
  FinishReason,
  GenerateResult,
  LLMProvider,
  Message,
  PromptCacheTTL,
  ProviderRequest,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolDefinition,
} from "../types.js";

const TYPE = "anthropic";
/** Streaming is used internally, so a generous default does not risk HTTP timeouts. */
const DEFAULT_MAX_TOKENS = 16000;

export class AnthropicProvider implements LLMProvider {
  readonly type = TYPE;
  private readonly client: Anthropic;

  constructor(config: AnthropicProviderConfig, client?: Anthropic) {
    this.client = client ?? new Anthropic(anthropicClientOptions(config));
  }

  /** Consumes `stream()`: streaming avoids HTTP timeouts on long generations. */
  async generate(request: ProviderRequest): Promise<GenerateResult> {
    for await (const event of this.stream(request)) {
      if (event.type === "finish") return event.result;
    }
    throw new LLMError("Stream ended without a final message.", {
      provider: TYPE,
      retryable: true,
    });
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const tools = request.tools?.length ? request.tools : undefined;
    const system = toAnthropicSystem(request.system, request.promptCache !== undefined);
    const messages = toAnthropicMessages(request.messages);
    const topLevelCacheControl = applyCacheBreakpoints(system, messages, request.promptCache);
    const params = {
      ...request.options,
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
      ...(system !== undefined && { system }),
      ...(tools && { tools: tools.map(toAnthropicTool) }),
      ...(tools && request.toolChoice && { tool_choice: { type: request.toolChoice } }),
      ...(topLevelCacheControl && { cache_control: topLevelCacheControl }),
    };
    const requestOptions = { signal: request.signal };

    let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
    try {
      // Beta features (fallbacks, compaction, ...) are opted into via `betas` in the model's `options`.
      const stream =
        "betas" in params
          ? this.client.beta.messages.stream(params as BetaMessageStreamParams, requestOptions)
          : this.client.messages.stream(params as Anthropic.MessageStreamParams, requestOptions);
      for await (const event of stream as AsyncIterable<
        Anthropic.RawMessageStreamEvent | Anthropic.Beta.BetaRawMessageStreamEvent
      >) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text-delta", text: event.delta.text };
        }
      }
      message = await stream.finalMessage();
    } catch (error) {
      throw toLLMError(error);
    }

    // Tool calls are emitted from the final message, where their input is complete and parsed.
    const result = fromAnthropicMessage(message);
    for (const toolCall of result.toolCalls) yield { type: "tool-call", toolCall };
    yield { type: "finish", result };
  }
}

/** The API allows at most this many cache_control breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

function cacheControl(ttl: PromptCacheTTL = "5m"): Anthropic.CacheControlEphemeral {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function textBlock(part: TextPart): Anthropic.TextBlockParam {
  return { type: "text", text: part.text, ...(part.cache && { cache_control: cacheControl() }) };
}

function toAnthropicSystem(
  system: string | TextPart[] | undefined,
  asBlocks: boolean,
): string | Anthropic.TextBlockParam[] | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") {
    if (!asBlocks) return system;
    return system ? [{ type: "text", text: system }] : undefined;
  }
  // The API rejects empty text blocks.
  const blocks = system.filter((part) => part.text).map(textBlock);
  return blocks.length ? blocks : undefined;
}

/**
 * Places prompt-cache breakpoints and returns the top-level (automatic)
 * cache_control, if any. With `promptCache` enabled this follows the pattern
 * recommended for agent loops: an explicit breakpoint on the last system block
 * (a read point that survives any change in `messages`) plus automatic caching
 * of the growing conversation tail. Parts flagged `cache: true` add explicit
 * breakpoints. When they exceed the 4-breakpoint limit, the earliest flagged
 * parts lose theirs: later breakpoints cover the same prefix and more.
 * All breakpoints share one TTL, which the API's TTL ordering rule requires.
 */
export function applyCacheBreakpoints(
  system: string | Anthropic.TextBlockParam[] | undefined,
  messages: Anthropic.MessageParam[],
  promptCache: { ttl: PromptCacheTTL } | undefined,
): Anthropic.CacheControlEphemeral | undefined {
  const ttl = promptCache?.ttl ?? "5m";
  const protectedBlock = promptCache && Array.isArray(system) ? system.at(-1) : undefined;
  if (protectedBlock) protectedBlock.cache_control = cacheControl(ttl);

  const marked: { cache_control?: Anthropic.CacheControlEphemeral | null }[] = [];
  for (const block of Array.isArray(system) ? system : []) {
    if (block.cache_control) marked.push(block);
  }
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if ("cache_control" in block && block.cache_control) marked.push(block);
    }
  }

  let excess = marked.length - (MAX_CACHE_BREAKPOINTS - (promptCache ? 1 : 0));
  for (const block of marked) {
    if (excess > 0 && block !== protectedBlock) {
      delete block.cache_control;
      excess--;
    } else if (block.cache_control) {
      block.cache_control = cacheControl(ttl);
    }
  }
  return promptCache ? cacheControl(ttl) : undefined;
}

/**
 * SDK options for a provider config. Omitted fields fall through to the SDK's
 * own env/credential resolution. Anthropic is not local unless configured so
 * (e.g. a local proxy), in which case the local defaults apply.
 */
export function anthropicClientOptions(
  config: AnthropicProviderConfig,
): ConstructorParameters<typeof Anthropic>[0] {
  const settings = effectiveProviderSettings(config);
  const fetchOptions = transportFetchOptions(settings);
  return {
    ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
    ...(config.baseURL !== undefined && { baseURL: config.baseURL }),
    ...(settings.timeoutMs !== undefined && { timeout: settings.timeoutMs }),
    ...(settings.maxRetries !== undefined && { maxRetries: settings.maxRetries }),
    ...(fetchOptions && { fetchOptions: fetchOptions as Record<string, unknown> }),
  };
}

export function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map(toAnthropicMessage);
}

function toAnthropicMessage(message: Message): Anthropic.MessageParam {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.filter((part) => part.text).map(textBlock),
      };
    case "assistant": {
      if (message.providerData?.providerType === TYPE) {
        return {
          role: "assistant",
          content: message.providerData.content as Anthropic.ContentBlockParam[],
        };
      }
      if (typeof message.content === "string") {
        return { role: "assistant", content: message.content };
      }
      const content: Anthropic.ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          // The API rejects empty text blocks.
          if (part.text) content.push(textBlock(part));
        } else {
          content.push({
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: part.input,
          });
        }
      }
      return { role: "assistant", content };
    }
    case "tool":
      return {
        role: "user",
        content: message.content.map((result) => ({
          type: "tool_result",
          tool_use_id: result.toolCallId,
          content: result.content,
          ...(result.isError && { is_error: true }),
        })),
      };
  }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

export function fromAnthropicMessage(
  message: Anthropic.Message | Anthropic.Beta.BetaMessage,
): GenerateResult {
  const content: (TextPart | ToolCallPart)[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      content.push({ type: "tool-call", id: block.id, name: block.name, input: block.input });
    }
    // Thinking, server-tool and other blocks are carried in providerData only.
  }
  const toolCalls = content.filter((part): part is ToolCallPart => part.type === "tool-call");
  const { usage } = message;

  return {
    message: {
      role: "assistant",
      content,
      providerData: { providerType: TYPE, content: message.content },
    },
    text: content
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join(""),
    toolCalls,
    finishReason: mapStopReason(message.stop_reason),
    rawFinishReason: message.stop_reason,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ...(usage.cache_read_input_tokens != null && {
        cacheReadTokens: usage.cache_read_input_tokens,
      }),
      ...(usage.cache_creation_input_tokens != null && {
        cacheWriteTokens: usage.cache_creation_input_tokens,
      }),
    },
    model: message.model,
    raw: message,
  };
}

function mapStopReason(reason: string | null): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "refusal":
      return "refusal";
    default:
      return "other"; // pause_turn, compaction, null
  }
}

function toLLMError(error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) {
    return new LLMError("Request aborted.", { provider: TYPE, retryable: false, cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new LLMError(error.message, {
      provider: TYPE,
      status: error.status,
      retryable: isRetryableStatus(error.status),
      cause: error,
    });
  }
  return error;
}
