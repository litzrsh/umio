/**
 * Command-line parsing: argv in, a typed command out. Pure: no I/O, no
 * terminal, so it is shared by `umio …` and the interactive `/graph …`.
 */
import { parseArgs } from "node:util";
import { parseDuration } from "./duration.js";

export interface GlobalOptions {
  readonly config?: string;
  readonly model?: string;
  /** Toolset names from the config; undefined = all of them. */
  readonly tools?: readonly string[];
  /** Approve every tool call without asking. */
  readonly yes: boolean;
  /** Graph checkpoint directory. */
  readonly store?: string;
  readonly json: boolean;
  readonly quiet: boolean;
  /** false with --no-color; undefined = decide from the environment. */
  readonly color?: boolean;
  /** Non-TTY "still running" interval. */
  readonly heartbeatMs: number;
  readonly debug: boolean;
  readonly verbose: boolean;
}

export type RecoverChoice =
  | { readonly type: "retry" }
  | { readonly type: "fail"; readonly reason?: string }
  | { readonly type: "complete"; readonly json?: string; readonly file?: string };

export type Command =
  | { readonly kind: "help"; readonly topic?: string }
  | { readonly kind: "version" }
  | { readonly kind: "chat" }
  | { readonly kind: "ask"; readonly prompt?: string }
  | { readonly kind: "init"; readonly force: boolean; readonly localModel: string }
  | { readonly kind: "doctor"; readonly nodeTimeoutMs: number | null }
  | { readonly kind: "config" }
  | { readonly kind: "models" }
  | { readonly kind: "tools" }
  | {
      readonly kind: "graph-run";
      readonly module: string;
      readonly input?: string;
      readonly inputFile?: string;
      readonly runId?: string;
    }
  | { readonly kind: "graph-status"; readonly runId: string }
  | { readonly kind: "graph-list"; readonly needsRecovery: boolean }
  | { readonly kind: "graph-resume"; readonly module: string; readonly runId: string }
  | {
      readonly kind: "graph-cancel";
      readonly runId: string;
      /** Wait until the run is seen to end, up to `timeoutMs`. */
      readonly wait: boolean;
      readonly timeoutMs: number;
    }
  | {
      readonly kind: "graph-recover";
      readonly module: string;
      readonly runId: string;
      readonly nodeId: string;
      readonly choice: RecoverChoice;
    };

export type ParseResult =
  | { readonly ok: true; readonly command: Command; readonly options: GlobalOptions }
  | { readonly ok: false; readonly error: string; readonly topic?: string };

export const DEFAULT_HEARTBEAT_MS = 5 * 60_000;
export const DEFAULT_LOCAL_MODEL = "llama3.2";
/** Covers the 2 s cancel poll plus the executor's 10 s grace for handlers that ignore aborts. */
export const DEFAULT_CANCEL_WAIT_MS = 30_000;
const THREE_HOURS = 3 * 3_600_000;

