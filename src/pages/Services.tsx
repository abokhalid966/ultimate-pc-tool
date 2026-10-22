import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  FolderOpen,
  Info,
  Lock,
  Play,
  RefreshCw,
  RotateCw,
  SearchX,
  ServerCog,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Square,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { api, errorText, ServiceAction, ServiceDetails, ServiceInfo, ServiceLink, ServiceStartup, ServiceStatus } from "../api";
import { useConfirm } from "../components/Confirm";
import { EmptyState, ErrorState } from "../components/EmptyState";
import { Menu, MenuEntry } from "../components/Menu";
import { PageHeader } from "../components/PageHeader";
import { SearchBox } from "../components/SearchBox";
import { Segmented } from "../components/Segmented";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { nameHue } from "../format";
import { useAsync } from "../hooks/useAsync";
import { useOnRefresh } from "../hooks/useRefresh";
import "./services.css";

type Filter = "all" | "running" | "stopped" | "thirdParty" | "disabled";
type SortKey = "name" | "status" | "startup" | "publisher";

const STATUS_LABEL: Record<ServiceStatus, string> = {
  running: "Running",
  stopped: "Stopped",
  starting: "Starting…",
  stopping: "Stopping…",
  paused: "Paused",
  pausing: "Pausing…",
  resuming: "Resuming…",
};
const PENDING: ServiceStatus[] = ["starting", "stopping", "pausing", "resuming"];
const STATUS_ORDER: Record<ServiceStatus, number> = { running: 0, starting: 1, resuming: 1, stopping: 2, pausing: 2, paused: 3, stopped: 4 };

const STARTUP_ORDER: ServiceStartup[] = ["automatic", "automaticDelayed", "manual", "disabled"];
const STARTUP_LABEL: Record<ServiceStartup, string> = {
  automatic: "Automatic",
  automaticDelayed: "Automatic (delayed)",
  manual: "Manual",
  disabled: "Disabled",
};
const STARTUP_HELP: Record<ServiceStartup, string> = {
  automatic: "Starts with Windows.",
  automaticDelayed: "Starts shortly after Windows, so signing in feels quicker.",
  manual: "Starts only when Windows or an app needs it.",
  disabled: "Never starts, even when something needs it.",
};
const STARTUP_DONE: Record<ServiceStartup, (name: string) => string> = {
  automatic: (n) => `${n} will start with Windows.`,
  automaticDelayed: (n) => `${n} will start shortly after Windows.`,
  manual: (n) => `${n} will start only when it's needed.`,
  disabled: (n) => `${n} is disabled and won't start.`,
};
/** How readily it runs: lower runs less. */
const rank = (s: ServiceStartup) => 3 - STARTUP_ORDER.indexOf(s);

const isAdminError = (message: string) => message.includes("Restart as administrator");
const isPending = (s: ServiceInfo) => PENDING.includes(s.status);

/** Per-user copies carry a random suffix ("…_4f2a1"); without it the name reads better. */
const cleanName = (s: ServiceInfo) => (s.template ? s.displayName.replace(/_[0-9a-z]+$/i, "") : s.displayName);

function publisherLabel(s: ServiceInfo): string {
  if (s.publisher === "microsoft") return "Microsoft";
  if (s.publisher === "thirdParty") return s.company ?? "Another company";
  return "Unknown";
}

function accountLabel(account: string | null): string | null {
  if (!account) return null;
  const a = account.toLowerCase();
  if (a === "localsystem" || a === "nt authority\\system") return "System (full access)";
  if (a.endsWith("\\localservice")) return "Local Service (limited access)";
  if (a.endsWith("\\networkservice")) return "Network Service (limited access)";
  return account;
}

// Why an action isn't available right now (null when it is). The backend checks the same rules.
function startBlock(s: ServiceInfo): string | null {
  if (s.status === "running") return "It's already running.";
  if (s.status !== "stopped") return "It's busy starting or stopping. Try again in a moment.";
  if (s.startup === "disabled") return "It's disabled. Change its startup type to Manual or Automatic first.";
  return null;
}
function stopBlock(s: ServiceInfo): string | null {
  if (s.status === "stopped") return "It isn't running.";
  if (s.safety === "protected") return s.safetyNote ?? "Windows needs this service.";
  if (isPending(s)) return "It's busy starting or stopping. Try again in a moment.";
  if (!s.canStop) return "Windows doesn't let this service be stopped while it's running.";
  return null;
}
const restartBlock = (s: ServiceInfo) => (s.status === "stopped" ? "It isn't running. Use Start instead." : stopBlock(s));

