/**
 * Turns errors into one actionable message and hint, without dumping internal
 * objects. `--debug` shows the full cause chain instead.
 */
import { ConfigError, LLMError, UmioError } from "../errors.js";
import {
  CheckpointStoreLockedError,
  DefinitionMismatchError,
  GraphValidationError,
  LeaseLostError,
  LeaseUnavailableError,
  RecoveryNotApplicableError,
  RunNotFoundError,
  RunNotResumableError,
} from "../graph/errors.js";

/** An error raised by the CLI itself, with the hint and exit code to use. */
export class CliError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(
    message: string,
    options: { hint?: string; exitCode?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CliError";
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

export interface Explanation {
  readonly message: string;
  readonly hint?: string;
}

export function explain(error: unknown): Explanation {
  if (error instanceof CliError) return withHint(error.message, error.hint);
  if (error instanceof LLMError) return explainLLM(error);
  if (error instanceof ConfigError) {
    const alias = /Unknown model alias "([^"]+)"/.exec(error.message);
    if (alias) {
      return withHint(
        error.message,
        'Pick one with --model <alias>, or add it under "models" in the config (see umio models).',
      );
    }
    const variable = /Environment variable (\w+) is not set/.exec(error.message);
    if (variable) {
      return withHint(
        error.message,
        `Set ${variable[1]} in your environment (or give the variable a default: \${${variable[1]}:-value}).`,
      );
    }
    return withHint(error.message, "Fix the config file, then check it with: umio doctor");
  }
  if (error instanceof CheckpointStoreLockedError) {
    return withHint(
      error.message,
      "The file checkpoint store is single-process. Wait for the other umio process to finish, or cancel it with Ctrl+C in its terminal. `umio graph status <run-id>` works meanwhile.",
    );
  }
  if (error instanceof LeaseUnavailableError) {
    return withHint(
      error.message,
      "The run is still owned. If its process died, retry after the lease expires (about 30 s).",
    );
  }
  if (error instanceof DefinitionMismatchError) {
    return withHint(
      error.message,
      "The workflow module changed since the run started. Resume with the version that started it, or start a new run.",
    );
  }
  if (error instanceof RunNotFoundError) {
    return withHint(error.message, "List runs with: umio graph list (check --store / --config).");
  }
  if (error instanceof RunNotResumableError) {
    return withHint(error.message, "Inspect it with: umio graph status <run-id>");
  }
  if (error instanceof RecoveryNotApplicableError) {
    return withHint(error.message, "See the node's state with: umio graph status <run-id>");
  }
  if (error instanceof LeaseLostError) {
    return withHint(
      error.message,
      "Another executor took over this run (or this process stalled for over 20 s). Nothing more was written; inspect it with umio graph status.",
    );
  }
  if (error instanceof GraphValidationError) {
    return withHint(error.message, "Fix the workflow definition in the module.");
  }
  if (error instanceof UmioError) return { message: error.message };
  const code = errorCode(error);
  if (code === "ENOENT") return withHint(firstLine(error), "Check the path.");
  return { message: firstLine(error) };
}

function explainLLM(error: LLMError): Explanation {
  const code = errorCode(error);
  const message = error.message;
  if (message === "Request aborted.") return { message: "Cancelled." };
  if (
    /timed out|timeout/i.test(message) ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT"
  ) {
    return withHint(
      `The ${error.provider} request timed out.`,
      "A provider limit ended the call: raise timeoutMs (and transport.headersTimeoutMs / bodyTimeoutMs) for this provider. Local providers default to 3 h 5 min per request. Check with: umio doctor",
    );
  }
  if (message.startsWith("Cannot connect") || code === "ECONNREFUSED" || code === "ENOTFOUND") {
    return withHint(
      `Cannot reach the ${error.provider} server.`,
      "Is it running? For Ollama: `ollama serve`; for LM Studio: start its local server. Then check the provider's baseURL with: umio doctor",
    );
  }
  if (error.status === 401 || error.status === 403) {
    return withHint(
      `${error.provider} rejected the credentials (HTTP ${error.status}).`,
      "Check the provider's API key variable.",
    );
  }
  if (error.status === 404) {
    return withHint(
      message,
      "The model name may not exist on this server (for Ollama: `ollama pull <model>`).",
    );
  }
  if (error.status === 429) return withHint(message, "Rate limited; wait and try again.");
  return { message: `${error.provider}: ${message}` };
}

/** The `code` of the error or of any error in its cause chain. */
export function errorCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Message, cause chain and stack, for --debug. */
export function debugDetails(error: unknown): string {
  const lines: string[] = [];
  for (let current = error, depth = 0; current !== undefined && depth < 8; depth++) {
    lines.push(
      depth === 0 ? "" : "caused by:",
      current instanceof Error ? (current.stack ?? current.message) : String(current),
    );
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return lines.filter(Boolean).join("\n");
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}

function withHint(message: string, hint: string | undefined): Explanation {
  return hint ? { message, hint } : { message };
}
