import { z } from "zod";

/**
 * Settings shared by every provider type. For providers classified as local
 * (see `src/llm/local.ts`) unset values get local defaults sized for
 * multi-hour inference: 3 h 5 min timeouts, no retries, one request at a time.
 */
const common = {
  /** Per-request timeout in milliseconds, from sending a request to its response headers. */
  timeoutMs: z.number().int().positive().optional(),
  /** Retries on connection errors (timeouts included), 408, 409, 429 and 5xx. SDK default: 2; local default: 0. */
  maxRetries: z.number().int().min(0).optional(),
  /**
   * Whether the server is local. Local providers get long timeouts, no retries and
   * `maxConcurrentRequests: 1` by default. Inferred when omitted: `ollama` is local;
   * `openai-compatible` is local when its baseURL host is localhost or a private IP.
   */
  local: z.boolean().optional(),
  /** In-flight request cap for this provider (per LLM instance). Local default: 1; otherwise unlimited. */
  maxConcurrentRequests: z.number().int().positive().optional(),
  /** Timeouts inside Node's fetch (undici). Local default: equal to the effective timeoutMs. */
  transport: z
    .object({
      /** Longest wait for response headers. */
      headersTimeoutMs: z.number().int().positive().optional(),
      /** Longest gap between response body chunks. */
      bodyTimeoutMs: z.number().int().positive().optional(),
    })
    .strict()
    .optional(),
};

const connection = {
  /** Overrides the provider's default endpoint. */
  baseURL: z.string().min(1).optional(),
  ...common,
};

export const AnthropicProviderSchema = z
  .object({
    type: z.literal("anthropic"),
    /** Falls back to the SDK's own resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, `ant auth login`). */
    apiKey: z.string().min(1).optional(),
    ...connection,
  })
  .strict();

export const OpenAIProviderSchema = z
  .object({
    type: z.literal("openai"),
    /** Falls back to OPENAI_API_KEY. */
    apiKey: z.string().min(1).optional(),
    organization: z.string().min(1).optional(),
    ...connection,
  })
  .strict();

/** Any server that speaks the OpenAI Chat Completions API: LM Studio, vLLM, llama.cpp, Groq, OpenRouter, ... */
export const OpenAICompatibleProviderSchema = z
  .object({
    type: z.literal("openai-compatible"),
    baseURL: z.string().min(1),
    /** Optional: most local servers accept any key. */
    apiKey: z.string().min(1).optional(),
    ...common,
  })
  .strict();

/** Ollama through its OpenAI-compatible endpoint. `baseURL` defaults to http://localhost:11434/v1. */
export const OllamaProviderSchema = z
  .object({
    type: z.literal("ollama"),
    ...connection,
  })
  .strict();

export const ProviderConfigSchema = z.discriminatedUnion("type", [
  AnthropicProviderSchema,
  OpenAIProviderSchema,
  OpenAICompatibleProviderSchema,
  OllamaProviderSchema,
]);

/** A middleware declared in JSON: `use` names a registered factory, the other keys are its options. */
export const MiddlewareSpecSchema = z.object({ use: z.string().min(1) }).catchall(z.unknown());

/**
 * A runtime profile applied whenever a model is called: the prompt, middleware
 * and loop settings that suit that model (a small local model may need tighter
 * instructions, fewer steps and shorter tool output than a frontier model).
 */
