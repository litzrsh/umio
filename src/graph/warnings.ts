import { resolveProviderConfig } from "../config/load.js";
import type { UmioConfig } from "../config/schema.js";
import { effectiveProviderSettings } from "../llm/local.js";

/** Warnings already emitted in this process; each is shown once. */
const emitted = new Set<string>();

/**
 * Local providers (of the given model aliases, or of every model) whose
 * request or header timeout would end a model call before a node timeout of
 * `nodeTimeoutMs` does (plan D12). The node timeout should govern long local
 * calls; provider limits are only a backstop above it.
 */
export function shortProviderTimeouts(
  config: Pick<UmioConfig, "models" | "providers">,
  nodeTimeoutMs: number | null,
  aliases: readonly string[] = Object.keys(config.models),
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (nodeTimeoutMs === null) return [];
  const providers = new Set(aliases.map((alias) => config.models[alias]?.provider));
  const warnings: string[] = [];
  for (const name of providers) {
    const raw = name !== undefined ? config.providers[name] : undefined;
    if (!name || !raw) continue;
    let settings: ReturnType<typeof effectiveProviderSettings>;
    try {
      settings = effectiveProviderSettings(resolveProviderConfig(name, raw, env));
    } catch {
      continue; // Unresolvable here (e.g. a missing variable); the call itself will report it.
    }
    if (!settings.local) continue;
    // Header timeouts default to the request timeout; report whichever ends a call first.
    const { timeoutMs } = settings;
    const headers = settings.transport?.headersTimeoutMs;
    const [field, limit] =
      headers !== undefined && (timeoutMs === undefined || headers < timeoutMs)
        ? ["transport.headersTimeoutMs", headers]
        : ["timeoutMs", timeoutMs];
    if (limit !== undefined && limit < nodeTimeoutMs) {
      warnings.push(
        `umio: local provider "${name}" has ${field} ${limit} ms, below the graph node timeout of ${nodeTimeoutMs} ms; long model calls will fail at the provider before the node times out.`,
      );
    }
  }
  return warnings;
}

/** Emits each warning once per process as a Node.js process warning. */
export function emitWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    if (emitted.has(warning)) continue;
    emitted.add(warning);
    process.emitWarning(warning, { code: "UMIO_PROVIDER_TIMEOUT_BELOW_NODE_TIMEOUT" });
  }
}
