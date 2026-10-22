import { useEffect, useRef, useState } from "react";
import {
  BatteryLow,
  Brush,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Cpu,
  ExternalLink,
  Gauge,
  HardDrive,
  HeartPulse,
  Info,
  Lightbulb,
  ListChecks,
  LucideIcon,
  MemoryStick,
  OctagonAlert,
  Power,
  RefreshCw,
  RotateCcw,
  Thermometer,
  TriangleAlert,
  Undo2,
  WandSparkles,
  Zap,
} from "lucide-react";
import { api, errorText, FixAction, HealthCheck, HealthIssue, HealthSeverity } from "../api";
import type { NavigateOptions } from "../App";
import { useConfirm } from "../components/Confirm";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { bytes, relativeTime } from "../format";
import { useEndProcesses } from "../hooks/useActions";
import { currentScore, FixResult, getHealthState, HealthState, markFixed, markUndone, startHealthCheck, useHealthCheck } from "../hooks/useHealthCheck";
import { useOnRefresh } from "../hooks/useRefresh";
import { PageId } from ".";
import "./Health.css";

interface Props {
  elevated: boolean;
  onNavigate: (page: PageId, opts?: NavigateOptions) => void;
  onRestartAsAdmin: () => void;
}

// ---- Wording and looks ----

type Band = "great" | "good" | "fair" | "poor";

const bandOf = (score: number): Band => (score >= 90 ? "great" : score >= 70 ? "good" : score >= 50 ? "fair" : "poor");

const BAND_COLOR: Record<Band, string> = {
  great: "var(--ok)",
  good: "var(--accent)",
  fair: "var(--warn-fill)",
  poor: "var(--danger-fill)",
};

const VERDICT: Record<Band, string> = {
  great: "Your PC is in great shape",
  good: "Your PC is in good shape",
  fair: "Your PC could be faster",
  poor: "Your PC needs some attention",
};

const SEVERITY: Record<HealthSeverity, { group: string; hint: string; icon: LucideIcon; tone: string; one: string; many: string }> = {
  critical: { group: "Serious problems", hint: "These slow your PC down the most.", icon: OctagonAlert, tone: "danger", one: "serious problem", many: "serious problems" },
  warning: { group: "Worth fixing", hint: "Fixing these makes a noticeable difference.", icon: TriangleAlert, tone: "warn", one: "warning", many: "warnings" },
  tip: { group: "Tips", hint: "Small things that can help a little.", icon: Lightbulb, tone: "tip", one: "tip", many: "tips" },
};
const ORDER: HealthSeverity[] = ["critical", "warning", "tip"];

/** Actions that only open something: shown quieter than ones that fix the issue. */
const isNavigation = (a: FixAction) => a.kind === "openPage" || a.kind === "openSettings";

const ACTION_ICON: Record<FixAction["kind"], LucideIcon> = {
  endProcess: CircleX,
  openPage: ChevronRight,
  cleanTemp: Brush,
  setPowerPlan: Zap,
  restart: RotateCcw,
  openSettings: ExternalLink,
};

/** Where the progress events of the check are (see STEPS in health.rs). */
const PHASES: { at: number; label: string; icon: LucideIcon }[] = [
  { at: 6, label: "Apps and processor", icon: Cpu },
  { at: 26, label: "Memory", icon: MemoryStick },
  { at: 46, label: "Drives", icon: HardDrive },
  { at: 66, label: "Restarts and updates", icon: RotateCcw },
  { at: 86, label: "Startup, temp files and power", icon: Power },
];

const WHAT_WE_CHECK: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Cpu, title: "Apps hogging the processor", body: "Apps that keep it busy the whole time, not just for a moment." },
  { icon: MemoryStick, title: "Memory", body: "Whether memory is running out, and which app is taking it." },
  { icon: HardDrive, title: "Free space", body: "Drives that are almost full, which slows Windows down." },
  { icon: Power, title: "Startup apps", body: "Too many apps starting with Windows makes sign-in slow." },
  { icon: RotateCcw, title: "Restarts and updates", body: "Updates waiting on a restart, or a PC that never restarts." },
  { icon: Brush, title: "Temporary files", body: "Leftover files from apps and installers that can go." },
  { icon: BatteryLow, title: "Power plan", body: "Power saver mode makes everything slower." },
  { icon: Thermometer, title: "Temperature", body: "A hot PC slows itself down to cool off." },
  { icon: Gauge, title: "Hard disk", body: "Whether Windows is on a slow, busy hard disk." },
];

