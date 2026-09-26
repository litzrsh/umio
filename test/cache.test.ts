import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FileKVStore,
  type GenerateResult,
  type KVStore,
  MemoryKVStore,
  ResponseCache,
  stableStringify,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

async function tempDir() {
  return mkdtemp(join(tmpdir(), "umio-cache-"));
}

function describeStore(name: string, create: () => Promise<KVStore>) {
  describe(name, () => {
    it("stores, reads and deletes values", async () => {
      const store = await create();
      await store.set("a", { n: 1, list: ["x"] });
      await expect(store.get("a")).resolves.toEqual({ n: 1, list: ["x"] });
      await expect(store.get("missing")).resolves.toBeUndefined();
      await store.delete("a");
      await expect(store.get("a")).resolves.toBeUndefined();
    });

    it("expires entries after their TTL", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const store = await create();
      await store.set("k", "v", { ttlMs: 1000 });
      vi.advanceTimersByTime(999);
      await expect(store.get("k")).resolves.toBe("v");
      vi.advanceTimersByTime(1);
      await expect(store.get("k")).resolves.toBeUndefined();
    });

    it("clears everything", async () => {
      const store = await create();
      await store.set("a", 1);
      await store.set("b", 2);
      await store.clear();
      await expect(store.get("a")).resolves.toBeUndefined();
      await expect(store.get("b")).resolves.toBeUndefined();
    });
  });
}

describeStore("MemoryKVStore", async () => new MemoryKVStore());
describeStore("FileKVStore", async () => new FileKVStore(await tempDir()));

describe("MemoryKVStore", () => {
  it("evicts the least recently used entry", async () => {
    const store = new MemoryKVStore({ maxEntries: 2 });
    await store.set("a", 1);
    await store.set("b", 2);
    await store.get("a"); // "b" is now least recently used
    await store.set("c", 3);
    await expect(store.get("b")).resolves.toBeUndefined();
    await expect(store.get("a")).resolves.toBe(1);
    expect(store.size).toBe(2);
  });

  it("isolates stored values from later mutation", async () => {
    const store = new MemoryKVStore();
    const value = { n: 1 };
    await store.set("k", value);
    value.n = 2;
    const read = await store.get<{ n: number }>("k");
    if (read) read.n = 3;
    await expect(store.get("k")).resolves.toEqual({ n: 1 });
  });
});

describe("FileKVStore", () => {
  it("persists across instances", async () => {
    const dir = await tempDir();
    await new FileKVStore(dir).set("key", { saved: true });
    await expect(new FileKVStore(dir).get("key")).resolves.toEqual({ saved: true });
  });

  it("drops corrupt entries instead of failing", async () => {
    const dir = await tempDir();
    const store = new FileKVStore(dir);
    await store.set("key", "ok");
    const [shard] = await readdir(dir);
    if (!shard) throw new Error("no shard written");
    const [file] = await readdir(join(dir, shard));
    if (!file) throw new Error("no entry written");
    await writeFile(join(dir, shard, file), "{ truncated");
    await expect(store.get("key")).resolves.toBeUndefined();
    await expect(readdir(join(dir, shard))).resolves.toEqual([]);
  });
});

describe("stableStringify", () => {
  it("sorts object keys at every level and keeps array order", () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: undefined } })).toBe(
      '{"a":{"d":[2,1]},"b":1}',
    );
    expect(stableStringify({ x: 1, y: 2 })).toBe(stableStringify({ y: 2, x: 1 }));
  });
});

describe("ResponseCache", () => {
  const result = (finishReason: GenerateResult["finishReason"]): GenerateResult => ({
    message: { role: "assistant", content: "hi" },
    text: "hi",
    toolCalls: [],
    finishReason,
    rawFinishReason: null,
    usage: { inputTokens: 100, outputTokens: 20 },
    model: "m",
    raw: {},
  });

  it("derives equal keys for equal requests regardless of key order", () => {
    expect(ResponseCache.key({ model: "m", messages: [] })).toBe(
      ResponseCache.key({ messages: [], model: "m" }),
    );
    expect(ResponseCache.key({ model: "m" })).not.toBe(ResponseCache.key({ model: "n" }));
  });

  it("returns hits flagged as cached, with zero usage", async () => {
    const cache = new ResponseCache(new MemoryKVStore());
    await cache.set("k", result("stop"));
    await expect(cache.get("k")).resolves.toMatchObject({
      text: "hi",
      cached: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("stores only complete responses", async () => {
    const cache = new ResponseCache(new MemoryKVStore());
    await cache.set("length", result("length"));
    await cache.set("refusal", result("refusal"));
    await cache.set("tools", result("tool-calls"));
    await expect(cache.get("length")).resolves.toBeUndefined();
    await expect(cache.get("refusal")).resolves.toBeUndefined();
    await expect(cache.get("tools")).resolves.toBeDefined();
  });

  it("applies the TTL", async () => {
    const store = new MemoryKVStore();
    const set = vi.spyOn(store, "set");
    await new ResponseCache(store, 5000).set("k", result("stop"));
    expect(set).toHaveBeenCalledWith("k", expect.anything(), { ttlMs: 5000 });
  });
});
