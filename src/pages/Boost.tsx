import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CircleAlert, CircleCheck, Rocket, ShieldCheck } from "lucide-react";
import { api, BoostInfo, BoostResult, BoostSettings, errorText } from "../api";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { Switch } from "../components/Switch";
import { useToast } from "../components/Toast";
import { bytes } from "../format";
import { useOnRefresh } from "../hooks/useRefresh";
import "./boost/boost.css";

const appLabel = (name: string) => name.replace(/\.exe$/i, "");

export function Boost({ onRestartAsAdmin }: { onRestartAsAdmin: () => void }) {
  const toast = useToast();
  const [info, setInfo] = useState<BoostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(BoostResult & { started: boolean }) | null>(null);

  const load = useCallback(() => {
    api.boost().then(
      (i) => {
        setInfo(i);
        setError(null);
      },
      (e) => setError(errorText(e)),
    );
  }, []);
  useEffect(() => {
    load();
    const unlisten = listen("boost://changed", load);
    return () => {
      unlisten.then((f) => f());
    };
  }, [load]);
  useOnRefresh(load);

  const save = (settings: BoostSettings) => {
    setInfo((i) => i && { ...i, settings });
    api.setBoostSettings(settings).catch((e) => toast(errorText(e), "error"));
  };

  const toggle = () => {
    if (!info) return;
    const starting = !info.state.active;
    setBusy(true);
    (starting ? api.startBoost() : api.stopBoost())
      .then((r) => {
        setResult({ ...r, started: starting });
        toast(starting ? "Boost is on." : "Boost is off. Your PC is back to normal.", "success");
      })
      .catch((e) => toast(errorText(e), "error"))
      .finally(() => {
        setBusy(false);
        load();
      });
  };

  if (error && !info) {
    return (
      <div className="page">
        <PageHeader title="Boost" />
        <div className="card">
          <EmptyState icon={CircleAlert} tone="danger" title="Couldn't load Boost" body={error} actions={<button className="btn" onClick={load}>Try again</button>} />
        </div>
      </div>
    );
  }

  const s = info?.settings;
  const active = info?.state.active ?? false;
  const chosen = new Set(s?.closeApps.map((n) => n.toLowerCase()));
  // Running apps first, then saved choices that aren't running now.
  const apps = info
    ? [
        ...info.runningApps,
        ...s!.closeApps.filter((n) => !info.runningApps.some((a) => a.name.toLowerCase() === n.toLowerCase())).map((name) => ({ name, memory: 0, count: 0 })),
      ]
    : [];
  const toggleApp = (name: string, on: boolean) =>
    s && save({ ...s, closeApps: on ? [...s.closeApps, name] : s.closeApps.filter((n) => n.toLowerCase() !== name.toLowerCase()) });

  return (
    <div className="page">
      <PageHeader title="Boost" subtitle="Game mode: one click gives games the most power and quiet, with no updates, pop-ups or background apps. One more click puts everything back." />

      <section className={`card boost-hero ${active ? "on" : ""}`}>
        <button className="boost-button" onClick={toggle} disabled={!info || busy} aria-pressed={active}>
          <Rocket size={34} />
          <span>{busy ? (active ? "Ending..." : "Starting...") : active ? "End Boost" : "Start Boost"}</span>
        </button>
        <div className="boost-status">
          {!info ? (
            <Skeleton width={220} height={18} />
          ) : active ? (
            <>
              <h2>Boost is on</h2>
              <p className="muted">Since {new Date(info.state.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. End it when you're done to put everything back.</p>
              {info.state.done.length > 0 && (
                <ul className="boost-list">
                  {info.state.done.map((d) => (
                    <li key={d}>
                      <CircleCheck size={15} className="text-ok" /> {d}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <h2>Boost is off</h2>
              <p className="muted">Pick what Boost does below. You can also turn it on or off from the tray icon.</p>
            </>
          )}
          {result && result.problems.length > 0 && (
            <ul className="boost-list">
              {result.problems.map((p) => (
                <li key={p}>
                  <CircleAlert size={15} className="text-warn" /> {p}
                </li>
              ))}
            </ul>
          )}
          {result && !result.started && result.done.length > 0 && (
            <ul className="boost-list">
              {result.done.map((d) => (
                <li key={d}>
                  <CircleCheck size={15} className="text-ok" /> {d}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {s && info && (
        <div className="boost-grid">
          <section className="card">
            <h3 className="boost-h">What Boost does</h3>
            <div className="boost-option">
              <div>
                <strong>Use the High performance power plan</strong>
                <p className="muted small">
                  {info.highPerformance ? "Keeps the processor at full speed. Your previous plan comes back when Boost ends." : "This PC doesn't have this plan, so this step is skipped."}
                </p>
              </div>
              <Switch label="Use the High performance power plan" checked={s.powerPlan} disabled={active} onChange={(on) => save({ ...s, powerPlan: on })} />
            </div>
            <div className="boost-option">
              <div>
                <strong>Pause background indexing</strong>
                <p className="muted small">Pauses Windows Search indexing and SysMain, which can use the disk while you play. They start again when Boost ends.</p>
                {!info.elevated && s.pauseServices && (
                  <button className="btn btn-sm btn-ghost" onClick={onRestartAsAdmin}>
                    <ShieldCheck size={14} /> Needs administrator: restart as administrator
                  </button>
                )}
              </div>
              <Switch label="Pause background indexing" checked={s.pauseServices} disabled={active} onChange={(on) => save({ ...s, pauseServices: on })} />
            </div>
            <div className="boost-option">
              <div>
                <strong>Pause Windows Update</strong>
                <p className="muted small">Stops updates from downloading or installing while you play. They carry on when Boost ends.</p>
                {!info.elevated && s.pauseUpdates && (
                  <button className="btn btn-sm btn-ghost" onClick={onRestartAsAdmin}>
                    <ShieldCheck size={14} /> Needs administrator: restart as administrator
                  </button>
                )}
              </div>
              <Switch label="Pause Windows Update" checked={s.pauseUpdates} disabled={active} onChange={(on) => save({ ...s, pauseUpdates: on })} />
            </div>
            <div className="boost-option">
              <div>
                <strong>Turn off notifications</strong>
                <p className="muted small">Hides pop-ups from apps while Boost is on. They come back when Boost ends.</p>
              </div>
              <Switch label="Turn off notifications" checked={s.quietNotifications} disabled={active} onChange={(on) => save({ ...s, quietNotifications: on })} />
            </div>
            <div className="boost-option">
              <div>
                <strong>Reopen closed apps afterwards</strong>
                <p className="muted small">Starts the apps Boost closed again when you end it.</p>
              </div>
              <Switch label="Reopen closed apps afterwards" checked={s.reopenApps} onChange={(on) => save({ ...s, reopenApps: on })} />
            </div>
          </section>

          <section className="card">
            <h3 className="boost-h">Close these apps</h3>
            <p className="muted small" style={{ marginTop: 0 }}>
              Pick apps you don't need while gaming. Unsaved work in them may be lost, so save first.
            </p>
            {apps.length === 0 ? (
              <p className="muted small">No apps to show.</p>
            ) : (
              <ul className="boost-apps">
                {apps.map((a) => (
                  <li key={a.name}>
                    <label className="check">
                      <input type="checkbox" checked={chosen.has(a.name.toLowerCase())} disabled={active} onChange={(e) => toggleApp(a.name, e.target.checked)} />
                      <span>{appLabel(a.name)}</span>
                    </label>
                    <span className="muted small">{a.count > 0 ? bytes(a.memory) : "Not running"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
