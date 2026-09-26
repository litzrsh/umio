/**
 * Finding, creating and summarizing `umio.config.json` for the CLI. Uses the
 * library's loader, so the CLI accepts exactly what the library accepts.
 */
import { access, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createToolsets } from "../builtin/registry.js";
import { DEFAULT_CONFIG_FILE, loadConfig, resolveProviderConfig } from "../config/load.js";
import type { UmioConfig } from "../config/schema.js";
import { effectiveProviderSettings } from "../llm/local.js";
import { sanitizeConnectionString, sanitizeUrl } from "../secrets.js";
import type { Toolset } from "../tools/toolset.js";
import { formatDuration } from "./duration.js";
import { CliError } from "./explain.js";

export interface LocatedConfig {
  readonly path: string;
  readonly config: UmioConfig;
}

/**
 * `--config`, else `UMIO_CONFIG`, else `umio.config.json` in `cwd` or the
 * nearest parent. Returns the path, or throws with where it looked.
 */
export async function findConfig(
  cwd: string,
  env: Record<string, string | undefined>,
  explicit?: string,
): Promise<string> {
  const given = explicit ?? env.UMIO_CONFIG;
  if (given) {
    const path = resolve(cwd, given);
    if (!(await exists(path))) {
      throw new CliError(`Config file ${path} does not exist.`, {
        hint: `Create it with: umio init${explicit ? ` --config ${given}` : ""}`,
      });
    }
    return path;
  }
  const searched: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const path = join(dir, DEFAULT_CONFIG_FILE);
    searched.push(path);
    if (await exists(path)) return path;
    if (dirname(dir) === dir) break;
  }
  throw new CliError(`No ${DEFAULT_CONFIG_FILE} found.`, {
    hint: `Create one here with \`umio init\` (a local Ollama model), or pass --config <file>. Looked in: ${searched.slice(0, 3).join(", ")}${searched.length > 3 ? ", …" : ""}`,
  });
}

export async function loadCliConfig(
  cwd: string,
  env: Record<string, string | undefined>,
  explicit?: string,
): Promise<LocatedConfig> {
  const path = await findConfig(cwd, env, explicit);
  return { path, config: await loadConfig(path, env) };
}

/** Checks a model alias against the config, with the list of valid ones. */
export function requireModel(config: UmioConfig, alias: string | undefined): string {
  const chosen = alias ?? config.defaultModel;
  const aliases = Object.keys(config.models);
  if (!chosen) {
    throw new CliError("No model selected and the config has no defaultModel.", {
      hint: aliases.length
        ? `Use --model <alias> (configured: ${aliases.join(", ")}), or set "defaultModel".`
        : 'Add a model under "models" (see umio init for an example).',
      exitCode: 2,
    });
  }
  if (!config.models[chosen]) {
    throw new CliError(`Unknown model alias "${chosen}".`, {
      hint: aliases.length
        ? `Configured aliases: ${aliases.join(", ")}.`
        : 'The config has no "models".',
      exitCode: 2,
    });
  }
  return chosen;
}

/** The config's toolsets, optionally restricted to `names` ("none" for no tools; unknown names are an error). */
export function selectToolsets(
  config: UmioConfig,
  names: readonly string[] | undefined,
): Record<string, Toolset> {
  const all = createToolsets(config);
  if (!names) return all;
  if (names.length === 1 && names[0] === "none") return {};
  const unknown = names.filter((name) => !all[name]);
  if (unknown.length > 0) {
    throw new CliError(`Unknown toolset${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`, {
      hint: Object.keys(all).length
        ? `Configured toolsets: ${Object.keys(all).join(", ")}.`
        : 'The config has no "tools" section.',
      exitCode: 2,
    });
  }
  return Object.fromEntries(names.map((name) => [name, all[name] as Toolset]));
}

/** A starter config for one local Ollama model, sized for long local runs. */
export function starterConfig(localModel: string): object {
  return {
    $schema: "./node_modules/umio/schema/umio.config.schema.json",
    defaultModel: "local",
    providers: {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a config env reference, not a template
      ollama: { type: "ollama", baseURL: "${OLLAMA_BASE_URL:-http://localhost:11434/v1}" },
    },
    models: {
      local: { provider: "ollama", model: localModel },
    },
    tools: {
      repo: { use: "files", root: ".", readOnly: true },
      misc: { use: "utilities" },
    },
    graph: { maxConcurrency: 1 },
  };
}

export async function writeStarterConfig(
  path: string,
  localModel: string,
  force: boolean,
): Promise<void> {
  if (!force && (await exists(path))) {
    throw new CliError(`${path} already exists.`, {
      hint: "Check it with `umio doctor`, or overwrite it with `umio init --force`.",
    });
  }
  await writeFile(path, `${JSON.stringify(starterConfig(localModel), null, 2)}\n`);
}

export interface ModelSummary {
  readonly alias: string;
  readonly provider: string;
  readonly providerType: string | undefined;
  readonly model: string;
  readonly local: boolean | undefined;
  /** Per-request limit, when known. */
  readonly timeoutMs: number | undefined;
  readonly isDefault: boolean;
}

export function summarizeModels(
  config: UmioConfig,
  env: Record<string, string | undefined>,
): ModelSummary[] {
  return Object.entries(config.models).map(([alias, model]) => {
    const raw = config.providers[model.provider];
    let local: boolean | undefined;
    let timeoutMs: number | undefined;
    try {
      if (raw) {
        const settings = effectiveProviderSettings(resolveProviderConfig(model.provider, raw, env));
        local = settings.local;
        timeoutMs = settings.timeoutMs;
      }
    } catch {
      // Unresolvable here (e.g. a missing variable); doctor reports it.
    }
    return {
      alias,
      provider: model.provider,
      providerType: raw?.type,
      model: model.model,
      local,
      timeoutMs,
      isDefault: alias === config.defaultModel,
    };
  });
}

export function describeModel(summary: ModelSummary): string {
  const where = summary.local === undefined ? "" : summary.local ? ", local" : ", remote";
  const timeout = summary.timeoutMs ? `, request timeout ${formatDuration(summary.timeoutMs)}` : "";
  const type =
    summary.providerType && summary.providerType !== summary.provider
      ? `/${summary.providerType}`
      : "";
  return `${summary.alias} → ${summary.model} (${summary.provider}${type}${where}${timeout})`;
}

/**
 * The config with secrets masked, for display: literal values of secret-named
 * keys, connection strings (password and credential parameters, or the whole
 * string if it cannot be parsed), and credentials inside any URL value.
 * `${VAR}` references (unresolved provider fields) are shown as written.
 */
export function maskedConfig(config: UmioConfig): unknown {
  const mask = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      if (/^\$\{[^}]+\}$/.test(value)) return value;
      if (/key|token|secret|password/i.test(key)) return "••••";
      if (/connection(string|uri|url)|^dsn$/i.test(key)) return sanitizeConnectionString(value);
      return sanitizeUrl(value) ?? value;
    }
    if (Array.isArray(value)) return value.map((item) => mask(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, mask(item, name)]),
      );
    }
    return value;
  };
  return mask(config);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
