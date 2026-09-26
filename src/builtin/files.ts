import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type Tool, tool } from "../tools/tool.js";
import { truncate } from "./shared.js";

export interface FileToolsOptions {
  /** Directory the tools are confined to. Paths outside it, including via symlinks, are refused. */
  root: string;
  /** Omit write_file and edit_file. Defaults to false. */
  readOnly?: boolean;
  /**
   * Name patterns (`*` wildcard) that may not be read, written or listed, matched
   * against every path segment. Defaults to [".env", ".env.*", ".git"], so
   * secrets and repository internals stay out of the model's reach.
   */
  deny?: string[];
  /** Directory names skipped by list and search (still readable directly). Defaults to ["node_modules"]. */
  skip?: string[];
  /** Largest text returned by a read, list or search. Defaults to 100 000 characters. */
  maxChars?: number;
}

export const DEFAULT_DENY = [".env", ".env.*", ".git"];
const DEFAULT_SKIP = ["node_modules"];
const DEFAULT_MAX_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 200;

class SandboxError extends Error {}

/**
 * File tools confined to one directory: read, list and search, plus write and
 * exact-match edit unless `readOnly`. Paths are given relative to the root.
 */
export function fileTools(options: FileToolsOptions): Tool[] {
  const root = resolve(options.root);
  const deny = (options.deny ?? DEFAULT_DENY).map(globToRegExp);
  const skip = new Set(options.skip ?? DEFAULT_SKIP);
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  /** Resolves a model-supplied path inside the root, refusing escapes and denied names. */
  async function inside(path: string): Promise<string> {
    const target = resolve(root, path);
    const rel = relative(root, target);
    if (escapes(rel)) {
      throw new SandboxError(`Path "${path}" is outside the allowed directory.`);
    }
    if (rel.split(sep).some((segment) => deny.some((pattern) => pattern.test(segment)))) {
      throw new SandboxError(`Access to "${path}" is not allowed.`);
    }
    // Follow symlinks on the deepest existing ancestor: a link must not lead outside the root.
    const realRoot = await realpath(root);
    let existing = target;
    for (;;) {
      try {
        const real = await realpath(existing);
        const realRel = relative(realRoot, real);
        if (escapes(realRel)) {
          throw new SandboxError(`Path "${path}" resolves outside the allowed directory.`);
        }
        return target;
      } catch (error) {
        if (error instanceof SandboxError) throw error;
        const parent = dirname(existing);
        if (parent === existing) throw error;
        existing = parent;
      }
    }
  }

  const display = (absolute: string) => relative(root, absolute) || ".";
  const isDenied = (name: string) => deny.some((pattern) => pattern.test(name));

  const readFileTool = tool({
    name: "read_file",
    description:
      "Reads a text file. Returns numbered lines. For large files, read a range with offset and limit.",
    parameters: z.object({
      path: z.string().describe("Path relative to the project root."),
      offset: z.number().int().min(1).optional().describe("First line to return (1-based)."),
      limit: z.number().int().positive().optional().describe("Number of lines to return."),
    }),
    annotations: { readOnly: true },
    execute: async ({ path, offset = 1, limit }) => {
      const content = await readFile(await inside(path), "utf8");
      const lines = content.split("\n");
      const end = limit ? offset - 1 + limit : lines.length;
      const numbered = lines
        .slice(offset - 1, end)
        .map((line, index) => `${offset + index}\t${line}`)
        .join("\n");
      return truncate(numbered, maxChars, "read a smaller range with offset and limit");
    },
  });

  const listDirectory = tool({
    name: "list_directory",
    description: "Lists a directory's entries. Directories end with '/'.",
    parameters: z.object({
      path: z.string().default(".").describe("Directory relative to the project root."),
      recursive: z.boolean().default(false),
    }),
    annotations: { readOnly: true },
    execute: async ({ path, recursive }) => {
      const start = await inside(path);
      const entries: string[] = [];
      async function walk(dir: string) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (isDenied(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            entries.push(`${display(full)}/`);
            if (recursive && !skip.has(entry.name)) await walk(full);
          } else {
            entries.push(display(full));
          }
        }
      }
      await walk(start);
      return truncate(entries.sort().join("\n") || "(empty)", maxChars, "list a subdirectory");
    },
  });

  const searchFiles = tool({
    name: "search_files",
    description:
      "Searches file contents for a regular expression and returns matching lines as path:line: text.",
    parameters: z.object({
      pattern: z.string().describe("JavaScript regular expression."),
      path: z.string().default(".").describe("Directory to search, relative to the project root."),
      ignoreCase: z.boolean().default(false),
    }),
    annotations: { readOnly: true },
    execute: async ({ pattern, path, ignoreCase }) => {
      const regex = new RegExp(pattern, ignoreCase ? "i" : "");
      const matches: string[] = [];
      async function walk(dir: string) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (matches.length >= MAX_SEARCH_RESULTS) return;
          if (isDenied(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!skip.has(entry.name)) await walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          const content = await readFile(full, "utf8").catch(() => "");
          if (content.includes("\u0000")) continue; // binary
          content.split("\n").forEach((line, index) => {
            if (matches.length < MAX_SEARCH_RESULTS && regex.test(line)) {
              matches.push(`${display(full)}:${index + 1}: ${line.trim()}`);
            }
          });
        }
      }
      await walk(await inside(path));
      if (matches.length === 0) return "No matches.";
      const capped =
        matches.length >= MAX_SEARCH_RESULTS
          ? `\n[stopped at ${MAX_SEARCH_RESULTS} matches; narrow the pattern or path]`
          : "";
      return truncate(matches.join("\n") + capped, maxChars, "narrow the pattern or path");
    },
  });

  const tools: Tool[] = [readFileTool, listDirectory, searchFiles];
  if (options.readOnly) return tools;

  const writeFileTool = tool({
    name: "write_file",
    description:
      "Creates or overwrites a text file with the given content. Creates parent directories. Prefer edit_file for changes to existing files.",
    parameters: z.object({
      path: z.string().describe("Path relative to the project root."),
      content: z.string(),
    }),
    annotations: { destructive: true },
    execute: async ({ path, content }) => {
      const target = await inside(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      return `Wrote ${content.length} characters to ${display(target)}.`;
    },
  });

  const editFile = tool({
    name: "edit_file",
    description:
      "Replaces an exact string in a file. oldText must match exactly once (include surrounding lines to make it unique), unless replaceAll is set.",
    parameters: z.object({
      path: z.string().describe("Path relative to the project root."),
      oldText: z.string().min(1),
      newText: z.string(),
      replaceAll: z.boolean().default(false),
    }),
    annotations: { destructive: true },
    execute: async ({ path, oldText, newText, replaceAll }) => {
      const target = await inside(path);
      if (!(await stat(target)).isFile()) throw new Error(`${path} is not a file.`);
      const content = await readFile(target, "utf8");
      const count = content.split(oldText).length - 1;
      if (count === 0)
        throw new Error("oldText was not found. Read the file and copy the text exactly.");
      if (count > 1 && !replaceAll) {
        throw new Error(
          `oldText matches ${count} times. Add surrounding context, or set replaceAll.`,
        );
      }
      await writeFile(target, content.split(oldText).join(newText));
      return `Replaced ${replaceAll ? count : 1} occurrence(s) in ${display(target)}.`;
    },
  });

  return [...tools, writeFileTool, editFile];
}

/** True when a path relative to the root points outside it. */
function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
