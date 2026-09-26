import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { UmioConfig } from "../config/schema.js";
import { ConfigError } from "../errors.js";
import type { Tool } from "../tools/tool.js";
import { Toolset } from "../tools/toolset.js";
import { shellTools } from "./command.js";
import { fileTools } from "./files.js";
import { utilityTools } from "./utilities.js";
import { webTools } from "./web.js";

/** A family of tools that can be created from JSON options. */
export interface ToolGroup<Options = Record<string, unknown>> {
  name: string;
  description: string;
  /** Validates the JSON options (everything except `use`). */
  options: z.ZodType<Options>;
  /**
   * Option keys holding filesystem paths. From a config file they resolve against
   * the config's directory, and default to it when omitted.
   */
  pathOptions?: string[];
  create(options: Options): Tool[];
}

/** Named tool groups. Start from `defaultToolRegistry()` and `register()` your own. */
export class ToolRegistry {
  private readonly groups = new Map<string, ToolGroup>();

  register<Options>(group: ToolGroup<Options>): this {
    if (this.groups.has(group.name))
      throw new ConfigError(`Tool group "${group.name}" is already registered.`);
    this.groups.set(group.name, group as unknown as ToolGroup);
    return this;
  }

  get(name: string): ToolGroup | undefined {
    return this.groups.get(name);
  }

  list(): ToolGroup[] {
    return [...this.groups.values()];
  }

  /** Validates options and creates the group's tools. */
  create(name: string, options: Record<string, unknown> = {}, baseDir?: string): Toolset {
    const group = this.groups.get(name);
    if (!group) {
      throw new ConfigError(
        `Unknown tool group "${name}". Available: ${[...this.groups.keys()].join(", ")}`,
      );
    }
    const withPaths = { ...options };
    for (const key of group.pathOptions ?? []) {
      const value = withPaths[key];
      if (typeof value === "string") {
        withPaths[key] = baseDir && !isAbsolute(value) ? resolve(baseDir, value) : value;
      } else if (value === undefined && baseDir) {
        withPaths[key] = baseDir;
      }
    }
    const parsed = group.options.safeParse(withPaths);
    if (!parsed.success) {
      throw new ConfigError(
        `Invalid options for tool group "${name}":\n${z.prettifyError(parsed.error)}`,
      );
    }
    return new Toolset(group.create(parsed.data));
  }
}

const FileOptions = z
  .object({
    root: z.string().min(1),
    readOnly: z.boolean().optional(),
    deny: z.array(z.string()).optional(),
    skip: z.array(z.string()).optional(),
    maxChars: z.number().int().positive().optional(),
  })
  .strict();

const WebOptions = z
  .object({
    allowedDomains: z.array(z.string().min(1)).optional(),
    allowPrivateNetwork: z.boolean().optional(),
    maxChars: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    userAgent: z.string().optional(),
  })
  .strict();

const ShellOptions = z
  .object({
    allow: z.array(z.string().min(1)).min(1),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputChars: z.number().int().positive().optional(),
  })
  .strict();

/**
 * The built-in groups: files, web, shell and utilities. SQL tools need a driver
 * function, so they are created in code with `sqlTools()` instead of JSON.
 */
export function defaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: "files",
      description: "Read, list, search, write and edit files under a root directory.",
      options: FileOptions,
      pathOptions: ["root"],
      create: (options) => fileTools(options),
    })
    .register({
      name: "web",
      description: "Fetch public web pages as text.",
      options: WebOptions,
      create: (options) => webTools(options),
    })
    .register({
      name: "shell",
      description: "Run allowlisted programs without a shell.",
      options: ShellOptions,
      pathOptions: ["cwd"],
      create: (options) => shellTools(options),
    })
    .register({
      name: "utilities",
      description: "Current time and exact arithmetic.",
      options: z.object({}).strict(),
      create: () => utilityTools(),
    });
}

/**
 * Builds the toolsets declared in the config's `tools` section, keyed by name.
 * Relative paths resolve against the config file's directory.
 */
export function createToolsets(
  config: Pick<UmioConfig, "tools" | "configDir">,
  registry: ToolRegistry = defaultToolRegistry(),
): Record<string, Toolset> {
  const baseDir = config.configDir ?? process.cwd();
  const toolsets: Record<string, Toolset> = {};
  for (const [name, { use, ...options }] of Object.entries(config.tools ?? {})) {
    try {
      toolsets[name] = registry.create(use, options, baseDir);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw new ConfigError(`tools.${name}: ${error.message}`, { cause: error });
      }
      throw error;
    }
  }
  return toolsets;
}
