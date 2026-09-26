import { UmioError } from "../errors.js";
import type { ToolDefinition } from "../llm/types.js";
import { assertToolName, type Tool } from "./tool.js";

/**
 * A named collection of tools. Built-in tool groups, agent permissions and
 * workflow steps all pass tools around as toolsets; `pick`/`omit` derive
 * restricted views without copying the tools.
 */
export class Toolset implements Iterable<Tool> {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Iterable<Tool> = []) {
    for (const tool of tools) this.add(tool);
  }

  /** Adds tools. Throws on a duplicate name, since the model could not tell them apart. */
  add(...tools: Tool[]): this {
    for (const tool of tools) {
      assertToolName(tool.name);
      if (this.tools.has(tool.name)) {
        throw new UmioError(`Duplicate tool name "${tool.name}".`);
      }
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get size(): number {
    return this.tools.size;
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * The tools' model-facing definitions, sorted by name. Tools render at the very
   * start of the prompt, so a stable order keeps provider prompt caches valid no
   * matter how the toolset was assembled.
   */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  /** A new toolset with only the named tools. Throws on unknown names to catch typos. */
  pick(names: Iterable<string>): Toolset {
    return new Toolset([...names].map((name) => this.require(name)));
  }

  /** A new toolset without the named tools. Throws on unknown names to catch typos. */
  omit(names: Iterable<string>): Toolset {
    const excluded = new Set([...names].map((name) => this.require(name).name));
    return new Toolset([...this.tools.values()].filter((tool) => !excluded.has(tool.name)));
  }

  [Symbol.iterator](): Iterator<Tool> {
    return this.tools.values();
  }

  private require(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new UmioError(
        `Unknown tool "${name}". Available: ${this.names.join(", ") || "(none)"}`,
      );
    }
    return tool;
  }
}
