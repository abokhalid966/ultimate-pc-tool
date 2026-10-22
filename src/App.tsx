import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Search, ShieldCheck } from "lucide-react";
import { api, AppInfo, CloseAction, errorText, SavedCommand, Shell } from "./api";
import { AppIcon } from "./components/AppIcon";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmProvider } from "./components/Confirm";
import { Modal } from "./components/Modal";
import { ToastProvider, useToast } from "./components/Toast";
import { pct } from "./format";
import { useCleanTemp } from "./hooks/useActions";
import { useMetrics } from "./hooks/useMetrics";
import { REFRESH_EVENT } from "./hooks/useRefresh";
import { RunsProvider } from "./hooks/useRuns";
import { PAGES, PageId, SECTIONS } from "./pages";
import { Activity } from "./pages/Activity";
import { Apps } from "./pages/Apps";
import { Commands, PendingRun } from "./pages/Commands";
import { Dashboard } from "./pages/Dashboard";
import { Health } from "./pages/Health";
import { ProcessSortKey, Processes } from "./pages/Processes";
import { Services } from "./pages/Services";
import { Settings } from "./pages/Settings";
import { Startup } from "./pages/Startup";
import { Storage } from "./pages/Storage";
import { Automations } from "./pages/Automations";
import { Boost } from "./pages/Boost";
import { Drivers } from "./pages/Drivers";
import { Network } from "./pages/Network";
import { Privacy } from "./pages/Privacy";
import { SystemInfo } from "./pages/SystemInfo";
import { ShellKind, Terminal, TerminalRequest } from "./pages/Terminal";

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppShell />
      </ConfirmProvider>
    </ToastProvider>
  );
}

export interface NavigateOptions {
  processQuery?: string;
  processSort?: ProcessSortKey;
}

