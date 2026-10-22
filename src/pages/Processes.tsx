import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, CirclePause, FolderOpen, SearchX, Shield, TriangleAlert, X } from "lucide-react";
import { api, errorText, Metrics, Priority, ProcessDetails, ProcessInfo, ProcessTarget } from "../api";
import { useConfirm } from "../components/Confirm";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SearchBox } from "../components/SearchBox";
import { Segmented } from "../components/Segmented";
import { SkeletonRows } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { bytes, nameHue, pct, rate } from "../format";
import { useEndProcesses } from "../hooks/useActions";
import { useOnRefresh } from "../hooks/useRefresh";

export type ProcessSortKey = "name" | "pid" | "cpu" | "memory" | "io";

/** Realtime is left out on purpose: it can freeze the whole PC. */
const PRIORITIES: { value: Priority; label: string }[] = [
  { value: "idle", label: "Low" },
  { value: "belowNormal", label: "Below normal" },
  { value: "normal", label: "Normal" },
  { value: "aboveNormal", label: "Above normal" },
  { value: "high", label: "High" },
];
const priorityLabel = (p: Priority) => (p === "realtime" ? "Realtime" : (PRIORITIES.find((x) => x.value === p)?.label ?? p));

interface Group {
  key: string;
  name: string;
  items: ProcessInfo[];
  cpu: number;
  memory: number;
  io: number;
  minPid: number;
}

const same = (p: ProcessTarget, q: ProcessTarget | null) => !!q && p.pid === q.pid && p.startTime === q.startTime;
const itemKey = (p: ProcessTarget) => `${p.pid}-${p.startTime}`;
const displayName = (p: ProcessInfo) => (p.isSelf && !p.name.toLowerCase().startsWith("msedgewebview2") ? "Optimo" : p.name);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface Props {
  active: boolean;
  initialQuery?: string;
  /** From the dashboard: open with this column sorted (the nonce makes repeat requests count). */
  initialSort?: { key: ProcessSortKey; nonce: number };
  metrics: Metrics | null;
}

