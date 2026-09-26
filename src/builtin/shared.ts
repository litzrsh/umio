/** Cuts text to `maxChars`, telling the model how much was left out and how to get more. */
export function truncate(text: string, maxChars: number, hint = ""): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n… [truncated: ${omitted} more characters${hint ? `; ${hint}` : ""}]`;
}

/** Combines the caller's abort signal with a timeout. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
