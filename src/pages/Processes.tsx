import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Search, X } from "lucide-react";
import { api, errorText, Priority, ProcessInfo } from "../api";
import { useToast } from "../components/Toast";
import { bytes, pct, rate } from "../format";

type SortKey = "name" | "pid" | "cpu" | "memory" | "disk";

const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "idle", label: "Low" },
  { value: "belowNormal", label: "Below normal" },
  { value: "normal", label: "Normal" },
  { value: "aboveNormal", label: "Above normal" },
  { value: "high", label: "High" },
  { value: "realtime", label: "Realtime" },
];

interface Group {
  name: string;
  items: ProcessInfo[];
  cpu: number;
  memory: number;
  disk: number;
}

export function Processes({ active, initialQuery }: { active: boolean; initialQuery?: string }) {
  const toast = useToast();
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "cpu", desc: true });
  const [grouped, setGrouped] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<ProcessInfo | null>(null);

  useEffect(() => {
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialQuery]);

  useEffect(() => {
    if (!active) return;
    const load = () => api.processes().then(setProcesses).catch(() => {});
    load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [active]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid) === q || p.exe?.toLowerCase().includes(q))
      : processes;

    const map = new Map<string, Group>();
    for (const p of filtered) {
      const key = grouped ? p.name.toLowerCase() : `${p.name}#${p.pid}`;
      const g = map.get(key) ?? { name: p.name, items: [], cpu: 0, memory: 0, disk: 0 };
      g.items.push(p);
      g.cpu += p.cpu;
      g.memory += p.memory;
      g.disk += p.diskRead + p.diskWrite;
      map.set(key, g);
    }

    const value = (g: Group): number | string =>
      sort.key === "name" ? g.name.toLowerCase() : sort.key === "pid" ? g.items[0].pid : g[sort.key];
    return [...map.values()].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    });
  }, [processes, query, sort, grouped]);

  const totals = useMemo(
    () => processes.reduce((t, p) => ({ cpu: t.cpu + p.cpu, memory: t.memory + p.memory }), { cpu: 0, memory: 0 }),
    [processes],
  );

  const header = (key: SortKey, label: string, numeric = false) => (
    <th
      className={`${numeric ? "num" : ""} sortable ${sort.key === key ? "sorted" : ""}`}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
    >
      {label}
      {sort.key === key && (sort.desc ? " ▾" : " ▴")}
    </th>
  );

  async function kill(list: ProcessInfo[]) {
    const names = list.length > 1 ? `${list.length} × ${list[0].name}` : `${list[0].name} (PID ${list[0].pid})`;
    if (!confirm(`End ${names}? Unsaved work in it will be lost.`)) return;
    const results = await Promise.allSettled(list.map((p) => api.killProcess(p.pid, p.name)));
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) toast(errorText(failed.reason), "error");
    else toast(`Ended ${names}`, "success");
    setSelected(null);
    api.processes().then(setProcesses);
  }

  async function setPriority(p: ProcessInfo, priority: Priority) {
    try {
      await api.setPriority(p.pid, p.name, priority);
      toast(`${p.name} priority set to ${PRIORITIES.find((x) => x.value === priority)?.label}`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const row = (p: ProcessInfo, child = false) => (
    <tr
      key={p.pid}
      className={`${selected?.pid === p.pid ? "selected" : ""} ${child ? "child" : ""}`}
      onClick={() => setSelected(p)}
    >
      <td className="name-cell" title={p.exe ?? p.name}>
        {p.name}
      </td>
      <td className="num muted">{p.pid}</td>
      <td className="num">{pct(p.cpu, 1)}</td>
      <td className="num">{bytes(p.memory)}</td>
      <td className="num">{rate(p.diskRead + p.diskWrite)}</td>
    </tr>
  );

  return (
    <div className="page page-fill">
      <header className="page-header">
        <div>
          <h1>Processes</h1>
          <p className="muted">
            {processes.length} running · CPU {pct(totals.cpu)} · {bytes(totals.memory)} in use
          </p>
        </div>
        <div className="toolbar">
          <label className="search">
            <Search size={16} />
            <input
              placeholder="Search by name, PID or path"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button className="icon-btn" onClick={() => setQuery("")} aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </label>
          <label className="check">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Group by app
          </label>
        </div>
      </header>

      <div className="split">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {header("name", "Name")}
                {header("pid", "PID", true)}
                {header("cpu", "CPU", true)}
                {header("memory", "Memory", true)}
                {header("disk", "Disk", true)}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                if (g.items.length === 1) return row(g.items[0]);
                const open = expanded.has(g.name);
                return [
                  <tr
                    key={`g-${g.name}`}
                    className="group-row"
                    onClick={() =>
                      setExpanded((s) => {
                        const next = new Set(s);
                        if (open) next.delete(g.name);
                        else next.add(g.name);
                        return next;
                      })
                    }
                  >
                    <td className="name-cell">
                      {open ? "▾" : "▸"} {g.name} <span className="muted">({g.items.length})</span>
                    </td>
                    <td className="num muted">—</td>
                    <td className="num">{pct(g.cpu, 1)}</td>
                    <td className="num">{bytes(g.memory)}</td>
                    <td className="num">{rate(g.disk)}</td>
                  </tr>,
                  ...(open ? g.items.map((p) => row(p, true)) : []),
                ];
              })}
            </tbody>
          </table>
          {groups.length === 0 && <div className="empty">No processes match “{query}”.</div>}
        </div>

        {selected && (
          <aside className="detail card">
            <div className="card-title">
              <h3>{selected.name}</h3>
              <button className="icon-btn" onClick={() => setSelected(null)} aria-label="Close details">
                <X size={16} />
              </button>
            </div>
            <dl>
              <dt>PID</dt>
              <dd>{selected.pid}</dd>
              <dt>Parent PID</dt>
              <dd>{selected.parentPid ?? "—"}</dd>
              <dt>Status</dt>
              <dd>{selected.status}</dd>
              <dt>Started</dt>
              <dd>{selected.startTime ? new Date(selected.startTime * 1000).toLocaleString() : "—"}</dd>
              <dt>Path</dt>
              <dd className="mono wrap">{selected.exe ?? "Access denied"}</dd>
              {selected.cmd && (
                <>
                  <dt>Command line</dt>
                  <dd className="mono wrap">{selected.cmd}</dd>
                </>
              )}
            </dl>
            <label className="field">
              <span>Priority</span>
              <select key={selected.pid} defaultValue="" onChange={(e) => e.target.value && setPriority(selected, e.target.value as Priority)}>
                <option value="" disabled>
                  Change priority…
                </option>
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="actions">
              {selected.exe && (
                <button className="btn" onClick={() => api.openFileLocation(selected.exe!).catch((e) => toast(errorText(e), "error"))}>
                  <FolderOpen size={16} /> Open file location
                </button>
              )}
              <button className="btn btn-danger" onClick={() => kill([selected])}>
                End process
              </button>
              {grouped && processes.filter((p) => p.name === selected.name).length > 1 && (
                <button className="btn btn-danger-ghost" onClick={() => kill(processes.filter((p) => p.name === selected.name))}>
                  End all {selected.name}
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
