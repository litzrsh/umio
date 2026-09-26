import { expiresAt, isExpired, type KVSetOptions, type KVStore } from "./kv.js";

export const DEFAULT_MAX_ENTRIES = 1000;

/** In-process store with least-recently-used eviction. Values are cloned on the way in and out. */
export class MemoryKVStore implements KVStore {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number | null }>();
  private readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (isExpired(entry.expiresAt)) {
      this.entries.delete(key);
      return undefined;
    }
    // Re-insert to mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value) as T;
  }

  async set(key: string, value: unknown, options?: KVSetOptions): Promise<void> {
    this.entries.delete(key);
    this.entries.set(key, { value: structuredClone(value), expiresAt: expiresAt(options) });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
