import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, CircleCheck, Clock, Cpu, HardDrive, HeartPulse, ListTree, MemoryStick, Thermometer, TriangleAlert, X } from "lucide-react";
import { api, errorText, Metrics, ProcessInfo, SystemOverview } from "../api";
import type { NavigateOptions } from "../App";
import { useConfirm } from "../components/Confirm";
import { RingGauge } from "../components/RingGauge";
import { Skeleton } from "../components/Skeleton";
import { Sparkline } from "../components/Sparkline";
import { useToast } from "../components/Toast";
import { bytes, driveLabel, duration, longDuration, mountLabel, nameHue, pct, rate } from "../format";
import { useEndProcesses } from "../hooks/useActions";
import { currentScore, startHealthCheck, useHealthCheck } from "../hooks/useHealthCheck";
import { MetricsState } from "../hooks/useMetrics";
import { PageId } from ".";

type Level = "ok" | "warn" | "danger";

const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

function level(value: number, warn: number, danger: number): Level {
  return value >= danger ? "danger" : value >= warn ? "warn" : "ok";
}

const LEVEL_COLOR: Record<Level, string> = { ok: "", warn: "var(--warn-fill)", danger: "var(--danger-fill)" };

const CPU_WORDS: Record<Level, string> = { ok: "Normal", warn: "Busy", danger: "Very busy" };
const MEM_WORDS: Record<Level, string> = { ok: "Normal", warn: "High", danger: "Very high" };

interface Props {
  metrics: MetricsState;
  onNavigate: (page: PageId, opts?: NavigateOptions) => void;
  onCleanTemp: () => void;
}

