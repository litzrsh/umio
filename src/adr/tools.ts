import { z } from "zod";
import { type Tool, tool } from "../tools/tool.js";
import type { Adr, AdrStore } from "./store.js";

export interface AdrToolsOptions {
  /** Called after an agent proposes a new record. */
  onPropose?(adr: Adr): void | Promise<void>;
}

/**
 * Tools that let agents consult the project's ADRs and propose new ones.
 * Proposals are written with status "Proposed"; accepting them stays a human
 * decision.
 */
export function adrTools(store: AdrStore, options: AdrToolsOptions = {}): Tool[] {
  const listAdrs = tool({
    name: "list_adrs",
    description:
      "Lists the project's Architecture Decision Records (number, title, status). Use before making an architectural choice, to find decisions that already apply.",
    parameters: z.object({
      status: z
        .string()
        .optional()
        .describe('Only records whose status starts with this, e.g. "Accepted" or "Proposed".'),
    }),
    annotations: { readOnly: true },
    execute: async ({ status }) => {
      const records = status ? await store.withStatus([status]) : await store.list();
      if (records.length === 0) return "No ADRs found.";
      return records.map((adr) => `ADR-${adr.number}: ${adr.title} [${adr.status}]`).join("\n");
    },
  });

  const readAdr = tool({
    name: "read_adr",
    description: "Returns the full text of one Architecture Decision Record.",
    parameters: z.object({ number: z.number().int().positive() }),
    annotations: { readOnly: true },
    execute: async ({ number }) => {
      const adr = await store.get(number);
      if (!adr) throw new Error(`ADR-${number} does not exist.`);
      return adr.content;
    },
  });

  const proposeAdr = tool({
    name: "propose_adr",
    description:
      "Records a significant architectural decision as a new ADR with status Proposed, for humans to review. Use it for decisions that are hard to reverse or that later work must follow, not for routine implementation details.",
    parameters: z.object({
      title: z
        .string()
        .min(3)
        .describe('Short imperative title, e.g. "Use PostgreSQL for persistence".'),
      context: z.string().min(1).describe("The problem and forces that make a decision necessary."),
      decision: z.string().min(1).describe('The decision, in active voice: "We will ...".'),
      consequences: z
        .string()
        .min(1)
        .describe("What becomes easier or harder, including risks and follow-up work."),
      supersedes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of an existing ADR this replaces."),
    }),
    execute: async (proposal) => {
      const adr = await store.propose(proposal);
      await options.onPropose?.(adr);
      return `Created ADR-${adr.number} "${adr.title}" with status ${adr.status} (${adr.file}).`;
    },
  });

  return [listAdrs, readAdr, proposeAdr];
}
