/**
 * `umio doctor`: checks the config the way a run would use it, without
 * calling any paid API. Local servers are probed with a short GET of their
 * model list; cloud providers only have their credentials resolved.
 */
import { loadConfig, resolveProviderConfig } from "../config/load.js";
import type { ProviderConfig, UmioConfig } from "../config/schema.js";
import { shortProviderTimeouts } from "../graph/warnings.js";
import { effectiveProviderSettings } from "../llm/local.js";
import { OLLAMA_DEFAULT_BASE_URL } from "../llm/providers/index.js";
import { findConfig } from "./config.js";
import { formatDuration } from "./duration.js";
import { explain } from "./explain.js";

export interface Check {
  readonly status: "ok" | "warn" | "error";
  readonly title: string;
  readonly hint?: string;
}

export interface DoctorOptions {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly config?: string;
  readonly model?: string;
  /** The longest a single node attempt (or request) is meant to run; null = unlimited. */
  readonly nodeTimeoutMs: number | null;
  readonly fetch?: typeof fetch;
  readonly probeTimeoutMs?: number;
}

export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  let path: string;
  try {
    path = await findConfig(options.cwd, options.env, options.config);
  } catch (error) {
    return [{ status: "error", ...explainAsCheck(error) }];
  }
  let config: UmioConfig;
  try {
    config = await loadConfig(path, options.env);
    checks.push({ status: "ok", title: `Config ${path} is valid.` });
  } catch (error) {
    return [{ status: "error", ...explainAsCheck(error) }];
  }

  // Models and aliases.
  const aliases = Object.keys(config.models);
  const selected = options.model ?? config.defaultModel;
  if (aliases.length === 0) {
    checks.push({
      status: "error",
      title: 'The config has no "models".',
      hint: "Run umio init for an example.",
    });
  } else if (!selected) {
    checks.push({
      status: "warn",
      title: "No defaultModel; every command needs --model.",
      hint: `Set "defaultModel" to one of: ${aliases.join(", ")}.`,
    });
  } else if (!config.models[selected]) {
    checks.push({
      status: "error",
      title: `Model alias "${selected}" is not configured.`,
      hint: `Configured aliases: ${aliases.join(", ")}.`,
    });
  } else {
    checks.push({
      status: "ok",
      title: `Model "${selected}" → ${config.models[selected]?.model}.`,
    });
  }
  for (const [alias, model] of Object.entries(config.models)) {
    if (!config.providers[model.provider]) {
      checks.push({
        status: "error",
        title: `Model "${alias}" uses provider "${model.provider}", which is not configured.`,
        hint: `Configured providers: ${Object.keys(config.providers).join(", ") || "none"}.`,
      });
    }
  }

  // Providers: only those some model uses.
  const used = new Set(Object.values(config.models).map((model) => model.provider));
  for (const name of used) {
    const raw = config.providers[name];
    if (!raw) continue;
    let provider: ProviderConfig;
    try {
      provider = resolveProviderConfig(name, raw, options.env);
    } catch (error) {
      // Only the selected model's provider must work now; the others matter when used.
      const users = Object.entries(config.models)
        .filter(([, model]) => model.provider === name)
        .map(([alias]) => alias);
      const needed = selected !== undefined && config.models[selected]?.provider === name;
      const { title, hint } = explainAsCheck(error);
      checks.push({
        status: needed ? "error" : "warn",
        title: needed ? title : `${title} Needed only for: ${users.join(", ")}.`,
        ...(hint && { hint }),
      });
      continue;
    }
    const settings = effectiveProviderSettings(provider);
    if (settings.local) {
      checks.push(await probeLocal(name, provider, config, options));
    } else {
      checks.push({
        status: "ok",
        title: `Provider "${name}" (${provider.type}) has its credentials; not contacted.`,
      });
    }
  }

  // Time limits.
  const intended = options.nodeTimeoutMs;
  const short = shortProviderTimeouts(config, intended, aliases, options.env);
  if (intended !== null) {
    for (const message of short) {
      checks.push({
        status: "warn",
        title: message.replace(/^umio: /, ""),
        hint: `Provider limits apply to ONE request; the node timeout covers a whole agent attempt (many requests and tool calls). Raise the provider's timeoutMs / transport timeouts only if a single request can take ${formatDuration(intended)}; otherwise this is expected.`,
      });
    }
  }
  const graphTimeout = config.graph?.nodeTimeoutMs;
  checks.push({
    status: "ok",
    title: `Graph node timeout: ${graphTimeout === null ? "none" : formatDuration(graphTimeout ?? 3 * 3_600_000)} per node attempt (covers every model call and tool call of an agent node).`,
  });
  if (short.length === 0 && intended !== null) {
    checks.push({
      status: "ok",
      title: `No local provider ends a request before ${formatDuration(intended)}.`,
    });
  }
  return checks;
}

async function probeLocal(
  name: string,
  provider: ProviderConfig,
  config: UmioConfig,
  options: DoctorOptions,
): Promise<Check> {
  const base = (
    ("baseURL" in provider && provider.baseURL) ||
    (provider.type === "ollama" ? OLLAMA_DEFAULT_BASE_URL : "")
  ).replace(/\/+$/, "");
  if (!base) {
    return { status: "warn", title: `Local provider "${name}" has no baseURL to probe.` };
  }
  const doFetch = options.fetch ?? fetch;
  let ids: string[] = [];
  try {
    const response = await doFetch(`${base}/models`, {
      signal: AbortSignal.timeout(options.probeTimeoutMs ?? 3_000),
    });
    if (!response.ok) {
      return {
        status: "warn",
        title: `Local provider "${name}" at ${base} answered HTTP ${response.status} for /models.`,
        hint: "Check that baseURL points at the server's OpenAI-compatible API (usually ending in /v1).",
      };
    }
    const body = (await response.json().catch(() => ({}))) as { data?: { id?: string }[] };
    ids = (body.data ?? []).map((item) => item.id ?? "").filter(Boolean);
  } catch {
    return {
      status: "error",
      title: `Local provider "${name}" is not reachable at ${base}.`,
      hint:
        provider.type === "ollama"
          ? "Start it with `ollama serve` (or set OLLAMA_BASE_URL)."
          : "Start the local server (e.g. LM Studio's server, vLLM, llama.cpp) or fix baseURL.",
    };
  }
  const wanted = Object.values(config.models)
    .filter((model) => model.provider === name)
    .map((model) => model.model);
  const missing = ids.length
    ? wanted.filter((id) => !ids.includes(id) && !ids.includes(`${id}:latest`))
    : [];
  if (missing.length > 0) {
    return {
      status: "warn",
      title: `Local provider "${name}" is up, but does not list: ${missing.join(", ")}.`,
      hint:
        provider.type === "ollama"
          ? `Pull it: ollama pull ${missing[0]}`
          : `Available: ${ids.slice(0, 8).join(", ")}`,
    };
  }
  return { status: "ok", title: `Local provider "${name}" is reachable at ${base}.` };
}

function explainAsCheck(error: unknown): { title: string; hint?: string } {
  const { message, hint } = explain(error);
  return hint ? { title: message, hint } : { title: message };
}
