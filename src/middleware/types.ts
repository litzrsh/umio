import type {
  GenerateRequest,
  GenerateResult,
  ProviderRequest,
  StreamEvent,
} from "../llm/types.js";

export interface MiddlewareContext {
  /** The model alias the caller asked for. */
  modelAlias: string;
  /** Provider key in the config, and its type (e.g. "anthropic", "ollama"). */
  providerName: string;
  providerType: string;
  /**
   * Calls a model with the response cache but without middleware, for
   * middleware that needs a model of its own (e.g. translation) and must not
   * recurse into itself.
   */
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

export interface WrapOptions<T> {
  request: ProviderRequest;
  /** Calls the next layer: the next middleware, then the response cache and provider. */
  next(request: ProviderRequest): T;
  context: MiddlewareContext;
}

/**
 * A layer around every model call. Middleware run in registration order, the
 * first being the outermost. All hooks are optional:
 * - `transformRequest` rewrites the request before inner layers see it. The
 *   response cache sits inside the middleware, so cache keys reflect the rewrite.
 * - `wrapGenerate` / `wrapStream` wrap the call: modify results, retry,
 *   short-circuit, measure. A middleware with `wrapGenerate` but no `wrapStream`
 *   still applies to streaming calls: its result is replayed as one text delta.
 */
export interface Middleware {
  readonly name: string;
  transformRequest?(
    request: ProviderRequest,
    context: MiddlewareContext,
  ): ProviderRequest | Promise<ProviderRequest>;
  wrapGenerate?(options: WrapOptions<Promise<GenerateResult>>): Promise<GenerateResult>;
  wrapStream?(options: WrapOptions<AsyncIterable<StreamEvent>>): AsyncIterable<StreamEvent>;
}
