import { z } from "zod";
import { ConfigError } from "../errors.js";
import { promptTranslator } from "./translator.js";
import type { Middleware } from "./types.js";

/** Builds a middleware from the options given in JSON (everything except `use`). */
export type MiddlewareFactory = (options: Record<string, unknown>) => Middleware;

const PromptTranslatorOptionsSchema = z
  .object({
    model: z.string().min(1),
    to: z.string().min(1).optional(),
    responseLanguage: z.string().min(1).optional(),
    memoSize: z.number().int().positive().optional(),
  })
  .strict();

/** Middleware that harnesses can declare by name in JSON. */
export const builtinMiddleware: Record<string, MiddlewareFactory> = {
  promptTranslator: (options) =>
    promptTranslator(parseOptions("promptTranslator", PromptTranslatorOptionsSchema, options)),
};

function parseOptions<T>(name: string, schema: z.ZodType<T>, options: unknown): T {
  const result = schema.safeParse(options);
  if (!result.success) {
    throw new ConfigError(
      `Invalid options for middleware "${name}":\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
