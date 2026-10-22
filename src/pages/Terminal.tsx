import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Plus, X } from "lucide-react";
import { api, errorText } from "../api";

type ShellKind = "powershell" | "cmd" | "wsl";
const SHELL_LABELS: Record<ShellKind, string> = { powershell: "PowerShell", cmd: "Command Prompt", wsl: "WSL" };

interface Tab {
  key: number;
  shell: ShellKind;
}

interface Props {
  active: boolean;
  /** Text to type into the current tab (from "Open in terminal"); `nonce` makes repeats distinct. */
  inject: { text: string; nonce: number } | null;
}

export function Terminal({ active, inject }: Props) {
  const [tabs, setTabs] = useState<Tab[]>([{ key: 1, shell: "powershell" }]);
  const [current, setCurrent] = useState(1);
  const nextKey = useRef(2);

  const add = (shell: ShellKind) => {
    const key = nextKey.current++;
    setTabs((t) => [...t, { key, shell }]);
    setCurrent(key);
  };

  const close = (key: number) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.key !== key);
      if (rest.length === 0) {
        const fresh = { key: nextKey.current++, shell: "powershell" as ShellKind };
        setCurrent(fresh.key);
        return [fresh];
      }
      if (key === current) setCurrent(rest[rest.length - 1].key);
      return rest;
    });
  };

  return (
    <div className="page page-fill terminal-page">
      <div className="tabs">
        {tabs.map((t) => (
          <div key={t.key} className={`tab ${t.key === current ? "tab-active" : ""}`} onClick={() => setCurrent(t.key)}>
            {SHELL_LABELS[t.shell]}
            <button
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                close(t.key);
              }}
              aria-label="Close tab"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="tab-add">
          <Plus size={14} />
          {(Object.keys(SHELL_LABELS) as ShellKind[]).map((s) => (
            <button key={s} className="btn btn-sm btn-ghost" onClick={() => add(s)}>
              {SHELL_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="terminal-host">
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            shell={t.shell}
            visible={active && t.key === current}
            inject={t.key === current ? inject : null}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalView({
  shell,
  visible,
  inject,
}: {
  shell: ShellKind;
  visible: boolean;
  inject: Props["inject"];
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<number | null>(null);
  const lastInject = useRef<number | null>(null);
  const spawnedRef = useRef(false);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    spawnedRef.current = false;
    idRef.current = null;
    const term = new XTerm({
      fontFamily: "'Cascadia Mono', Consolas, 'Courier New', monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: "#0b0d12", foreground: "#d7dae0", cursor: "#7aa2f7", selectionBackground: "#2a3350" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    termRef.current = term;
    fitRef.current = fit;

    const unlisteners = [
      listen<{ id: number; data: string }>("terminal://output", (e) => {
        if (e.payload.id === idRef.current) term.write(e.payload.data);
      }),
      listen<number>("terminal://exit", (e) => {
        if (e.payload === idRef.current) term.write("\r\n\x1b[90m[process exited — close this tab or open a new one]\x1b[0m\r\n");
      }),
    ];

    const input = term.onData((data) => idRef.current !== null && api.terminalWrite(idRef.current, data));
    const resize = term.onResize(({ rows, cols }) => idRef.current !== null && api.terminalResize(idRef.current, rows, cols));
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

    return () => {
      disposedRef.current = true;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      unlisteners.forEach((p) => p.then((f) => f()));
      if (idRef.current !== null) api.terminalClose(idRef.current);
      term.dispose();
    };
  }, [shell]);

  // The shell starts the first time the tab is shown, so it gets the real window size.
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      const term = termRef.current;
      if (!term) return;
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      term.focus();
      if (spawnedRef.current) return;
      spawnedRef.current = true;
      api
        .terminalSpawn(shell, term.rows, term.cols)
        .then((id) => {
          // StrictMode / fast tab close: the view may be gone before the shell started.
          if (disposedRef.current) api.terminalClose(id);
          else idRef.current = id;
        })
        .catch((e) => term.write(`\x1b[31mCould not start ${shell}: ${errorText(e)}\x1b[0m\r\n`));
    });
  }, [visible, shell]);

  useEffect(() => {
    if (!inject || inject.nonce === lastInject.current) return;
    lastInject.current = inject.nonce;
    const send = () => {
      if (idRef.current === null) return setTimeout(send, 200);
      api.terminalWrite(idRef.current, inject.text + "\r");
    };
    send();
  }, [inject]);

  return <div ref={hostRef} className="terminal-view" style={{ display: visible ? "block" : "none" }} />;
}
