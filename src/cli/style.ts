/**
 * Color and symbols. Meaning never depends on color alone: every status has a
 * symbol and a word, and without color the output is plain text.
 */
export interface Style {
  readonly color: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  readonly symbols: Symbols;
}

export interface Symbols {
  readonly prompt: string;
  readonly tool: string;
  readonly ok: string;
  readonly error: string;
  readonly warn: string;
  readonly cancelled: string;
  readonly uncertain: string;
  readonly running: string;
  readonly pending: string;
  readonly retry: string;
  readonly spinner: readonly string[];
}

const UNICODE: Symbols = {
  prompt: "›",
  tool: "⚙",
  ok: "✓",
  error: "✗",
  warn: "!",
  cancelled: "–",
  uncertain: "?",
  running: "▸",
  pending: "·",
  retry: "↻",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

const ASCII: Symbols = {
  prompt: ">",
  tool: "*",
  ok: "+",
  error: "x",
  warn: "!",
  cancelled: "-",
  uncertain: "?",
  running: ">",
  pending: ".",
  retry: "~",
  spinner: ["|", "/", "-", "\\"],
};

/**
 * Colors when the stream is a TTY, unless `--no-color` or `NO_COLOR` says
 * otherwise; `FORCE_COLOR` or `--color` force them. `TERM=dumb` also switches
 * to ASCII symbols.
 */
export function detectColor(
  isTTY: boolean,
  env: Record<string, string | undefined>,
  option?: boolean,
): boolean {
  if (option !== undefined) return option;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return isTTY && env.TERM !== "dumb";
}

export function createStyle(color: boolean, env: Record<string, string | undefined> = {}): Style {
  const wrap = (open: number, close: number) => (text: string) =>
    color ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    color,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    symbols: env.TERM === "dumb" ? ASCII : UNICODE,
  };
}

/** Removes ANSI escape sequences, e.g. to measure visible width. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}