export function Processes({ active, initialQuery, initialSort, metrics }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const endProcesses = useEndProcesses();
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [sort, setSort] = useState<{ key: ProcessSortKey; desc: boolean }>({ key: initialSort?.key ?? "cpu", desc: initialSort?.key !== "name" });
  const [grouped, setGrouped] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The selection is a pid + start time, matched against every new list, so a PID that Windows
  // reuses for another program is never mistaken for the selected one.
  const [selection, setSelection] = useState<ProcessInfo | null>(null);
  const [details, setDetails] = useState<{ key: ProcessTarget; data?: ProcessDetails; error?: string } | null>(null);
  // Rows keep their order while the pointer is over the list or the keyboard moves through it,
  // so the row under the cursor is the one that gets clicked.
  const [hovering, setHovering] = useState(false);
  const [keyboarding, setKeyboarding] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const order = useRef<{ for: string; groups: string[]; items: string[] }>({ for: "", groups: [], items: [] });
  const tbody = useRef<HTMLTableSectionElement>(null);
  const frozen = hovering || keyboarding;

  useEffect(() => {
    if (initialQuery !== undefined) setQuery(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    if (initialSort) setSort({ key: initialSort.key, desc: initialSort.key !== "name" });
  }, [initialSort?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = () =>
    api
      .processes()
      .then((list) => {
        setProcesses(list);
        // The sampler's first snapshot can be empty for a moment right after launch.
        if (list.length > 0) setLoaded(true);
      })
      .catch(() => {});
  useOnRefresh(load);

  useEffect(() => {
    if (!active) return;
    load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [active]);

  const live = selection ? processes.find((p) => same(p, selection)) : undefined;
  const selected = live ?? selection;
  const ended = !!selection && !live && loaded;

  // Path, command line and current priority are read on demand for the selected process.
  const loadDetails = (key: ProcessTarget) =>
    api
      .processDetails(key)
      .then((data) => setDetails((d) => (d && same(d.key, key) ? { key, data } : d)))
      .catch((e) => setDetails((d) => (d && same(d.key, key) ? { key, error: errorText(e) } : d)));

  useEffect(() => {
    if (!selection) {
      setDetails(null);
      return;
    }
    const key = { pid: selection.pid, startTime: selection.startTime };
    setDetails({ key });
    loadDetails(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.pid, selection?.startTime]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid) === q || p.exe?.toLowerCase().includes(q))
      : processes;

    const map = new Map<string, Group>();
    for (const p of filtered) {
      const key = grouped ? p.name.toLowerCase() : `${p.name}#${p.pid}`;
      const g = map.get(key) ?? { key, name: p.name, items: [], cpu: 0, memory: 0, io: 0, minPid: p.pid };
      g.items.push(p);
      g.cpu += p.cpu;
      g.memory += p.memory;
      g.io += p.ioRead + p.ioWrite;
      g.minPid = Math.min(g.minPid, p.pid);
      map.set(key, g);
    }

    const list = [...map.values()];
    const signature = `${sort.key}:${sort.desc}:${q}:${grouped}`;
    if (frozen && order.current.for === signature) {
      // Keep the previous order; anything new goes to the end.
      const rank = (keys: string[], key: string) => {
        const i = keys.indexOf(key);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
      };
      for (const g of list) g.items.sort((a, b) => rank(order.current.items, itemKey(a)) - rank(order.current.items, itemKey(b)));
      return list.sort((a, b) => rank(order.current.groups, a.key) - rank(order.current.groups, b.key));
    }

    const by = <T,>(value: (x: T) => number | string) => (a: T, b: T) => {
      const [x, y] = [value(a), value(b)];
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    };
    const processValue = (p: ProcessInfo): number | string =>
      sort.key === "name" ? p.name.toLowerCase() : sort.key === "pid" ? p.pid : sort.key === "io" ? p.ioRead + p.ioWrite : p[sort.key];
    const groupValue = (g: Group): number | string =>
      sort.key === "name" ? g.name.toLowerCase() : sort.key === "pid" ? g.minPid : g[sort.key];

    for (const g of list) g.items.sort(by(processValue));
    list.sort(by(groupValue));
    order.current = { for: signature, groups: list.map((g) => g.key), items: list.flatMap((g) => g.items.map(itemKey)) };
    return list;
  }, [processes, query, sort, grouped, frozen]);

  const memTotal = metrics?.memTotal ?? 0;
  const cpuHeat = (cpu: number) => clamp01(cpu / 25);
  const memHeat = (mem: number) => clamp01(memTotal ? mem / (memTotal * 0.12) : mem / 2e9);

  const header = (key: ProcessSortKey, label: string, opts: { numeric?: boolean; title?: string; className?: string; total?: string } = {}) => {
    const sorted = sort.key === key;
    return (
      <th
        className={`${opts.numeric ? "num" : ""} ${sorted ? "sorted" : ""} ${opts.className ?? ""}`}
        aria-sort={sorted ? (sort.desc ? "descending" : "ascending") : "none"}
        title={opts.title}
      >
        <button className="th-btn" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
          {label}
          {opts.total && <span className="th-total">{opts.total}</span>}
          {sorted ? sort.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} /> : null}
        </button>
      </th>
    );
  };

  async function kill(list: ProcessInfo[]) {
    if (!(await endProcesses(list))) return;
    if (list.some((p) => same(p, selection))) setSelection(null);
    load();
  }

  async function setPriority(p: ProcessInfo, priority: Priority) {
    if (p.warning && (priority === "idle" || priority === "high")) {
      const ok = await confirm({
        title: `Set ${p.name} to ${priorityLabel(priority)} priority?`,
        message: "Windows relies on this process. A different priority can make sound, printing or the desktop stutter.",
        confirmLabel: "Change priority",
      });
      if (!ok) return;
    }
    try {
      const change = await api.setPriority(p, priority);
      const applied = change.applied ?? priority;
      if (applied !== priority) toast(`Windows set ${p.name} to ${priorityLabel(applied)} instead.`, "info");
      else toast(`${p.name} priority set to ${priorityLabel(applied)}. You can undo this in Activity.`, "success");
      setDetails((d) => (d?.data && same(d.key, p) ? { ...d, data: { ...d.data, priority: applied } } : d));
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const toggleGroup = (key: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });

  // Keyboard: ↑↓ move, Enter/Space opens a group or the details, ←→ collapse/expand, Delete ends.
  const onRowKey = (e: React.KeyboardEvent<HTMLTableRowElement>, row: { group?: Group; proc?: ProcessInfo }) => {
    const rows = [...(tbody.current?.querySelectorAll<HTMLTableRowElement>("tr[data-key]") ?? [])];
    const i = rows.indexOf(e.currentTarget);
    const move = (to: number) => {
      e.preventDefault();
      setKeyboarding(true);
      rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (row.group) toggleGroup(row.group.key);
      else if (row.proc) setSelection(row.proc);
    } else if (row.group && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      toggleGroup(row.group.key, e.key === "ArrowRight");
    } else if (e.key === "Delete") {
      e.preventDefault();
      kill(row.group ? row.group.items : row.proc ? [row.proc] : []);
    }
  };

  const firstKey = groups[0] ? (groups[0].items.length > 1 ? `g-${groups[0].key}` : itemKey(groups[0].items[0])) : null;
  const rowFocus = (key: string) => ({
    "data-key": key,
    tabIndex: key === (focusKey ?? firstKey) ? 0 : -1,
    onFocus: () => setFocusKey(key),
  });

  const avatar = (name: string, system: boolean) => (
    <span className={`app-avatar ${system ? "system" : ""}`} style={{ "--avatar-h": nameHue(name) } as React.CSSProperties} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  );

  const numbers = (cpu: number, memory: number, io: number, pid: number | null) => (
    <>
      {!grouped && <td className="num muted col-optional">{pid ?? "—"}</td>}
      <td className="num heat" style={{ "--h": cpuHeat(cpu) } as React.CSSProperties}>
        {pct(cpu, 1)}
      </td>
      <td className="num heat" style={{ "--h": memHeat(memory) } as React.CSSProperties}>
        {bytes(memory)}
      </td>
      <td className="num col-optional">{rate(io)}</td>
    </>
  );

  const row = (p: ProcessInfo, child = false) => {
    const key = itemKey(p);
    return (
      <tr
        key={key}
        {...rowFocus(key)}
        className={`clickable ${same(p, selection) ? "selected" : ""}`}
        aria-selected={same(p, selection)}
        onClick={() => setSelection(p)}
        onKeyDown={(e) => onRowKey(e, { proc: p })}
      >
        <td className="name-cell" title={p.exe ?? p.name}>
          <span className={`name-flex ${child ? "child-indent" : ""}`}>
            {!child && <span className="chev-spacer" />}
            {!child && avatar(displayName(p), !!p.protected && !p.isSelf)}
            <span className="truncate">{displayName(p)}</span>
            {child && <span className="subtle small nowrap">PID {p.pid}</span>}
            {p.isSelf ? <span className="pill pill-sm pill-accent">This app</span> : p.protected && <ProtectedIcon reason={p.protected} />}
          </span>
        </td>
        {numbers(p.cpu, p.memory, p.ioRead + p.ioWrite, p.pid)}
      </tr>
    );
  };

  const siblings = selected ? processes.filter((p) => p.name === selected.name) : [];
  const siblingsProtected = siblings.some((p) => p.protected);
  const exe = details?.data?.exe || selected?.exe || null;
  const currentPriority = details?.data?.priority ?? null;
  const blockReason = ended ? "This app has closed." : selected?.protected;
  const columns = grouped ? 4 : 5;

  const m = metrics;
  const memPct = m && m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;

  return (
    <div className="page page-fill">
      <PageHeader
        title="Processes"
        subtitle={
          m
            ? `CPU ${pct(m.cpuTotal)} · Memory ${bytes(m.memUsed)} of ${bytes(m.memTotal)} (${pct(memPct)}) · ${processes.length || m.processCount} processes`
            : "Everything running on your PC, heaviest first."
        }
        actions={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Search by name or PID" />
            <Segmented
              label="Show"
              value={grouped ? "apps" : "all"}
              onChange={(v) => setGrouped(v === "apps")}
              options={[
                { value: "apps", label: "Apps", title: "One row per app, with its processes inside" },
                { value: "all", label: "All processes", title: "Every process on its own row, with its PID" },
              ]}
            />
          </>
        }
      />

      <div className="split">
        <div
          className="table-wrap"
          onMouseEnter={() => setHovering(true)}
          onMouseLeave={() => {
            setHovering(false);
            setKeyboarding(false);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyboarding(false);
          }}
        >
          <table className="table table-fixed" aria-label="Running processes">
            <thead>
              <tr>
                {header("name", grouped ? "App" : "Name")}
                {!grouped && header("pid", "PID", { numeric: true, className: "col-optional col-pid" })}
                {header("cpu", "CPU", { numeric: true, total: m ? pct(m.cpuTotal) : undefined, title: "Share of the whole processor", className: "col-cpu" })}
                {header("memory", "Memory", { numeric: true, total: m ? pct(memPct) : undefined, className: "col-mem" })}
                {header("io", "Disk & net", {
                  numeric: true,
                  className: "col-optional col-io",
                  title: "Disk, network and other input/output per second (Windows doesn't separate them per process)",
                })}
              </tr>
            </thead>
            <tbody ref={tbody}>
              {!loaded && processes.length === 0 && <SkeletonRows columns={columns} rows={10} />}
              {groups.map((g) => {
                if (g.items.length === 1) return row(g.items[0]);
                const open = expanded.has(g.key);
                const shielded = g.items.find((p) => p.protected && !p.isSelf);
                const key = `g-${g.key}`;
                return [
                  <tr
                    key={key}
                    {...rowFocus(key)}
                    className="clickable"
                    aria-expanded={open}
                    onClick={() => toggleGroup(g.key)}
                    onKeyDown={(e) => onRowKey(e, { group: g })}
                  >
                    <td className="name-cell">
                      <span className="name-flex">
                        <ChevronRight size={14} className={`chev ${open ? "open" : ""}`} />
                        {avatar(g.name, !!shielded)}
                        <span className="truncate">{g.name}</span>
                        <span className="pill pill-sm">{g.items.length}</span>
                        {shielded && <ProtectedIcon reason={shielded.protected!} />}
                      </span>
                    </td>
                    {numbers(g.cpu, g.memory, g.io, null)}
                  </tr>,
                  ...(open ? g.items.map((p) => row(p, true)) : []),
                ];
              })}
            </tbody>
          </table>
          {loaded && groups.length === 0 && (
            <EmptyState
              icon={SearchX}
              title={query ? `No results for “${query}”` : "No processes to show"}
              body={query ? "Check the spelling, or search by part of the name, the PID or the file path." : undefined}
              actions={
                query && (
                  <button className="btn" onClick={() => setQuery("")}>
                    Clear search
                  </button>
                )
              }
            />
          )}
          {frozen && groups.length > 1 && (
            <div className="paused-chip" aria-hidden="true">
              <span>
                <CirclePause size={13} /> Order paused while you browse
              </span>
            </div>
          )}
        </div>

        {selected && (
          <aside className="detail card" aria-label={`Details for ${displayName(selected)}`}>
            <div className="detail-head">
              <span className={`app-avatar lg ${selected.protected && !selected.isSelf ? "system" : ""}`} style={{ "--avatar-h": nameHue(displayName(selected)) } as React.CSSProperties}>
                {displayName(selected).charAt(0).toUpperCase()}
              </span>
              <div className="detail-title">
                <h3 title={displayName(selected)}>{displayName(selected)}</h3>
                <p>{selected.isSelf ? "This app" : selected.protected ? "Part of Windows" : `PID ${selected.pid}`}</p>
              </div>
              <button className="icon-btn" onClick={() => setSelection(null)} aria-label="Close details" title="Close details">
                <X size={16} />
              </button>
            </div>
            {ended ? (
              <div className="note">
                <CirclePause size={16} />
                <span>This app has closed, so there's nothing left to change.</span>
              </div>
            ) : selected.protected ? (
              <div className="note note-info">
                <Shield size={16} />
                <span>{selected.protected}</span>
              </div>
            ) : (
              selected.warning && (
                <div className="note note-warn">
                  <TriangleAlert size={16} />
                  <span>{selected.warning}</span>
                </div>
              )
            )}
            {!ended && (
              <div className="detail-stats">
                <div className="detail-stat">
                  <span>CPU</span>
                  <strong>{pct(selected.cpu, 1)}</strong>
                </div>
                <div className="detail-stat">
                  <span>Memory</span>
                  <strong>{bytes(selected.memory)}</strong>
                </div>
              </div>
            )}
            <dl>
              <dt>PID</dt>
              <dd className="selectable">{selected.pid}</dd>
              <dt>Parent PID</dt>
              <dd>{selected.parentPid ?? "—"}</dd>
              <dt>Started</dt>
              <dd>{selected.startTime ? new Date(selected.startTime * 1000).toLocaleString() : "—"}</dd>
              <dt>Location</dt>
              <dd className="mono wrap small">{exe ?? (details && !details.data && !details.error ? "…" : "Not available (access denied)")}</dd>
              {details?.data?.cmd && (
                <>
                  <dt>Command line</dt>
                  <dd className="mono wrap small">{details.data.cmd}</dd>
                </>
              )}
            </dl>
            <label className="field" title={blockReason ?? undefined}>
              <span>Priority</span>
              <select
                value={currentPriority ?? ""}
                disabled={!!blockReason}
                onChange={(e) => e.target.value && setPriority(selected, e.target.value as Priority)}
              >
                <option value="" disabled>
                  {details?.data ? "Unknown" : "…"}
                </option>
                {currentPriority === "realtime" && (
                  <option value="realtime" disabled>
                    Realtime
                  </option>
                )}
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="actions">
              {exe && (
                <button className="btn" onClick={() => api.openFileLocation(exe).catch((e) => toast(errorText(e), "error"))}>
                  <FolderOpen size={16} /> Open file location
                </button>
              )}
              <button className="btn btn-danger" disabled={!!blockReason} title={blockReason ?? undefined} onClick={() => kill([selected])}>
                End process
              </button>
              {grouped && !ended && siblings.length > 1 && !siblingsProtected && (
                <button className="btn btn-danger-ghost" onClick={() => kill(siblings)}>
                  End all {siblings.length} {selected.name}
                </button>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ProtectedIcon({ reason }: { reason: string }) {
  return (
    <span className="protected" title={reason} aria-label="Protected: part of Windows">
      <Shield size={13} />
    </span>
  );
}
