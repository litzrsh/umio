import { Agent } from "undici";
import type { EffectiveProviderSettings } from "./local.js";

/**
 * Node's fetch (undici) enforces its own idle timeouts (300 s to headers and
 * between body chunks by default), independently of the SDK's request timeout.
 * A local server answering a non-streaming request sends headers only when
 * generation finishes, so a long call would fail there first. When transport
 * timeouts are configured (always for local providers), requests go through a
 * dedicated undici Agent carrying them; the SDKs pass it on as `dispatcher`.
 */
export function transportFetchOptions(
  settings: EffectiveProviderSettings,
): { dispatcher: Agent } | undefined {
  const { transport } = settings;
  if (!transport) return undefined;
  return {
    dispatcher: new Agent({
      ...(transport.headersTimeoutMs !== undefined && {
        headersTimeout: transport.headersTimeoutMs,
      }),
      ...(transport.bodyTimeoutMs !== undefined && { bodyTimeout: transport.bodyTimeoutMs }),
    }),
  };
}