export const HarnessSchema = z
  .object({
    /**
     * Prepended to every system prompt sent to the model. Keep it static: it
     * sits at the start of the prompt, where changes invalidate prompt caches.
     */
    system: z.string().min(1).optional(),
    /** Applied only to calls to this model, inside the globally registered middleware. */
    middleware: z.array(MiddlewareSpecSchema).optional(),
    /** Defaults for tool loops (and agents) running on this model. */
    toolLoop: z
      .object({
        maxSteps: z.number().int().positive().optional(),
        /** Tool results longer than this are condensed before the model sees them. */
        maxToolOutputChars: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const AdrConfigSchema = z
  .object({
    /** Directory of ADR files (NNNN-title.md). Relative paths resolve against the config file's directory. */
    path: z.string().min(1),
    /** Statuses whose ADRs are given to agents as binding context. Defaults to ["Accepted"]. */
    include: z.array(z.string().min(1)).optional(),
    /** Give agents list/read/propose ADR tools. Defaults to true. */
    tools: z.boolean().optional(),
  })
  .strict();

/**
 * Settings for `WorkflowExecutor.fromConfig`. Explicit constructor and run
 * options take precedence. The executor checks how the lease, poll and grace
 * settings relate to each other when it is created.
 */
export const GraphConfigSchema = z
  .object({
    /** Nodes running at once. Default 4; 1 is recommended for a single local model. */
    maxConcurrency: z.number().int().positive().optional(),
    /** Largest checkpointed node output in bytes. Default 262144 (256 KiB). */
    maxOutputBytes: z.number().int().positive().optional(),
    /** Wall-clock limit per node attempt. Default 10800000 (3 h); null disables it. */
    nodeTimeoutMs: z.number().int().positive().nullable().optional(),
    /** How long a lease stays valid without renewal. Default 30000. */
    leaseTtlMs: z.number().int().positive().optional(),
    /** How often the lease is renewed; below half of leaseTtlMs. Default 10000. */
    leaseRenewIntervalMs: z.number().int().positive().optional(),
    /** How often the owner checks for cancel requests; below leaseTtlMs. Default 2000. */
    cancelPollIntervalMs: z.number().int().positive().optional(),
    /** How long a stopped attempt may take to finish before it is abandoned; below leaseTtlMs. Default 10000. */
    cancelGraceMs: z.number().int().nonnegative().optional(),
    /** How long a finished run waits for observers to receive queued events. Default 5000. */
    observerDrainTimeoutMs: z.number().int().nonnegative().optional(),
    /**
     * Where the `umio` CLI keeps graph runs. Default: a file store in
     * `.umio/runs` next to the config (one process at a time). `postgres`
     * lets several processes and machines share runs; it needs the `pg`
     * package and tables created with `umio graph migrate`. Library code
     * passes a store to the executor instead.
     */
    checkpoint: z
      .discriminatedUnion("type", [
        z
          .object({
            type: z.literal("file"),
            /** Directory, relative to the config file. Default ".umio/runs". */
            dir: z.string().min(1).optional(),
          })
          .strict(),
        z
          .object({
            type: z.literal("postgres"),
            /** e.g. "${DATABASE_URL}" or "postgres://user:pass@host:5432/db". */
            connectionString: z.string().min(1),
            /** Schema for the tables. Default: the connection's search_path. */
            schema: z
              .string()
              .regex(/^[a-z_][a-z0-9_]*$/)
              .optional(),
            /** Prefix of the table names. Default "umio_". */
            tablePrefix: z
              .string()
              .regex(/^[a-z_][a-z0-9_]*$/)
              .optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();

const skillName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a skill name like code-review");

/**
 * Local skills (docs/design/umio-skills-design.md): instruction packages the
 * CLI and `skillsFromConfig` apply to agents. Nothing is permitted unless it
 * is listed in `include`.
 */
export const SkillsConfigSchema = z
  .object({
    /** Directories whose immediate children are skills. Relative paths resolve against the config file's directory. */
    roots: z.array(z.string().min(1)).min(1),
    /** Permitted skills. Required; an empty list permits none. */
    include: z.array(skillName),
    /** Skills whose instructions go into the system prompt of every run. Must be in `include`. */
    activate: z.array(skillName).optional(),
    /** List the other permitted skills and let the model load one with `skills_load`. Default false. */
    allowModelSelection: z.boolean().optional(),
    /** Byte limits; defaults: 100 entries, 64 KiB per SKILL.md, 128 KiB per file, 256 KiB of prompt, 1 MiB read per run. */
    limits: z
      .object({
        maxCatalogEntries: z.number().int().positive(),
        maxDocumentBytes: z.number().int().positive(),
        maxResourceBytes: z.number().int().positive(),
        maxContextBytes: z.number().int().positive(),
        maxReadBytes: z.number().int().positive(),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((skills, ctx) => {
    for (const [index, name] of (skills.activate ?? []).entries()) {
      if (!skills.include.includes(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["activate", index],
          message: `"${name}" is not in skills.include`,
        });
      }
    }
  });

export const ModelConfigSchema = z
  .object({
    /** Key of an entry in `providers`. */
    provider: z.string().min(1),
    /** Model ID as the provider knows it, e.g. "claude-opus-5" or "llama3.2". */
    model: z.string().min(1),
    maxTokens: z.number().int().positive().optional(),
    /**
     * Provider-native request fields merged into every request for this model,
     * e.g. `output_config`, `thinking` or `betas` for Anthropic, `temperature` or
     * `reasoning_effort` for OpenAI-compatible servers.
     */
    options: z.record(z.string(), z.unknown()).optional(),
    /**
     * Provider-side prompt caching. `true` uses a 5-minute TTL; `{ "ttl": "1h" }`
     * suits prefixes reused 5-60 minutes apart. Anthropic: caches the system prompt
     * and the growing conversation (cache writes cost more than normal input, reads
     * far less). OpenAI and local servers cache prefixes automatically regardless.
     */
    promptCache: z
      .union([z.boolean(), z.object({ ttl: z.enum(["5m", "1h"]) }).strict()])
      .optional(),
    /** Set to false to exclude this model from the response cache. */
    responseCache: z.boolean().optional(),
    /** Name of an entry in `harnesses`, or an inline harness. */
    harness: z.union([z.string().min(1), HarnessSchema]).optional(),
  })
  .strict();

export const ResponseCacheConfigSchema = z.discriminatedUnion("store", [
  z
    .object({
      store: z.literal("memory"),
      /** Least recently used entries are evicted beyond this. Defaults to 1000. */
      maxEntries: z.number().int().positive().optional(),
      ttlSeconds: z.number().positive().optional(),
    })
    .strict(),
  z
    .object({
      store: z.literal("file"),
      /** Cache directory. Relative paths resolve against the config file's directory. */
      path: z.string().min(1),
      ttlSeconds: z.number().positive().optional(),
    })
    .strict(),
]);

export const UmioConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** Model alias used when a request does not name one. */
    defaultModel: z.string().min(1),
    providers: z.record(z.string(), ProviderConfigSchema),
    /** Model aliases. Code refers to models by these keys, not by provider model IDs. */
    models: z.record(z.string(), ModelConfigSchema),
    /**
     * Stores responses keyed by the exact request, so repeating a request costs
     * no tokens. Only complete responses (finish reason stop or tool-calls) are stored.
     */
    responseCache: ResponseCacheConfigSchema.optional(),
    /** Named harnesses that models refer to with `"harness": "<name>"`. */
    harnesses: z.record(z.string(), HarnessSchema).optional(),
    /** Architecture Decision Records applied to workflows. */
    adr: AdrConfigSchema.optional(),
    /** Graph workflow executor settings, applied by `WorkflowExecutor.fromConfig`. */
    graph: GraphConfigSchema.optional(),
    /** Local skills: instruction packages for agents. */
    skills: SkillsConfigSchema.optional(),
    /**
     * Named toolsets built from built-in (or registered) tool groups, e.g.
     * { "project-files": { "use": "files", "root": ".", "readOnly": true } }.
     * Relative paths in options resolve against the config file's directory.
     */
    tools: z
      .record(z.string(), z.object({ use: z.string().min(1) }).catchall(z.unknown()))
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    for (const [alias, model] of Object.entries(config.models)) {
      if (typeof model.harness === "string" && !(model.harness in (config.harnesses ?? {}))) {
        ctx.addIssue({
          code: "custom",
          path: ["models", alias, "harness"],
          message: `Unknown harness "${model.harness}". Defined harnesses: ${Object.keys(config.harnesses ?? {}).join(", ") || "(none)"}`,
        });
      }
    }
    for (const [alias, model] of Object.entries(config.models)) {
      if (!(model.provider in config.providers)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", alias, "provider"],
          message: `Unknown provider "${model.provider}". Defined providers: ${Object.keys(config.providers).join(", ") || "(none)"}`,
        });
      }
    }
    if (!(config.defaultModel in config.models)) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModel"],
        message: `Unknown model alias "${config.defaultModel}".`,
      });
    }
  });

export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderSchema>;
export type OpenAICompatibleProviderConfig = z.infer<typeof OpenAICompatibleProviderSchema>;
export type OllamaProviderConfig = z.infer<typeof OllamaProviderSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type ResponseCacheConfig = z.infer<typeof ResponseCacheConfigSchema>;
export type HarnessConfig = z.infer<typeof HarnessSchema>;
export type MiddlewareSpec = z.infer<typeof MiddlewareSpecSchema>;
export type AdrConfig = z.infer<typeof AdrConfigSchema>;
export type GraphConfig = z.infer<typeof GraphConfigSchema>;
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;
export type UmioConfig = z.infer<typeof UmioConfigSchema> & {
  /** Directory of the config file; set by `loadConfig`. Relative tool paths resolve against it. */
  configDir?: string;
};
export type ToolsetSpec = NonNullable<UmioConfig["tools"]>[string];
/** Config as written in JSON, before validation. */
export type UmioConfigInput = z.input<typeof UmioConfigSchema>;
