import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Command } from "lucide-react";
import { SavedCommand } from "./api";
import { CommandPalette } from "./components/CommandPalette";
import { ToastProvider } from "./components/Toast";
import { pct } from "./format";
import { useMetrics } from "./hooks/useMetrics";
import { PAGES, PageId } from "./pages";
import { Activity } from "./pages/Activity";
import { Commands } from "./pages/Commands";
import { Dashboard } from "./pages/Dashboard";
import { Processes } from "./pages/Processes";
import { Startup } from "./pages/Startup";
import { Terminal } from "./pages/Terminal";

export default function App() {
  const metrics = useMetrics();
  const [page, setPage] = useState<PageId>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingRun, setPendingRun] = useState<SavedCommand | null>(null);
  const [processQuery, setProcessQuery] = useState<string | undefined>();
  const [terminalInject, setTerminalInject] = useState<{ text: string; nonce: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey, true);
    const unlisten = listen("app://open-palette", () => setPaletteOpen(true));
    return () => {
      window.removeEventListener("keydown", onKey, true);
      unlisten.then((f) => f());
    };
  }, []);

  const navigate = useCallback((id: PageId, opts?: { processQuery?: string }) => {
    if (opts?.processQuery !== undefined) setProcessQuery(opts.processQuery);
    setPage(id);
  }, []);

  const runCommand = useCallback((cmd: SavedCommand) => {
    setPendingRun(cmd);
    setPage("commands");
  }, []);

  const openInTerminal = useCallback((text: string) => {
    setTerminalInject({ text, nonce: Date.now() });
    setPage("terminal");
  }, []);

  const m = metrics.latest;
  const memPct = m ? (m.memUsed / m.memTotal) * 100 : 0;

  return (
    <ToastProvider>
      <div className="app">
        <nav className="sidebar">
          <div className="brand">
            <span className="brand-mark">U</span>
            <span>Ultimate PC Tool</span>
          </div>
          <button className="palette-trigger" onClick={() => setPaletteOpen(true)}>
            <Command size={14} /> Search or run
            <kbd>Ctrl K</kbd>
          </button>
          <ul>
            {PAGES.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button className={`nav-item ${page === id ? "active" : ""}`} onClick={() => setPage(id)}>
                  <Icon size={18} />
                  {label}
                </button>
              </li>
            ))}
          </ul>
          {m && (
            <div className="sidebar-stats">
              <div>
                <span>CPU</span>
                <div className="bar">
                  <div className="bar-fill" style={{ width: `${m.cpuTotal}%` }} />
                </div>
                <span>{pct(m.cpuTotal)}</span>
              </div>
              <div>
                <span>RAM</span>
                <div className="bar">
                  <div className="bar-fill mem" style={{ width: `${memPct}%` }} />
                </div>
                <span>{pct(memPct)}</span>
              </div>
            </div>
          )}
        </nav>

        <main className="content">
          {page === "dashboard" && <Dashboard metrics={metrics} />}
          {page === "processes" && <Processes active initialQuery={processQuery} />}
          {page === "commands" && (
            <Commands pendingRun={pendingRun} onPendingHandled={() => setPendingRun(null)} onOpenInTerminal={openInTerminal} />
          )}
          {/* Terminal stays mounted so shells survive page switches. */}
          <div style={{ display: page === "terminal" ? "contents" : "none" }}>
            <Terminal active={page === "terminal"} inject={terminalInject} />
          </div>
          {page === "startup" && <Startup />}
          {page === "activity" && <Activity />}
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNavigate={navigate}
          onRunCommand={runCommand}
          onOpenInTerminal={openInTerminal}
        />
      )}
    </ToastProvider>
  );
}
