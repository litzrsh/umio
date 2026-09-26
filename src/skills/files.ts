/**
 * Bounded filesystem access for skill packages: regular files only, no
 * symbolic links anywhere below a skill directory, and never more than the
 * allowed bytes plus one read (to detect an oversized file). Path checks
 * assume application-controlled skill roots; they are not a sandbox against
 * a process modifying the tree concurrently.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, posix, win32 } from "node:path";
import { SkillError } from "./errors.js";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BoundedRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: "too-large" | "not-regular"; readonly size?: number };

/**
 * Reads a regular file that is not a symbolic link, at most `maxBytes`.
 * `reserve(size)` runs synchronously once the size is known, before any
 * further read, so callers can account for bytes without parallel
 * oversubscription; it may throw to refuse.
 */
export async function readBounded(
  path: string,
  maxBytes: number,
  options: { signal?: AbortSignal; reserve?: (size: number) => void } = {},
): Promise<BoundedRead> {
  options.signal?.throwIfAborted();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, reason: "not-regular" };
    if (info.size > maxBytes) return { ok: false, reason: "too-large", size: info.size };
    options.reserve?.(info.size);
    options.signal?.throwIfAborted();
    // One byte more than allowed, so a file that grew since fstat is detected.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length === buffer.length) break;
    }
    options.signal?.throwIfAborted();
    if (length > maxBytes) return { ok: false, reason: "too-large", size: length };
    return { ok: true, bytes: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
}

/**
 * Resolves a resource path inside a skill directory. Rejects absolute paths,
 * empty, `.` and `..` components, symbolic links at any level, and anything
 * but a regular file at the end. Returns the file path and the normalized
 * relative path (`/`-separated).
 */
export async function resolveResource(
  dir: string,
  relative: unknown,
): Promise<{ file: string; path: string }> {
  if (typeof relative !== "string" || !relative || relative.length > 1_024) {
    throw new SkillError("path must be a nonempty relative path of at most 1024 characters.");
  }
  if (
    relative.includes("\0") ||
    isAbsolute(relative) ||
    posix.isAbsolute(relative) ||
    win32.isAbsolute(relative) ||
    /^[a-zA-Z]:/.test(relative)
  ) {
    throw new SkillError(`"${relative}" is not a relative path inside the skill.`);
  }
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new SkillError(
      `"${relative}" must not contain empty, "." or ".." segments; name a file inside the skill, e.g. references/checklist.md.`,
    );
  }
  let current = dir;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillError(`"${relative}" does not exist in this skill.`);
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new SkillError(`"${relative}" goes through a symbolic link, which skills may not use.`);
    }
    const last = index === parts.length - 1;
    if (!last && !info.isDirectory())
      throw new SkillError(`"${relative}" does not exist in this skill.`);
    if (last && !info.isFile()) throw new SkillError(`"${relative}" is not a regular file.`);
  }
  return { file: current, path: parts.join("/") };
}
