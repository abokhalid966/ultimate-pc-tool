import { useEffect, useMemo, useRef, useState } from "react";
import {
  Brush,
  Code,
  CircleCheck,
  CircleX,
  Copy,
  CopyPlus,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  SearchX,
  ShieldCheck,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
  Zap,
} from "lucide-react";
import { api, errorText, Risk, SavedCommand, Shell } from "../api";
import { categoryLook } from "../categories";
import { useConfirm } from "../components/Confirm";
import { EmptyState, ErrorState } from "../components/EmptyState";
import { Menu } from "../components/Menu";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { SearchBox } from "../components/SearchBox";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { clock, commandVariables, fillVariables } from "../format";
import { useAsync } from "../hooks/useAsync";
import { useOnRefresh } from "../hooks/useRefresh";
import { Run, useRuns } from "../hooks/useRuns";

const EMPTY: SavedCommand = {
  id: "",
  name: "",
  description: "",
  command: "",
  shell: "powershell",
  admin: false,
  category: "My commands",
  risk: "safe",
  warning: null,
};

const MY_COMMANDS = "My commands";

/** A run request from the command palette; `nonce` makes each request distinct. */
export interface PendingRun {
  cmd: SavedCommand;
  nonce: number;
}

interface Props {
  /** Set by the command palette: start this saved command once (confirming first when needed). */
  pendingRun: PendingRun | null;
  onPendingHandled: () => void;
  onOpenInTerminal: (text: string, shell: Shell) => void;
  onCleanTemp: () => void;
  cleaningTemp: boolean;
  elevated: boolean;
}

type Target = "run" | "terminal";

/** Fills placeholders for a preview or a run; `error` explains a value that can't be used. */
function fill(cmd: SavedCommand, values: Record<string, string>): { text: string; error?: string } {
  const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
  try {
    return { text: fillVariables(cmd.command, filled, cmd.shell) };
  } catch (e) {
    return { text: cmd.command, error: errorText(e) };
  }
}

