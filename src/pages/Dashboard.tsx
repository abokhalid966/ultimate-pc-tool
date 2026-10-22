import { useEffect, useState } from "react";
import { api, SystemOverview } from "../api";
import { Sparkline } from "../components/Sparkline";
import { bytes, duration, pct, rate } from "../format";
import { MetricsState } from "../hooks/useMetrics";

const COLORS = {
  cpu: "var(--chart-cpu)",
  mem: "var(--chart-mem)",
  netDown: "var(--chart-net)",
  netUp: "var(--chart-net-up)",
  disk: "var(--chart-disk)",
};

function level(value: number, warn: number, danger: number) {
  return value >= danger ? "danger" : value >= warn ? "warn" : "ok";
}

export function Dashboard({ metrics }: { metrics: MetricsState }) {
  const [overview, setOverview] = useState<SystemOverview | null>(null);
  const { latest: m, history } = metrics;

  useEffect(() => {
    api.overview().then(setOverview).catch(() => {});
  }, []);

  if (!m) return <div className="empty">Collecting first sample…</div>;

  const memPct = (m.memUsed / m.memTotal) * 100;
  const hottest = m.temps.reduce<number | null>((max, t) => (max === null || t.celsius > max ? t.celsius : max), null);
  const netMax = Math.max(...history.map((h) => Math.max(h.netRxBps, h.netTxBps)), 1024);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{overview?.hostName || "This PC"}</h1>
          <p className="muted">
            {overview?.osVersion} · {overview?.cpuName} · {overview?.physicalCores} cores / {overview?.logicalCores} threads
          </p>
        </div>
        <div className="header-stats">
          <span>
            Up <strong>{duration(m.uptimeSecs)}</strong>
          </span>
          <span>
            <strong>{m.processCount}</strong> processes
          </span>
          {hottest !== null && (
            <span className={`pill pill-${level(hottest, 75, 90)}`}>{hottest.toFixed(0)}°C hottest sensor</span>
          )}
        </div>
      </header>

      <section className="grid-cards">
        <div className="card">
          <div className="card-title">
            <span>CPU</span>
            <span className={`big ${level(m.cpuTotal, 70, 90)}`}>{pct(m.cpuTotal)}</span>
          </div>
          <Sparkline values={history.map((h) => h.cpuTotal)} max={100} color={COLORS.cpu} />
          <div className="card-foot muted">{(m.cpuFreqMhz / 1000).toFixed(2)} GHz</div>
        </div>

        <div className="card">
          <div className="card-title">
            <span>Memory</span>
            <span className={`big ${level(memPct, 80, 92)}`}>{pct(memPct)}</span>
          </div>
          <Sparkline values={history.map((h) => (h.memUsed / h.memTotal) * 100)} max={100} color={COLORS.mem} />
          <div className="card-foot muted">
            {bytes(m.memUsed)} of {bytes(m.memTotal)}
            {m.swapTotal > 0 && ` · page file ${bytes(m.swapUsed)}`}
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <span>Network</span>
            <span className="big">
              <span style={{ color: COLORS.netDown }}>↓ {rate(m.netRxBps)}</span>
            </span>
          </div>
          <div className="stacked">
            <Sparkline values={history.map((h) => h.netRxBps)} max={netMax} color={COLORS.netDown} />
            <Sparkline values={history.map((h) => h.netTxBps)} max={netMax} color={COLORS.netUp} />
          </div>
          <div className="card-foot muted">
            <span style={{ color: COLORS.netUp }}>↑ {rate(m.netTxBps)}</span> upload
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <span>Disk activity</span>
            <span className="big">{rate(m.diskReadBps + m.diskWriteBps)}</span>
          </div>
          <Sparkline values={history.map((h) => h.diskReadBps + h.diskWriteBps)} color={COLORS.disk} />
          <div className="card-foot muted">
            Read {rate(m.diskReadBps)} · Write {rate(m.diskWriteBps)}
          </div>
        </div>
      </section>

      <section className="two-col">
        <div className="card">
          <h3>CPU cores</h3>
          <div className="cores">
            {m.cpuPerCore.map((v, i) => (
              <div key={i} className="core" title={`Thread ${i}: ${pct(v)}`}>
                <div className="core-fill" style={{ height: `${Math.min(v, 100)}%` }} />
                <span>{v.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>Drives</h3>
          <ul className="drives">
            {m.disks.map((d) => {
              const used = d.totalBytes - d.availableBytes;
              const usedPct = d.totalBytes ? (used / d.totalBytes) * 100 : 0;
              return (
                <li key={d.mount}>
                  <div className="drive-row">
                    <strong>{d.mount}</strong>
                    <span className="muted">{d.name || d.fileSystem}</span>
                    <span className="spacer" />
                    <span>
                      {bytes(d.availableBytes)} free of {bytes(d.totalBytes)}
                    </span>
                  </div>
                  <div className="bar">
                    <div className={`bar-fill ${level(usedPct, 85, 95)}`} style={{ width: `${usedPct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
          {m.temps.length > 0 && (
            <>
              <h3>Temperatures</h3>
              <ul className="temps">
                {m.temps.map((t) => (
                  <li key={t.label}>
                    <span>{t.label}</span>
                    <span className={level(t.celsius, 75, 90)}>{t.celsius.toFixed(0)}°C</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
