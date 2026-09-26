import { createHash } from "node:crypto";
import type { ResponseCacheConfig } from "../config/schema.js";
import type { GenerateResult } from "../llm/types.js";
import { FileKVStore } from "./file.js";
import type { KVStore } from "./kv.js";
import { MemoryKVStore } from "./memory.js";

const KEY_PREFIX = "umio:response:v1:";

/** Finish reasons worth replaying. Truncated, refused or odd responses are fetched again. */
const CACHEABLE = new Set<GenerateResult["finishReason"]>(["stop", "tool-calls"]);

export function createKVStore(config: ResponseCacheConfig): KVStore {
  switch (config.store) {
    case "memory":
      return new MemoryKVStore(
        config.maxEntries !== undefined ? { maxEntries: config.maxEntries } : {},
      );
    case "file":
      return new FileKVStore(config.path);
  }
}

/**
 * Exact-match response cache: a request identical in every field that reaches
 * the provider (model, system, messages, tools, options, ...) gets the stored
 * result instead of a new model call.
 */
export class ResponseCache {
  constructor(
    readonly store: KVStore,
    private readonly ttlMs?: number,
  ) {}

  /** A deterministic key: the SHA-256 of the request serialized with sorted object keys. */
  static key(request: unknown): string {
    return KEY_PREFIX + createHash("sha256").update(stableStringify(request)).digest("hex");
  }

  async get(key: string): Promise<GenerateResult | undefined> {
    const stored = await this.store.get<GenerateResult>(key);
    if (!stored) return undefined;
    return { ...stored, cached: true, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async set(key: string, result: GenerateResult): Promise<void> {
    if (result.cached || !CACHEABLE.has(result.finishReason)) return;
    await this.store.set(key, result, this.ttlMs !== undefined ? { ttlMs: this.ttlMs } : {});
  }
}

/** JSON.stringify with object keys sorted at every level, so equal values serialize identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}
