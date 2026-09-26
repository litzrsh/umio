import { UmioError } from "../errors.js";
import type { GenerateResult, Message, TextPart } from "../llm/types.js";
import type { Middleware, MiddlewareContext } from "./types.js";

export interface PromptTranslatorOptions {
  /** Model alias that performs the translation, typically a cheap local model. */
  model: string;
  /** Language the main model receives. Defaults to "English". */
  to?: string;
  /**
   * Translate final answers (finish reason "stop") into this language. Omit to
   * return answers as the main model wrote them. Streaming calls then arrive
   * as a single delta, since the answer is translated as a whole.
   */
  responseLanguage?: string;
  /**
   * Whether a user text needs translating. Defaults to "contains non-ASCII
   * characters", which suits translating into English; supply your own for
   * other target languages.
   */
  shouldTranslate?(text: string): boolean;
  /** Translations remembered in-process, so a growing conversation is not re-translated. Defaults to 500. */
  memoSize?: number;
}

const NON_ASCII = /[^\t\n\r\x20-\x7e]/;

/**
 * Translates user messages before they reach the model, and optionally the
 * answer back. Sending English to a paid model can save tokens (many scripts
 * tokenize less efficiently) and improves results on models trained mostly on
 * English. System prompts, tool results and assistant turns are not translated.
 */
export function promptTranslator(options: PromptTranslatorOptions): Middleware {
  const to = options.to ?? "English";
  const shouldTranslate = options.shouldTranslate ?? ((text: string) => NON_ASCII.test(text));
  const memoSize = options.memoSize ?? 500;
  const memo = new Map<string, string>();

  async function translate(text: string, language: string, context: MiddlewareContext) {
    const memoKey = `${language}\u0000${text}`;
    const remembered = memo.get(memoKey);
    if (remembered !== undefined) return remembered;

    const result = await context.generate({
      model: options.model,
      system: `Translate the user's message into ${language}. Output only the translation, with no preamble or notes. Keep code, identifiers, file paths, URLs, numbers and Markdown formatting unchanged.`,
      messages: [{ role: "user", content: text }],
    });
    if (result.finishReason !== "stop" || !result.text.trim()) {
      throw new UmioError(
        `Translation by "${options.model}" did not complete (finish reason: ${result.finishReason}).`,
      );
    }
    const translated = result.text.trim();
    memo.set(memoKey, translated);
    if (memo.size > memoSize) {
      const oldest = memo.keys().next();
      if (!oldest.done) memo.delete(oldest.value);
    }
    return translated;
  }

  const translateUserText = (text: string, context: MiddlewareContext) =>
    shouldTranslate(text) ? translate(text, to, context) : Promise.resolve(text);

  async function translateMessage(message: Message, context: MiddlewareContext): Promise<Message> {
    if (message.role !== "user") return message;
    if (typeof message.content === "string") {
      return { ...message, content: await translateUserText(message.content, context) };
    }
    const content = await Promise.all(
      message.content.map(
        async (part): Promise<TextPart> => ({
          ...part,
          text: await translateUserText(part.text, context),
        }),
      ),
    );
    return { ...message, content };
  }

  const middleware: Middleware = {
    name: "prompt-translator",
    async transformRequest(request, context) {
      // Calls to the translation model itself pass through untouched.
      if (context.modelAlias === options.model) return request;
      const messages = await Promise.all(
        request.messages.map((message) => translateMessage(message, context)),
      );
      return { ...request, messages };
    },
  };

  const responseLanguage = options.responseLanguage;
  if (responseLanguage) {
    middleware.wrapGenerate = async ({ request, next, context }) => {
      const result = await next(request);
      if (context.modelAlias === options.model) return result;
      if (result.finishReason !== "stop" || !result.text.trim()) return result;
      return withText(result, await translate(result.text, responseLanguage, context));
    };
  }
  return middleware;
}

/** Replaces the answer text. `providerData` is kept, so the model still sees its original words. */
function withText(result: GenerateResult, text: string): GenerateResult {
  const toolCalls = typeof result.message.content === "string" ? [] : result.toolCalls;
  return {
    ...result,
    text,
    message: { ...result.message, content: [{ type: "text", text }, ...toolCalls] },
  };
}
