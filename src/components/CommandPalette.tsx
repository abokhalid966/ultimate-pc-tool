import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api, errorText, ProcessInfo, SavedCommand } from "../api";
import { useToast } from "./Toast";
import { PAGES, PageId } from "../pages";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void | Promise<void>;
}

interface Props {
  onClose: () => void;
  onNavigate: (page: PageId, opts?: { processQuery?: string }) => void;
  onRunCommand: (cmd: SavedCommand) => void;
  onOpenInTerminal: (command: string) => void;
}

/** Subsequence match: every query character appears in order. Lower score = better. */
function score(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct === 0 ? 0 : 1 + direct / 100;
  let ti = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    gaps += found - ti;
    ti = found + 1;
  }
  return 10 + gaps;
}

export function CommandPalette({ onClose, onNavigate, onRunCommand, onOpenInTerminal }: Props) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.commands().then(setCommands).catch(() => {});
    api.processes().then(setProcesses).catch(() => {});
  }, []);

  const items = useMemo<Item[]>(() => {
    const nav: Item[] = PAGES.map((p) => ({
      id: `nav-${p.id}`,
      group: "Go to",
      label: p.label,
      hint: p.description,
      run: () => onNavigate(p.id),
    }));

    const cmds: Item[] = commands.map((c) => ({
      id: `cmd-${c.id}`,
      group: "Run command",
      label: c.name,
      hint: c.admin ? `${c.description} · admin` : c.description,
      keywords: `${c.command} ${c.category}`,
      run: () => onRunCommand(c),
    }));

    const quick: Item[] = [
      { id: "q-term", group: "Quick actions", label: "New PowerShell terminal", run: () => onNavigate("terminal") },
      {
        id: "q-taskmgr",
        group: "Quick actions",
        label: "Open Windows Task Manager",
        run: () => api.runCommand("Start-Process taskmgr", "powershell", false, "Open Task Manager").then(() => {}),
      },
      {
        id: "q-settings",
        group: "Quick actions",
        label: "Open Windows Settings",
        run: () => api.runCommand("Start-Process ms-settings:", "powershell", false, "Open Settings").then(() => {}),
      },
      {
        id: "q-lock",
        group: "Quick actions",
        label: "Lock PC",
        run: () => api.runCommand("rundll32.exe user32.dll,LockWorkStation", "cmd", false, "Lock PC").then(() => {}),
      },
    ];

    // One entry per app name, heaviest first, so "kill chrome" ends every chrome.exe.
    const byName = new Map<string, ProcessInfo[]>();
    for (const p of processes) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
    const procs: Item[] = [...byName.entries()]
      .sort((a, b) => b[1].reduce((s, p) => s + p.memory, 0) - a[1].reduce((s, p) => s + p.memory, 0))
      .map(([name, list]) => ({
        id: `kill-${name}`,
        group: "End process",
        label: `End ${name}`,
        hint: list.length > 1 ? `${list.length} processes` : `PID ${list[0].pid}`,
        keywords: `kill stop close ${name}`,
        run: async () => {
          if (!confirm(`End ${name}${list.length > 1 ? ` (${list.length} processes)` : ""}? Unsaved work will be lost.`)) return;
          const results = await Promise.allSettled(list.map((p) => api.killProcess(p.pid, p.name)));
          const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
          if (failed) toast(errorText(failed.reason), "error");
          else toast(`Ended ${name}`, "success");
        },
      }));

    const q = query.trim();
    // A raw command typed after ">" runs in the terminal.
    if (q.startsWith(">")) {
      const raw = q.slice(1).trim();
      return raw
        ? [{ id: "raw", group: "Terminal", label: `Run in terminal: ${raw}`, run: () => onOpenInTerminal(raw) }]
        : [];
    }
    if (!q) return [...nav, ...quick, ...cmds.slice(0, 8)];

    // Strip a leading verb so "kill chrome" matches the "End chrome.exe" entry well.
    const killQuery = q.replace(/^(kill|end|stop|close)\s+/i, "");
    const wantsKill = killQuery !== q;
    const pool = wantsKill ? procs : [...nav, ...quick, ...cmds, ...procs];
    const needle = wantsKill ? killQuery : q;

    return pool
      .map((item) => {
        const s = Math.min(
          score(item.label, needle) ?? Infinity,
          (score(item.keywords ?? "", needle) ?? Infinity) + 5,
        );
        return { item, s: item.group === "End process" && !wantsKill ? s + 20 : s };
      })
      .filter((x) => x.s !== Infinity)
      .sort((a, b) => a.s - b.s)
      .slice(0, 50)
      .map((x) => x.item);
  }, [query, commands, processes, onNavigate, onRunCommand, onOpenInTerminal, toast]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    Promise.resolve(item.run()).catch((e) => toast(errorText(e), "error"));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[index]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  let lastGroup = "";
  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <label className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder='Search anything: "flush dns", "kill chrome", "startup", or ">" to run a command'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd>Esc</kbd>
        </label>
        <div className="palette-list" ref={listRef}>
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  className={`palette-item ${i === index ? "active" : ""}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(item)}
                >
                  <span>{item.label}</span>
                  {item.hint && <span className="muted small">{item.hint}</span>}
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="empty">No matches</div>}
        </div>
      </div>
    </div>
  );
}
