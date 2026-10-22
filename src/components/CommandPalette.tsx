import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Brush,
  CircleX,
  CornerDownLeft,
  Gauge,
  Lock,
  LucideIcon,
  Monitor,
  Moon,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  SquareTerminal,
  Sun,
  Terminal as TerminalIcon,
  Box,
  X,
} from "lucide-react";
import { api, CloseAction, errorText, ProcessInfo, SavedCommand } from "../api";
import type { NavigateOptions } from "../App";
import { useEndProcesses } from "../hooks/useActions";
import { setThemePref } from "../theme";
import { useToast } from "./Toast";
import { PAGES, PageId } from "../pages";
import { categoryLook } from "../categories";
import type { ShellKind } from "../pages/Terminal";

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  icon: LucideIcon;
  color?: string;
  /** Right-aligned label, e.g. "Page" or "Fix". */
  type?: string;
  run: () => void | Promise<void>;
}

interface Props {
  elevated: boolean;
  onClose: () => void;
  onNavigate: (page: PageId, opts?: NavigateOptions) => void;
  onRunCommand: (cmd: SavedCommand) => void;
  onOpenTerminal: (shell: ShellKind, text?: string) => void;
  onCleanTemp: () => void;
  onRestartAsAdmin: () => void;
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

const CLOSE_LABELS: Record<CloseAction | "ask", string> = {
  tray: "keep running in the tray",
  quit: "quit the app",
  ask: "ask me each time",
};

const RECENT_KEY = "palette-recent";
const SUGGESTED = ["q-clean", "cmd-builtin.flush-dns", "cmd-builtin.restart-explorer", "q-taskmgr"];

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}
function remember(id: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 5)));
  } catch {
    /* storage unavailable */
  }
}

