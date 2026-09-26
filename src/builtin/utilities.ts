import { z } from "zod";
import { type Tool, tool } from "../tools/tool.js";

/** `current_time` and `calculate`: things models are unreliable at on their own. */
export function utilityTools(): Tool[] {
  const currentTime = tool({
    name: "current_time",
    description: "Returns the current date and time, optionally in a given IANA time zone.",
    parameters: z.object({
      timeZone: z.string().optional().describe('IANA zone such as "Asia/Seoul". Defaults to UTC.'),
    }),
    annotations: { readOnly: true },
    execute: ({ timeZone = "UTC" }) => {
      const now = new Date();
      const local = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
      return `${local}\nISO (UTC): ${now.toISOString()}`;
    },
  });

  const calculate = tool({
    name: "calculate",
    description:
      "Evaluates an arithmetic expression exactly as written. Supports + - * / % ^, parentheses, and sqrt, abs, round, floor, ceil, min, max, log (base 10), ln, exp, sin, cos, tan, pi, e.",
    parameters: z.object({ expression: z.string().min(1) }),
    annotations: { readOnly: true, idempotent: true },
    execute: ({ expression }) => String(evaluate(expression)),
  });

  return [currentTime, calculate];
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** A recursive-descent evaluator; nothing is passed to `eval` or `Function`. */
export function evaluate(expression: string): number {
  const tokens =
    expression.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|[a-z_]\w*|[-+*/%^(),]|\S/gi) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const take = (expected?: string) => {
    const token = tokens[position++];
    if (expected && token !== expected)
      throw new Error(`Expected "${expected}" but found "${token ?? "end"}".`);
    return token;
  };

  // expression := term (("+" | "-") term)*
  function expr(): number {
    let value = term();
    while (peek() === "+" || peek() === "-")
      value = take() === "+" ? value + term() : value - term();
    return value;
  }
  // term := unary (("*" | "/" | "%") unary)*
  function term(): number {
    let value = unary();
    for (;;) {
      const op = peek();
      if (op !== "*" && op !== "/" && op !== "%") return value;
      take();
      const right = unary();
      value = op === "*" ? value * right : op === "/" ? value / right : value % right;
    }
  }
  // unary := ("-" | "+") unary | power     (so -2^2 = -(2^2) = -4)
  function unary(): number {
    const op = peek();
    if (op !== "-" && op !== "+") return power();
    take();
    return op === "-" ? -unary() : unary();
  }
  // power := primary ("^" unary)?          (right-associative; allows 2^-1)
  function power(): number {
    const base = primary();
    if (peek() !== "^") return base;
    take();
    return base ** unary();
  }
  function primary(): number {
    const token = take();
    if (token === undefined) throw new Error("Unexpected end of expression.");
    if (token === "(") {
      const value = expr();
      take(")");
      return value;
    }
    if (/^(\d|\.\d)/.test(token)) return Number(token);
    const name = token.toLowerCase();
    if (name in CONSTANTS) return CONSTANTS[name] as number;
    const fn = FUNCTIONS[name];
    if (fn) {
      take("(");
      const args = [expr()];
      while (peek() === ",") {
        take();
        args.push(expr());
      }
      take(")");
      return fn(...args);
    }
    throw new Error(`Unknown token "${token}".`);
  }

  const value = expr();
  if (position < tokens.length) throw new Error(`Unexpected "${tokens[position]}".`);
  if (!Number.isFinite(value)) throw new Error("The result is not a finite number.");
  return value;
}
