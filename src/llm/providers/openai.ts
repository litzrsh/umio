import OpenAI from "openai";
import type {
  OllamaProviderConfig,
  OpenAICompatibleProviderConfig,
  OpenAIProviderConfig,
} from "../../config/schema.js";
import { isRetryableStatus, LLMError } from "../../errors.js";
import type {
  FinishReason,
  GenerateResult,
  LLMProvider,
  Message,
  ProviderRequest,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolDefinition,
} from "../types.js";

type Config = OpenAIProviderConfig | OpenAICompatibleProviderConfig | OllamaProviderConfig;

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

/**
 * Chat Completions adapter. Serves OpenAI itself and every server that speaks
 * the same API: Ollama, LM Studio, vLLM, llama.cpp, and hosted gateways.
 */
export class OpenAIProvider implements LLMProvider {
  readonly type: Config["type"];
  private readonly client: OpenAI;

  constructor(config: Config, client?: OpenAI) {
    this.type = config.type;
    this.client = client ?? new OpenAI(clientOptions(config));
  }

  async generate(request: ProviderRequest): Promise<GenerateResult> {
    const params = { ...this.params(request), stream: false } as const;
    let completion: OpenAI.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        params as OpenAI.ChatCompletionCreateParamsNonStreaming,
        { signal: request.signal },
      );
    } catch (error) {
      throw toLLMError(error, this.type);
    }
    return fromOpenAICompletion(completion, this.type);
  }

  async *stream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
    const params = {
      ...this.params(request),
      stream: true,
      stream_options: { include_usage: true },
    } as const;
    const accumulator = new ChunkAccumulator();
    try {
      const stream = await this.client.chat.completions.create(
        params as OpenAI.ChatCompletionCreateParamsStreaming,
        { signal: request.signal },
      );
      for await (const chunk of stream) {
        const text = accumulator.add(chunk);
        if (text) yield { type: "text-delta", text };
      }
    } catch (error) {
      throw toLLMError(error, this.type);
    }

    const result = fromOpenAICompletion(accumulator.toCompletion(), this.type);
    for (const toolCall of result.toolCalls) yield { type: "tool-call", toolCall };
    yield { type: "finish", result };
  }

  private params(request: ProviderRequest): Record<string, unknown> {
    const tools = request.tools?.length ? request.tools : undefined;
    // OpenAI deprecated `max_tokens` (reasoning models reject it); most local servers only know `max_tokens`.
    const maxTokensField = this.type === "openai" ? "max_completion_tokens" : "max_tokens";
    return {
      ...request.options,
      model: request.model,
      messages: toOpenAIMessages(request.system, request.messages),
      // Only sent when configured: servers such as vLLM reject a cap larger than the remaining context.
      ...(request.maxTokens !== undefined && { [maxTokensField]: request.maxTokens }),
      ...(tools && { tools: tools.map(toOpenAITool) }),
      ...(tools && request.toolChoice && { tool_choice: request.toolChoice }),
    };
  }
}

/**
 * Rebuilds a ChatCompletion from stream chunks. Written by hand instead of using
 * the SDK's stream helper so it stays tolerant of local servers whose chunks
 * deviate from OpenAI's (e.g. tool calls without an `index`).
 */
class ChunkAccumulator {
  private id = "";
  private model = "";
  private created = 0;
  private content = "";
  private refusal = "";
  private finishReason: string | null = null;
  private usage: OpenAI.CompletionUsage | undefined;
  private readonly toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  /** Returns the text delta carried by the chunk, if any. */
  add(chunk: OpenAI.ChatCompletionChunk): string {
    this.id ||= chunk.id;
    this.model ||= chunk.model;
    this.created ||= chunk.created;
    if (chunk.usage) this.usage = chunk.usage;

    const choice = chunk.choices?.[0];
    if (!choice) return "";
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (delta.refusal) this.refusal += delta.refusal;
    for (const call of delta.tool_calls ?? []) {
      // Some servers send each call whole, without an index.
      const index = call.index ?? this.toolCalls.size;
      const entry = this.toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
      if (call.id) entry.id = call.id;
      if (call.function?.name) entry.name = call.function.name;
      entry.arguments += call.function?.arguments ?? "";
      this.toolCalls.set(index, entry);
    }
    if (delta.content) this.content += delta.content;
    return delta.content ?? "";
  }

  toCompletion(): OpenAI.ChatCompletion {
    const toolCalls = [...this.toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      }));
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: (this.finishReason ??
            "stop") as OpenAI.ChatCompletion.Choice["finish_reason"],
          message: {
            role: "assistant",
            content: this.content || null,
            refusal: this.refusal || null,
            ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
          },
        },
      ],
      ...(this.usage && { usage: this.usage }),
    };
  }
}