export function Dashboard({ metrics, onNavigate, onCleanTemp }: Props) {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const { latest: m, history } = metrics;

  useEffect(() => {
    api.overview().then(setOverview).catch(() => {});
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <div className="page-header-text">
          <h1>{overview?.hostName || "This PC"}</h1>
          {overview ? (
            <p>
              {overview.osVersion || overview.osName} · {overview.cpuName}
            </p>
          ) : (
            <Skeleton width={320} height={14} style={{ marginTop: 8 }} />
          )}
        </div>
        {m && (
          <div className="page-header-actions header-chips">
            <span className="chip" title="Time since Windows last started">
              <Clock size={14} /> Up <strong>{duration(m.uptimeSecs)}</strong>
            </span>
            <button className="chip" style={{ cursor: "pointer" }} onClick={() => onNavigate("processes")} title="Open Processes">
              <ListTree size={14} /> <strong>{m.processCount}</strong> processes
            </button>
          </div>
        )}
      </header>

      {m ? (
        <>
          <HealthSummary m={m} history={history} onNavigate={onNavigate} onCleanTemp={onCleanTemp} />
          <Tiles m={m} history={history} onNavigate={onNavigate} />
          <div className="dash-grid">
            <div className="dash-col">
              <TopApps memTotal={m.memTotal} onNavigate={onNavigate} />
              <Threads m={m} />
            </div>
            <div className="dash-col">
              <Drives m={m} />
              <AboutPc m={m} overview={overview} />
            </div>
          </div>
        </>
      ) : (
        <DashboardSkeleton />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Health summary

interface Issue {
  key: string;
  level: "warn" | "danger";
  title: string;
  detail: string;
  actions: { label: string; primary?: boolean; run: () => void }[];
}

function HealthSummary({
  m,
  history,
  onNavigate,
  onCleanTemp,
}: {
  m: Metrics;
  history: Metrics[];
  onNavigate: Props["onNavigate"];
  onCleanTemp: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();

  const launch = (label: string, command: string) =>
    api.runCommand(command, "powershell", false, label).catch((e) => toast(errorText(e), "error"));

  const issues: Issue[] = [];

  const recent = history.slice(-15);
  const busy = recent.filter((h) => h.cpuTotal >= 90).length;
  if (recent.length >= 10 && busy >= 10) {
    issues.push({
      key: "cpu",
      level: "warn",
      title: "Your processor is very busy",
      detail: `It has been above 90% for most of the last ${recent.length} seconds, which can make everything feel slow.`,
      actions: [{ label: "See what's using it", primary: true, run: () => onNavigate("processes", { processSort: "cpu" }) }],
    });
  }

  const memPct = m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  if (memPct >= 85) {
    issues.push({
      key: "mem",
      level: memPct >= 95 ? "danger" : "warn",
      title: "Memory is almost full",
      detail: `${bytes(m.memUsed)} of ${bytes(m.memTotal)} in use. Closing apps you aren't using will speed things up.`,
      actions: [{ label: "See what's using it", primary: true, run: () => onNavigate("processes", { processSort: "memory" }) }],
    });
  }

  for (const d of m.disks) {
    if (d.removable || d.totalBytes <= 0) continue;
    const freePct = (d.availableBytes / d.totalBytes) * 100;
    const GB = 1024 ** 3;
    if (freePct >= 10 && d.availableBytes >= 10 * GB) continue;
    const mount = mountLabel(d.mount);
    const system = mount.toUpperCase() === "C:";
    issues.push({
      key: `disk-${d.mount}`,
      level: freePct < 5 || d.availableBytes < 5 * GB ? "danger" : "warn",
      title: `Drive ${mount} is almost full`,
      detail: `${bytes(d.availableBytes)} free of ${bytes(d.totalBytes)}. ${system ? "Windows" : "Apps"} can slow down or fail to save files when a drive is this full.`,
      actions: [
        ...(system ? [{ label: "Clean temp files", primary: true, run: onCleanTemp }] : []),
        { label: "Open Storage settings", primary: !system, run: () => launch("Open Storage settings", "Start-Process ms-settings:storagesense") },
      ],
    });
  }

  const hottest = m.temps.reduce<{ label: string; celsius: number } | null>((a, t) => (!a || t.celsius > a.celsius ? t : a), null);
  if (hottest && hottest.celsius >= 85) {
    issues.push({
      key: "temp",
      level: hottest.celsius >= 95 ? "danger" : "warn",
      title: "Your PC is running hot",
      detail: `${hottest.label} is at ${hottest.celsius.toFixed(0)}°C. Make sure the air vents aren't blocked.`,
      actions: [{ label: "See what's using the CPU", run: () => onNavigate("processes", { processSort: "cpu" }) }],
    });
  }

  if (m.uptimeSecs > 7 * 86400) {
    issues.push({
      key: "uptime",
      level: "warn",
      title: "A restart is recommended",
      detail: `Windows has been running for ${longDuration(m.uptimeSecs)}. Restarting clears out slowdowns and finishes updates.`,
      actions: [
        {
          label: "Restart now…",
          run: async () => {
            const ok = await confirm({
              title: "Restart your PC now?",
              message: "Save your work first: every open app will close.",
              confirmLabel: "Restart now",
              danger: true,
            });
            if (ok) launch("Restart PC", "shutdown.exe /r /t 0");
          },
        },
      ],
    });
  }

  const worst: Level = issues.some((i) => i.level === "danger") ? "danger" : issues.length ? "warn" : "ok";

  return (
    <section className="card health" aria-live="polite">
      <div className="health-main">
        <div className={`health-icon ${worst}`}>{worst === "ok" ? <CircleCheck size={24} /> : <TriangleAlert size={22} />}</div>
        <div className="health-text">
          <h2>
            {issues.length === 0
              ? "Your PC is running smoothly"
              : issues.length === 1
                ? "One thing needs your attention"
                : `${issues.length} things need your attention`}
          </h2>
          <p>
            {issues.length === 0
              ? "Processor, memory, drives and uptime all look healthy. This updates every second."
              : "Everything else looks healthy. Here's what we found and how to fix it:"}
          </p>
        </div>
        <SpeedCheckLink onNavigate={onNavigate} />
      </div>
      {issues.length > 0 && (
        <ul className="health-issues">
          {issues.map((i) => (
            <li key={i.key} className="health-issue">
              <TriangleAlert size={18} className={i.level === "danger" ? "danger" : "warn"} aria-label={i.level === "danger" ? "Serious" : "Warning"} />
              <div className="health-issue-text">
                <strong>{i.title}</strong>
                <span>{i.detail}</span>
              </div>
              <div className="health-issue-actions">
                {i.actions.map((a) => (
                  <button key={a.label} className={`btn btn-sm ${a.primary ? "btn-primary" : ""}`} onClick={a.run}>
                    {a.label}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Opens PC health: the full "Why is my PC slow?" check, started right away the first time. */
function SpeedCheckLink({ onNavigate }: { onNavigate: Props["onNavigate"] }) {
  const health = useHealthCheck();
  const open = () => {
    onNavigate("health");
    if (!health.report) startHealthCheck();
  };
  return (
    <button className="btn btn-sm" onClick={open} title="Find out why your PC is slow, and fix it">
      <HeartPulse size={14} />
      {health.running ? "Checking…" : health.report ? `Health score ${currentScore(health)}` : "Run speed check"}
      <ChevronRight size={14} />
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Live tiles

function Tiles({ m, history, onNavigate }: { m: Metrics; history: Metrics[]; onNavigate: Props["onNavigate"] }) {
  const memPct = m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0;
  const cpuLevel = level(m.cpuTotal, 70, 90);
  const memLevel = level(memPct, 80, 92);
  const netPeak = Math.max(0, ...history.flatMap((h) => [h.netRxBps, h.netTxBps]));
  const diskPeak = Math.max(0, ...history.map((h) => h.diskReadBps + h.diskWriteBps));

  const open = (sort: "cpu" | "memory") => ({
    role: "button",
    tabIndex: 0,
    onClick: () => onNavigate("processes", { processSort: sort }),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onNavigate("processes", { processSort: sort });
      }
    },
  });

  return (
    <section className="tiles" aria-label="Live usage">
      <div className="card tile clickable" {...open("cpu")} aria-label={`Processor ${pct(m.cpuTotal)}, ${CPU_WORDS[cpuLevel]}. Open apps sorted by CPU.`}>
        <ChevronRight size={16} className="tile-go" />
        <div className="tile-top">
          <RingGauge value={m.cpuTotal} color={LEVEL_COLOR[cpuLevel] || "var(--chart-cpu)"} label={`Processor ${pct(m.cpuTotal)}`} />
          <div className="tile-text">
            <span className="tile-label">
              <Cpu size={14} /> Processor
            </span>
            <span className={`tile-status ${cpuLevel}`}>
              {cpuLevel !== "ok" && <TriangleAlert size={12} />}
              {CPU_WORDS[cpuLevel]}
            </span>
            <span className="tile-status">{m.cpuFreqMhz > 0 ? `${(m.cpuFreqMhz / 1000).toFixed(2)} GHz` : `${m.cpuPerCore.length} threads`}</span>
          </div>
        </div>
        <Sparkline series={[{ label: "CPU", values: history.map((h) => h.cpuTotal), color: "var(--chart-cpu)" }]} max={100} format={(v) => pct(v)} />
        <div className="tile-foot">
          <span>
            <span className="legend-dot" style={{ background: "var(--chart-cpu)" }} />
            Last minute · average {pct(avg(history.map((h) => h.cpuTotal)))}
          </span>
        </div>
      </div>

      <div
        className="card tile clickable"
        {...open("memory")}
        aria-label={`Memory ${pct(memPct)}, ${MEM_WORDS[memLevel]}. Open apps sorted by memory.`}
      >
        <ChevronRight size={16} className="tile-go" />
        <div className="tile-top">
          <RingGauge value={memPct} color={LEVEL_COLOR[memLevel] || "var(--chart-mem)"} label={`Memory ${pct(memPct)}`} />
          <div className="tile-text">
            <span className="tile-label">
              <MemoryStick size={14} /> Memory
            </span>
            <span className={`tile-status ${memLevel}`}>
              {memLevel !== "ok" && <TriangleAlert size={12} />}
              {MEM_WORDS[memLevel]}
            </span>
            <span className="tile-status num-text">
              {bytes(m.memUsed)} of {bytes(m.memTotal)}
            </span>
          </div>
        </div>
        <Sparkline
          series={[{ label: "Memory", values: history.map((h) => (h.memTotal ? (h.memUsed / h.memTotal) * 100 : 0)), color: "var(--chart-mem)" }]}
          max={100}
          format={(v) => pct(v)}
        />
        <div className="tile-foot">
          <span>
            <span className="legend-dot" style={{ background: "var(--chart-mem)" }} />
            {bytes(Math.max(m.memTotal - m.memUsed, 0))} free
          </span>
        </div>
      </div>

      <div className="card tile">
        <div className="tile-top">
          <div className="tile-text">
            <span className="tile-label">Network</span>
            <span className="tile-value" title="Download speed">
              <ArrowDown size={18} strokeWidth={2.5} style={{ color: "var(--chart-net)", verticalAlign: -2, marginRight: 2 }} aria-label="Download" />
              {rate(m.netRxBps)}
            </span>
            <span className="tile-status num-text">
              <ArrowUp size={12} strokeWidth={2.5} style={{ color: "var(--chart-net-up)" }} aria-hidden="true" />
              {rate(m.netTxBps)} upload
            </span>
          </div>
        </div>
        <Sparkline
          series={[
            { label: "Download", values: history.map((h) => h.netRxBps), color: "var(--chart-net)" },
            { label: "Upload", values: history.map((h) => h.netTxBps), color: "var(--chart-net-up)", dashed: true },
          ]}
          floor={1024 * 1024}
          format={rate}
          caption={netPeak > 0 ? `Peak ${rate(netPeak)}` : undefined}
        />
        <div className="tile-foot">
          <span>
            <span className="legend-dot" style={{ background: "var(--chart-net)" }} />
            Download
          </span>
          <span style={{ color: "var(--chart-net-up)" }}>
            <span className="legend-line" />
            <span style={{ color: "var(--text-2)" }}>Upload</span>
          </span>
        </div>
      </div>

      <div className="card tile">
        <div className="tile-top">
          <div className="tile-text">
            <span className="tile-label">Disk</span>
            <span className="tile-value">{rate(m.diskReadBps + m.diskWriteBps)}</span>
            <span className="tile-status num-text">
              Read {rate(m.diskReadBps)} · Write {rate(m.diskWriteBps)}
            </span>
          </div>
        </div>
        <Sparkline
          series={[{ label: "Disk", values: history.map((h) => h.diskReadBps + h.diskWriteBps), color: "var(--chart-disk)" }]}
          floor={10 * 1024 * 1024}
          format={rate}
          caption={diskPeak > 0 ? `Peak ${rate(diskPeak)}` : undefined}
        />
        <div className="tile-foot">
          <span>
            <span className="legend-dot" style={{ background: "var(--chart-disk)" }} />
            Read and write, last minute
          </span>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Top apps

interface AppGroup {
  name: string;
  items: ProcessInfo[];
  cpu: number;
  memory: number;
}

function TopApps({ memTotal, onNavigate }: { memTotal: number; onNavigate: Props["onNavigate"] }) {
  const endProcesses = useEndProcesses();
  const [procs, setProcs] = useState<ProcessInfo[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .processes()
        .then((p) => alive && setProcs(p))
        .catch(() => {});
    load();
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const top = useMemo(() => {
    const map = new Map<string, AppGroup>();
    for (const p of procs ?? []) {
      if (p.isSelf) continue;
      const key = p.name.toLowerCase();
      const g = map.get(key) ?? { name: p.name, items: [], cpu: 0, memory: 0 };
      g.items.push(p);
      g.cpu += p.cpu;
      g.memory += p.memory;
      map.set(key, g);
    }
    // Heaviest first: CPU matters most for "why is my PC slow", memory breaks ties.
    return [...map.values()].sort((a, b) => b.cpu - a.cpu || b.memory - a.memory).slice(0, 5);
  }, [procs]);

  const maxCpu = Math.max(10, ...top.map((g) => g.cpu));

  return (
    <section className="card">
      <div className="card-header">
        <h3>Top apps right now</h3>
        <button className="btn btn-sm btn-ghost" onClick={() => onNavigate("processes", { processSort: "cpu" })}>
          See all <ChevronRight size={14} />
        </button>
      </div>
      <ul className="top-apps">
        <li className="top-app top-app-head" aria-hidden="true">
          <span>App</span>
          <span className="num">CPU</span>
          <span className="num">Memory</span>
          <span />
        </li>
        {procs === null
          ? Array.from({ length: 5 }, (_, i) => (
              <li key={i} className="top-app">
                <Skeleton width={`${60 - i * 6}%`} />
                <Skeleton width="70%" style={{ marginLeft: "auto" }} />
                <Skeleton width="80%" style={{ marginLeft: "auto" }} />
                <span />
              </li>
            ))
          : top.map((g) => {
              const blocked = g.items.some((p) => p.protected);
              return (
                <li key={g.name} className="top-app">
                  <span className="name-flex">
                    <span
                      className={`app-avatar ${blocked ? "system" : ""}`}
                      style={{ "--avatar-h": nameHue(g.name) } as React.CSSProperties}
                      aria-hidden="true"
                    >
                      {g.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate" title={g.name}>
                      {g.name}
                    </span>
                    {g.items.length > 1 && <span className="subtle small nowrap">×{g.items.length}</span>}
                  </span>
                  <span className="top-app-cpu num">
                    <span>{pct(g.cpu, 1)}</span>
                    <span className="bar">
                      <span className="bar-fill" style={{ width: `${(g.cpu / maxCpu) * 100}%`, display: "block" }} />
                    </span>
                  </span>
                  <span className="num" title={memTotal ? `${pct((g.memory / memTotal) * 100, 1)} of memory` : undefined}>
                    {bytes(g.memory)}
                  </span>
                  {blocked ? (
                    <span />
                  ) : (
                    <button
                      className="icon-btn icon-btn-sm"
                      title={`End ${g.name}`}
                      aria-label={`End ${g.name}`}
                      onClick={() =>
                        endProcesses(g.items).then((done) => {
                          if (done) api.processes().then(setProcs).catch(() => {});
                        })
                      }
                    >
                      <X size={14} />
                    </button>
                  )}
                </li>
              );
            })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Drives, threads, about

function Drives({ m }: { m: Metrics }) {
  return (
    <section className="card">
      <div className="card-header">
        <h3>Drives</h3>
        <span className="muted">{m.disks.length === 1 ? "1 drive" : `${m.disks.length} drives`}</span>
      </div>
      <ul className="drives">
        {m.disks.map((d) => {
          const used = d.totalBytes - d.availableBytes;
          const usedPct = d.totalBytes ? (used / d.totalBytes) * 100 : 0;
          const freePct = 100 - usedPct;
          const lvl: Level = freePct < 5 ? "danger" : freePct < 10 ? "warn" : "ok";
          return (
            <li key={d.mount} className="drive">
              <span className="drive-icon">
                <HardDrive size={17} />
              </span>
              <div>
                <div className="drive-row">
                  <strong title={`${d.fileSystem}`}>{driveLabel(d)}</strong>
                  {lvl !== "ok" && <span className={`pill pill-sm pill-${lvl}`}>Almost full</span>}
                  <span className="muted">
                    {bytes(d.availableBytes)} free of {bytes(d.totalBytes)}
                  </span>
                </div>
                <div className="bar" role="meter" aria-valuenow={Math.round(usedPct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${driveLabel(d)} used`}>
                  <div className={`bar-fill ${lvl}`} style={{ width: `${usedPct}%` }} />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Threads({ m }: { m: Metrics }) {
  const n = m.cpuPerCore.length;
  const cols = n <= 8 ? n : n <= 32 ? Math.ceil(n / 2) : 16;
  return (
    <section className="card">
      <div className="card-header">
        <h3>Usage per CPU thread</h3>
        <span className="muted">{n} threads</span>
      </div>
      <div className="threads" style={{ "--cols": Math.max(cols, 1) } as React.CSSProperties}>
        {m.cpuPerCore.map((v, i) => (
          <div key={i} className="thread" title={`Thread ${i + 1}: ${pct(v)}`}>
            <div className="thread-bar">
              <div className="thread-fill" style={{ height: `${Math.max(Math.min(v, 100), 2)}%` }} />
            </div>
            <span>{v.toFixed(0)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const tempWord = (c: number) => (c >= 90 ? "Hot" : c >= 75 ? "Warm" : "Normal");

function AboutPc({ m, overview }: { m: Metrics; overview: SystemOverview | null }) {
  return (
    <section className="card">
      <div className="card-header">
        <h3>About this PC</h3>
      </div>
      <dl className="facts">
        <dt>Windows</dt>
        <dd>{overview ? overview.osVersion || overview.osName : <Skeleton width="70%" />}</dd>
        <dt>Processor</dt>
        <dd title={overview?.cpuName || m.cpuName}>{overview?.cpuName || m.cpuName}</dd>
        <dt>Cores</dt>
        <dd>{overview ? `${overview.physicalCores} cores, ${overview.logicalCores} threads` : <Skeleton width="50%" />}</dd>
        <dt>Memory</dt>
        <dd>{bytes(m.memTotal)}</dd>
        <dt>Running for</dt>
        <dd>{longDuration(m.uptimeSecs)}</dd>
        {m.temps.map((t) => {
          const lvl = level(t.celsius, 75, 90);
          return (
            <div key={t.label} style={{ display: "contents" }}>
              <dt>
                <Thermometer size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                {t.label}
              </dt>
              <dd>
                {t.celsius.toFixed(0)}°C <span className={lvl === "ok" ? "muted" : lvl}>· {tempWord(t.celsius)}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <section className="card health">
        <div className="health-main">
          <Skeleton width={44} height={44} radius={22} />
          <div className="health-text">
            <Skeleton width={260} height={18} />
            <Skeleton width={360} height={12} style={{ marginTop: 8 }} />
          </div>
        </div>
      </section>
      <section className="tiles">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="card tile">
            <div className="tile-top">
              <Skeleton width={64} height={64} radius={32} />
              <div className="tile-text" style={{ gap: 8 }}>
                <Skeleton width="60%" />
                <Skeleton width="40%" />
              </div>
            </div>
            <Skeleton height={56} radius={6} />
          </div>
        ))}
      </section>
    </>
  );
}
