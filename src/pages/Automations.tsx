import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Brush, CalendarClock, CircleAlert, CircleCheck, Info, Pencil, Play, Plus, RefreshCw, Stethoscope, Terminal, Trash2 } from "lucide-react";
import { api, Automation, AutomationInfo, AutomationTask, CleanupKind, errorText, SavedCommand, Schedule } from "../api";
import { EmptyState } from "../components/EmptyState";
import { Menu, MenuEntry } from "../components/Menu";
import { Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import "./automations.css";
import { relativeTime } from "../format";
import { useOnRefresh } from "../hooks/useRefresh";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CLEAN_CHOICES: { kind: CleanupKind; label: string; admin?: boolean }[] = [
  { kind: "userTemp", label: "Temporary files" },
  { kind: "thumbnails", label: "Thumbnail cache" },
  { kind: "errorReports", label: "Error reports" },
  { kind: "recycleBin", label: "Recycle Bin" },
  { kind: "edge", label: "Microsoft Edge cache" },
  { kind: "chrome", label: "Google Chrome cache" },
  { kind: "brave", label: "Brave cache" },
  { kind: "firefox", label: "Firefox cache" },
  { kind: "windowsTemp", label: "Windows temporary files", admin: true },
  { kind: "windowsUpdate", label: "Windows Update leftovers", admin: true },
  { kind: "deliveryOptimization", label: "Delivery Optimization files", admin: true },
  { kind: "systemErrorReports", label: "System error reports", admin: true },
];

const TASK_LOOK: Record<AutomationTask["type"], { icon: typeof Brush; color: string }> = {
  cleanup: { icon: Brush, color: "var(--cat-cleanup)" },
  command: { icon: Terminal, color: "var(--cat-network)" },
  checkUpdates: { icon: RefreshCw, color: "var(--cat-apps)" },
  healthCheck: { icon: Stethoscope, color: "var(--cat-repair)" },
};

const time = (minute: number) => {
  const d = new Date(2000, 0, 1, Math.floor(minute / 60), minute % 60);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};

export function scheduleText(s: Schedule): string {
  switch (s.type) {
    case "appStart":
      return "When Optimo starts";
    case "daily":
      return `Every day at ${time(s.minute)}`;
    case "weekly":
      return `Every ${DAYS[s.day]} at ${time(s.minute)}`;
    case "hours":
      return s.every === 1 ? "Every hour" : `Every ${s.every} hours`;
  }
}

function taskText(t: AutomationTask, commands: SavedCommand[]): string {
  switch (t.type) {
    case "cleanup": {
      const names = t.kinds.map((k) => CLEAN_CHOICES.find((c) => c.kind === k)?.label ?? k);
      return `Cleans: ${names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ")}`;
    }
    case "command": {
      const c = commands.find((c) => c.id === t.commandId);
      return c ? `Runs "${c.name}"` : "Runs a command that was deleted";
    }
    case "checkUpdates":
      return "Tells you when apps have updates";
    case "healthCheck":
      return "Runs the speed check and tells you if something needs fixing";
  }
}

function needsAdmin(t: AutomationTask, commands: SavedCommand[]): boolean {
  if (t.type === "cleanup") return t.kinds.every((k) => CLEAN_CHOICES.find((c) => c.kind === k)?.admin);
  if (t.type === "command") return !!commands.find((c) => c.id === t.commandId)?.admin;
  return false;
}

const hasVariables = (command: string) => /\{[\w-]+(:raw)?\}/.test(command);

export function Automations({ elevated }: { elevated: boolean }) {
  const toast = useToast();
  const [items, setItems] = useState<AutomationInfo[] | null>(null);
  const [commands, setCommands] = useState<SavedCommand[]>([]);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .listAutomations()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  useEffect(() => {
    reload();
    api.commands().then(setCommands).catch(() => {});
    api.getAutostart().then(setAutostart).catch(() => setAutostart(true));
    const un = listen("automations://changed", reload);
    // Keeps "next run" and "2 minutes ago" fresh.
    const timer = window.setInterval(reload, 60_000);
    return () => {
      un.then((f) => f());
      window.clearInterval(timer);
    };
  }, [reload]);
  useOnRefresh(reload);

  const act = async (what: () => Promise<void>, done?: string) => {
    try {
      await what();
      if (done) toast(done, "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
    reload();
  };

  const toggle = (a: AutomationInfo, on: boolean) => {
    setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, enabled: on } : x)) ?? null);
    act(() => api.setAutomationEnabled(a.id, on), on ? `"${a.name}" is on. ${scheduleText(a.schedule)}.` : undefined);
  };

  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled)), [items]);
  const onCount = items?.filter((a) => a.enabled).length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Automations"
        subtitle="Let Optimo take care of routine jobs on a schedule: cleanups, update checks and your favourite fixes."
        actions={
          <button className="btn btn-primary" onClick={() => setEditing(blank())}>
            <Plus size={16} /> New automation
          </button>
        }
      />

      {autostart === false && onCount > 0 && (
        <div className="note note-info">
          <Info size={16} />
          <span>Automations run while Optimo is open, even in the tray. Turn on Start with Windows so they don't miss a run.</span>
          <button className="btn btn-sm" onClick={() => act(() => api.setAutostart(true).then(() => setAutostart(true)), "Optimo will now start with Windows.")}>
            Turn on
          </button>
        </div>
      )}

      {error ? (
        <div className="card">
          <EmptyState icon={CircleAlert} tone="danger" title="Couldn't load automations" body={error} actions={<button className="btn" onClick={reload}>Try again</button>} />
        </div>
      ) : (
        <div className="card fix-list">
          {items === null
            ? null
            : sorted.map((a) => {
                const look = TASK_LOOK[a.task.type];
                const Icon = look.icon;
                const admin = needsAdmin(a.task, commands);
                const items: MenuEntry[] = [
                  { label: "Run now", icon: Play, onSelect: () => act(() => api.runAutomation(a.id), `Running "${a.name}"…`), disabled: a.running },
                  { label: "Edit…", icon: Pencil, onSelect: () => setEditing(a) },
                  ...(a.builtin
                    ? []
                    : (["separator", { label: "Delete", icon: Trash2, danger: true, onSelect: () => act(() => api.deleteAutomation(a.id), `Deleted "${a.name}".`) }] as MenuEntry[])),
                ];
                return (
                  <div key={a.id} className={`fix-row auto-row ${a.enabled ? "" : "off"} ${a.running ? "running" : ""}`}>
                    <span className="cmd-icon" style={{ "--cat": look.color } as React.CSSProperties} aria-hidden="true">
                      <Icon size={18} />
                    </span>
                    <div className="fix-text">
                      <div className="fix-name">
                        <strong>{a.name}</strong>
                        {admin && (
                          <span className={`pill pill-sm ${elevated ? "pill-outline" : "pill-warn"}`} title="Only runs when Optimo is running as administrator">
                            Admin
                          </span>
                        )}
                      </div>
                      <div className="fix-desc">
                        {taskText(a.task, commands)} · {scheduleText(a.schedule)}
                      </div>
                      <div className="auto-status">
                        {a.running ? (
                          <span>
                            <span className="spinner" /> Running now…
                          </span>
                        ) : a.lastRun ? (
                          <span className={a.lastRun.ok ? "" : "bad"} title={new Date(a.lastRun.at).toLocaleString()}>
                            {a.lastRun.ok ? <CircleCheck size={13} /> : <CircleAlert size={13} />} {relativeTime(new Date(a.lastRun.at))}: {a.lastRun.summary}
                          </span>
                        ) : (
                          <span className="muted">Hasn't run yet</span>
                        )}
                        {a.enabled && a.nextRun && !a.running && <span className="muted">Next: {nextText(a.nextRun)}</span>}
                      </div>
                    </div>
                    <div className="fix-actions">
                      <Switch label={`${a.name} on or off`} checked={a.enabled} onChange={(on) => toggle(a, on)} />
                      <Menu items={items} label={`More actions for ${a.name}`} />
                    </div>
                  </div>
                );
              })}
        </div>
      )}

      <p className="storage-foot">
        <CalendarClock size={14} />
        If the PC was off at the planned time, the job runs the next time Optimo is open. Jobs marked Admin only run when Optimo runs as administrator, so you
        never get a surprise prompt.
      </p>

      {editing && (
        <AutomationEditor
          initial={editing}
          commands={commands}
          onCancel={() => setEditing(null)}
          onSave={(a) =>
            api
              .saveAutomation(a)
              .then(() => {
                setEditing(null);
                toast(a.id ? "Saved." : `Added "${a.name}".`, "success");
                reload();
              })
              .catch((e) => toast(errorText(e), "error"))
          }
        />
      )}
    </div>
  );
}

