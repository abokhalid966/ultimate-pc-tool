import { useEffect, useMemo, useState } from "react";
import { Pencil, Play, Plus, Search, ShieldCheck, SquareTerminal, Trash2 } from "lucide-react";
import { api, CommandOutput, errorText, SavedCommand } from "../api";
import { Modal } from "../components/Modal";
import { useToast } from "../components/Toast";
import { commandVariables, fillVariables } from "../format";
import { useAsync } from "../hooks/useAsync";

interface RunResult {
  name: string;
  command: string;
  output?: CommandOutput;
  error?: string;
  running: boolean;
}

const EMPTY: SavedCommand = {
  id: "",
  name: "",
  description: "",
  command: "",
  shell: "powershell",
  admin: false,
  category: "My commands",
};

interface Props {
  /** Set by the command palette: run this saved command as soon as it arrives. */
  pendingRun: SavedCommand | null;
  onPendingHandled: () => void;
  onOpenInTerminal: (command: string) => void;
}

export function Commands({ pendingRun, onPendingHandled, onOpenInTerminal }: Props) {
  const toast = useToast();
  const { data: commands, reload } = useAsync(api.commands, [] as SavedCommand[]);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<SavedCommand | null>(null);
  const [asking, setAsking] = useState<{ cmd: SavedCommand; values: Record<string, string>; target: "run" | "terminal" } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  useEffect(() => {
    if (pendingRun) {
      start(pendingRun, "run");
      onPendingHandled();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRun]);

  const byCategory = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = commands.filter(
      (c) => !q || [c.name, c.description, c.command, c.category].some((f) => f.toLowerCase().includes(q)),
    );
    const map = new Map<string, SavedCommand[]>();
    for (const c of list) map.set(c.category, [...(map.get(c.category) ?? []), c]);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [commands, query]);

  function start(cmd: SavedCommand, target: "run" | "terminal") {
    const vars = commandVariables(cmd.command);
    if (vars.length) setAsking({ cmd, values: Object.fromEntries(vars.map((v) => [v, ""])), target });
    else execute(cmd, cmd.command, target);
  }

  async function execute(cmd: SavedCommand, command: string, target: "run" | "terminal") {
    if (target === "terminal") {
      onOpenInTerminal(command);
      return;
    }
    setResult({ name: cmd.name, command, running: true });
    try {
      const output = await api.runCommand(command, cmd.shell, cmd.admin, cmd.name);
      setResult({ name: cmd.name, command, output, running: false });
    } catch (e) {
      setResult({ name: cmd.name, command, error: errorText(e), running: false });
    }
  }

  async function save(cmd: SavedCommand) {
    try {
      await api.saveCommand(cmd);
      setEditing(null);
      toast(`Saved “${cmd.name}”`, "success");
      reload();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function remove(cmd: SavedCommand) {
    if (!confirm(`Delete “${cmd.name}”?`)) return;
    await api.deleteCommand(cmd.id);
    reload();
  }

  return (
    <div className="page page-fill">
      <header className="page-header">
        <div>
          <h1>Commands</h1>
          <p className="muted">Your saved commands and one-click fixes. Use {"{name}"} in a command to ask for a value when it runs.</p>
        </div>
        <div className="toolbar">
          <label className="search">
            <Search size={16} />
            <input placeholder="Search commands" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="btn btn-primary" onClick={() => setEditing({ ...EMPTY })}>
            <Plus size={16} /> New command
          </button>
        </div>
      </header>

      <div className="split">
        <div className="scroll">
          {byCategory.map(([category, list]) => (
            <section key={category} className="cmd-section">
              <h3>{category}</h3>
              <div className="cmd-grid">
                {list.map((c) => (
                  <div key={c.id} className="cmd-card card">
                    <div className="cmd-head">
                      <strong>{c.name}</strong>
                      {c.admin && (
                        <span className="pill pill-warn" title="Runs as administrator">
                          <ShieldCheck size={12} /> Admin
                        </span>
                      )}
                    </div>
                    <p className="muted small">{c.description}</p>
                    <code className="cmd-code">{c.command}</code>
                    <div className="cmd-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => start(c, "run")}>
                        <Play size={14} /> Run
                      </button>
                      <button className="icon-btn" title="Open in terminal" onClick={() => start(c, "terminal")}>
                        <SquareTerminal size={16} />
                      </button>
                      <span className="spacer" />
                      <button className="icon-btn" title="Edit" onClick={() => setEditing({ ...c })}>
                        <Pencil size={15} />
                      </button>
                      <button className="icon-btn" title="Delete" onClick={() => remove(c)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {byCategory.length === 0 && <div className="empty">No commands match “{query}”.</div>}
        </div>

        {result && (
          <aside className="detail card output-panel">
            <div className="card-title">
              <h3>{result.name}</h3>
              <button className="icon-btn" onClick={() => setResult(null)} aria-label="Close output">
                ×
              </button>
            </div>
            <code className="cmd-code">{result.command}</code>
            {result.running ? (
              <div className="muted">Running…</div>
            ) : result.error ? (
              <pre className="output error">{result.error}</pre>
            ) : (
              <>
                {result.output && !result.output.elevated && (
                  <div className={`pill ${result.output.code === 0 ? "pill-ok" : "pill-danger"}`}>
                    Exit code {result.output.code ?? "?"}
                  </div>
                )}
                <pre className="output">{result.output?.stdout || (result.output?.stderr ? "" : "(no output)")}</pre>
                {result.output?.stderr && <pre className="output error">{result.output.stderr}</pre>}
              </>
            )}
          </aside>
        )}
      </div>

      {asking && (
        <Modal
          title={asking.cmd.name}
          onClose={() => setAsking(null)}
          footer={
            <button
              className="btn btn-primary"
              disabled={Object.values(asking.values).some((v) => !v.trim())}
              onClick={() => {
                execute(asking.cmd, fillVariables(asking.cmd.command, asking.values), asking.target);
                setAsking(null);
              }}
            >
              <Play size={14} /> Run
            </button>
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (Object.values(asking.values).some((v) => !v.trim())) return;
              execute(asking.cmd, fillVariables(asking.cmd.command, asking.values), asking.target);
              setAsking(null);
            }}
          >
            {Object.keys(asking.values).map((name, i) => (
              <label key={name} className="field">
                <span>{name}</span>
                <input
                  autoFocus={i === 0}
                  value={asking.values[name]}
                  onChange={(e) => setAsking({ ...asking, values: { ...asking.values, [name]: e.target.value } })}
                />
              </label>
            ))}
            <code className="cmd-code">{fillVariables(asking.cmd.command, asking.values)}</code>
            <button type="submit" hidden />
          </form>
        </Modal>
      )}

      {editing && <CommandEditor initial={editing} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function CommandEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: SavedCommand;
  onCancel: () => void;
  onSave: (c: SavedCommand) => void;
}) {
  const [c, setC] = useState(initial);
  const set = <K extends keyof SavedCommand>(key: K, value: SavedCommand[K]) => setC({ ...c, [key]: value });

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
          <button className="btn btn-primary" disabled={!c.name.trim() || !c.command.trim()} onClick={() => onSave(c)}>
            Save
          </button>
        </>
      }
    >
      <label className="field">
        <span>Name</span>
        <input autoFocus value={c.name} onChange={(e) => set("name", e.target.value)} placeholder="Ping my router" />
      </label>
      <label className="field">
        <span>Description</span>
        <input value={c.description} onChange={(e) => set("description", e.target.value)} />
      </label>
      <label className="field">
        <span>Command</span>
        <textarea
          className="mono"
          rows={4}
          value={c.command}
          onChange={(e) => set("command", e.target.value)}
          placeholder="ping -n 4 {host}"
        />
      </label>
      <div className="row">
        <label className="field">
          <span>Category</span>
          <input value={c.category} onChange={(e) => set("category", e.target.value)} />
        </label>
        <label className="field">
          <span>Shell</span>
          <select value={c.shell} onChange={(e) => set("shell", e.target.value as SavedCommand["shell"])}>
            <option value="powershell">PowerShell</option>
            <option value="cmd">Command Prompt</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={c.admin} onChange={(e) => set("admin", e.target.checked)} /> Run as administrator
        (opens in its own window after a Windows prompt)
      </label>
    </Modal>
  );
}