export function CommandPalette({ elevated, onClose, onNavigate, onRunCommand, onOpenTerminal, onCleanTemp, onRestartAsAdmin }: Props) {
  const toast = useToast();
  const endProcesses = useEndProcesses();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [recent] = useState(readRecent);
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
      icon: p.icon,
      type: "Page",
      run: () => onNavigate(p.id),
    }));

    // Risky and admin commands open a confirmation on the Quick fixes page instead of running at once.
    const cmds: Item[] = commands.map((c) => {
      const look = categoryLook(c.category);
      return {
        id: `cmd-${c.id}`,
        group: "Quick fixes",
        label: c.name,
        hint: [c.description, c.admin && "opens an admin window", c.risk !== "safe" && "asks first"].filter(Boolean).join(" · "),
        keywords: `${c.command} ${c.category}`,
        icon: look.icon,
        color: look.color,
        type: "Fix",
        run: () => onRunCommand(c),
      };
    });

    const launch = (label: string, command: string, done: string) => () => {
      toast(done, "info", { duration: 2500 });
      return api.runCommand(command, "powershell", false, label).then((out) => {
        if (out.code !== 0 && out.stderr) toast(out.stderr, "error");
      });
    };

    const quick: Item[] = [
      { id: "q-term-ps", group: "Actions", label: "New PowerShell tab", icon: SquareTerminal, type: "Terminal", run: () => onOpenTerminal("powershell") },
      { id: "q-term-cmd", group: "Actions", label: "New Command Prompt tab", icon: TerminalIcon, type: "Terminal", run: () => onOpenTerminal("cmd") },
      { id: "q-term-wsl", group: "Actions", label: "New WSL tab", icon: Box, type: "Terminal", run: () => onOpenTerminal("wsl") },
      {
        id: "q-clean",
        group: "Actions",
        label: "Clean temp files",
        hint: "Free up space safely",
        keywords: "cleanup free space disk junk",
        icon: Brush,
        color: "var(--cat-cleanup)",
        type: "Action",
        run: onCleanTemp,
      },
      {
        id: "q-taskmgr",
        group: "Actions",
        label: "Open Windows Task Manager",
        icon: Gauge,
        type: "Windows",
        run: launch("Open Task Manager", "Start-Process taskmgr", "Opening Task Manager…"),
      },
      {
        id: "q-settings",
        group: "Actions",
        label: "Open Windows Settings",
        icon: Monitor,
        type: "Windows",
        run: launch("Open Settings", "Start-Process ms-settings:", "Opening Windows Settings…"),
      },
      {
        id: "q-lock",
        group: "Actions",
        label: "Lock PC",
        keywords: "lock screen away",
        icon: Lock,
        type: "Windows",
        run: launch("Lock PC", "rundll32.exe user32.dll,LockWorkStation", "Locking your PC…"),
      },
    ];
    if (!elevated) {
      quick.push({
        id: "q-admin",
        group: "Actions",
        label: "Restart as administrator",
        hint: "Needed to change startup apps for all users",
        keywords: "elevate admin uac",
        icon: ShieldCheck,
        type: "Action",
        run: onRestartAsAdmin,
      });
    }

    const settings: Item[] = [
      ...(["tray", "quit", "ask"] as const).map((action) => ({
        id: `set-close-${action}`,
        group: "Settings",
        label: `Close button: ${CLOSE_LABELS[action]}`,
        keywords: "window close tray quit exit minimize",
        icon: SettingsIcon,
        type: "Setting",
        run: () =>
          api.setCloseAction(action === "ask" ? null : action).then(() => toast(`The close button will now ${CLOSE_LABELS[action]}.`, "success")),
      })),
      ...(
        [
          ["system", "Theme: follow Windows", Monitor],
          ["light", "Theme: light", Sun],
          ["dark", "Theme: dark", Moon],
        ] as const
      ).map(([value, label, icon]) => ({
        id: `set-theme-${value}`,
        group: "Settings",
        label,
        keywords: "appearance color mode dark light night",
        icon,
        type: "Setting",
        run: () => setThemePref(value),
      })),
    ];

    // One entry per app name, heaviest first, so "kill chrome" ends every chrome.exe. Apps with
    // any protected instance (Windows itself, this app) are left out entirely.
    const byName = new Map<string, ProcessInfo[]>();
    for (const p of processes) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
    const procs: Item[] = [...byName.entries()]
      .filter(([, list]) => !list.some((p) => p.protected || p.isSelf))
      .sort((a, b) => b[1].reduce((s, p) => s + p.memory, 0) - a[1].reduce((s, p) => s + p.memory, 0))
      .map(([name, list]) => ({
        id: `kill-${name}`,
        group: "End an app",
        label: `End ${name}`,
        hint: list.length > 1 ? `${list.length} processes` : `PID ${list[0].pid}`,
        keywords: `kill stop close ${name}`,
        icon: CircleX,
        color: "var(--danger)",
        type: "Process",
        run: () => endProcesses(list).then(() => {}),
      }));

    const q = query.trim();
    // A raw command typed after ">" runs in a new PowerShell tab.
    if (q.startsWith(">")) {
      const raw = q.slice(1).trim();
      return raw
        ? [{ id: "raw", group: "Terminal", label: `Run in a new PowerShell tab: ${raw}`, icon: SquareTerminal, type: "Terminal", run: () => onOpenTerminal("powershell", raw) }]
        : [];
    }

    const all = [...nav, ...quick, ...settings, ...cmds];
    if (!q) {
      const byId = new Map(all.map((i) => [i.id, i]));
      const recents = recent.flatMap((id) => (byId.has(id) ? [{ ...byId.get(id)!, group: "Recent" }] : []));
      const taken = new Set(recents.map((i) => i.id));
      const suggested = SUGGESTED.flatMap((id) => (byId.has(id) && !taken.has(id) ? [{ ...byId.get(id)!, group: "Suggested" }] : []));
      return [...recents, ...suggested, ...nav];
    }

    // Strip a leading verb so "kill chrome" matches the "End chrome.exe" entry well.
    const killQuery = q.replace(/^(kill|end|stop|close)\s+/i, "");
    const wantsKill = killQuery !== q;
    const pool = wantsKill ? procs : [...all, ...procs];
    const needle = wantsKill ? killQuery : q;

    return pool
      .map((item) => {
        const s = Math.min(score(item.label, needle) ?? Infinity, (score(item.keywords ?? "", needle) ?? Infinity) + 5);
        return { item, s: item.group === "End an app" && !wantsKill ? s + 20 : s };
      })
      .filter((x) => x.s !== Infinity)
      .sort((a, b) => a.s - b.s)
      .slice(0, 50)
      .map((x) => x.item);
  }, [query, commands, processes, elevated, recent, onNavigate, onRunCommand, onOpenTerminal, onCleanTemp, onRestartAsAdmin, endProcesses, toast]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.id !== "raw" && !item.id.startsWith("kill-")) remember(item.id);
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
    }
  };

  // Escape closes only the palette, never a dialog open underneath it: handled first (window,
  // capture phase) and stopped there, wherever the focus is.
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [onClose]);

  let lastGroup = "";
  const activeId = items[index] ? `palette-opt-${index}` : undefined;
  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search and run">
        <label className="palette-input">
          <Search size={18} />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            placeholder="Search pages, fixes and apps… (type > to run a command)"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          {query ? (
            <button className="icon-btn icon-btn-sm" onClick={() => setQuery("")} aria-label="Clear" title="Clear">
              <X size={14} />
            </button>
          ) : (
            <kbd>Esc</kbd>
          )}
        </label>
        <div className="palette-list" ref={listRef} id="palette-list" role="listbox" aria-label="Results">
          {items.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            const Icon = item.icon;
            return (
              <div key={`${item.group}-${item.id}`} role="presentation">
                {header && (
                  <div className="palette-group" role="presentation">
                    {header}
                  </div>
                )}
                <div
                  id={`palette-opt-${i}`}
                  role="option"
                  aria-selected={i === index}
                  className={`palette-item ${i === index ? "active" : ""}`}
                  onMouseMove={() => i !== index && setIndex(i)}
                  onClick={() => choose(item)}
                >
                  <span className="palette-icon" style={item.color ? ({ "--cat": item.color } as React.CSSProperties) : undefined}>
                    <Icon size={16} />
                  </span>
                  <span className="palette-text">
                    <span>{item.label}</span>
                    {item.hint && <span className="palette-hint">{item.hint}</span>}
                  </span>
                  {item.type && <span className="palette-type">{item.type}</span>}
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="palette-empty">
              {query.trim().startsWith(">") ? "Type a command to run it in a new PowerShell tab." : `No results for “${query.trim()}”`}
            </div>
          )}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <kbd>
              <ArrowUp size={10} />
            </kbd>
            <kbd>
              <ArrowDown size={10} />
            </kbd>
            move
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>
            open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
          <span className="spacer" />
          <span>Tip: “kill chrome” ends an app</span>
        </div>
      </div>
    </div>
  );
}