function nextText(ms: number): string {
  const d = new Date(ms);
  if (ms - Date.now() < 60_000) return "in a moment";
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `today at ${t}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${t}`;
  return `${d.toLocaleDateString(undefined, { weekday: "long" })} at ${t}`;
}

const blank = (): Automation => ({
  id: "",
  name: "",
  task: { type: "cleanup", kinds: ["userTemp", "thumbnails", "errorReports"] },
  schedule: { type: "weekly", day: 0, minute: 12 * 60 },
  enabled: true,
  builtin: false,
  armedAt: 0,
  lastRun: null,
});

const TASK_NAMES: Record<AutomationTask["type"], string> = {
  cleanup: "Clean up files",
  command: "Run a quick fix or saved command",
  checkUpdates: "Check for app updates",
  healthCheck: "Check why the PC is slow",
};

function AutomationEditor({ initial, commands, onCancel, onSave }: { initial: Automation; commands: SavedCommand[]; onCancel: () => void; onSave: (a: Automation) => void }) {
  const [a, setA] = useState(initial);
  const runnable = commands.filter((c) => !hasVariables(c.command));
  const s = a.schedule;
  const minute = s.type === "daily" || s.type === "weekly" ? s.minute : 12 * 60;
  const timeValue = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const parseTime = (v: string) => {
    const [h, m] = v.split(":").map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : minute;
  };

  const setTaskType = (type: AutomationTask["type"]) => {
    const task: AutomationTask =
      type === "cleanup" ? { type, kinds: ["userTemp", "thumbnails", "errorReports"] } : type === "command" ? { type, commandId: runnable[0]?.id ?? "" } : { type };
    setA({ ...a, task, name: a.name && a.name !== TASK_NAMES[a.task.type] ? a.name : TASK_NAMES[type] });
  };
  const setScheduleType = (type: Schedule["type"]) => {
    const schedule: Schedule =
      type === "appStart" ? { type } : type === "daily" ? { type, minute } : type === "weekly" ? { type, day: s.type === "weekly" ? s.day : 0, minute } : { type, every: 6 };
    setA({ ...a, schedule });
  };

  const problem = !a.name.trim()
    ? "Give it a name."
    : a.task.type === "cleanup" && a.task.kinds.length === 0
      ? "Choose at least one thing to clean."
      : a.task.type === "command" && !a.task.commandId
        ? "Choose a command."
        : null;

  return (
    <Modal
      title={initial.id ? `Edit "${initial.name}"` : "New automation"}
      onClose={onCancel}
      wide
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!problem} title={problem ?? undefined} onClick={() => onSave({ ...a, name: a.name.trim() })}>
            Save
          </button>
        </>
      }
    >
      <div className="row">
        <label className="field">
          <span>What to do</span>
          <select value={a.task.type} onChange={(e) => setTaskType(e.target.value as AutomationTask["type"])}>
            {(Object.keys(TASK_NAMES) as AutomationTask["type"][]).map((t) => (
              <option key={t} value={t}>
                {TASK_NAMES[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Name</span>
          <input value={a.name} placeholder={TASK_NAMES[a.task.type]} onChange={(e) => setA({ ...a, name: e.target.value })} />
        </label>
      </div>

      {a.task.type === "cleanup" && (
        <fieldset className="field auto-kinds">
          <span>What to clean</span>
          <div>
            {CLEAN_CHOICES.map((c) => {
              const kinds = a.task.type === "cleanup" ? a.task.kinds : [];
              return (
                <label key={c.kind} className="check">
                  <input
                    type="checkbox"
                    checked={kinds.includes(c.kind)}
                    onChange={(e) =>
                      setA({ ...a, task: { type: "cleanup", kinds: e.target.checked ? [...kinds, c.kind] : kinds.filter((k) => k !== c.kind) } })
                    }
                  />
                  {c.label}
                  {c.admin && <span className="pill pill-sm pill-outline">Admin</span>}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {a.task.type === "command" && (
        <label className="field">
          <span>Command</span>
          <select value={a.task.commandId} onChange={(e) => setA({ ...a, task: { type: "command", commandId: e.target.value } })}>
            {!a.task.commandId && <option value="">Choose…</option>}
            {runnable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.admin ? " (needs administrator)" : ""}
              </option>
            ))}
          </select>
          <span className="field-help">Commands that ask for a value each time, like Ping, can't run on their own so they aren't listed.</span>
        </label>
      )}

      <div className="row">
        <label className="field">
          <span>When</span>
          <select value={s.type} onChange={(e) => setScheduleType(e.target.value as Schedule["type"])}>
            <option value="appStart">When Optimo starts</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="hours">Every few hours</option>
          </select>
        </label>
        {s.type === "weekly" && (
          <label className="field">
            <span>Day</span>
            <select value={s.day} onChange={(e) => setA({ ...a, schedule: { ...s, day: Number(e.target.value) } })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {(s.type === "daily" || s.type === "weekly") && (
          <label className="field">
            <span>Time</span>
            <input type="time" value={timeValue} onChange={(e) => setA({ ...a, schedule: { ...s, minute: parseTime(e.target.value) } })} />
          </label>
        )}
        {s.type === "hours" && (
          <label className="field">
            <span>Every</span>
            <select value={s.every} onChange={(e) => setA({ ...a, schedule: { type: "hours", every: Number(e.target.value) } })}>
              {[1, 2, 3, 4, 6, 8, 12, 24, 48].map((h) => (
                <option key={h} value={h}>
                  {h} {h === 1 ? "hour" : "hours"}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {s.type === "appStart" && <p className="field-help">With Start with Windows on, this runs each time you sign in.</p>}
    </Modal>
  );
}
