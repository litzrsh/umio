/** Parses "90s", "15m", "2h30m", "1h 5m", "500ms" or plain milliseconds; "none"/"off" is null. */
export function parseDuration(text: string): number | null | undefined {
  const value = text.trim().toLowerCase();
  if (value === "none" || value === "off") return null;
  if (/^\d+$/.test(value)) return Number(value);
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value.replace(/\s+/g, "")) {
    return undefined;
  }
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
  return Math.round(
    parts.reduce((total, [, amount, name]) => total + Number(amount) * unit[name as "ms"], 0),
  );
}

/** Compact elapsed time: "850ms", "12s", "4m 05s", "2h 03m". */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
