import type { KVStore } from "../cache/kv.js";
import { createKVStore, ResponseCache } from "../cache/response.js";
import { loadConfig, resolveProviderConfig } from "../config/load.js";
import type { HarnessConfig, UmioConfig } from "../config/schema.js";
import { ConfigError } from "../errors.js";
import { builtinMiddleware, type MiddlewareFactory } from "../middleware/registry.js";
import type { Middleware, MiddlewareContext } from "../middleware/types.js";
import { createProvider, type ProviderFactory } from "./providers/index.js";
import type {
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  ModelClient,
  ProviderRequest,
  StreamEvent,
  TextPart,
  ToolLoopDefaults,
} from "./types.js";

export interface LLMOptions {
  /** Source for `${VAR}` references in the config. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Maps a provider config to an implementation. Override to add or stub providers. */
  providerFactory?: ProviderFactory;
  /**
   * Backend for the response cache, overriding `responseCache.store` in the
   * config (e.g. a shared Redis-backed store). The config's `ttlSeconds` still applies.
   */
  responseCacheStore?: KVStore;
  /** Middleware applied to every call, first = outermost. More can be added with `use()`. */
  middleware?: Middleware[];
  /** Middleware that harnesses can declare by name in JSON, in addition to the built-ins. */
  middlewareFactories?: Record<string, MiddlewareFactory>;
}

interface ResolvedRequest {
  providerRequest: ProviderRequest;
  context: MiddlewareContext;
  /** False when the response cache is off for this request. */
  useCache: boolean;
}

/**
 * Entry point for model calls. Resolves a model alias from the config to its
 * provider and forwards the request. Providers are created, and their `${VAR}`
 * references resolved, on first use, so a config may list cloud providers whose
 * API keys are absent as long as they are not called.
 *
 * Call path: middleware (outermost first) → response cache → provider.
 */
export class LLM implements ModelClient {
  /** Undefined unless the config has `responseCache` or a store was passed in. */
  readonly responseCache: ResponseCache | undefined;

  private readonly providers = new Map<string, LLMProvider>();
  private readonly env: Record<string, string | undefined>;
  private readonly providerFactory: ProviderFactory;
  private readonly middleware: Middleware[];
  private readonly middlewareFactories: Record<string, MiddlewareFactory>;
  /** Harness middleware, instantiated once per model alias so stateful middleware keeps its state. */
  private readonly harnessLayers = new Map<string, Middleware[]>();

  constructor(
    readonly config: UmioConfig,
    options: LLMOptions = {},
  ) {
    this.env = options.env ?? process.env;
    this.providerFactory = options.providerFactory ?? createProvider;
    this.middleware = [...(options.middleware ?? [])];
    this.middlewareFactories = { ...builtinMiddleware, ...options.middlewareFactories };
    // Fail at startup, not on the first call, when a harness names unknown middleware.
    for (const alias of Object.keys(config.models)) {
      for (const spec of this.harness(alias)?.middleware ?? []) {
        if (!(spec.use in this.middlewareFactories)) {
          throw new ConfigError(
            `Model "${alias}": unknown middleware "${spec.use}". Available: ${Object.keys(this.middlewareFactories).join(", ")}`,
          );
        }
      }
    }
    const cacheConfig = config.responseCache;
    const store =
      options.responseCacheStore ?? (cacheConfig ? createKVStore(cacheConfig) : undefined);
    const ttlSeconds = cacheConfig?.ttlSeconds;
    this.responseCache = store
      ? new ResponseCache(store, ttlSeconds !== undefined ? ttlSeconds * 1000 : undefined)
      : undefined;
  }

  /** Loads and validates a JSON config file. Defaults to `umio.config.json` in the working directory. */
  static async fromFile(file?: string, options: LLMOptions = {}): Promise<LLM> {
    return new LLM(await loadConfig(file, options.env), options);
  }

