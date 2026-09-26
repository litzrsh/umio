/**
 * A minimal async key-value store for JSON-serializable values. The response
 * cache is built on it, and later features (agent/project state) are meant to
 * reuse it. Implement it to plug in another backend, e.g. Redis or SQLite.
 */
export interface KVStore {
  /** Returns undefined when the key is missing or expired. The type parameter is an unchecked cast. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: KVSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every entry. */
  clear(): Promise<void>;
}

export interface KVSetOptions {
  /** Time to live. Omit to keep the entry until it is deleted or evicted. */
  ttlMs?: number;
}

export function expiresAt(options: KVSetOptions | undefined): number | null {
  return options?.ttlMs !== undefined ? Date.now() + options.ttlMs : null;
}

export function isExpired(expiry: number | null): boolean {
  return expiry !== null && Date.now() >= expiry;
}
