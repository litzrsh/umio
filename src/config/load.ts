import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { z } from "zod";
import { ConfigError } from "../errors.js";
import {
  type ProviderConfig,
  ProviderConfigSchema,
  type UmioConfig,
  UmioConfigSchema,
} from "./schema.js";

export const DEFAULT_CONFIG_FILE = "umio.config.json";

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces `${VAR}` and `${VAR:-fallback}` in every string value, so secrets
 * such as API keys stay in the environment instead of the JSON file.
 */
export function interpolateEnv(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
  path = "",
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (_match, name: string, fallback: string | undefined) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== "") return resolved;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(
        `Environment variable ${name} is not set (referenced at ${path || "<root>"}).`,
      );
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => interpolateEnv(item, env, `${path}[${i}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolateEnv(item, env, path ? `${path}.${key}` : key),
      ]),
    );
  }
  return value;
}

/**
 * Validates a config object (already parsed from JSON) and resolves env references.
 * References inside `providers` are left as-is and resolved by
 * {@link resolveProviderConfig} when the provider is first used, so a missing
 * API key only matters for providers that are actually called.
 */
export function parseConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): UmioConfig {
  let input = raw;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const { providers, ...rest } = raw as Record<string, unknown>;
    input = { ...(interpolateEnv(rest, env) as object), providers };
  }
  return validate(UmioConfigSchema, input, "Invalid umio config");
}

/** Resolves env references in one provider's config and re-validates it. */
export function resolveProviderConfig(
  name: string,
  config: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): ProviderConfig {
  return validate(
    ProviderConfigSchema,
    interpolateEnv(config, env, `providers.${name}`),
    `Invalid config for provider "${name}"`,
  );
}

function validate<T>(schema: z.ZodType<T>, input: unknown, title: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("\n");
    throw new ConfigError(`${title}:\n${issues}`);
  }
  return result.data;
}

/** Reads and validates a JSON config file. Defaults to `umio.config.json` in the working directory. */
export async function loadConfig(
  file: string = DEFAULT_CONFIG_FILE,
  env: Record<string, string | undefined> = process.env,
): Promise<UmioConfig> {
  const path = resolve(file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new ConfigError(`Cannot read config file ${path}.`, { cause });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`Config file ${path} is not valid JSON.`, { cause });
  }
  const config = parseConfig(raw, env);
  // File paths belong to the project that owns the config, not to the working directory.
  if (config.responseCache?.store === "file") {
    config.responseCache.path = resolve(dirname(path), config.responseCache.path);
  }
  if (config.adr) config.adr.path = resolve(dirname(path), config.adr.path);
  return { ...config, configDir: dirname(path) };
}
