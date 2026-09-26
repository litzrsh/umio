import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expiresAt, isExpired, type KVSetOptions, type KVStore } from "./kv.js";

interface FileEntry {
  key: string;
  expiresAt: number | null;
  value: unknown;
}

/**
 * Stores each entry as a JSON file under a directory, so the cache persists
 * across runs and belongs to the project that owns the directory. File names
 * are hashes of the keys, sharded into 256 subdirectories. Writes are atomic
 * (temp file + rename), so concurrent processes never read a partial entry.
 * Expired entries are removed when read.
 */
export class FileKVStore implements KVStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const file = this.fileFor(key);
    let entry: FileEntry;
    try {
      entry = JSON.parse(await readFile(file, "utf8")) as FileEntry;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (error instanceof SyntaxError) {
        await rm(file, { force: true }); // corrupt entry: drop it
        return undefined;
      }
      throw error;
    }
    if (entry.key !== key) return undefined;
    if (isExpired(entry.expiresAt)) {
      await rm(file, { force: true });
      return undefined;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, options?: KVSetOptions): Promise<void> {
    const file = this.fileFor(key);
    const entry: FileEntry = { key, expiresAt: expiresAt(options), value };
    await mkdir(join(file, ".."), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(entry));
    await rename(temp, file);
  }

  async delete(key: string): Promise<void> {
    await rm(this.fileFor(key), { force: true });
  }

  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  private fileFor(key: string): string {
    const hash = createHash("sha256").update(key).digest("hex");
    return join(this.dir, hash.slice(0, 2), `${hash}.json`);
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