function AppShell() {
  const metrics = useMetrics();
  const toast = useToast();
  const cleanTemp = useCleanTemp();
  const [page, setPage] = useState<PageId>("dashboard");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  const [processQuery, setProcessQuery] = useState<string | undefined>();
  const [processSort, setProcessSort] = useState<{ key: ProcessSortKey; nonce: number } | undefined>();
  const [terminalRequest, setTerminalRequest] = useState<TerminalRequest | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo>({ elevated: false, version: "" });
  const [askClose, setAskClose] = useState(false);

  useEffect(() => {
    api.appInfo().then(setAppInfo).catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "k") {
        // Stopped here so a focused terminal doesn't also receive ^K.
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen((open) => !open);
        return;
      }
      // Ctrl+1..9 jump to the pages in sidebar order.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
        const target = PAGES[Number(e.key) - 1];
        if (target) {
          e.preventDefault();
          e.stopPropagation();
          setPage(target.id);
        }
        return;
      }
      // A reload would reset every page and orphan the terminal tabs, so F5 refreshes the
      // current page instead, and Ctrl+R / Ctrl+P (reload, print) do nothing. A focused
      // terminal still receives Ctrl+R and Ctrl+P for its shell.
      if (import.meta.env.PROD && (key === "f5" || ((e.ctrlKey || e.metaKey) && (key === "r" || key === "p")))) {
        e.preventDefault();
        if (key === "f5") window.dispatchEvent(new Event(REFRESH_EVENT));
      }
    };
    window.addEventListener("keydown", onKey, true);
    const unlisten = [
      listen("app://open-palette", () => setPaletteOpen(true)),
      listen("app://close-requested", () => setAskClose(true)),
    ];
    return () => {
      window.removeEventListener("keydown", onKey, true);
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, []);

  // Messages from the backend, e.g. a damaged settings file that was set aside.
  useEffect(() => {
    const show = () =>
      api
        .takeNotices()
        .then((list) => list.forEach((text) => toast(text, "error")))
        .catch(() => {});
    show();
    const unlisten = listen("app://notice", show);
    return () => {
      unlisten.then((f) => f());
    };
  }, [toast]);

  const navigate = useCallback((id: PageId, opts?: NavigateOptions) => {
    if (opts?.processQuery !== undefined) setProcessQuery(opts.processQuery);
    if (opts?.processSort) setProcessSort({ key: opts.processSort, nonce: Date.now() });
    setPage(id);
  }, []);

  const runCommand = useCallback((cmd: SavedCommand) => {
    setPendingRun({ cmd, nonce: Date.now() });
    setPage("commands");
  }, []);

  const openTerminal = useCallback((shell: ShellKind, text?: string) => {
    setTerminalRequest({ shell, text, nonce: Date.now() });
    setPage("terminal");
  }, []);

  const openInTerminal = useCallback((text: string, shell: Shell) => openTerminal(shell, text), [openTerminal]);

  const restartAsAdmin = useCallback(() => {
    api.restartAsAdmin().catch((e) => toast(errorText(e), "error"));
  }, [toast]);

  const m = metrics.latest;
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const settingsPage = PAGES.find((p) => p.id === "settings")!;

  const navButton = ({ id, label, icon: Icon }: (typeof PAGES)[number]) => (
    <button
      className={`nav-item ${page === id ? "active" : ""}`}
      aria-current={page === id ? "page" : undefined}
      onClick={() => setPage(id)}
      title={`${label} (Ctrl+${PAGES.findIndex((p) => p.id === id) + 1})`}
    >
      <Icon size={18} />
      {label}
    </button>
  );

  return (
    <RunsProvider notify={page !== "commands"}>
      <div className="app">
        <nav className="sidebar" aria-label="Main">
          <div className="brand">
            <AppIcon className="brand-mark" />
            <div className="brand-text">
              <span className="brand-name">Optimo</span>
              <span className="brand-sub">{appInfo.version ? `Version ${appInfo.version}` : "For Windows"}</span>
            </div>
          </div>
          <button className="palette-trigger" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K">
            <Search size={15} /> Search or run
            <span className="kbd-combo">
              <kbd>Ctrl</kbd>+<kbd>K</kbd>
            </span>
          </button>
          <div className="nav">
            {SECTIONS.map((section) => (
              <div key={section}>
                <div className="nav-section">{section}</div>
                <ul>
                  {PAGES.filter((p) => p.section === section).map((p) => (
                    <li key={p.id}>{navButton(p)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="sidebar-bottom">
            {m && (
              <button className="sidebar-stats" onClick={() => setPage("dashboard")} title="Open the dashboard">
                <span className="sidebar-stat">
                  <span>CPU</span>
                  <span className="bar">
                    <span className="bar-fill" style={{ width: `${Math.min(m.cpuTotal, 100)}%`, display: "block" }} />
                  </span>
                  <span>{pct(m.cpuTotal)}</span>
                </span>
                <span className="sidebar-stat">
                  <span>Memory</span>
                  <span className="bar">
                    <span className="bar-fill mem" style={{ width: `${Math.min(memPct, 100)}%`, display: "block" }} />
                  </span>
                  <span>{pct(memPct)}</span>
                </span>
              </button>
            )}
            {navButton(settingsPage)}
            <div className="sidebar-foot">
              {appInfo.elevated ? (
                <span className="pill pill-warn" title="Everything this app does, including terminal tabs, runs with administrator rights.">
                  <ShieldCheck size={13} /> Running as administrator
                </span>
              ) : (
                <button className="btn btn-sm btn-ghost" onClick={restartAsAdmin} title="Needed to change startup apps for all users">
                  <ShieldCheck size={15} /> Restart as administrator
                </button>
              )}
            </div>
          </div>
        </nav>

        <main className="content">
          {page === "dashboard" && <Dashboard metrics={metrics} onNavigate={navigate} onCleanTemp={cleanTemp.run} />}
          {page === "health" && <Health elevated={appInfo.elevated} onNavigate={navigate} onRestartAsAdmin={restartAsAdmin} />}
          {page === "processes" && (
            <Processes active initialQuery={processQuery} initialSort={processSort} metrics={metrics.latest} />
          )}
          {page === "commands" && (
            <Commands
              pendingRun={pendingRun}
              onPendingHandled={() => setPendingRun(null)}
              onOpenInTerminal={openInTerminal}
              onCleanTemp={cleanTemp.run}
              cleaningTemp={cleanTemp.busy}
              elevated={appInfo.elevated}
            />
          )}
          {/* Terminal stays mounted so shells survive page switches. */}
          <div style={{ display: page === "terminal" ? "contents" : "none" }}>
            <Terminal
              active={page === "terminal"}
              elevated={appInfo.elevated}
              request={terminalRequest}
              onRequestHandled={() => setTerminalRequest(null)}
            />
          </div>
          {page === "startup" && <Startup elevated={appInfo.elevated} onRestartAsAdmin={restartAsAdmin} />}
          {page === "apps" && <Apps elevated={appInfo.elevated} onRestartAsAdmin={restartAsAdmin} />}
          {page === "services" && <Services elevated={appInfo.elevated} onRestartAsAdmin={restartAsAdmin} />}
          {page === "automations" && <Automations elevated={appInfo.elevated} />}
          {page === "storage" && <Storage elevated={appInfo.elevated} onRestartAsAdmin={restartAsAdmin} disks={m?.disks ?? []} />}
          {page === "sysinfo" && <SystemInfo />}
          {page === "drivers" && <Drivers />}
          {page === "network" && <Network elevated={appInfo.elevated} onRestartAsAdmin={restartAsAdmin} />}
          {page === "boost" && <Boost onRestartAsAdmin={restartAsAdmin} />}
          {page === "privacy" && <Privacy elevated={appInfo.elevated} onRestartAsAdmin={restartAsAdmin} />}
          {page === "activity" && <Activity elevated={appInfo.elevated} />}
          {page === "settings" && <Settings appInfo={appInfo} onRestartAsAdmin={restartAsAdmin} />}
        </main>
      </div>

      {paletteOpen && (
        <CommandPalette
          elevated={appInfo.elevated}
          onClose={() => setPaletteOpen(false)}
          onNavigate={navigate}
          onRunCommand={runCommand}
          onOpenTerminal={openTerminal}
          onCleanTemp={cleanTemp.run}
          onRestartAsAdmin={restartAsAdmin}
        />
      )}

      {askClose && <CloseDialog onDone={() => setAskClose(false)} />}
    </RunsProvider>
  );
}

/** Asked the first time the window is closed, so the app never seems to vanish into the tray. */
function CloseDialog({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [remember, setRemember] = useState(true);

  const choose = async (action: CloseAction) => {
    try {
      await api.closeMainWindow(action, remember);
      onDone();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  return (
    <Modal
      title="Keep Optimo running?"
      onClose={onDone}
      footer={
        <>
          <button className="btn" onClick={() => choose("quit")}>
            Quit
          </button>
          <button className="btn btn-primary" autoFocus onClick={() => choose("tray")}>
            Keep running in the tray
          </button>
        </>
      }
    >
      <p>
        The app can keep running in the system tray, near the clock (Windows may hide it behind the <strong>^</strong> arrow). The tray
        icon shows CPU and memory use, and a click brings this window back.
      </p>
      <p className="muted">To quit later, right-click the tray icon and choose Quit.</p>
      <p style={{ marginTop: 16 }}>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Remember my choice. You can change it later in Settings.</span>
        </label>
      </p>
    </Modal>
  );
}