/** Shows the preview with the placeholders still to fill highlighted. */
function Preview({ text, pending }: { text: string; pending: string[] }) {
  if (pending.length === 0) return <>{text}</>;
  const names = pending.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(\\{(?:${names})(?::raw)?\\})`, "g"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="var">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** "host_name" -> "Host name" */
const humanize = (name: string) => {
  const s = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const hintFor = (name: string) =>
  /host|site|url|domain|server|address/i.test(name)
    ? "e.g. example.com"
    : /path|folder|dir|file/i.test(name)
      ? "e.g. C:\\Users\\You\\Documents"
      : /port/i.test(name)
        ? "e.g. 443"
        : /name|app|process/i.test(name)
          ? "e.g. notepad"
          : "";

const runFailed = (r: Run) => r.status === "error" || !!r.output?.stopped || (!!r.output && !r.output.elevated && r.output.code !== 0);

export function Commands({ pendingRun, onPendingHandled, onOpenInTerminal, onCleanTemp, cleaningTemp, elevated }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const runs = useRuns();
  const { data: commands, error: loadError, loaded, reload } = useAsync(api.commands, [] as SavedCommand[]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SavedCommand | null>(null);
  const [asking, setAsking] = useState<{ cmd: SavedCommand; values: Record<string, string>; target: Target; fromPalette: boolean } | null>(null);
  const [shownRun, setShownRun] = useState<string | null>(null);
  const [panelHidden, setPanelHidden] = useState(false);
  const handledNonce = useRef<number | null>(null);

  useOnRefresh(reload);

  // Handled once per request: the ref survives StrictMode's double effect run in dev.
  useEffect(() => {
    if (!pendingRun || pendingRun.nonce === handledNonce.current) return;
    handledNonce.current = pendingRun.nonce;
    start(pendingRun.cmd, "run", true);
    onPendingHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun]);

  const categories = useMemo(() => [...new Set(commands.map((c) => c.category.trim()).filter(Boolean))].sort(), [commands]);

  const byCategory = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = commands.filter((c) => !q || [c.name, c.description, c.command, c.category].some((f) => f.toLowerCase().includes(q)));
    const map = new Map<string, SavedCommand[]>();
    for (const c of list) map.set(c.category, [...(map.get(c.category) ?? []), c]);
    // The user's own commands first, then the built-in groups alphabetically.
    return [...map.entries()].sort(([a], [b]) => Number(b === MY_COMMANDS) - Number(a === MY_COMMANDS) || a.localeCompare(b));
  }, [commands, query]);

  function start(cmd: SavedCommand, target: Target, fromPalette = false) {
    const vars = commandVariables(cmd.command);
    if (vars.length) setAsking({ cmd, values: Object.fromEntries(vars.map((v) => [v, ""])), target, fromPalette });
    else execute(cmd, cmd.command, target, fromPalette);
  }

  async function execute(cmd: SavedCommand, command: string, target: Target, fromPalette: boolean) {
    // Risky commands always ask first (the terminal runs them right away too). From the palette
    // (one Enter on a fuzzy match), admin commands ask as well; on this page their card already
    // shows the Admin badge.
    if (cmd.risk !== "safe" || (fromPalette && cmd.admin)) {
      const ok = await confirm({
        title: `Run “${cmd.name}”?`,
        message: cmd.description,
        warning: cmd.warning,
        code: command,
        badge: cmd.admin && target === "run" && (
          <span className="pill pill-warn">
            <ShieldCheck size={12} /> Opens an administrator window
          </span>
        ),
        confirmLabel: target === "terminal" ? "Open in terminal" : "Run",
        danger: cmd.risk === "danger",
      });
      if (!ok) return;
    }
    if (target === "terminal") {
      onOpenInTerminal(command, cmd.shell);
      return;
    }
    runs.start(cmd, command);
    setShownRun(null);
    setPanelHidden(false);
  }

  async function save(cmd: SavedCommand) {
    try {
      // "network" and "Network" are one group: reuse the existing spelling.
      const category = categories.find((c) => c.toLowerCase() === cmd.category.trim().toLowerCase()) ?? (cmd.category.trim() || MY_COMMANDS);
      await api.saveCommand({ ...cmd, name: cmd.name.trim(), category });
      setEditing(null);
      toast(`Saved “${cmd.name.trim()}”`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      reload();
    }
  }

  async function remove(cmd: SavedCommand) {
    try {
      const activityId = await api.deleteCommand(cmd.id);
      toast(`Deleted “${cmd.name}”`, "success", {
        action: activityId
          ? {
              label: "Undo",
              run: () =>
                api
                  .undoActivity(activityId)
                  .then(() => toast(`Restored “${cmd.name}”`, "success"))
                  .catch((e) => toast(errorText(e), "error"))
                  .finally(reload),
            }
          : undefined,
      });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      reload();
    }
  }

  async function restoreBuiltins() {
    try {
      const added = await api.restoreBuiltinCommands();
      toast(added ? `Restored ${added} built-in fix${added > 1 ? "es" : ""}` : "All built-in fixes are already here", "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      reload();
    }
  }

  const run = panelHidden ? undefined : (runs.runs.find((r) => r.id === shownRun) ?? runs.runs[0]);
  const askingFill = asking && fill(asking.cmd, asking.values);
  const askingReady = asking && !askingFill?.error && Object.values(asking.values).every((v) => v.trim());
  const submitAsking = () => {
    if (!asking || !askingReady) return;
    execute(asking.cmd, fillVariables(asking.cmd.command, asking.values, asking.cmd.shell), asking.target, asking.fromPalette);
    setAsking(null);
  };

  const showRun = (id: string) => {
    setShownRun(id);
    setPanelHidden(false);
  };

  const runAgain = (r: Run) => {
    const cmd = commands.find((c) => c.id === r.cmdId) ?? { ...EMPTY, id: r.cmdId, name: r.name, command: r.command, shell: r.shell, admin: r.admin };
    execute(cmd, r.command, "run", false);
  };

  return (
    <div className="page page-fill">
      <PageHeader
        title="Quick fixes"
        subtitle="One-click fixes for common problems, plus your own saved commands."
        actions={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Search fixes and commands" />
            <Menu
              label="More options"
              items={[{ label: "Restore built-in fixes", icon: RotateCcw, onSelect: restoreBuiltins, title: "Add back any built-in fix you deleted" }]}
            />
            <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}>
              <Plus size={16} /> New command
            </button>
          </>
        }
      />

      <div className="split">
        <div className="scroll">
          {loadError && commands.length === 0 ? (
            <ErrorState what="your commands" message={loadError} onRetry={reload} />
          ) : !loaded ? (
            <section className="cmd-section">
              <Skeleton width={120} height={14} style={{ marginBottom: 12 }} />
              <div className="fix-list card">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="fix-row" aria-hidden="true">
                    <Skeleton width={36} height={36} radius={8} />
                    <div>
                      <Skeleton width={`${30 + i * 6}%`} height={14} />
                      <Skeleton width="60%" style={{ marginTop: 8 }} />
                    </div>
                    <Skeleton width={72} height={28} radius={6} />
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <>
              {!query && (
                <section className="cmd-section">
                  <h2 className="section-title">Cleanup</h2>
                  <div className="fix-list card">
                    <div className="fix-row" style={{ "--cat": "var(--cat-cleanup)" } as React.CSSProperties}>
                      <span className="cmd-icon">
                        <Brush size={18} />
                      </span>
                      <div className="fix-text">
                        <div className="fix-name">
                          <strong>Clean temp files</strong>
                        </div>
                        <p className="fix-desc">Frees space taken by old temporary files. Shows how much first, and keeps anything used in the last day.</p>
                      </div>
                      <div className="fix-actions">
                        <button className="btn btn-sm" onClick={onCleanTemp} disabled={cleaningTemp}>
                          {cleaningTemp ? <span className="spinner" /> : <Brush size={14} />} {cleaningTemp ? "Checking…" : "Check and clean"}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              )}
              {byCategory.map(([category, list]) => (
                <section key={category} className="cmd-section">
                  <h2 className="section-title">
                    {category} <span className="count">{list.length}</span>
                  </h2>
                  <div className="fix-list card">
                    {list.map((c) => {
                      const cardRuns = runs.runs.filter((r) => r.cmdId === c.id);
                      return (
                        <FixRow
                          key={c.id}
                          cmd={c}
                          elevated={elevated}
                          running={cardRuns.some((r) => r.status === "running")}
                          lastRun={cardRuns.find((r) => r.status !== "running")}
                          onShowRun={showRun}
                          onRun={() => start(c, "run")}
                          onTerminal={() => start(c, "terminal")}
                          onEdit={() => setEditing({ ...c })}
                          onDuplicate={() => setEditing({ ...c, id: "", name: `${c.name} (copy)`, category: MY_COMMANDS })}
                          onDelete={() => remove(c)}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
              {byCategory.length === 0 &&
                (query ? (
                  <EmptyState
                    icon={SearchX}
                    title={`No results for “${query}”`}
                    body="Try a shorter word, like “dns”, “wifi” or “update”."
                    actions={
                      <button className="btn" onClick={() => setQuery("")}>
                        Clear search
                      </button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={Zap}
                    title="No saved commands yet"
                    body="Save a command you use often, or bring back the built-in fixes."
                    actions={
                      <>
                        <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}>
                          <Plus size={16} /> New command
                        </button>
                        <button className="btn" onClick={restoreBuiltins}>
                          <RotateCcw size={16} /> Restore built-in fixes
                        </button>
                      </>
                    }
                  />
                ))}
            </>
          )}
        </div>

        {run && (
          <RunPanel
            run={run}
            others={runs.runs.filter((r) => r.id !== run.id)}
            onShow={showRun}
            onStop={() => runs.cancel(run.id)}
            onRunAgain={() => runAgain(run)}
            onClose={async () => {
              if (run.status === "running" && !run.admin) {
                const ok = await confirm({
                  title: `Stop “${run.name}”?`,
                  message: "It is still running. Closing this panel stops it.",
                  confirmLabel: "Stop and close",
                  danger: true,
                });
                if (!ok) return;
                runs.cancel(run.id);
                runs.dismiss(run.id);
                return;
              }
              // Finished results stay available from the card's "Last run" button.
              setPanelHidden(true);
            }}
          />
        )}
      </div>

      {asking && askingFill && (
        <Modal
          title={asking.cmd.name}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button className="btn" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={!askingReady} onClick={submitAsking}>
                {asking.target === "terminal" ? <SquareTerminal size={14} /> : <Play size={14} />}
                {asking.target === "terminal" ? "Open in terminal" : "Run"}
              </button>
            </>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitAsking();
            }}
          >
            {asking.cmd.description && <p className="muted" style={{ marginBottom: 16 }}>{asking.cmd.description}</p>}
            {Object.keys(asking.values).map((name, i) => (
              <label key={name} className="field">
                <span>{humanize(name)}</span>
                <input
                  autoFocus={i === 0}
                  value={asking.values[name]}
                  placeholder={hintFor(name)}
                  spellCheck={false}
                  onChange={(e) => setAsking({ ...asking, values: { ...asking.values, [name]: e.target.value } })}
                />
              </label>
            ))}
            <div className="field" style={{ marginBottom: 0 }}>
              <span>Will run</span>
              <code className="cmd-code wrap-code">
                <Preview text={askingFill.text} pending={Object.keys(asking.values).filter((k) => !asking.values[k])} />
              </code>
            </div>
            {askingFill.error && (
              <div className="note note-danger" style={{ marginTop: 12 }}>
                <TriangleAlert size={16} />
                <span>{askingFill.error}</span>
              </div>
            )}
            <button type="submit" hidden />
          </form>
        </Modal>
      )}

      {editing && <CommandEditor initial={editing} categories={categories} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function FixRow({
  cmd: c,
  elevated,
  running,
  lastRun,
  onShowRun,
  onRun,
  onTerminal,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  cmd: SavedCommand;
  elevated: boolean;
  running: boolean;
  lastRun?: Run;
  onShowRun: (id: string) => void;
  onRun: () => void;
  onTerminal: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [showCode, setShowCode] = useState(false);
  // Terminal tabs run with the app's own rights, so admin commands would fail there.
  const terminalBlocked = c.admin && !elevated;
  const look = categoryLook(c.category);
  const Icon = look.icon;
  const failed = lastRun && runFailed(lastRun);
  return (
    <div className={`fix-row ${running ? "running" : ""}`} style={{ "--cat": look.color } as React.CSSProperties}>
      <span className="cmd-icon">
        <Icon size={18} />
      </span>
      <div className="fix-text">
        <div className="fix-name">
          <strong>{c.name}</strong>
          {c.admin && (
            <span className="pill pill-sm" title="Opens in its own administrator window after a Windows prompt">
              <ShieldCheck size={12} /> Admin window
            </span>
          )}
          {c.risk !== "safe" && (
            <span className={`pill pill-sm ${c.risk === "danger" ? "pill-danger" : "pill-warn"}`} title={c.warning ?? "Asks before running"}>
              <TriangleAlert size={12} /> {c.risk === "danger" ? "Careful: asks first" : "Asks first"}
            </span>
          )}
        </div>
        {c.description && <p className="fix-desc">{c.description}</p>}
        {showCode && (
          <code className="cmd-code wrap-code" title={c.command}>
            {c.command}
          </code>
        )}
      </div>
      <div className="fix-actions">
        {lastRun && !running && (
          <button
            className={`pill pill-sm ${failed ? "pill-danger" : "pill-ok"}`}
            onClick={() => onShowRun(lastRun.id)}
            title="Show the result of the last run"
          >
            {failed ? <CircleX size={12} /> : <CircleCheck size={12} />} Last run
          </button>
        )}
        <button className="btn btn-sm fix-run" onClick={onRun} disabled={running} aria-label={`Run ${c.name}`}>
          {running ? <span className="spinner" /> : <Play size={14} />} {running ? "Running…" : "Run"}
        </button>
        <Menu
          label={`More actions for ${c.name}`}
          className="icon-btn icon-btn-sm"
          items={[
            { label: showCode ? "Hide command" : "Show command", icon: Code, onSelect: () => setShowCode((v) => !v) },
            {
              label: "Open in terminal",
              icon: SquareTerminal,
              onSelect: onTerminal,
              disabled: terminalBlocked,
              title: terminalBlocked ? "Needs administrator rights: use Run instead" : undefined,
            },
            "separator",
            { label: "Edit", icon: Pencil, onSelect: onEdit },
            { label: "Duplicate", icon: CopyPlus, onSelect: onDuplicate },
            { label: "Delete", icon: Trash2, onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </div>
  );
}

function RunPanel({
  run,
  others,
  onShow,
  onStop,
  onRunAgain,
  onClose,
}: {
  run: Run;
  others: Run[];
  onShow: (id: string) => void;
  onStop: () => void;
  onRunAgain: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const running = run.status === "running";
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const out = run.output;
  const ms = (run.finishedAt ?? now) - run.startedAt;
  const elapsed = clock(ms);
  const took = ms < 1000 ? "in under a second" : ms < 60000 ? `in ${Math.round(ms / 1000)} s` : `in ${elapsed}`;
  const text = [run.stdout, run.stderr].filter(Boolean).join("\n");
  const copy = () =>
    navigator.clipboard
      .writeText(run.error ?? text)
      .then(() => toast("Output copied", "success"))
      .catch(() => toast("Couldn't copy the output", "error"));

  return (
    <aside className="detail card output-panel" aria-label={`Result of ${run.name}`}>
      <div className="run-head">
        <h3>{run.name}</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close output" title="Close">
          <X size={16} />
        </button>
      </div>
      <code className="cmd-code" title={run.command}>
        {run.command}
      </code>
      <div className="run-status" aria-live="polite">
        {running ? (
          run.admin ? (
            <span className="run-state">
              <span className="spinner" /> Waiting for the administrator prompt…
            </span>
          ) : (
            <>
              <span className="run-state">
                <span className="spinner" /> {run.stopping ? "Stopping…" : `Running for ${elapsed}`}
              </span>
              <span className="spacer" />
              <button className="btn btn-sm btn-danger-ghost" onClick={onStop} disabled={run.stopping}>
                <Square size={12} /> Stop
              </button>
            </>
          )
        ) : run.error ? (
          <span className="run-state bad">
            <CircleX size={16} /> Couldn't run
          </span>
        ) : out?.elevated ? (
          <span className="run-state ok">
            <ShieldCheck size={16} /> Opened in an administrator window
          </span>
        ) : out?.stopped ? (
          <span className="run-state warn">
            <Square size={14} /> {out.stopped === "timedOut" ? "Stopped after 10 minutes" : `Stopped after ${elapsed}`}
          </span>
        ) : out?.code === 0 ? (
          <>
            <span className="run-state ok">
              <CircleCheck size={16} /> Finished
            </span>
            <span className="muted small">{took}</span>
          </>
        ) : (
          <>
            <span className="run-state bad" title="The command reported a problem">
              <CircleX size={16} /> Finished with problems
            </span>
            <span className="muted small">
              code {out?.code ?? "?"} · {took}
            </span>
          </>
        )}
      </div>
      {running && !run.admin && <div className="progress" role="progressbar" aria-label="Running" />}
      {run.error ? (
        <pre className="output error">{run.error}</pre>
      ) : out?.elevated ? (
        <p className="muted small">The command runs in its own administrator window. Follow its progress there.</p>
      ) : (
        <>
          <pre className="output">
            {run.stdout || (run.stderr ? "" : <span className="output-empty">{running ? "Waiting for output…" : "Finished without any output."}</span>)}
          </pre>
          {run.stderr && <pre className="output error">{run.stderr}</pre>}
          {out?.truncated && <p className="muted small">The output was very long, so only the last part is shown.</p>}
        </>
      )}
      {!running && (
        <div className="run-tools">
          <button className="btn btn-sm" onClick={onRunAgain}>
            <RotateCcw size={14} /> Run again
          </button>
          {(text || run.error) && (
            <button className="btn btn-sm" onClick={copy}>
              <Copy size={14} /> Copy output
            </button>
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="run-list">
          <span className="muted small">Recent runs</span>
          {others.map((r) => (
            <button key={r.id} className="run-item" onClick={() => onShow(r.id)}>
              <span className={`dot dot-${r.status === "running" ? "running" : runFailed(r) ? "bad" : "ok"}`} />
              {r.name}
              <span className="spacer" />
              <span className="muted small">{new Date(r.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

const RISKS: { value: Risk; label: string }[] = [
  { value: "safe", label: "Just run it" },
  { value: "caution", label: "Ask me first" },
  { value: "danger", label: "Ask me first (dangerous)" },
];

function CommandEditor({
  initial,
  categories,
  onCancel,
  onSave,
}: {
  initial: SavedCommand;
  categories: string[];
  onCancel: () => void;
  onSave: (c: SavedCommand) => void;
}) {
  const [c, setC] = useState(initial);
  const [touched, setTouched] = useState<{ name?: boolean; command?: boolean }>({});
  const set = <K extends keyof SavedCommand>(key: K, value: SavedCommand[K]) => setC({ ...c, [key]: value });
  const missingName = !c.name.trim();
  const missingCommand = !c.command.trim();
  const valid = !missingName && !missingCommand;

  return (
    <Modal
      title={initial.id ? "Edit command" : "New command"}
      onClose={onCancel}
      wide
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => (valid ? onSave(c) : setTouched({ name: true, command: true }))}
            title={valid ? undefined : "Add a name and a command first"}
          >
            Save
          </button>
        </>
      }
    >
      <label className={`field ${touched.name && missingName ? "invalid" : ""}`}>
        <span>Name</span>
        <input
          autoFocus
          value={c.name}
          onChange={(e) => set("name", e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, name: true }))}
          placeholder="Ping my router"
        />
        {touched.name && missingName && <span className="field-error">Give the command a name.</span>}
      </label>
      <label className="field">
        <span>What it does (optional)</span>
        <input value={c.description} onChange={(e) => set("description", e.target.value)} placeholder="Checks that my router answers" />
      </label>
      <label className={`field ${touched.command && missingCommand ? "invalid" : ""}`}>
        <span>Command</span>
        <textarea
          className="mono"
          rows={4}
          value={c.command}
          spellCheck={false}
          onChange={(e) => set("command", e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, command: true }))}
          placeholder="ping -n 4 {host}"
        />
        {touched.command && missingCommand && <span className="field-error">Type the command to run.</span>}
      </label>
      <p className="field-help">
        Tip: write <code>{"{name}"}</code> to be asked for a value each time, e.g. <code>{"ping {host}"}</code>. It's inserted safely quoted, so
        spaces and symbols stay part of it. <code>{"{name:raw}"}</code> inserts it exactly as typed, and <code>{"{{name}}"}</code> gives a literal{" "}
        <code>{"{name}"}</code>.
      </p>
      <div className="row">
        <label className="field">
          <span>Category</span>
          <input list="command-categories" value={c.category} onChange={(e) => set("category", e.target.value)} />
          <datalist id="command-categories">
            {categories.map((cat) => (
              <option key={cat} value={cat} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Shell</span>
          <select value={c.shell} onChange={(e) => set("shell", e.target.value as Shell)}>
            <option value="powershell">PowerShell</option>
            <option value="cmd">Command Prompt</option>
          </select>
        </label>
        <label className="field">
          <span>Before running</span>
          <select value={c.risk} onChange={(e) => set("risk", e.target.value as Risk)}>
            {RISKS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {c.risk !== "safe" && (
        <label className="field">
          <span>Warning to show</span>
          <input
            value={c.warning ?? ""}
            onChange={(e) => set("warning", e.target.value || null)}
            placeholder="What this changes, e.g. Closes all File Explorer windows"
          />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={c.admin} onChange={(e) => set("admin", e.target.checked)} />
        <span>
          Run as administrator
          <span className="muted small" style={{ display: "block" }}>
            Opens in its own window after a Windows prompt, so its output isn't shown here.
          </span>
        </span>
      </label>
    </Modal>
  );
}
