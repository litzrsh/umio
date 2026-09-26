import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { type Tool, type ToolAnnotations, tool } from "../tools/tool.js";
import { truncate, withTimeout } from "./shared.js";

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

/**
 * Runs a program directly (no shell), so arguments are never interpreted as
 * shell syntax: `;`, `|`, `$()` and globs reach the program literally.
 */
export function runCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  return new Promise((done) => {
    const signal = withTimeout(options.signal, options.timeoutMs);
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        signal,
        maxBuffer: 10 * 1024 * 1024,
        ...(options.env && { env: { ...process.env, ...options.env } }),
      },
      (error, stdout, stderr) => {
        const code = (error as (NodeJS.ErrnoException & { code?: unknown }) | null)?.code;
        if (error && code === "ENOENT") {
          done({
            exitCode: null,
            stdout: "",
            stderr: `Command not found: ${command}`,
            timedOut: false,
          });
          return;
        }
        done({
          exitCode: error ? (typeof code === "number" ? code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: signal.aborted && !options.signal?.aborted,
        });
      },
    );
  });
}

export function formatCommandResult(result: CommandResult, maxChars: number): string {
  const parts = [
    result.timedOut ? "Timed out." : `Exit code: ${result.exitCode ?? "unknown"}`,
    result.stdout && `stdout:\n${result.stdout.trimEnd()}`,
    result.stderr && `stderr:\n${result.stderr.trimEnd()}`,
  ].filter(Boolean);
  return truncate(parts.join("\n\n"), maxChars);
}

export interface CommandToolConfig<Schema extends z.ZodType> {
  name: string;
  description: string;
  /** The program to run, e.g. "graft" or "git". */
  command: string;
  parameters: Schema;
  /** Builds the argument list from validated input. */
  args(input: z.output<Schema>): string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputChars?: number;
  env?: Record<string, string | undefined>;
  annotations?: ToolAnnotations;
}

/**
 * A tool that runs one fixed program with arguments derived from the model's
 * input. The safest way to expose a CLI: the model chooses arguments, never
 * the program. Example: a code-search tool over `graft ask <query>`.
 */
export function commandTool<Schema extends z.ZodType>(config: CommandToolConfig<Schema>): Tool {
  const cwd = resolve(config.cwd ?? ".");
  return tool({
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    ...(config.annotations && { annotations: config.annotations }),
    execute: async (input, { signal }) =>
      formatCommandResult(
        await runCommand(config.command, config.args(input), {
          cwd,
          timeoutMs: config.timeoutMs ?? 60_000,
          ...(signal && { signal }),
          ...(config.env && { env: config.env }),
        }),
        config.maxOutputChars ?? 20_000,
      ),
  });
}

export interface ShellToolsOptions {
  /** Programs the model may run, e.g. ["git", "npm", "graft"]. Required: there is no default. */
  allow: string[];
  /** Working directory. Defaults to the current directory. */
  cwd?: string;
  /** Defaults to 60 seconds. */
  timeoutMs?: number;
  /** Defaults to 20 000 characters. */
  maxOutputChars?: number;
}

/**
 * `run_command`: runs an allowlisted program with arguments, without a shell.
 * An allowlisted program can still do anything its arguments allow (`npm run`
 * executes scripts, `git` can rewrite history), so allow only what the agent
 * needs and gate risky calls with a `beforeToolCall` hook.
 */
export function shellTools(options: ShellToolsOptions): Tool[] {
  const allowed = new Set(options.allow);
  if (allowed.size === 0) throw new Error("shellTools: `allow` must list at least one program.");
  const cwd = resolve(options.cwd ?? ".");

  const run = tool({
    name: "run_command",
    description: `Runs a program with arguments (no shell: pipes, redirects and globs are not interpreted). Allowed programs: ${[...allowed].join(", ")}.`,
    parameters: z.object({
      command: z.string().describe("Program name, one of the allowed programs."),
      args: z.array(z.string()).default([]).describe("Arguments, one per element."),
    }),
    annotations: { destructive: true, openWorld: true },
    execute: async ({ command, args }, { signal }) => {
      if (!allowed.has(command)) {
        throw new Error(
          `"${command}" is not allowed. Allowed programs: ${[...allowed].join(", ")}.`,
        );
      }
      const result = await runCommand(command, args, {
        cwd,
        timeoutMs: options.timeoutMs ?? 60_000,
        ...(signal && { signal }),
      });
      return formatCommandResult(result, options.maxOutputChars ?? 20_000);
    },
  });
  return [run];
}
