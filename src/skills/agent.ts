/**
 * Composing skills into an agent run without new `Agent` fields: the prepared
 * context goes after the caller's context (ADRs), the reading tools after the
 * caller's extra tools. Hooks, cancellation, state and events are untouched.
 */
import type { Agent, AgentRunOptions } from "../agents/agent.js";
import { SkillError } from "./errors.js";
import { SKILL_TOOL_NAMES } from "./prepare.js";
import type { PreparedSkills, SkillCatalog, SkillEvent, SkillSelection } from "./types.js";

/** A catalog and what one agent (or workflow step, or graph node) may use of it. */
export interface SkillBinding {
  readonly catalog: SkillCatalog;
  readonly selection: SkillSelection;
  /** Diagnostics for preparations and reads; failures here never change the run. */
  readonly onEvent?: (event: SkillEvent) => void;
}

/**
 * Prepares `binding` for one run of `agent` and returns `options` with the
 * skill context and tools added. Without a binding, returns `options`
 * unchanged. Rejects before any model call for an invalid catalog or
 * selection, a limit, or an agent tool that uses a reserved skill tool name.
 */
export async function withSkills(
  agent: Agent,
  options: AgentRunOptions,
  binding: SkillBinding | undefined,
): Promise<{ options: AgentRunOptions; prepared?: PreparedSkills }> {
  if (!binding) return { options };
  const extraTools = [...(options.extraTools ?? [])];
  for (const tool of [...agent.tools, ...extraTools]) {
    if ((SKILL_TOOL_NAMES as readonly string[]).includes(tool.name)) {
      throw new SkillError(
        `Tool name "${tool.name}" is reserved for skills; rename that tool of agent "${agent.name}".`,
      );
    }
  }
  const prepared = await binding.catalog.prepare(binding.selection, {
    ...(options.signal && { signal: options.signal }),
    ...(binding.onEvent && { onEvent: binding.onEvent }),
  });
  return {
    options: {
      ...options,
      ...((options.context?.length || prepared.context.length) && {
        context: [...(options.context ?? []), ...prepared.context],
      }),
      extraTools: [...extraTools, ...prepared.tools],
    },
    prepared,
  };
}