function clientOptions(config: Config): ConstructorParameters<typeof OpenAI>[0] {
  const common = {
    ...(config.timeoutMs !== undefined && { timeout: config.timeoutMs }),
    ...(config.maxRetries !== undefined && { maxRetries: config.maxRetries }),
  };
  switch (config.type) {
    case "openai":
      return {
        ...common,
        // Omitted fields fall back to OPENAI_API_KEY / OPENAI_BASE_URL.
        ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
        ...(config.organization !== undefined && { organization: config.organization }),
        ...(config.baseURL !== undefined && { baseURL: config.baseURL }),
      };
    case "openai-compatible":
      // The SDK refuses to construct without a key; local servers ignore it.
      return { ...common, baseURL: config.baseURL, apiKey: config.apiKey ?? "not-needed" };
    case "ollama":
      return { ...common, baseURL: config.baseURL ?? OLLAMA_DEFAULT_BASE_URL, apiKey: "ollama" };
  }
}

export function toOpenAIMessages(
  system: string | TextPart[] | undefined,
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  const systemText =
    typeof system === "string" ? system : system?.map((part) => part.text).join("\n\n");
  // Prompt caching is automatic here (prefix-based), so `cache` flags need no translation.
  if (systemText) result.push({ role: "system", content: systemText });

  for (const message of messages) {
    switch (message.role) {
      case "user":
        result.push({
          role: "user",
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => ({ type: "text", text: part.text })),
        });
        break;
      case "assistant": {
        if (typeof message.content === "string") {
          result.push({ role: "assistant", content: message.content });
          break;
        }
        const text = message.content
          .filter((part): part is TextPart => part.type === "text")
          .map((part) => part.text)
          .join("");
        const toolCalls = message.content.filter(
          (part): part is ToolCallPart => part.type === "tool-call",
        );
        result.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 && {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: {
                name: call.name,
                arguments:
                  typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {}),
              },
            })),
          }),
        });
        break;
      }
      case "tool":
        // Chat Completions has no error flag on tool results, so mark it in the text.
        for (const toolResult of message.content) {
          result.push({
            role: "tool",
            tool_call_id: toolResult.toolCallId,
            content: toolResult.isError ? `Error: ${toolResult.content}` : toolResult.content,
          });
        }
        break;
    }
  }
  return result;
}

function toOpenAITool(tool: ToolDefinition): OpenAI.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

export function fromOpenAICompletion(
  completion: OpenAI.ChatCompletion,
  providerType: string,
): GenerateResult {
  const choice = completion.choices[0];
  if (!choice) {
    throw new LLMError("Response contained no choices.", {
      provider: providerType,
      retryable: false,
    });
  }
  const { message } = choice;
  const content: (TextPart | ToolCallPart)[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  if (message.refusal) content.push({ type: "text", text: message.refusal });

  message.tool_calls?.forEach((call, index) => {
    if (call.type !== "function") return;
    content.push({
      type: "tool-call",
      // Some local servers omit tool call IDs.
      id: call.id || `call_${index}`,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  });
  const toolCalls = content.filter((part): part is ToolCallPart => part.type === "tool-call");
  const usage = completion.usage;
  const cached = usage?.prompt_tokens_details?.cached_tokens;

  return {
    message: { role: "assistant", content },
    text: content
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join(""),
    toolCalls,
    finishReason: message.refusal
      ? "refusal"
      : mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    rawFinishReason: choice.finish_reason ?? null,
    usage: {
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      ...(cached != null && { cacheReadTokens: cached }),
    },
    model: completion.model,
    raw: completion,
  };
}

function parseArguments(args: string): unknown {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return args; // local models sometimes emit invalid JSON; leave it for tool validation to report
  }
}

function mapFinishReason(reason: string | null | undefined, hasToolCalls: boolean): FinishReason {
  // Several local servers report "stop" even when the message contains tool calls.
  if (hasToolCalls) return "tool-calls";
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "other";
  }
}

function toLLMError(error: unknown, provider: string): unknown {
  if (error instanceof OpenAI.APIUserAbortError) {
    return new LLMError("Request aborted.", { provider, retryable: false, cause: error });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new LLMError(`Cannot connect to ${provider} server: ${error.message}`, {
      provider,
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIError) {
    return new LLMError(error.message, {
      provider,
      status: error.status,
      retryable: isRetryableStatus(error.status),
      cause: error,
    });
  }
  return error;
}
