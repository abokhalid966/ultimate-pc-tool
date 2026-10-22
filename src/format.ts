const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${UNITS[i]}`;
}

export const rate = (bps: number) => `${bytes(bps)}/s`;

export const pct = (n: number, digits = 0) => `${n.toFixed(digits)}%`;

export function duration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Placeholders like `{host}` inside a saved command. */
export function commandVariables(command: string): string[] {
  return [...new Set([...command.matchAll(/\{([a-zA-Z_][\w-]*)\}/g)].map((m) => m[1]))];
}

export function fillVariables(command: string, values: Record<string, string>): string {
  return command.replace(/\{([a-zA-Z_][\w-]*)\}/g, (all, name) => values[name] ?? all);
}