  /** Appends middleware; it becomes the innermost layer so far. */
  use(...middleware: Middleware[]): this {
    this.middleware.push(...middleware);
    return this;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    return this.generateWith(this.layers(request.model), request);
  }

  /**
   * Streams the response. The last event is always `finish` with the full result.
   * Providers without streaming support, cache hits, and middleware that only
   * wrap `generate` emit their whole text as one delta.
   */
  async *stream(request: GenerateRequest): AsyncGenerator<StreamEvent> {
    const resolved = this.resolve(request);
    yield* this.streamAt(this.layers(request.model), 0, resolved, resolved.providerRequest);
  }

  /** The harness of a model alias (defaults to `defaultModel`), with named references resolved. */
  harness(alias: string = this.config.defaultModel): HarnessConfig | undefined {
    const harness = this.config.models[alias]?.harness;
    return typeof harness === "string" ? this.config.harnesses?.[harness] : harness;
  }

  /** Tool-loop defaults from the model's harness; `runToolLoop` and agents apply them. */
  loopDefaults(alias?: string): ToolLoopDefaults | undefined {
    return this.harness(alias)?.toolLoop;
  }

  /** Global middleware first (outermost), then the model's harness middleware. */
  private layers(alias: string = this.config.defaultModel): Middleware[] {
    let harnessLayers = this.harnessLayers.get(alias);
    if (!harnessLayers) {
      harnessLayers = (this.harness(alias)?.middleware ?? []).map(({ use, ...options }) => {
        const factory = this.middlewareFactories[use];
        if (!factory) throw new ConfigError(`Unknown middleware "${use}".`);
        return factory(options);
      });
      this.harnessLayers.set(alias, harnessLayers);
    }
    return [...this.middleware, ...harnessLayers];
  }

  private async generateWith(middleware: Middleware[], request: GenerateRequest) {
    const resolved = this.resolve(request);
    return this.generateAt(middleware, 0, resolved, resolved.providerRequest);
  }

  private async generateAt(
    middleware: Middleware[],
    index: number,
    resolved: ResolvedRequest,
    request: ProviderRequest,
  ): Promise<GenerateResult> {
    const layer = middleware[index];
    if (!layer) return this.callProvider(resolved, request);

    const { context } = resolved;
    const transformed = layer.transformRequest
      ? await layer.transformRequest(request, context)
      : request;
    const next = (r: ProviderRequest) => this.generateAt(middleware, index + 1, resolved, r);
    return layer.wrapGenerate
      ? layer.wrapGenerate({ request: transformed, next, context })
      : next(transformed);
  }

  private async *streamAt(
    middleware: Middleware[],
    index: number,
    resolved: ResolvedRequest,
    request: ProviderRequest,
  ): AsyncGenerator<StreamEvent> {
    const layer = middleware[index];
    if (!layer) {
      yield* this.streamProvider(resolved, request);
      return;
    }

    const { context } = resolved;
    const transformed = layer.transformRequest
      ? await layer.transformRequest(request, context)
      : request;
    if (layer.wrapStream) {
      const next = (r: ProviderRequest) => this.streamAt(middleware, index + 1, resolved, r);
      yield* layer.wrapStream({ request: transformed, next, context });
    } else if (layer.wrapGenerate) {
      const next = (r: ProviderRequest) => this.generateAt(middleware, index + 1, resolved, r);
      yield* replay(await layer.wrapGenerate({ request: transformed, next, context }));
    } else {
      yield* this.streamAt(middleware, index + 1, resolved, transformed);
    }
  }

  private async callProvider(
    resolved: ResolvedRequest,
    request: ProviderRequest,
  ): Promise<GenerateResult> {
    const cacheKey = this.cacheKey(resolved, request);
    const cached = cacheKey && (await this.responseCache?.get(cacheKey));
    if (cached) return cached;

    const result = await this.provider(resolved.context.providerName).generate(request);
    if (cacheKey) await this.responseCache?.set(cacheKey, result);
    return result;
  }