const STALE_MS = 30 * 60 * 1000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Re-renders every `ms` so "checked 5 minutes ago" stays true. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Counts smoothly towards `target`, for the score and the progress number. */
function useAnimatedNumber(target: number, ms = 700) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const begin = from.current;
    if (begin === target || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = target;
      setValue(target);
      return;
    }
    let frame = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = begin + (target - begin) * eased;
      from.current = v;
      setValue(v);
      if (k < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

// ---- Page ----

export function Health({ elevated, onNavigate, onRestartAsAdmin }: Props) {
  const health = useHealthCheck();
  const { report, running, error } = health;
  const fixes = useFixes({ elevated, onNavigate, onRestartAsAdmin });
  const now = useNow(30_000);
  useOnRefresh(() => startHealthCheck());

  const open = report?.issues.filter((i) => !health.fixed[i.id]) ?? [];
  const safe = open.filter((i) => i.action?.safe);
  const stale = report && !running && now - report.checkedAt > STALE_MS;

  return (
    <div className="page">
      <PageHeader
        title="PC health"
        subtitle="Find out why your PC is slow, and fix it in a click. Nothing changes until you choose a fix."
        actions={
          (report || running) && (
            <>
              {report && !running && (
                <span className="hc-last" title={new Date(report.checkedAt).toLocaleString()}>
                  <Clock size={14} /> Last checked {relativeTime(new Date(report.checkedAt), now)}
                </span>
              )}
              <button className={`btn ${report ? "" : "btn-primary"}`} onClick={() => startHealthCheck()} disabled={running}>
                <RefreshCw size={16} className={running ? "spin" : undefined} />
                {running ? `Checking… ${Math.round(health.percent)}%` : "Check again"}
              </button>
            </>
          )
        }
      />

      {error && !running && (
        <div className="note note-danger" role="alert">
          <TriangleAlert size={16} />
          <span>The speed check didn't finish: {error}</span>
          <button className="btn btn-sm" onClick={() => startHealthCheck()}>
            <RefreshCw size={14} /> Try again
          </button>
        </div>
      )}

      {running ? (
        <RunningHero percent={health.percent} step={health.step} />
      ) : report ? (
        <ScoreHero
          state={health}
          openCount={open.length}
          safe={safe}
          busy={fixes.busy}
          onFixAll={() => fixes.fixAll(safe)}
        />
      ) : (
        <IntroHero />
      )}

      {stale && (
        <div className="note note-info">
          <Info size={16} />
          <span>These results are from {relativeTime(new Date(report.checkedAt), now)}. Things may have changed since, so check again for up-to-date advice.</span>
          <button className="btn btn-sm" onClick={() => startHealthCheck()}>
            <RefreshCw size={14} /> Check again
          </button>
        </div>
      )}

      {report ? (
        <div className={`hc-results ${running ? "is-busy" : ""}`} aria-busy={running}>
          {ORDER.map((severity) => {
            const list = report.issues.filter((i) => i.severity === severity);
            if (list.length === 0) return null;
            const meta = SEVERITY[severity];
            return (
              <section key={severity} className="hc-group" aria-label={meta.group}>
                <div className="hc-group-head">
                  <h2 className={`hc-group-title tone-${meta.tone}`}>
                    <meta.icon size={16} />
                    {meta.group}
                    <span className="hc-count">{list.length}</span>
                  </h2>
                  <span className="hc-group-hint">{meta.hint}</span>
                </div>
                <div className="hc-issue-list">
                  {list.map((issue) => (
                    <IssueCard
                      key={issue.id}
                      issue={issue}
                      fixed={health.fixed[issue.id]}
                      busy={fixes.busy === issue.id || (fixes.busy === "all" && !!issue.action?.safe && !health.fixed[issue.id])}
                      disabled={fixes.busy !== null || running}
                      onRun={(action) => fixes.runOne(issue, action)}
                      onUndo={() => fixes.undo(issue)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          <ChecksList checks={report.checks} durationMs={report.durationMs} />
        </div>
      ) : running ? (
        <div className="hc-issue-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card hc-issue hc-issue-skeleton">
              <Skeleton width={36} height={36} radius={18} />
              <div className="hc-issue-body">
                <Skeleton width={`${46 - i * 6}%`} height={14} />
                <Skeleton width="88%" style={{ marginTop: 10 }} />
                <Skeleton width="64%" style={{ marginTop: 6 }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <WhatWeCheck />
      )}
    </div>
  );
}

// ---- Hero states ----

function ScoreRing({ value, color, mode, label }: { value: number; color: string; mode: "score" | "progress" | "idle"; label: string }) {
  const size = 156;
  const stroke = 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = useAnimatedNumber(value, mode === "progress" ? 900 : 800);
  const len = mode === "idle" ? 0 : Math.max((Math.min(Math.max(shown, 0), 100) / 100) * c, 0.5);
  return (
    <div className={`hc-ring mode-${mode}`} style={{ width: size, height: size, "--ring-color": color } as React.CSSProperties} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="hc-ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
        {mode !== "idle" && (
          <circle
            className="hc-ring-value"
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${len} ${c}`}
          />
        )}
      </svg>
      <div className="hc-ring-center" aria-hidden="true">
        {mode === "idle" ? (
          <HeartPulse size={44} strokeWidth={1.75} />
        ) : (
          <>
            <span className="hc-ring-num">
              {Math.round(shown)}
              {mode === "progress" && <small>%</small>}
            </span>
            <span className="hc-ring-sub">{mode === "progress" ? "Checking" : "out of 100"}</span>
          </>
        )}
      </div>
    </div>
  );
}

function IntroHero() {
  return (
    <section className="card hc-hero">
      <ScoreRing value={0} color="var(--accent)" mode="idle" label="Not checked yet" />
      <div className="hc-hero-text">
        <span className="hc-eyebrow">Speed check</span>
        <h2>Why is my PC slow?</h2>
        <p>
          In about five seconds, we watch which apps keep your processor and memory busy, and check your drives, startup apps, updates, power
          settings and temperature. Then you get a score and one-click fixes.
        </p>
        <div className="hc-hero-actions">
          <button className="btn btn-primary hc-cta" onClick={() => startHealthCheck()} autoFocus>
            <HeartPulse size={18} /> Run speed check
          </button>
          <span className="hc-hero-note">Nothing on your PC is changed until you choose a fix.</span>
        </div>
      </div>
    </section>
  );
}

function RunningHero({ percent, step }: { percent: number; step: string }) {
  return (
    <section className="card hc-hero" aria-live="polite">
      <ScoreRing value={percent} color="var(--accent)" mode="progress" label={`Checking, ${Math.round(percent)}% done`} />
      <div className="hc-hero-text">
        <span className="hc-eyebrow">Speed check running</span>
        <h2>Checking your PC…</h2>
        <p className="hc-step">{step || "Getting ready…"}</p>
        <ol className="hc-phases">
          {PHASES.map((p, i) => {
            const next = PHASES[i + 1]?.at ?? 100;
            const state = percent >= next ? "done" : percent >= p.at ? "active" : "pending";
            return (
              <li key={p.label} className={`hc-phase ${state}`}>
                <span className="hc-phase-icon">{state === "done" ? <Check size={13} strokeWidth={3} /> : <p.icon size={13} />}</span>
                {p.label}
              </li>
            );
          })}
        </ol>
        <span className="hc-hero-note">Takes about five seconds. You can keep using your PC, or leave this page; the check keeps going.</span>
      </div>
    </section>
  );
}

function ScoreHero({
  state,
  openCount,
  safe,
  busy,
  onFixAll,
}: {
  state: HealthState;
  openCount: number;
  safe: HealthIssue[];
  busy: string | null;
  onFixAll: () => void;
}) {
  const report = state.report!;
  const score = currentScore(state);
  const band = bandOf(score);
  const fixedCount = report.issues.length - openCount;
  const counts = ORDER.map((s) => ({ s, n: report.issues.filter((i) => i.severity === s && !state.fixed[i.id]).length })).filter((c) => c.n > 0);

  let body: string;
  if (report.issues.length === 0) body = `We checked ${report.checks.length} things and found nothing slowing it down. Run the check again whenever your PC feels slow.`;
  else if (openCount === 0) body = "You've fixed everything we found. Run the check again later to see how it's doing.";
  else if (band === "great" || band === "good") body = "A few small things could make it a little faster. Here's what we found.";
  else if (band === "fair") body = "We found some things that are slowing it down. Most can be fixed in one click.";
  else body = "Several things are slowing it down. Start with the serious problems at the top.";

  return (
    <section className={`card hc-hero band-${band}`}>
      <ScoreRing value={score} color={BAND_COLOR[band]} mode="score" label={`Health score ${score} out of 100`} />
      <div className="hc-hero-text">
        <span className="hc-eyebrow">
          Health score
          {fixedCount > 0 && score > report.score && <span className="hc-was"> · was {report.score} before your fixes</span>}
        </span>
        <h2>{VERDICT[band]}</h2>
        <p>{body}</p>
        {(counts.length > 0 || fixedCount > 0) && (
          <div className="hc-summary">
            {counts.map(({ s, n }) => (
              <span key={s} className={`hc-tally tone-${SEVERITY[s].tone}`}>
                <span className="hc-tally-dot" />
                {plural(n, SEVERITY[s].one, SEVERITY[s].many)}
              </span>
            ))}
            {fixedCount > 0 && (
              <span className="hc-tally tone-ok">
                <Check size={13} strokeWidth={3} />
                {fixedCount} fixed
              </span>
            )}
          </div>
        )}
        {safe.length > 0 && (
          <div className="hc-hero-actions">
            <button className="btn btn-primary" onClick={onFixAll} disabled={busy !== null}>
              {busy === "all" ? <span className="spinner" /> : <WandSparkles size={16} />}
              Fix all safe items ({safe.length})
            </button>
            <span className="hc-hero-note">{safe.map((i) => i.action!.label).join(" · ")}</span>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- Issues ----

function IssueCard({
  issue,
  fixed,
  busy,
  disabled,
  onRun,
  onUndo,
}: {
  issue: HealthIssue;
  fixed: FixResult | undefined;
  busy: boolean;
  disabled: boolean;
  onRun: (action: FixAction) => void;
  onUndo: () => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = SEVERITY[issue.severity];
  const Icon = fixed ? CircleCheck : meta.icon;
  const actions = [issue.action, ...issue.alternatives].filter((a): a is FixAction => a !== null);
  const detailId = `hc-detail-${issue.id}`;

  return (
    <article className={`card hc-issue tone-${meta.tone} ${fixed ? "is-fixed" : ""}`} aria-label={issue.title}>
      <span className="hc-issue-icon" role="img" aria-label={fixed ? "Fixed" : meta.one}>
        <Icon size={18} />
      </span>
      <div className="hc-issue-body">
        <div className="hc-issue-title">
          <h3>{issue.title}</h3>
          {!fixed && issue.points > 0 && (
            <span className="hc-points" title={`Fixing this raises your score by ${issue.points} points`}>
              +{issue.points}
            </span>
          )}
        </div>
        <p className="hc-issue-text">{issue.explanation}</p>
        {issue.detail && (
          <>
            <button className="hc-details-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
              <ChevronDown size={14} className={open ? "open" : undefined} />
              Technical details
            </button>
            {open && (
              <p id={detailId} className="hc-issue-detail selectable">
                {issue.detail}
              </p>
            )}
          </>
        )}
      </div>
      <div className="hc-issue-actions">
        {fixed ? (
          <>
            <span className="pill pill-ok hc-fixed-pill">
              <Check size={13} strokeWidth={3} /> {fixed.text}
            </span>
            {fixed.undoId && (
              <button className="btn btn-sm" onClick={onUndo} disabled={disabled}>
                <Undo2 size={14} /> Undo
              </button>
            )}
          </>
        ) : (
          actions.map((a, i) => {
            const AIcon = ACTION_ICON[a.kind];
            const trailing = a.kind === "openPage";
            return (
              <button
                key={`${a.kind}-${a.label}`}
                className={`btn ${i > 0 ? "btn-sm hc-alt" : isNavigation(a) ? "hc-go" : "btn-primary"}`}
                onClick={() => onRun(a)}
                disabled={disabled}
                title={a.safe ? "Safe: changes nothing you'd miss" : undefined}
              >
                {i === 0 && busy ? <span className="spinner" /> : !trailing && <AIcon size={i === 0 ? 16 : 14} />}
                {a.label}
                {trailing && <AIcon size={i === 0 ? 16 : 14} />}
              </button>
            );
          })
        )}
      </div>
    </article>
  );
}

const CHECK_ICON = { ok: CircleCheck, issue: TriangleAlert, skipped: CircleMinus };

function ChecksList({ checks, durationMs }: { checks: HealthCheck[]; durationMs: number }) {
  if (checks.length === 0) return null;
  const skipped = checks.filter((c) => c.status === "skipped").length;
  return (
    <section className="card hc-checks">
      <div className="card-header">
        <h3>
          <ListChecks size={16} /> What we checked
        </h3>
        <span className="muted">
          {checks.length} checks · took {(durationMs / 1000).toFixed(1)} seconds
          {skipped > 0 && ` · ${skipped} not available on this PC`}
        </span>
      </div>
      <ul className="hc-check-list">
        {checks.map((c) => {
          const Icon = CHECK_ICON[c.status];
          return (
            <li key={c.id} className={`hc-check status-${c.status}`}>
              <Icon size={16} aria-label={c.status === "ok" ? "Looks good" : c.status === "issue" ? "Found something" : "Skipped"} />
              <div>
                <strong>{c.label}</strong>
                <span>{c.summary}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WhatWeCheck() {
  return (
    <section className="card hc-checks">
      <div className="card-header">
        <h3>
          <ListChecks size={16} /> What the speed check looks at
        </h3>
      </div>
      <ul className="hc-feature-list">
        {WHAT_WE_CHECK.map((f) => (
          <li key={f.title} className="hc-feature">
            <span className="hc-feature-icon">
              <f.icon size={16} />
            </span>
            <div>
              <strong>{f.title}</strong>
              <span>{f.body}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Fixes ----

const ADMIN_HINT = "Restart as administrator";

function useFixes({ elevated, onNavigate, onRestartAsAdmin }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const endProcesses = useEndProcesses();
  const [busy, setBusy] = useState<string | null>(null);

  const fail = (e: unknown) => {
    const text = errorText(e);
    // Offer the way out when Windows refused for lack of administrator rights.
    if (!elevated && text.includes(ADMIN_HINT)) toast(text, "error", { action: { label: ADMIN_HINT, run: onRestartAsAdmin } });
    else toast(text, "error");
  };

  const undo = async (issue: HealthIssue) => {
    const undoId = getHealthState().fixed[issue.id]?.undoId;
    if (!undoId) return;
    try {
      await api.undoActivity(undoId);
      markUndone(issue.id);
      toast("Undone. Your PC is back on its previous power plan.", "success");
    } catch (e) {
      fail(e);
    }
  };

  /**
   * Runs one fix and returns what changed, or null when nothing did. In a batch ("Fix all safe
   * items", already confirmed) it asks nothing and leaves the toasts to the caller.
   */
  const perform = async (issue: HealthIssue, action: FixAction, batch: boolean): Promise<FixResult | null> => {
    switch (action.kind) {
      case "openPage": {
        const { page, sort, query } = action.payload;
        if (page === "processes") onNavigate("processes", { processSort: sort ?? undefined, processQuery: query ?? "" });
        else onNavigate("startup");
        return null;
      }
      case "openSettings":
        await api.openWindowsSettings(action.payload.page);
        return null;
      case "endProcess": {
        const { name, targets } = action.payload;
        const friendly = action.label.replace(/^End /, "");
        const keys = new Set(targets.map((t) => `${t.pid}:${t.startTime}`));
        const running = (await api.processes()).filter((p) => keys.has(`${p.pid}:${p.startTime}`));
        if (running.length === 0) {
          toast(`${friendly} has closed or restarted since the check. Run the check again to see whether it's still busy.`, "info");
          return null;
        }
        // The same confirmation and protection checks as the Processes page.
        if (!(await endProcesses(running))) return null;
        const left = (await api.processes()).filter((p) => keys.has(`${p.pid}:${p.startTime}`));
        return left.length === 0 ? { text: `Ended ${friendly || name}` } : null;
      }
      case "cleanTemp": {
        if (!batch) {
          const ok = await confirm({
            title: "Clean temp files?",
            message: `About ${bytes(action.payload.bytes)} can be freed. Files used in the last 24 hours and files that are in use are kept, and nothing outside the temp folder is touched.`,
            confirmLabel: `Free ${bytes(action.payload.bytes)}`,
          });
          if (!ok) return null;
        }
        const r = await api.cleanTemp(false);
        const text = r.files > 0 ? `Freed ${bytes(r.bytes)}` : "Already clean";
        if (!batch) {
          const kept = r.skipped > 0 ? ` ${r.skipped.toLocaleString()} files were kept because they are new or in use.` : "";
          toast(`${text} (${r.files.toLocaleString()} files).${kept}`, "success");
        }
        return { text };
      }
      case "setPowerPlan": {
        const { guid, name } = action.payload;
        const undoId = await api.setPowerPlan(guid);
        const text = `Switched to ${name}`;
        if (!batch) {
          toast(`${text}. Your PC can now run at full speed when it needs to.`, "success", {
            action: undoId ? { label: "Undo", run: () => undo(issue) } : undefined,
          });
        }
        return { text, undoId };
      }
      case "restart": {
        const ok = await confirm({
          title: "Restart your PC now?",
          message: "Save your work first. Every open app will close, and apps with unsaved changes may ask you what to do.",
          confirmLabel: "Restart now",
          danger: true,
        });
        if (!ok) return null;
        await api.restartPc();
        return { text: "Restarting…" };
      }
    }
  };

  const runOne = async (issue: HealthIssue, action: FixAction) => {
    setBusy(issue.id);
    try {
      const result = await perform(issue, action, false);
      if (result) markFixed(issue.id, result);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };

  const fixAll = async (items: HealthIssue[]) => {
    if (items.length === 0) return;
    const ok = await confirm({
      title: items.length === 1 ? "Fix 1 item?" : `Fix ${items.length} items?`,
      message: (
        <>
          <p>These fixes don't close any apps and can't harm your files:</p>
          <ul className="hc-fixall-list">
            {items.map((i) => (
              <li key={i.id}>
                <strong>{i.action!.label}</strong>
                <span>{i.title}</span>
              </li>
            ))}
          </ul>
          {items.some((i) => i.action?.kind === "setPowerPlan") && <p className="muted">You can undo the power plan change here or in Activity.</p>}
        </>
      ),
      confirmLabel: items.length === 1 ? "Fix it" : `Fix ${items.length} items`,
    });
    if (!ok) return;
    setBusy("all");
    let done = 0;
    const errors: string[] = [];
    for (const issue of items) {
      try {
        const result = await perform(issue, issue.action!, true);
        if (result) {
          markFixed(issue.id, result);
          done++;
        }
      } catch (e) {
        errors.push(errorText(e));
      }
    }
    setBusy(null);
    if (errors.length === 0) toast(done === 1 ? "Fixed 1 item." : `Fixed ${done} items.`, "success");
    else if (done > 0) fail(`Fixed ${done} of ${items.length} items. ${errors[0]}`);
    else fail(errors[0]);
  };

  return { busy, runOne, fixAll, undo };
}
