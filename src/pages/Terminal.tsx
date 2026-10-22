import { useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Box, Plus, RotateCcw, ShieldCheck, SquareTerminal, Terminal as TerminalIcon, X } from "lucide-react";
import { api, errorText, TermEvent } from "../api";
import { Menu } from "../components/Menu";
import { PageHeader } from "../components/PageHeader";
import { onThemeChange } from "../theme";

export type ShellKind = "powershell" | "cmd" | "wsl";
const SHELL_LABELS: Record<ShellKind, string> = { powershell: "PowerShell", cmd: "Command Prompt", wsl: "WSL" };
const SHELL_ICONS = { powershell: SquareTerminal, cmd: TerminalIcon, wsl: Box };
const SHELLS = Object.keys(SHELL_LABELS) as ShellKind[];

/** Live terminals, so a theme change can recolor all of them. */
const liveTerms = new Set<XTerm>();

/** xterm colors from the CSS tokens (--term-*), so the console matches the app theme. */
function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--term-bg", "#161616"),
    foreground: v("--term-fg", "#e8e8e8"),
    cursor: v("--term-cursor", "#60cdff"),
    cursorAccent: v("--term-bg", "#161616"),
    selectionBackground: v("--term-selection", "#264f78"),
  };
}

const MIN_FONT = 9;
const MAX_FONT = 24;

/** Ask the terminal to open a new tab, optionally typing a command into it once. */
export interface TerminalRequest {
  shell: ShellKind;
  text?: string;
  nonce: number;
}

interface Tab {
  key: number;
  shell: ShellKind;
  /** Typed once into the new shell (from "Open in terminal"). */
  initialInput?: string;
}

interface Props {
  active: boolean;
  /** The app runs as administrator, so every shell does too. */
  elevated: boolean;
  request: TerminalRequest | null;
  onRequestHandled: () => void;
}

export function Terminal({ active, elevated, request, onRequestHandled }: Props) {
  const [tabs, setTabs] = useState<Tab[]>([{ key: 1, shell: "powershell" }]);
  const [current, setCurrent] = useState(1);
  const nextKey = useRef(2);
  const handledNonce = useRef<number | null>(null);

  const add = (shell: ShellKind, initialInput?: string) => {
    const key = nextKey.current++;
    setTabs((t) => [...t, { key, shell, initialInput }]);
    setCurrent(key);
  };

  // Each request opens exactly one new tab, once (the ref also survives StrictMode's double run).
  useEffect(() => {
    if (!request || request.nonce === handledNonce.current) return;
    handledNonce.current = request.nonce;
    add(request.shell, request.text);
    onRequestHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const close = (key: number) => {
    const rest = tabs.filter((x) => x.key !== key);
    if (rest.length === 0) {
      const fresh: Tab = { key: nextKey.current++, shell: "powershell" };
      setTabs([fresh]);
      setCurrent(fresh.key);
      return;
    }
    setTabs(rest);
    if (key === current) setCurrent(rest[rest.length - 1].key);
  };

  // Recolor every open terminal when the Windows theme or the app's theme setting changes.
  useEffect(
    () =>
      onThemeChange(() =>
        requestAnimationFrame(() => {
          const theme = termTheme();
          liveTerms.forEach((t) => (t.options.theme = theme));
        }),
      ),
    [],
  );

  // Ctrl+Shift+T opens another tab of the current shell, like Windows Terminal.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        e.stopPropagation();
        add(tabs.find((t) => t.key === current)?.shell ?? "powershell");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <div className="page page-fill terminal-page">
      <PageHeader
        title="Terminal"
        subtitle="Type commands in PowerShell, Command Prompt or WSL. Saved fixes are one click away on the Quick fixes page."
      />
      <div className="console">
        <div className="tabs" role="tablist" aria-label="Terminal tabs">
          {tabs.map((t) => {
            const Icon = SHELL_ICONS[t.shell];
            return (
              <div
                key={t.key}
                role="tab"
                tabIndex={t.key === current ? 0 : -1}
                aria-selected={t.key === current}
                className={`tab ${t.key === current ? "tab-active" : ""}`}
                onClick={() => setCurrent(t.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setCurrent(t.key);
                  }
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) close(t.key);
                }}
              >
                <Icon size={14} />
                <span className="tab-label">{SHELL_LABELS[t.shell]}</span>
                {elevated && (
                  <span className="tab-admin" title="Running as administrator">
                    <ShieldCheck size={12} />
                  </span>
                )}
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    close(t.key);
                  }}
                  aria-label={`Close ${SHELL_LABELS[t.shell]} tab`}
                  title="Close tab"
                >
                  <X size={13} />
                </button>
              </div>
            );
          })}
          <Menu
            label="New tab"
            className="icon-btn icon-btn-sm tab-new"
            align="start"
            items={SHELLS.map((s) => ({ label: SHELL_LABELS[s], icon: SHELL_ICONS[s], onSelect: () => add(s), hint: s === "powershell" ? "Ctrl+Shift+T" : undefined }))}
          >
            <Plus size={16} />
          </Menu>
        </div>
        <div className="terminal-host">
          {tabs.map((t) => (
            <TerminalView key={t.key} shell={t.shell} visible={active && t.key === current} initialInput={t.initialInput} />
          ))}
        </div>
        <div className="console-foot" aria-hidden="true">
          <span>
            <kbd>Ctrl</kbd>+<kbd>C</kbd> copies selected text
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>V</kbd> or right-click pastes
          </span>
          <span>
            <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>-</kbd> text size
          </span>
        </div>
      </div>
    </div>
  );
}

