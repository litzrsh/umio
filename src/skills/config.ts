import { isAbsolute } from "node:path";
import type { UmioConfig } from "../config/schema.js";
import type { SkillBinding } from "./agent.js";
import { loadSkillCatalog } from "./catalog.js";
import { SkillError } from "./errors.js";
import type { SkillEvent, SkillSelection } from "./types.js";

/**
 * Loads the config's `skills` section as a binding: a catalog of its roots
 * (relative to the config file's directory) and its selection. Undefined when
 * the config has no `skills` section. `selection` replaces the configured
 * activation (e.g. from a CLI flag) but can never permit more than `include`.
 */
export async function skillsFromConfig(
  config: Pick<UmioConfig, "skills" | "configDir">,
  options: {
    /** Base for relative roots when the config was not loaded from a file. */
    baseDir?: string;
    /** Replaces `activate`; every name must be in the configured `include`. */
    activate?: readonly string[];
    signal?: AbortSignal;
    onEvent?: (event: SkillEvent) => void;
  } = {},
): Promise<SkillBinding | undefined> {
  const section = config.skills;
  if (!section) return undefined;
  const baseDir = config.configDir ?? options.baseDir;
  if (!baseDir && section.roots.some((root) => !isAbsolute(root))) {
    throw new SkillError(
      "skills.roots has relative paths but the config has no directory; load it with loadConfig or pass baseDir.",
    );
  }
  const catalog = await loadSkillCatalog({
    roots: section.roots,
    baseDir: baseDir ?? "/",
    ...(section.limits && { limits: section.limits }),
    ...(options.signal && { signal: options.signal }),
  });
  const selection: SkillSelection = {
    include: section.include,
    activate: options.activate ?? section.activate ?? [],
    ...(section.allowModelSelection !== undefined && {
      allowModelSelection: section.allowModelSelection,
    }),
  };
  return { catalog, selection, ...(options.onEvent && { onEvent: options.onEvent }) };
}
