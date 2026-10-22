const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/**
 * Sizes like Windows shows them: about three significant digits, switching unit at 1000 so a
 * value never reads "1012.3 MB" ("0.99 GB" instead), and no trailing ".0".
 */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  let i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), UNITS.length - 1);
  if (n / 1024 ** i >= 1000 && i < UNITS.length - 1) i++;
  const v = n / 1024 ** i;
  if (i === 0) return `${Math.round(v)} B`;
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${s.replace(/\.0+$|(\.\d*?)0+$/, "$1")} ${UNITS[i]}`;
}

export const rate = (bps: number) => `${bytes(bps)}/s`;

export const pct = (n: number, digits = 0) => `${(Number.isFinite(n) ? n : 0).toFixed(digits)}%`;

export function duration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** "1 day, 2 hours" for sentences. */
export function longDuration(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const part = (v: number, unit: string) => `${v} ${unit}${v === 1 ? "" : "s"}`;
  if (d > 0) return h > 0 ? `${part(d, "day")}, ${part(h, "hour")}` : part(d, "day");
  if (h > 0) return m > 0 ? `${part(h, "hour")}, ${part(m, "minute")}` : part(h, "hour");
  return part(Math.max(m, 1), "minute");
}

/** Elapsed time as m:ss. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "C:\\" -> "C:" for display. */
export const mountLabel = (mount: string) => mount.replace(/[\\/]+$/, "");

/** "Samsung 990 Pro (C:)" or "Local Disk (C:)", like File Explorer. */
export const driveLabel = (d: { name: string; mount: string; removable?: boolean }) =>
  `${d.name || (d.removable ? "USB Drive" : "Local Disk")} (${mountLabel(d.mount)})`;

const rtf = typeof Intl !== "undefined" ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }) : null;

/** "just now", "5 minutes ago", "yesterday"… */
export function relativeTime(date: Date, now = Date.now()): string {
  const secs = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(secs);
  if (abs < 45) return "just now";
  if (!rtf) return date.toLocaleString();
  if (abs < 3600) return rtf.format(Math.round(secs / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), "hour");
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Today", "Yesterday" or a date, for grouping a history list. */
export function dayLabel(date: Date, now = new Date()): string {
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: days < 7 ? "long" : undefined, month: "long", day: "numeric", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

/** A stable hue (0-359) for a name, used for the letter avatars of apps. */
export function nameHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

// ---- {variable} placeholders in saved commands ----
//
// `{name}` asks for a value and inserts it safely quoted for the command's shell, so spaces and
// characters like ; | & $ stay part of the value. `{name:raw}` inserts it exactly as typed.
// `{{name}}` is a literal `{name}`. bcdedit identifiers like `{current}` and GUIDs are left alone.

export type QuoteShell = "powershell" | "cmd";

const LITERAL_NAMES = new Set([
  "current",
  "default",
  "bootmgr",
  "fwbootmgr",
  "memdiag",
  "ntldr",
  "badmemory",
  "globalsettings",
  "dbgsettings",
  "emssettings",
  "bootloadersettings",
  "resumeloadersettings",
  "hypervisorsettings",
  "ramdefects",
]);
const GUID_START = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const TOKEN = /\{\{([a-zA-Z_][\w-]*(?::raw)?)\}\}|\{([a-zA-Z_][\w-]*)(:raw)?\}/g;

type Part = { text: string } | { name: string; raw: boolean };

function parse(template: string): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of template.matchAll(TOKEN)) {
    const [all, escaped, name, raw] = m;
    if (escaped === undefined && (LITERAL_NAMES.has(name.toLowerCase()) || GUID_START.test(name))) continue;
    parts.push({ text: template.slice(last, m.index) });
    parts.push(escaped !== undefined ? { text: `{${escaped}}` } : { name, raw: raw !== undefined });
    last = m.index + all.length;
  }
  parts.push({ text: template.slice(last) });
  return parts;
}

/** Names of the placeholders in a saved command, in order of first use. */
export function commandVariables(command: string): string[] {
  const names = parse(command).flatMap((p) => ("name" in p ? [p.name] : []));
  return [...new Set(names)];
}

const PS_SINGLE = /['‘’‚‛]/;
const PS_DOUBLE = /["“”„]/;
type Quote = "none" | "single" | "double";

/** Tracks whether the end of `text` is inside quotes, starting from `state`. */
function scanQuotes(text: string, state: Quote, shell: QuoteShell): Quote {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (shell === "cmd") {
      if (ch === "^" && state === "none") i++;
      else if (ch === '"') state = state === "none" ? "double" : "none";
      continue;
    }
    if (state === "single") {
      if (PS_SINGLE.test(ch)) state = "none";
    } else if (ch === "`") {
      i++;
    } else if (state === "double") {
      if (PS_DOUBLE.test(ch)) state = "none";
    } else if (PS_SINGLE.test(ch)) {
      state = "single";
    } else if (PS_DOUBLE.test(ch)) {
      state = "double";
    }
  }
  return state;
}

/** Turns a typed value into a literal for the shell, given the quotes it is placed in. */
function quote(name: string, value: string, shell: QuoteShell, state: Quote): string {
  if (shell === "cmd") {
    if (/["%\r\n]/.test(value)) {
      throw new Error(`“${name}” can't contain " or % or line breaks in a Command Prompt command.`);
    }
    return state === "none" ? `"${value}"` : value;
  }
  if (state === "single") return value.replace(/['‘’‚‛]/g, "$&$&");
  if (state === "double") return value.replace(/[`$"“”„]/g, "`$&");
  return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

/**
 * Fills placeholders with `values`, quoted for `shell`. Names without a value are left as typed
 * (for previews). Throws with a readable message when a value can't be used safely.
 */
export function fillVariables(command: string, values: Record<string, string>, shell: QuoteShell): string {
  let state: Quote = "none";
  let out = "";
  for (const part of parse(command)) {
    if ("text" in part) {
      out += part.text;
      state = scanQuotes(part.text, state, shell);
    } else {
      const value = values[part.name];
      if (value === undefined) {
        out += `{${part.name}${part.raw ? ":raw" : ""}}`;
      } else if (part.raw) {
        out += value;
        state = scanQuotes(value, state, shell);
      } else {
        out += quote(part.name, value, shell, state);
      }
    }
  }
  return out;
}