/** One running shell. Keystrokes are queued until its id is known and sent in order. */
interface Session {
  id: number | null;
  alive: boolean;
  queue: string[];
  writing: boolean;
}

function flush(s: Session) {
  if (s.writing || s.id === null || !s.alive || s.queue.length === 0) return;
  const data = s.queue.join("");
  s.queue = [];
  s.writing = true;
  api
    .terminalWrite(s.id, data)
    .catch(() => {})
    .finally(() => {
      s.writing = false;
      flush(s);
    });
}

function send(s: Session, data: string) {
  s.queue.push(data);
  flush(s);
}

function TerminalView({ shell, visible, initialInput }: { shell: ShellKind; visible: boolean; initialInput?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const startRef = useRef<(() => void) | null>(null);
  const restartRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);
  const pendingInput = useRef(initialInput);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    startedRef.current = false;
    const term = new XTerm({
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: termTheme(),
    });
    liveTerms.add(term);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    // Windows-style copy and paste: Ctrl+C copies when text is selected (otherwise it interrupts),
    // Ctrl+V lets the browser paste. Ctrl+K belongs to the command palette.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && !e.shiftKey && !e.altKey && k === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
        return false;
      }
      if (e.ctrlKey && !e.altKey && k === "v") return false;
      if ((e.ctrlKey || e.metaKey) && k === "k") return false;
      // Ctrl + and Ctrl - change the text size; Ctrl+0 resets it.
      if (e.ctrlKey && !e.altKey && (k === "=" || k === "+" || k === "-" || k === "0")) {
        const size = term.options.fontSize ?? 13;
        term.options.fontSize = k === "0" ? 13 : Math.max(MIN_FONT, Math.min(MAX_FONT, size + (k === "-" ? -1 : 1)));
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
        return false;
      }
      return true;
    });

    // Right-click copies the selection if there is one, otherwise pastes (like Windows Terminal).
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
        term.clearSelection();
      } else {
        navigator.clipboard
          .readText()
          .then((text) => text && term.paste(text))
          .catch(() => {});
      }
    };
    hostRef.current!.addEventListener("contextmenu", onContextMenu);

    const start = () => {
      const s: Session = { id: null, alive: true, queue: [], writing: false };
      sessionRef.current = s;
      setExited(false);
      const { rows, cols } = term;
      const channel = new Channel<TermEvent>();
      channel.onmessage = (m) => {
        if (sessionRef.current !== s) return;
        if (m.type === "output") {
          term.write(m.data, () => {
            // Type the requested command only once the shell has started talking (and xterm has
            // answered its startup queries), so it reaches the prompt.
            const input = pendingInput.current;
            if (input && sessionRef.current === s) {
              pendingInput.current = undefined;
              send(s, input + "\r");
            }
          });
        } else {
          s.alive = false;
          const code = m.code ? ` with code ${m.code}` : "";
          term.write(`\r\n\x1b[90m[${SHELL_LABELS[shell]} exited${code}. Press Enter or click Restart shell to start it again.]\x1b[0m\r\n`);
          setExited(true);
        }
      };
      api
        .terminalSpawn(shell, rows, cols, channel)
        .then((id) => {
          // The tab was closed (or restarted) before the shell started.
          if (sessionRef.current !== s) {
            api.terminalClose(id).catch(() => {});
            return;
          }
          s.id = id;
          if (term.rows !== rows || term.cols !== cols) api.terminalResize(id, term.rows, term.cols).catch(() => {});
          flush(s);
        })
        .catch((e) => {
          if (sessionRef.current !== s) return;
          s.alive = false;
          term.write(`\x1b[31mCould not start ${SHELL_LABELS[shell]}: ${errorText(e)}\x1b[0m\r\n`);
          if (pendingInput.current) {
            term.write(`\x1b[31mCould not run: ${pendingInput.current}\x1b[0m\r\n`);
            pendingInput.current = undefined;
          }
          setExited(true);
        });
    };
    startRef.current = start;
    restartRef.current = () => {
      term.write("\r\n");
      start();
      term.focus();
    };

    const input = term.onData((data) => {
      const s = sessionRef.current;
      if (!s) return;
      if (!s.alive) {
        if (data === "\r") restartRef.current?.();
        return;
      }
      send(s, data);
    });
    const resize = term.onResize(({ rows, cols }) => {
      const s = sessionRef.current;
      if (s?.id != null && s.alive) api.terminalResize(s.id, rows, cols).catch(() => {});
    });
    const observer = new ResizeObserver(() => {
      if (hostRef.current?.offsetParent) {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
    });
    observer.observe(hostRef.current!);

    const host = hostRef.current!;
    return () => {
      host.removeEventListener("contextmenu", onContextMenu);
      liveTerms.delete(term);
      const s = sessionRef.current;
      sessionRef.current = null;
      if (s?.id != null && s.alive) api.terminalClose(s.id).catch(() => {});
      observer.disconnect();
      input.dispose();
      resize.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [shell]);

  // The shell starts the first time the tab is shown, so it gets the real window size.
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term) return;
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      term.focus();
      if (!startedRef.current) {
        startedRef.current = true;
        startRef.current?.();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <div className="terminal-wrap" style={{ display: visible ? "block" : "none" }}>
      <div ref={hostRef} className="terminal-view" />
      {exited && (
        <button className="btn btn-sm terminal-restart" onClick={() => restartRef.current?.()}>
          <RotateCcw size={14} /> Restart shell
        </button>
      )}
    </div>
  );
}
