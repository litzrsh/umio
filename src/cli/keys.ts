/**
 * Interactive decisions as pure functions: which action a key means in the
 * current state, and what a line typed at the prompt asks for.
 */
import { splitCommandLine } from "./args.js";

export interface Key {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly sequence?: string;
}

export interface KeyState {
  readonly operation: "idle" | "running" | "cancelling";
  readonly approvalPending: boolean;
}

export type KeyAction =
  | "cancel"
  | "still-cancelling"
  | "hint-cancel-first"
  | "approve-yes"
  | "approve-no"
  | "approve-always"
  | "ignore";

/**
 * Keys while an operation runs (the idle prompt is handled by readline).
 * Cancelling never exits; exiting needs an idle prompt.
 */
export function keyAction(key: Key, state: KeyState): KeyAction {
  if (state.operation === "idle") return "ignore";
  const cancelKey = key.name === "escape" || (key.ctrl === true && key.name === "c");
  if (cancelKey) return state.operation === "cancelling" ? "still-cancelling" : "cancel";
  if (key.ctrl === true && key.name === "d") return "hint-cancel-first";
  if (state.approvalPending && !key.ctrl) {
    switch (key.name) {
      case "y":
        return "approve-yes";
      case "n":
      case "return":
        return "approve-no";
      case "a":
        return "approve-always";
    }
  }
  return "ignore";
}

export type LineAction =
  | { readonly kind: "empty" }
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "help" }
  | { readonly kind: "model"; readonly alias?: string }
  | { readonly kind: "config" }
  | { readonly kind: "session" }
  | { readonly kind: "tools" }
  | { readonly kind: "new" }
  | { readonly kind: "cancel" }
  | { readonly kind: "exit" }
  | { readonly kind: "graph"; readonly argv: readonly string[] }
  | { readonly kind: "error"; readonly message: string };

export const SLASH_COMMANDS = [
  "help",
  "model",
  "config",
  "session",
  "tools",
  "new",
  "cancel",
  "exit",
  "quit",
  "graph",
] as const;

/** A line starting with "/" is a command ("//" sends a literal "/…" prompt). */
export function parseLine(line: string): LineAction {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "prompt", text: line.trimEnd() };
  if (text.startsWith("//")) return { kind: "prompt", text: text.slice(1) };
  const args = splitCommandLine(text.slice(1));
  if (!args) return { kind: "error", message: "Unterminated quote." };
  const [name = "", ...rest] = args;
  switch (name) {
    case "help":
    case "?":
      return { kind: "help" };
    case "model":
      if (rest.length > 1) return { kind: "error", message: "Usage: /model [alias]" };
      return rest[0] ? { kind: "model", alias: rest[0] } : { kind: "model" };
    case "config":
    case "session":
    case "tools":
    case "new":
    case "cancel":
      return rest.length
        ? { kind: "error", message: `/${name} takes no arguments.` }
        : { kind: name };
    case "exit":
    case "quit":
      return { kind: "exit" };
    case "graph":
      return { kind: "graph", argv: rest };
    default: {
      const near = SLASH_COMMANDS.filter((command) => distance(command, name) <= 2);
      return {
        kind: "error",
        message: `Unknown command /${name}.${near.length ? ` Did you mean ${near.map((item) => `/${item}`).join(", ")}?` : " Type /help."} To send text starting with "/", type "//".`,
      };
    }
  }
}

/** Completions for readline's tab completion. */
export function completeLine(line: string): [string[], string] {
  if (!line.startsWith("/") || line.includes(" ")) return [[], line];
  const hits = SLASH_COMMANDS.map((command) => `/${command}`).filter((command) =>
    command.startsWith(line),
  );
  return [hits, line];
}

/** Levenshtein distance, for "did you mean" suggestions. */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}