const matches = (s: ServiceInfo, filter: Filter) =>
  filter === "running"
    ? s.status !== "stopped"
    : filter === "stopped"
      ? s.status === "stopped"
      : filter === "thirdParty"
        ? s.publisher === "thirdParty"
        : filter === "disabled"
          ? s.startup === "disabled"
          : true;

interface Props {
  elevated: boolean;
  onRestartAsAdmin: () => void;
}

export function Services({ elevated, onRestartAsAdmin }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: services, setData, reload, loading, loaded, error } = useAsync(api.services, [] as ServiceInfo[]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Services with an action in flight; their row shows the expected state until it's confirmed.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<{ name: string; data?: ServiceDetails; error?: string } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const tbody = useRef<HTMLTableSectionElement>(null);
  useOnRefresh(reload);

  const replace = (svc: ServiceInfo) => setData((list) => list.map((s) => (s.name === svc.name ? svc : s)));
  const patch = (name: string, change: Partial<ServiceInfo>) => setData((list) => list.map((s) => (s.name === name ? { ...s, ...change } : s)));
  const setBusyFor = (name: string, on: boolean) =>
    setBusy((set) => {
      const next = new Set(set);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const selected = selectedName ? (services.find((s) => s.name === selectedName) ?? null) : null;

  const loadDetails = (name: string) =>
    api
      .serviceDetails(name)
      .then((data) => setDetails((d) => (d?.name === name ? { name, data } : d)))
      .catch((e) => setDetails((d) => (d?.name === name ? { name, error: errorText(e) } : d)));

  useEffect(() => {
    if (!selectedName) {
      setDetails(null);
      return;
    }
    setDetails({ name: selectedName });
    loadDetails(selectedName);
  }, [selectedName]);

  // Services starting or stopping on their own (or after a timed-out wait) are checked again
  // every two seconds until they settle.
  const pending = services
    .filter((s) => isPending(s) && !busy.has(s.name))
    .map((s) => s.name)
    .join("|");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      for (const name of pending.split("|")) api.service(name).then(replace).catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [pending]);

  const counts = useMemo(
    () => ({
      all: services.length,
      running: services.filter((s) => matches(s, "running")).length,
      stopped: services.filter((s) => matches(s, "stopped")).length,
      thirdParty: services.filter((s) => matches(s, "thirdParty")).length,
      disabled: services.filter((s) => matches(s, "disabled")).length,
    }),
    [services],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = services.filter(
      (s) => matches(s, filter) && (!q || [s.displayName, s.name, s.summary, s.description, s.company].some((f) => f?.toLowerCase().includes(q))),
    );
    const value = (s: ServiceInfo): number | string =>
      sort.key === "status"
        ? STATUS_ORDER[s.status]
        : sort.key === "startup"
          ? s.startup
            ? STARTUP_ORDER.indexOf(s.startup)
            : 9
          : sort.key === "publisher"
            ? publisherLabel(s).toLowerCase()
            : cleanName(s).toLowerCase();
    return list.sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const cmp = x < y ? -1 : x > y ? 1 : cleanName(a).localeCompare(cleanName(b), undefined, { sensitivity: "base" });
      return sort.desc ? -cmp : cmp;
    });
  }, [services, query, filter, sort]);

  const fail = (e: unknown) => {
    const message = errorText(e);
    if (!elevated && isAdminError(message)) {
      toast(message, "error", { action: { label: "Restart as administrator", run: onRestartAsAdmin } });
    } else {
      toast(message, "error");
    }
  };

  /** Running services that need `svc`, which stop along with it. */
  async function runningDependents(svc: ServiceInfo): Promise<ServiceLink[]> {
    const data = details?.name === svc.name && details.data ? details.data : await api.serviceDetails(svc.name).catch(() => null);
    return (data?.dependents ?? []).filter((d) => d.status && d.status !== "stopped");
  }

  async function control(svc: ServiceInfo, action: ServiceAction) {
    if (busy.has(svc.name)) return;
    const name = cleanName(svc);
    if (action === "stop" || (action === "restart" && svc.safety === "important")) {
      const dependents = await runningDependents(svc);
      const also = dependents.map((d) => d.displayName);
      const ok = await confirm({
        title: action === "stop" ? `Stop ${name}?` : `Restart ${name}?`,
        message: (
          <>
            {action === "stop" ? (
              <p>
                {name} stops until you start it again
                {svc.startup === "automatic" || svc.startup === "automaticDelayed" ? " or restart your PC" : ""}.
              </p>
            ) : (
              <p>{name} stops for a moment, then starts again.</p>
            )}
            {also.length > 0 && (
              <p className="svc-confirm-also">
                {also.length === 1 ? "This service needs it and stops too: " : "These services need it and stop too: "}
                <strong>{also.join(", ")}</strong>
              </p>
            )}
          </>
        ),
        warning: svc.safetyNote,
        confirmLabel: action === "stop" ? "Stop service" : "Restart service",
        danger: action === "stop",
      });
      if (!ok) return;
    }

    setBusyFor(svc.name, true);
    patch(svc.name, { status: action === "start" ? "starting" : "stopping" });
    try {
      const r = await api.controlService(svc.name, action);
      if (r.service) replace(r.service);
      else api.service(svc.name).then(replace).catch(() => {});
      // Services stopped or restarted along with it changed too.
      if (r.also.length > 0) reload();
      const also = r.also.length > 0 ? (action === "restart" ? ` Also restarted: ${r.also.join(", ")}.` : ` Also stopped: ${r.also.join(", ")}.`) : "";
      if (r.note) toast(r.note, "info");
      else if (r.timedOut) {
        const doing = action === "start" ? "start" : action === "stop" ? "stop" : "restart";
        toast(`${name} is taking longer than usual to ${doing}. Windows keeps trying, and this list updates when it's done.`, "info");
      } else {
        const done = action === "start" ? "is running" : action === "stop" ? "has stopped" : "has restarted";
        toast(`${name} ${done}.${also}`, "success");
      }
    } catch (e) {
      replace(svc);
      fail(e);
    } finally {
      setBusyFor(svc.name, false);
      if (selectedName === svc.name) loadDetails(svc.name);
    }
  }

  async function changeStartup(svc: ServiceInfo, startup: ServiceStartup) {
    if (svc.startup === startup || busy.has(svc.name)) return;
    const name = cleanName(svc);
    const lowering = !!svc.startup && rank(startup) < rank(svc.startup);
    if (startup === "disabled" || (svc.safety === "important" && lowering)) {
      const ok = await confirm({
        title: startup === "disabled" ? `Disable ${name}?` : `Set ${name} to ${STARTUP_LABEL[startup]}?`,
        message:
          startup === "disabled"
            ? `It won't start any more, even when Windows or an app needs it. You can undo this in Activity.`
            : `${STARTUP_HELP[startup]} You can undo this in Activity.`,
        warning: svc.safetyNote ?? (svc.publisher === "microsoft" ? "This is part of Windows. Some Windows features may stop working until you change it back." : null),
        confirmLabel: startup === "disabled" ? "Disable" : "Change",
        danger: startup === "disabled",
      });
      if (!ok) return;
    }

    setBusyFor(svc.name, true);
    patch(svc.name, { startup });
    try {
      const r = await api.setServiceStartup(svc.name, startup);
      if (r.service) replace(r.service);
      const activityId = r.activityId;
      toast(STARTUP_DONE[startup](name), "success", activityId ? { action: { label: "Undo", run: () => undo(svc, activityId) } } : undefined);
    } catch (e) {
      patch(svc.name, { startup: svc.startup });
      fail(e);
    } finally {
      setBusyFor(svc.name, false);
    }
  }

  /** Reverts through the activity log, so the history shows the change as undone. */
  async function undo(svc: ServiceInfo, activityId: string) {
    try {
      await api.undoActivity(activityId);
      replace(await api.service(svc.name));
      toast(`Undone: ${cleanName(svc)} is back to ${svc.startup ? STARTUP_LABEL[svc.startup] : "how it was"}.`, "success");
    } catch (e) {
      fail(e);
    }
  }

  const menuFor = (s: ServiceInfo): MenuEntry[] => {
    const locked = busy.has(s.name);
    const start = startBlock(s);
    const stop = stopBlock(s);
    const restart = restartBlock(s);
    return [
      { label: "Start", icon: Play, onSelect: () => control(s, "start"), disabled: locked || !!start, title: start ?? undefined },
      { label: "Stop", icon: Square, onSelect: () => control(s, "stop"), disabled: locked || !!stop, title: stop ?? undefined, danger: true },
      { label: "Restart", icon: RotateCw, onSelect: () => control(s, "restart"), disabled: locked || !!restart, title: restart ?? undefined },
      "separator",
      { label: "Details", icon: Info, onSelect: () => setSelectedName(s.name) },
    ];
  };

  const header = (key: SortKey, label: string, opts: { className?: string; style?: React.CSSProperties } = {}) => {
    const sorted = sort.key === key;
    return (
      <th className={`${sorted ? "sorted" : ""} ${opts.className ?? ""}`} style={opts.style} aria-sort={sorted ? (sort.desc ? "descending" : "ascending") : "none"}>
        <button className="th-btn" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }))}>
          {label}
          {sorted ? sort.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} /> : null}
        </button>
      </th>
    );
  };

  // Keyboard: ↑↓ Home End move between rows, Enter or Space opens the details.
  const onRowKey = (e: React.KeyboardEvent<HTMLTableRowElement>, s: ServiceInfo) => {
    const rows = [...(tbody.current?.querySelectorAll<HTMLTableRowElement>("tr[data-key]") ?? [])];
    const i = rows.indexOf(e.currentTarget);
    const move = (to: number) => {
      e.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, to))]?.focus();
    };
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setSelectedName(s.name);
    }
  };

  const firstKey = visible[0]?.name ?? null;
  const activeKey = focusKey && visible.some((s) => s.name === focusKey) ? focusKey : firstKey;
  const filterLabel = (label: string, count: number) => (
    <>
      {label}
      {loaded && <span className="svc-count">{count}</span>}
    </>
  );

  return (
    <div className="page page-fill">
      <PageHeader
        title="Services"
        subtitle={
          loaded && services.length > 0
            ? `${counts.running} of ${counts.all} services are running. Services are programs that work in the background for Windows and your apps.`
            : "Programs that work in the background for Windows and your apps."
        }
        actions={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Search services" />
            <button className="btn" onClick={reload} disabled={loading} title="Read the list again">
              <RefreshCw size={16} className={loading ? "spin" : undefined} /> Refresh
            </button>
          </>
        }
      />

      <div className="svc-toolbar">
        <Segmented<Filter>
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: filterLabel("All", counts.all) },
            { value: "running", label: filterLabel("Running", counts.running) },
            { value: "stopped", label: filterLabel("Stopped", counts.stopped) },
            { value: "thirdParty", label: filterLabel("Other companies", counts.thirdParty), title: "Services from companies other than Microsoft" },
            { value: "disabled", label: filterLabel("Disabled", counts.disabled), title: "Services that never start" },
          ]}
        />
        {!elevated && loaded && (
          <div className="svc-admin" role="note">
            <ShieldAlert size={15} />
            <span>Starting, stopping and changing services needs administrator rights.</span>
            <button className="btn btn-sm" onClick={onRestartAsAdmin}>
              <ShieldCheck size={14} /> Restart as administrator
            </button>
          </div>
        )}
      </div>

      <div className="split">
        <div className="table-wrap">
          {error && services.length === 0 ? (
            <ErrorState what="services" message={error} onRetry={reload} />
          ) : (
            <>
              <table className="table table-fixed svc-table" aria-label="Services">
                <thead>
                  <tr>
                    {header("name", "Service")}
                    {header("status", "Status", { style: { width: 128 } })}
                    {header("startup", "Startup type", { className: "col-optional", style: { width: 168 } })}
                    {header("publisher", "Publisher", { className: "col-optional svc-col-publisher" })}
                    <th style={{ width: 52 }}>
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody ref={tbody}>
                  {!loaded &&
                    Array.from({ length: 9 }, (_, i) => (
                      <tr key={i} aria-hidden="true">
                        <td>
                          <span className="name-flex">
                            <Skeleton width={28} height={28} radius={7} />
                            <span style={{ flex: 1 }}>
                              <Skeleton width={`${38 + ((i * 13) % 30)}%`} />
                              <Skeleton width={`${55 + ((i * 7) % 25)}%`} height={10} style={{ marginTop: 6 }} />
                            </span>
                          </span>
                        </td>
                        <td>
                          <Skeleton width={78} height={22} radius={11} />
                        </td>
                        <td className="col-optional">
                          <Skeleton width={84} />
                        </td>
                        <td className="col-optional">
                          <Skeleton width={70} />
                        </td>
                        <td />
                      </tr>
                    ))}
                  {visible.map((s) => {
                    const microsoft = s.publisher === "microsoft";
                    return (
                      <tr
                        key={s.name}
                        data-key={s.name}
                        tabIndex={s.name === activeKey ? 0 : -1}
                        onFocus={() => setFocusKey(s.name)}
                        className={`clickable ${selectedName === s.name ? "selected" : ""} ${s.status === "stopped" ? "svc-off" : ""}`}
                        aria-selected={selectedName === s.name}
                        onClick={() => setSelectedName(s.name)}
                        onKeyDown={(e) => onRowKey(e, s)}
                      >
                        <td className="svc-name-cell">
                          <span className="name-flex">
                            <span
                              className={`app-avatar svc-avatar ${microsoft ? "system" : ""}`}
                              style={{ "--avatar-h": nameHue(s.company ?? s.name) } as React.CSSProperties}
                              aria-hidden="true"
                            >
                              {microsoft ? <ServerCog size={14} /> : cleanName(s).charAt(0).toUpperCase()}
                            </span>
                            <span className="svc-name">
                              <span className="svc-name-line">
                                <strong className="truncate" title={s.displayName}>
                                  {cleanName(s)}
                                </strong>
                                <SafetyPill service={s} />
                                {s.template && (
                                  <span className="pill pill-sm pill-outline" title={`Windows made this copy of “${s.template}” for your account.`}>
                                    <UserRound size={11} /> Your account
                                  </span>
                                )}
                              </span>
                              <span className="svc-sub truncate" title={s.description ?? undefined}>
                                {s.summary ?? s.description ?? s.name}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <StatusChip status={s.status} />
                        </td>
                        <td className="col-optional">
                          <span className={`svc-startup ${s.startup ?? "unknown"}`}>{s.startup ? STARTUP_LABEL[s.startup] : "Unknown"}</span>
                        </td>
                        <td className="col-optional svc-col-publisher">
                          <span className={`svc-publisher truncate ${s.publisher}`} title={s.company ?? undefined}>
                            {publisherLabel(s)}
                          </span>
                        </td>
                        <td className="svc-menu-cell" onClick={(e) => e.stopPropagation()}>
                          {busy.has(s.name) ? (
                            <span className="svc-busy" aria-label="Working">
                              <span className="spinner" />
                            </span>
                          ) : (
                            <Menu items={menuFor(s)} label={`Actions for ${cleanName(s)}`} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {loaded &&
                visible.length === 0 &&
                (query || filter !== "all" ? (
                  <EmptyState
                    icon={SearchX}
                    title={query ? `No services match “${query}”` : "No services here"}
                    body={query ? "Try part of the name, or the service name shown in its details." : "Nothing matches this filter right now."}
                    actions={
                      <button
                        className="btn"
                        onClick={() => {
                          setQuery("");
                          setFilter("all");
                        }}
                      >
                        Show all services
                      </button>
                    }
                  />
                ) : (
                  <EmptyState icon={ServerCog} title="No services found" body="Windows didn't report any services." />
                ))}
            </>
          )}
        </div>

        {selected && (
          <ServicePanel
            key={selected.name}
            service={selected}
            details={details?.name === selected.name ? details : null}
            busy={busy.has(selected.name)}
            known={(name) => services.some((s) => s.name.toLowerCase() === name.toLowerCase())}
            onSelect={(name) => setSelectedName(services.find((s) => s.name.toLowerCase() === name.toLowerCase())?.name ?? null)}
            onClose={() => setSelectedName(null)}
            onControl={(action) => control(selected, action)}
            onStartup={(startup) => changeStartup(selected, startup)}
            onError={fail}
          />
        )}
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: ServiceStatus }) {
  return (
    <span className={`svc-status ${status}`}>
      {PENDING.includes(status) ? <span className="spinner" aria-hidden="true" /> : <span className="svc-dot" aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

function SafetyPill({ service: s }: { service: ServiceInfo }) {
  if (s.safety === "protected") {
    return (
      <span className="pill pill-sm svc-pill-protected" title={s.safetyNote ?? undefined}>
        <Lock size={11} /> Needed by Windows
      </span>
    );
  }
  if (s.safety === "important") {
    return (
      <span className="pill pill-sm pill-warn" title={s.safetyNote ? `If it stops: ${s.safetyNote}` : undefined}>
        <TriangleAlert size={11} /> Use care
      </span>
    );
  }
  return null;
}

interface PanelProps {
  service: ServiceInfo;
  details: { data?: ServiceDetails; error?: string } | null;
  busy: boolean;
  known: (name: string) => boolean;
  onSelect: (name: string) => void;
  onClose: () => void;
  onControl: (action: ServiceAction) => void;
  onStartup: (startup: ServiceStartup) => void;
  onError: (e: unknown) => void;
}

function ServicePanel({ service: s, details, busy, known, onSelect, onClose, onControl, onStartup, onError }: PanelProps) {
  const name = cleanName(s);
  const microsoft = s.publisher === "microsoft";
  const start = startBlock(s);
  const stop = stopBlock(s);
  const restart = restartBlock(s);
  const startupLocked = s.template
    ? `Windows makes this copy for your account from “${s.template}”, and it follows that service's startup type.`
    : !s.startup
      ? "Windows didn't let this app read how this service starts."
      : null;
  // Protected services can be made to run more, never less.
  const optionBlocked = (option: ServiceStartup) =>
    s.safety === "protected" && (option === "disabled" || (!!s.startup && rank(option) < rank(s.startup)));
  const account = accountLabel(s.account);

  return (
    <aside className="detail card svc-detail" aria-label={`Details for ${name}`}>
      <div className="detail-head">
        <span className={`app-avatar lg ${microsoft ? "system" : ""}`} style={{ "--avatar-h": nameHue(s.company ?? s.name) } as React.CSSProperties} aria-hidden="true">
          {microsoft ? <ServerCog size={20} /> : name.charAt(0).toUpperCase()}
        </span>
        <div className="detail-title">
          <h3 title={s.displayName}>{name}</h3>
          <p className="selectable">{s.name}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details" title="Close details">
          <X size={16} />
        </button>
      </div>

      {s.safety === "protected" ? (
        <div className="note note-info">
          <Shield size={16} />
          <span>{s.safetyNote}</span>
        </div>
      ) : (
        s.safety === "important" &&
        s.safetyNote && (
          <div className="note note-warn">
            <TriangleAlert size={16} />
            <span>
              <strong>If it stops: </strong>
              {s.safetyNote}
            </span>
          </div>
        )
      )}

      <div className="detail-stats">
        <div className="detail-stat">
          <span>Status</span>
          <strong className="svc-stat-status">
            <StatusChip status={s.status} />
          </strong>
        </div>
        <div className="detail-stat">
          <span>Process ID</span>
          <strong>{s.pid ?? "—"}</strong>
        </div>
      </div>

      <div className="svc-actions">
        {s.status === "stopped" ? (
          <button className="btn btn-primary" disabled={busy || !!start} title={start ?? undefined} onClick={() => onControl("start")}>
            {busy ? <span className="spinner" /> : <Play size={15} />} Start
          </button>
        ) : (
          <>
            <button className="btn" disabled={busy || !!restart} title={restart ?? undefined} onClick={() => onControl("restart")}>
              {busy ? <span className="spinner" /> : <RotateCw size={15} />} Restart
            </button>
            <button className="btn btn-danger-ghost" disabled={busy || !!stop} title={stop ?? undefined} onClick={() => onControl("stop")}>
              <Square size={14} /> Stop
            </button>
          </>
        )}
      </div>

      <label className="field" title={startupLocked ?? undefined}>
        <span>Startup type</span>
        <select value={s.startup ?? ""} disabled={busy || !!startupLocked} onChange={(e) => e.target.value && onStartup(e.target.value as ServiceStartup)}>
          {!s.startup && (
            <option value="" disabled>
              Unknown
            </option>
          )}
          {STARTUP_ORDER.map((option) => (
            <option key={option} value={option} disabled={optionBlocked(option)}>
              {STARTUP_LABEL[option]}
              {optionBlocked(option) ? " (not allowed)" : ""}
            </option>
          ))}
        </select>
        <span className="field-help">{startupLocked ?? (s.startup ? STARTUP_HELP[s.startup] : "")}</span>
      </label>

      {(s.summary || s.description) && (
        <section className="svc-about">
          <h4>What it does</h4>
          {s.summary && <p>{s.summary}</p>}
          {s.description && <p className={s.summary ? "svc-official" : undefined}>{s.description}</p>}
        </section>
      )}

      <dl>
        <dt>Publisher</dt>
        <dd>
          {publisherLabel(s)}
          {s.company && s.company !== publisherLabel(s) && <span className="svc-dd-sub">{s.company}</span>}
        </dd>
        {account && (
          <>
            <dt>Runs as</dt>
            <dd>
              {account}
              {account !== s.account && <span className="svc-dd-sub mono">{s.account}</span>}
            </dd>
          </>
        )}
        <dt>Runs in</dt>
        <dd>{s.sharedProcess ? "A shared Service Host process (svchost.exe)" : "Its own process"}</dd>
        {s.program && (
          <>
            <dt>Program</dt>
            <dd className="mono wrap small selectable">{s.program}</dd>
          </>
        )}
        {s.commandLine && s.commandLine !== s.program && (
          <>
            <dt>Command line</dt>
            <dd className="mono wrap small selectable">{s.commandLine}</dd>
          </>
        )}
      </dl>

      <Links
        title="Needs these services"
        empty="It doesn't need other services."
        links={details?.data?.dependencies}
        error={details?.error}
        known={known}
        onSelect={onSelect}
      />
      <Links
        title="These services need it"
        empty="No other service needs it."
        links={details?.data?.dependents}
        error={details?.error}
        known={known}
        onSelect={onSelect}
      />

      {s.program && (
        <button className="btn" onClick={() => api.openFileLocation(s.program!).catch(onError)}>
          <FolderOpen size={16} /> Open file location
        </button>
      )}
    </aside>
  );
}

function Links({
  title,
  empty,
  links,
  error,
  known,
  onSelect,
}: {
  title: string;
  empty: string;
  links: ServiceLink[] | undefined;
  error?: string;
  known: (name: string) => boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <section className="svc-links">
      <h4>{title}</h4>
      {error ? (
        <p className="muted small">Couldn't read this: {error}</p>
      ) : !links ? (
        <div className="svc-link-list" aria-hidden="true">
          <Skeleton width={110} height={26} radius={13} />
          <Skeleton width={84} height={26} radius={13} />
        </div>
      ) : links.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <div className="svc-link-list">
          {links.map((l) =>
            l.group || !known(l.name) ? (
              <span key={l.name} className="svc-link static" title={l.group ? "A group of drivers or services Windows loads together" : l.name}>
                {l.status && <span className={`svc-dot ${l.status}`} aria-hidden="true" />}
                {l.group ? `Group: ${l.displayName}` : l.displayName}
              </span>
            ) : (
              <button key={l.name} type="button" className="svc-link" title={`${l.name} · ${l.status ? STATUS_LABEL[l.status] : ""}`} onClick={() => onSelect(l.name)}>
                {l.status && <span className={`svc-dot ${l.status}`} aria-hidden="true" />}
                {l.displayName}
              </button>
            ),
          )}
        </div>
      )}
    </section>
  );
}