const OPTIONS = {
  config: { type: "string", short: "c" },
  model: { type: "string", short: "m" },
  tools: { type: "string" },
  yes: { type: "boolean", short: "y" },
  store: { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  "no-color": { type: "boolean" },
  color: { type: "boolean" },
  heartbeat: { type: "string" },
  debug: { type: "boolean" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  // Command-specific.
  input: { type: "string" },
  "input-file": { type: "string" },
  "run-id": { type: "string" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
  "needs-recovery": { type: "boolean" },
  retry: { type: "boolean" },
  fail: { type: "boolean" },
  reason: { type: "string" },
  complete: { type: "string" },
  "complete-file": { type: "string" },
  force: { type: "boolean" },
  "local-model": { type: "string" },
  "node-timeout": { type: "string" },
} as const;

const GRAPH_SUBCOMMANDS = ["run", "status", "list", "resume", "cancel", "recover"];

export function parseCommandLine(argv: readonly string[]): ParseResult {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    return { ok: false, error: (error as Error).message.replace(/^TypeError[^:]*: /, "") };
  }
  const { values, positionals } = parsed;
  const [name, ...rest] = positionals;

  const heartbeat = values.heartbeat === undefined ? undefined : parseDuration(values.heartbeat);
  if (values.heartbeat !== undefined && (heartbeat === undefined || heartbeat === null)) {
    return { ok: false, error: `Invalid --heartbeat "${values.heartbeat}"; use e.g. 30s or 5m.` };
  }
  const options: GlobalOptions = {
    ...(values.config !== undefined && { config: values.config }),
    ...(values.model !== undefined && { model: values.model }),
    ...(values.tools !== undefined && { tools: splitList(values.tools) }),
    yes: values.yes ?? false,
    ...(values.store !== undefined && { store: values.store }),
    json: values.json ?? false,
    quiet: values.quiet ?? false,
    ...(values["no-color"] ? { color: false } : values.color ? { color: true } : {}),
    heartbeatMs: heartbeat ?? DEFAULT_HEARTBEAT_MS,
    debug: values.debug ?? false,
    verbose: values.verbose ?? false,
  };
  const ok = (command: Command): ParseResult => ({ ok: true, command, options });

  if (values.version) return ok({ kind: "version" });
  if (values.help) return ok({ kind: "help", ...(name && { topic: topicOf(name, rest) }) });
  if (name === "help") return ok({ kind: "help", ...(rest[0] && { topic: rest.join(" ") }) });

  const extra = (count: number, topic: string): ParseResult | undefined =>
    rest.length > count
      ? { ok: false, error: `Unexpected argument "${rest[count]}".`, topic }
      : undefined;

  switch (name) {
    case undefined:
    case "chat":
      return extra(0, "chat") ?? ok({ kind: "chat" });
    case "ask":
      return ok({ kind: "ask", ...(rest.length > 0 && { prompt: rest.join(" ") }) });
    case "init":
      return (
        extra(0, "init") ??
        ok({
          kind: "init",
          force: values.force ?? false,
          localModel: values["local-model"] ?? DEFAULT_LOCAL_MODEL,
        })
      );
    case "doctor": {
      const timeout =
        values["node-timeout"] === undefined ? THREE_HOURS : parseDuration(values["node-timeout"]);
      if (timeout === undefined) {
        return {
          ok: false,
          error: `Invalid --node-timeout "${values["node-timeout"]}"; use e.g. 3h, 12h or none.`,
          topic: "doctor",
        };
      }
      return extra(0, "doctor") ?? ok({ kind: "doctor", nodeTimeoutMs: timeout });
    }
    case "config":
    case "models":
    case "tools":
      return extra(0, name) ?? ok({ kind: name });
    case "graph":
      return parseGraph(rest, values, ok);
    default:
      return {
        ok: false,
        error: `Unknown command "${name}". To send a prompt, use: umio ask "${name}${rest.length ? " …" : ""}"`,
      };
  }
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function parseGraph(
  args: string[],
  values: Values,
  ok: (command: Command) => ParseResult,
): ParseResult {
  const [sub, ...rest] = args;
  const usage = (error: string): ParseResult => ({ ok: false, error, topic: "graph" });
  if (sub === undefined) return usage("Missing graph subcommand.");
  if (!GRAPH_SUBCOMMANDS.includes(sub)) return usage(`Unknown graph subcommand "${sub}".`);
  const need = (names: string[]): string[] | ParseResult => {
    if (rest.length < names.length) {
      return usage(`graph ${sub} needs ${names.map((item) => `<${item}>`).join(" ")}.`);
    }
    if (rest.length > names.length) return usage(`Unexpected argument "${rest[names.length]}".`);
    return rest;
  };
  const failed = (value: string[] | ParseResult): value is ParseResult => !Array.isArray(value);

  switch (sub) {
    case "run": {
      const args = need(["module"]);
      if (failed(args)) return args;
      if (values.input !== undefined && values["input-file"] !== undefined) {
        return usage("Use either --input or --input-file, not both.");
      }
      return ok({
        kind: "graph-run",
        module: args[0] as string,
        ...(values.input !== undefined && { input: values.input }),
        ...(values["input-file"] !== undefined && { inputFile: values["input-file"] }),
        ...(values["run-id"] !== undefined && { runId: values["run-id"] }),
      });
    }
    case "status": {
      const args = need(["run-id"]);
      if (failed(args)) return args;
      return ok({ kind: "graph-status", runId: args[0] as string });
    }
    case "cancel": {
      const args = need(["run-id"]);
      if (failed(args)) return args;
      const timeout =
        values.timeout === undefined ? DEFAULT_CANCEL_WAIT_MS : parseDuration(values.timeout);
      if (timeout === undefined || timeout === null) {
        return usage(`Invalid --timeout "${values.timeout}"; use e.g. 30s or 2m.`);
      }
      return ok({
        kind: "graph-cancel",
        runId: args[0] as string,
        wait: values.wait ?? false,
        timeoutMs: timeout,
      });
    }
    case "list": {
      const args = need([]);
      if (failed(args)) return args;
      return ok({ kind: "graph-list", needsRecovery: values["needs-recovery"] ?? false });
    }
    case "resume": {
      const args = need(["module", "run-id"]);
      if (failed(args)) return args;
      return ok({ kind: "graph-resume", module: args[0] as string, runId: args[1] as string });
    }
    default: {
      const args = need(["module", "run-id", "node-id"]);
      if (failed(args)) return args;
      const choices = [
        values.retry && ({ type: "retry" } as const),
        values.fail && ({ type: "fail", ...(values.reason && { reason: values.reason }) } as const),
        values.complete !== undefined && ({ type: "complete", json: values.complete } as const),
        values["complete-file"] !== undefined &&
          ({ type: "complete", file: values["complete-file"] } as const),
      ].filter((choice) => choice !== false && choice !== undefined) as RecoverChoice[];
      if (choices.length !== 1) {
        return usage(
          "graph recover needs exactly one of --retry, --fail [--reason <text>], --complete <json> or --complete-file <file>. umio never picks one for you.",
        );
      }
      return ok({
        kind: "graph-recover",
        module: args[0] as string,
        runId: args[1] as string,
        nodeId: args[2] as string,
        choice: choices[0] as RecoverChoice,
      });
    }
  }
}

function topicOf(name: string, rest: string[]): string {
  return name === "graph" && rest[0] ? `graph ${rest[0]}` : name;
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Splits an interactive command line into arguments: whitespace separates,
 * single and double quotes group, and a backslash escapes the next character.
 * Returns undefined for an unterminated quote.
 */
export function splitCommandLine(line: string): string[] | undefined {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < line.length) current += line[++index];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "\\" && index + 1 < line.length) {
      current += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) args.push(current);
  return args;
}
