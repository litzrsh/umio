import { isIP } from "node:net";
import type { ProviderConfig } from "../config/schema.js";
import { isInternalAddress } from "../net.js";

/**
 * Local defaults are sized for multi-hour inference on modest hardware. The
 * request timeout sits just above the 3-hour graph node timeout, so the node
 * timeout, not the HTTP layer, is what ends a long call.
 */
export const LOCAL_TIMEOUT_MS = 11_100_000; // 3 h 5 min

export interface EffectiveProviderSettings {
  local: boolean;
  /** Undefined means the SDK default. */
  timeoutMs: number | undefined;
  maxRetries: number | undefined;
  /** Undefined means undici's defaults (no custom dispatcher). */
  transport:
    | { headersTimeoutMs: number | undefined; bodyTimeoutMs: number | undefined }
    | undefined;
  /** Infinity means unlimited. */
  maxConcurrentRequests: number;
}

/**
 * Whether a provider talks to a local server. An explicit `local` always wins.
 * Otherwise `ollama` is local, and `openai-compatible` is local when its baseURL
 * host is localhost or a loopback/private/link-local IP literal (no DNS lookup:
 * classification must not depend on network state). Hosted gateways such as
 * OpenRouter or Groq configured as `openai-compatible` are therefore not local.
 */
export function isLocalProvider(config: ProviderConfig): boolean {
  if (config.local !== undefined) return config.local;
  switch (config.type) {
    case "ollama":
      return true;
    case "openai-compatible":
      return isLocalHost(config.baseURL);
    default:
      return false;
  }
}

export function isLocalHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return isIP(host) !== 0 && isInternalAddress(host);
}

/** Resolves the settings an adapter should use: explicit config first, then local defaults. */
export function effectiveProviderSettings(config: ProviderConfig): EffectiveProviderSettings {
  const local = isLocalProvider(config);
  const timeoutMs = config.timeoutMs ?? (local ? LOCAL_TIMEOUT_MS : undefined);
  const headersTimeoutMs = config.transport?.headersTimeoutMs ?? (local ? timeoutMs : undefined);
  const bodyTimeoutMs = config.transport?.bodyTimeoutMs ?? (local ? timeoutMs : undefined);
  return {
    local,
    timeoutMs,
    maxRetries: config.maxRetries ?? (local ? 0 : undefined),
    transport:
      headersTimeoutMs !== undefined || bodyTimeoutMs !== undefined
        ? { headersTimeoutMs, bodyTimeoutMs }
        : undefined,
    maxConcurrentRequests: config.maxConcurrentRequests ?? (local ? 1 : Number.POSITIVE_INFINITY),
  };
}
