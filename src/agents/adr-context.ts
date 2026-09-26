import { type Adr, AdrStore, DEFAULT_ADR_STATUSES } from "../adr/store.js";
import { adrTools } from "../adr/tools.js";
import { LLM } from "../llm/client.js";
import type { ModelClient } from "../llm/types.js";
import type { Tool } from "../tools/tool.js";

export interface AdrWorkflowOptions {
  store: AdrStore;
  /** Statuses given to agents as binding context. Defaults to ["Accepted"]. */
  include?: string[];
  /** Give every agent list/read/propose ADR tools. Defaults to true. */
  tools?: boolean;
}

/**
 * Resolves a workflow's ADR option: an explicit store or options object, `false`
 * to disable, or, when omitted, the config's `adr` section if `llm` is an `LLM`.
 */
export function resolveAdrOptions(
  adr: AdrStore | AdrWorkflowOptions | false | undefined,
  llm: ModelClient,
): AdrWorkflowOptions | undefined {
  if (adr === false) return undefined;
  if (adr instanceof AdrStore) return { store: adr };
  if (adr) return adr;
  const configured = llm instanceof LLM ? llm.config.adr : undefined;
  if (!configured) return undefined;
  return {
    store: new AdrStore(configured.path),
    ...(configured.include && { include: configured.include }),
    ...(configured.tools !== undefined && { tools: configured.tools }),
  };
}

/** The binding ADR text, loaded once per run so every agent sees identical (cacheable) context. */
export function loadAdrContext(adr: AdrWorkflowOptions | undefined): Promise<string | undefined> {
  return adr ? adr.store.context(adr.include ?? DEFAULT_ADR_STATUSES) : Promise.resolve(undefined);
}

/** ADR tools for one agent run, or none when ADRs or their tools are disabled. */
export function adrToolsFor(
  adr: AdrWorkflowOptions | undefined,
  onPropose: (adr: Adr) => void | Promise<void>,
): Tool[] {
  return adr && adr.tools !== false ? adrTools(adr.store, { onPropose }) : [];
}
