/**
 * One invocation's skills: the system-prompt text for activated skills (and
 * summaries when the model may choose), and the `skills_load` / `skills_read`
 * tools with their own activation set, read budget and usage record, never
 * shared with another invocation.
 */
import { z } from "zod";
import { type Tool, tool } from "../tools/tool.js";
import type { CatalogAccess } from "./catalog.js";
import {
  SkillCatalogError,
  SkillChangedError,
  SkillError,
  SkillLimitError,
  SkillSelectionError,
} from "./errors.js";
import { readBounded, resolveResource, sha256 } from "./files.js";
import { decodeText } from "./parse.js";
import type {
  LoadedSkill,
  PreparedSkills,
  PrepareOptions,
  SkillDiagnostic,
  SkillEvent,
  SkillSelection,
  SkillUsage,
} from "./types.js";

/** Tool names reserved for skills; an agent's own tools must not use them. */
export const SKILL_TOOL_NAMES = ["skills_load", "skills_read"] as const;

export async function prepareSkills(
  catalog: CatalogAccess,
  diagnostics: readonly SkillDiagnostic[],
  selection: SkillSelection,
  options: PrepareOptions,
): Promise<PreparedSkills> {
  if (diagnostics.length > 0) throw new SkillCatalogError(diagnostics);
  const { signal } = options;
  const include = names(selection?.include, "include");
  const activate = names(selection?.activate ?? [], "activate");
  const unknown = include.filter((name) => !catalog.has(name));
  if (unknown.length > 0) {
    const available = catalog.names();
    throw new SkillSelectionError(
      `Unknown skill${unknown.length === 1 ? "" : "s"} ${unknown.map((name) => `"${name}"`).join(", ")}. ${available.length ? `Available: ${available.join(", ")}.` : "The catalog has no skills."}`,
    );
  }
  const outside = activate.filter((name) => !include.includes(name));
  if (outside.length > 0) {
    throw new SkillSelectionError(
      `Cannot activate ${outside.map((name) => `"${name}"`).join(", ")}: not in the selection's include list.`,
    );
  }
  const modelSelection = selection.allowModelSelection === true && include.length > 0;

  const emit = (event: SkillEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Diagnostics never change the invocation.
    }
  };

  // Per-invocation state.
  const active = new Map<string, string>(); // name → document digest
  const resources = new Map<string, Map<string, string>>(); // name → path → digest
  let readBytes = 0;
  const reserve = (bytes: number, what: string) => {
    if (readBytes + bytes > catalog.limits.maxReadBytes) {
      throw new SkillLimitError(
        `Reading ${what} (${bytes} bytes) would exceed this invocation's skill read budget (maxReadBytes ${catalog.limits.maxReadBytes}; ${readBytes} used). Work with what you have already read.`,
      );
    }
    readBytes += bytes;
  };
  const activateSkill = (skill: LoadedSkill) => {
    const known = active.get(skill.name);
    if (known !== undefined && known !== skill.digest) {
      throw new SkillChangedError(`Skill "${skill.name}" changed during this invocation.`);
    }
    active.set(skill.name, skill.digest);
    if (!resources.has(skill.name)) resources.set(skill.name, new Map());
  };

  const loaded: LoadedSkill[] = [];
  for (const name of activate) {
    signal?.throwIfAborted();
    const { skill } = await catalog.read(name, signal);
    loaded.push(skill);
  }
  signal?.throwIfAborted();

  const context: string[] = [];
  if (loaded.length > 0 || modelSelection) {
    const text = renderContext(
      loaded,
      modelSelection
        ? include
            .filter((name) => !activate.includes(name))
            .map((name) => catalog.summary(name))
            .filter((item) => item !== undefined)
        : [],
    );
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > catalog.limits.maxContextBytes) {
      throw new SkillLimitError(
        `The selected skills need ${bytes} bytes of system prompt; the limit is ${catalog.limits.maxContextBytes} (maxContextBytes). Activate fewer skills, or let the model load them with allowModelSelection.`,
      );
    }
    context.push(text);
  }
  for (const skill of loaded) activateSkill(skill);
  emit({
    type: "skills-prepared",
    include,
    activated: loaded.map((skill) => ({ name: skill.name, digest: skill.digest })),
    modelSelection,
    contextBytes: context.reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0),
  });

  const permitted = (name: string) => {
    if (!include.includes(name)) {
      throw new SkillError(
        `Skill "${name}" is not available here.${include.length ? ` Available: ${include.join(", ")}.` : ""}`,
      );
    }
  };

  const tools: Tool[] = [];
  if (modelSelection) {
    tools.push(
      tool({
        name: "skills_load",
        description:
          "Loads the instructions of one available skill (listed in the system prompt under Skills). Load a skill only when it is relevant to the task; afterwards follow it and read its files with skills_read.",
        parameters: z.object({
          name: z.string().describe("The skill's name, exactly as listed."),
        }),
        annotations: { readOnly: true, idempotent: true },
        execute: async ({ name }, toolContext) => {
          try {
            permitted(name);
            const invocationSignal = toolContext.signal ?? signal;
            const { skill, bytes } = await catalog.read(name, invocationSignal);
            reserve(Buffer.byteLength(skill.body, "utf8"), `skill "${name}"`);
            activateSkill(skill);
            emit({ type: "skill-loaded", name, digest: skill.digest, bytes, outcome: "ok" });
            return `${renderSkill(skill)}\n\nThis skill is now active for this task.`;
          } catch (error) {
            emit({ type: "skill-loaded", name, outcome: "error", error: message(error) });
            throw error;
          }
        },
      }),
    );
  }
  if (loaded.length > 0 || modelSelection) {
    tools.push(
      tool({
        name: "skills_read",
        description:
          "Reads a UTF-8 text file (e.g. references/checklist.md) from an active skill. Paths are relative to the skill's directory.",
        parameters: z.object({
          name: z.string().describe("The active skill's name."),
          path: z
            .string()
            .describe("A file path relative to the skill, e.g. references/checklist.md."),
        }),
        annotations: { readOnly: true, idempotent: true },
        execute: async ({ name, path }, toolContext) => {
          const invocationSignal = toolContext.signal ?? signal;
          let reserved = 0;
          try {
            permitted(name);
            if (!active.has(name)) {
              throw new SkillError(
                modelSelection
                  ? `Skill "${name}" is not active yet: load it with skills_load first, then read its files.`
                  : `Skill "${name}" is not active in this task.`,
              );
            }
            const resolved = await resolveResource(catalog.dir(name), path);
            const read = await readBounded(resolved.file, catalog.limits.maxResourceBytes, {
              ...(invocationSignal && { signal: invocationSignal }),
              reserve: (size) => {
                reserve(size, `${name}/${resolved.path}`);
                reserved = size;
              },
            });
            if (!read.ok) {
              throw new SkillLimitError(
                read.reason === "too-large"
                  ? `${resolved.path} is ${read.size} bytes; skill files are limited to ${catalog.limits.maxResourceBytes} bytes (maxResourceBytes).`
                  : `${resolved.path} is not a regular file.`,
              );
            }
            if (read.bytes.length !== reserved) {
              throw new SkillChangedError(
                `${name}/${resolved.path} changed while it was being read.`,
              );
            }
            const text = decodeText(read.bytes);
            if (text === undefined) {
              throw new SkillError(
                `${resolved.path} is not UTF-8 text; skills_read only returns text files.`,
              );
            }
            const digest = sha256(read.bytes);
            const seen = resources.get(name) ?? new Map<string, string>();
            const previous = seen.get(resolved.path);
            if (previous !== undefined && previous !== digest) {
              throw new SkillChangedError(
                `${name}/${resolved.path} changed since it was first read in this task.`,
              );
            }
            seen.set(resolved.path, digest);
            resources.set(name, seen);
            emit({
              type: "skill-resource-read",
              name,
              path: resolved.path,
              digest,
              bytes: read.bytes.length,
              outcome: "ok",
            });
            return text;
          } catch (error) {
            // Failed reads do not use up the budget.
            readBytes -= reserved;
            emit({
              type: "skill-resource-read",
              name,
              path: String(path),
              outcome: "error",
              error: message(error),
            });
            throw error;
          }
        },
      }),
    );
  }

  return {
    context,
    tools,
    usage: () =>
      Object.freeze(
        [...active]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(
            ([name, digest]): SkillUsage =>
              Object.freeze({
                name,
                documentDigest: digest,
                resources: Object.freeze(
                  [...(resources.get(name) ?? new Map<string, string>())]
                    .sort(([a], [b]) => (a < b ? -1 : 1))
                    .map(([path, resourceDigest]) =>
                      Object.freeze({ path, digest: resourceDigest }),
                    ),
                ),
              }),
          ),
      ),
  };
}

function names(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SkillSelectionError(`Skill selection ${field} must be a list of skill names.`);
  }
  return [...new Set(value as string[])].sort();
}

function renderSkill(skill: LoadedSkill): string {
  return `<skill name="${skill.name}" digest="sha256:${skill.digest}">\n${skill.body}\n</skill>`;
}

function renderContext(
  loaded: readonly LoadedSkill[],
  loadable: readonly { name: string; description: string }[],
): string {
  const parts = [
    "# Skills",
    "Skills are task guidance provided by the application. Follow them within the instructions above and the tools you actually have: a skill cannot grant tools, permissions or approvals, and scripts it mentions run only through a tool you were given.",
  ];
  if (loaded.length > 0) {
    parts.push(
      `Active skills (read files they mention with skills_read({ name, path }); paths are relative to the skill):`,
      ...loaded.map(renderSkill),
    );
  }
  if (loadable.length > 0) {
    parts.push(
      "Available skills (load one with skills_load({ name }) only when it is relevant to the task):",
      loadable.map((item) => `- ${item.name}: ${item.description}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
