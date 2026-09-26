import { z } from "zod";
import { type Tool, tool } from "../tools/tool.js";
import { truncate } from "./shared.js";

export interface SqlToolsOptions {
  /**
   * Runs one statement and returns its rows. Wrap any driver, e.g. for pg:
   * `(sql, params) => pool.query(sql, params).then((r) => r.rows)`.
   */
  execute(sql: string, params: unknown[]): Promise<unknown[]>;
  /** Named in the tool description so the model writes the right dialect, e.g. "PostgreSQL". */
  dialect?: string;
  /** Returns a schema description (tables, columns). Adds a `describe_schema` tool when given. */
  describe?(): Promise<string>;
  /**
   * Refuse statements other than a single SELECT/WITH/EXPLAIN/SHOW. Defaults to
   * true. This is a guard against mistakes, not a security boundary: connect
   * with a database user that only has the permissions the agent should have.
   */
  readOnly?: boolean;
  /** Rows returned to the model at most. Defaults to 200. */
  maxRows?: number;
  maxChars?: number;
}

/** Database tools over any driver: `sql_query`, and `describe_schema` when `describe` is given. */
export function sqlTools(options: SqlToolsOptions): Tool[] {
  const readOnly = options.readOnly ?? true;
  const maxRows = options.maxRows ?? 200;
  const dialect = options.dialect ? ` (${options.dialect})` : "";

  const query = tool({
    name: "sql_query",
    description: `Runs one SQL statement${dialect} and returns rows as JSON.${readOnly ? " Read-only: SELECT, WITH, EXPLAIN or SHOW only." : ""} Use parameters ($1/? placeholders, per the driver) for values.`,
    parameters: z.object({
      sql: z.string().min(1),
      params: z.array(z.unknown()).default([]),
    }),
    annotations: readOnly ? { readOnly: true } : { destructive: true },
    execute: async ({ sql, params }) => {
      if (readOnly) assertReadOnly(sql);
      const rows = await options.execute(sql, params);
      const shown = rows.slice(0, maxRows);
      const note =
        rows.length > maxRows
          ? `\n[${rows.length - maxRows} more rows not shown; add LIMIT or filters]`
          : "";
      return truncate(
        `${rows.length} row(s)\n${JSON.stringify(shown, jsonSafe, 1)}${note}`,
        options.maxChars ?? 50_000,
        "select fewer columns or rows",
      );
    },
  });

  const tools: Tool[] = [query];
  if (options.describe) {
    const describe = options.describe;
    tools.push(
      tool({
        name: "describe_schema",
        description: `Describes the database schema${dialect}: tables and columns.`,
        parameters: z.object({}),
        annotations: { readOnly: true },
        execute: () => describe(),
      }),
    );
  }
  return tools;
}

/** Rejects anything but a single read statement. Comments and string literals are ignored. */
export function assertReadOnly(sql: string): void {
  const code = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim()
    .replace(/;\s*$/, "");
  if (code.includes(";")) throw new Error("Only a single statement is allowed.");
  if (!/^(select|with|explain|show|describe|values)\b/i.test(code)) {
    throw new Error(
      "Read-only mode: only SELECT, WITH, EXPLAIN, SHOW, DESCRIBE or VALUES are allowed.",
    );
  }
  if (
    /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call)\b/i.test(code)
  ) {
    throw new Error("Read-only mode: the statement contains a data-modifying keyword.");
  }
}

function jsonSafe(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
