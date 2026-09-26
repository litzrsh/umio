/**
 * Adapter from the config's `skills` section and the `--skill`/`--no-skills`
 * flags to a `SkillBinding`. The catalog is loaded once per command (per
 * session for chat) and prepared afresh for each turn by `runChatTurn`.
 */
import type { UmioConfig } from "../config/schema.js";
import type { SkillBinding } from "../skills/agent.js";
import { skillsFromConfig } from "../skills/config.js";
import type { GlobalOptions } from "./args.js";
import { CliError } from "./explain.js";

/**
 * The binding for an `ask` or chat invocation, or undefined with
 * `--no-skills` or no `skills` section. `--skill` replaces the configured
 * activation but may only name permitted (`include`d) skills.
 */
export async function cliSkills(
  config: UmioConfig,
  options: Pick<GlobalOptions, "skills" | "noSkills">,
): Promise<SkillBinding | undefined> {
  if (options.noSkills) return undefined;
  if (options.skills && !config.skills) {
    throw new CliError("--skill needs a skills section in the config.", {
      hint: 'Add "skills": { "roots": ["./skills"], "include": ["<name>"] } (see umio help skills).',
      exitCode: 2,
    });
  }
  const outside = (options.skills ?? []).filter((name) => !config.skills?.include.includes(name));
  if (outside.length > 0) {
    throw new CliError(
      `--skill ${outside.join(", ")}: not permitted by skills.include in the config.`,
      {
        hint: `Permitted: ${config.skills?.include.join(", ") || "(none)"}. A flag can choose among them but never add skills.`,
        exitCode: 2,
      },
    );
  }
  const binding = await skillsFromConfig(config, {
    ...(options.skills && { activate: [...new Set(options.skills)] }),
  });
  if (binding && binding.catalog.diagnostics.length > 0) {
    throw new CliError(
      `The skills configuration has problems:\n${binding.catalog.diagnostics
        .map((item) => `  - ${item.path}${item.field ? ` (${item.field})` : ""}: ${item.message}`)
        .join("\n")}`,
      { hint: "Fix them (see umio skills list), or run with --no-skills." },
    );
  }
  return binding;
}