  private async *streamProvider(
    resolved: ResolvedRequest,
    request: ProviderRequest,
  ): AsyncGenerator<StreamEvent> {
    const cacheKey = this.cacheKey(resolved, request);
    const cached = cacheKey && (await this.responseCache?.get(cacheKey));
    if (cached) {
      yield* replay(cached);
      return;
    }

    const provider = this.provider(resolved.context.providerName);
    if (!provider.stream) {
      const result = await provider.generate(request);
      if (cacheKey) await this.responseCache?.set(cacheKey, result);
      yield* replay(result);
      return;
    }
    for await (const event of provider.stream(request)) {
      if (event.type === "finish" && cacheKey) {
        await this.responseCache?.set(cacheKey, event.result);
      }
      yield event;
    }
  }

  private resolve(request: GenerateRequest): ResolvedRequest {
    const { model: alias = this.config.defaultModel, responseCache, ...rest } = request;
    const modelConfig = this.config.models[alias];
    if (!modelConfig) {
      throw new ConfigError(
        `Unknown model alias "${alias}". Configured models: ${Object.keys(this.config.models).join(", ")}`,
      );
    }
    const providerConfig = this.config.providers[modelConfig.provider];
    if (!providerConfig) throw new ConfigError(`Unknown provider "${modelConfig.provider}".`);

    const maxTokens = request.maxTokens ?? modelConfig.maxTokens;
    const promptCache = modelConfig.promptCache;
    const system = withHarnessSystem(this.harness(alias)?.system, rest.system);
    return {
      providerRequest: {
        ...rest,
        ...(system !== undefined && { system }),
        model: modelConfig.model,
        ...(maxTokens !== undefined && { maxTokens }),
        ...(modelConfig.options && { options: modelConfig.options }),
        ...(promptCache && {
          promptCache: { ttl: promptCache === true ? "5m" : promptCache.ttl },
        }),
      },
      context: {
        modelAlias: alias,
        providerName: modelConfig.provider,
        providerType: providerConfig.type,
        generate: (inner) => this.generateWith([], inner),
      },
      useCache:
        this.responseCache !== undefined &&
        responseCache !== false &&
        modelConfig.responseCache !== false,
    };
  }

  /** Keyed on the request as it reaches the provider, i.e. after middleware rewrites. */
  private cacheKey(resolved: ResolvedRequest, request: ProviderRequest): string | undefined {
    if (!resolved.useCache) return undefined;
    const { signal: _, ...keyed } = request;
    const providerConfig = this.config.providers[resolved.context.providerName];
    return ResponseCache.key({
      provider: resolved.context.providerName,
      // Unresolved config values: `${VAR}` references, never secrets.
      providerType: providerConfig?.type,
      baseURL: providerConfig && "baseURL" in providerConfig ? providerConfig.baseURL : undefined,
      request: keyed,
    });
  }

  private provider(name: string): LLMProvider {
    let provider = this.providers.get(name);
    if (!provider) {
      const providerConfig = this.config.providers[name];
      if (!providerConfig) throw new ConfigError(`Unknown provider "${name}".`);
      provider = this.providerFactory(resolveProviderConfig(name, providerConfig, this.env));
      this.providers.set(name, provider);
    }
    return provider;
  }
}

export function* replay(result: GenerateResult): Generator<StreamEvent> {
  if (result.text) yield { type: "text-delta", text: result.text };
  for (const toolCall of result.toolCalls) yield { type: "tool-call", toolCall };
  yield { type: "finish", result };
}

/** Puts the harness preamble first: it is the most stable part of the prompt. */
function withHarnessSystem(
  preamble: string | undefined,
  system: string | TextPart[] | undefined,
): string | TextPart[] | undefined {
  if (!preamble) return system;
  if (system === undefined || system === "") return preamble;
  if (typeof system === "string") return `${preamble}\n\n${system}`;
  return [{ type: "text", text: preamble }, ...system];
}
