// A tiny console emulator for winget's live output, which redraws its spinner and progress bars
// in place: `\r` goes back to the start of the line, `\b` steps back, escape codes are dropped.
// Kept free of imports so dev/apps.test.ts can test it.

// CSI (ESC [ ... final), OSC (ESC ] ... BEL or ESC \), and two-character escapes.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// An escape sequence cut off at the end of a chunk; kept for the next one.
const PARTIAL_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*)?$/;
const MAX_LINES = 1500;

/** Spinner frames and progress bars. */
export const isNoise = (line: string) => {
  const t = line.trim();
  return t === "-" || t === "\\" || t === "|" || t === "/" || t.includes("█") || t.includes("▒");
};

export class Screen {
  lines: string[] = [];
  cur: string[] = [];
  col = 0;
  tail = "";

  write(chunk: string) {
    let text = this.tail + chunk;
    const partial = PARTIAL_ESCAPE.exec(text);
    this.tail = partial ? partial[0] : "";
    if (partial) text = text.slice(0, partial.index);
    text = text.replace(ESCAPES, "");
    for (const ch of text) {
      if (ch === "\n") {
        this.lines.push(this.cur.join("").trimEnd());
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        this.cur = [];
        this.col = 0;
      } else if (ch === "\r") {
        this.col = 0;
      } else if (ch === "\b") {
        this.col = Math.max(0, this.col - 1);
      } else if (ch >= " " || ch === "\t") {
        while (this.cur.length < this.col) this.cur.push(" ");
        this.cur[this.col++] = ch === "\t" ? " " : ch;
      }
    }
  }

  /** The line being drawn right now (e.g. a progress bar). */
  get current(): string {
    return this.cur.join("").trimEnd();
  }

  /** The latest line of real text, for a one-line status. */
  get status(): string {
    if (this.current.trim() && !isNoise(this.current)) return this.current.trim();
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].trim() && !isNoise(this.lines[i])) return this.lines[i].trim();
    }
    return "";
  }

  /** Everything so far without spinners, progress bars or runs of blank lines. */
  text(): string {
    const out: string[] = [];
    for (const line of [...this.lines, this.current]) {
      if (isNoise(line)) continue;
      if (!line.trim() && (out.length === 0 || !out[out.length - 1].trim())) continue;
      out.push(line);
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join("\n");
  }
}

const UNIT: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
const SIZES = /([\d.,]+)\s*(B|KB|MB|GB)\s*\/\s*([\d.,]+)\s*(B|KB|MB|GB)/i;
const PERCENT = /(\d{1,3}(?:[.,]\d+)?)\s*%/;

/** "52,3" and "52.3" are both 52.3; "1,024" is 1024. */
function number(text: string): number {
  if (text.includes(",") && text.includes(".")) return parseFloat(text.replace(/,/g, ""));
  if (/,\d{3}$/.test(text)) return parseFloat(text.replace(",", ""));
  return parseFloat(text.replace(",", "."));
}

/** Progress from a winget progress line ("██▒▒  10.0 MB / 52.3 MB" or "██▒▒  45%"), 0 to 1. */
export function parseProgress(line: string): number | null {
  const s = SIZES.exec(line);
  if (s) {
    const done = number(s[1]) * UNIT[s[2].toLowerCase()];
    const total = number(s[3]) * UNIT[s[4].toLowerCase()];
    if (total > 0 && Number.isFinite(done)) return Math.max(0, Math.min(1, done / total));
  }
  const p = PERCENT.exec(line);
  if (p) {
    const v = number(p[1]);
    if (Number.isFinite(v)) return Math.max(0, Math.min(1, v / 100));
  }
  return null;
}

export type Phase = "preparing" | "downloading" | "verifying" | "installing";

/** What winget is doing, from its latest lines (English output; other languages show "preparing"). */
export function phaseOf(current: string, status: string): Phase {
  if (SIZES.test(current) || /download/i.test(status)) return "downloading";
  if (/verif|hash/i.test(status)) return "verifying";
  if (/install|upgrad|updat/i.test(status) && !/^found\b/i.test(status)) return "installing";
  return "preparing";
}
