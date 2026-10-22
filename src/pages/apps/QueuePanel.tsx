import { useState } from "react";
import { ChevronDown, CircleCheck, CircleX, Copy, RotateCcw, Square, TriangleAlert } from "lucide-react";
import { WingetAction } from "../../api";
import { useConfirm } from "../../components/Confirm";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { AppAvatar, phaseLabel } from "./common";
import { cancelAll, cancelJob, dismissFinished, failureText, isActive, Job } from "./queue";

const WORDS: Record<WingetAction, { doing: string; done: string; verb: string; noun: string }> = {
  install: { doing: "Installing", done: "installed", verb: "install", noun: "installation" },
  upgrade: { doing: "Updating", done: "updated", verb: "update", noun: "update" },
};

const plural = (n: number, word = "app") => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Live progress of the queue for one kind of job, then a summary of how it went. */
export function QueuePanel({ action, jobs, onRetry }: { action: WingetAction; jobs: Job[]; onRetry: (jobs: Job[]) => void }) {
  const confirm = useConfirm();
  const [details, setDetails] = useState<Job | null>(null);
  const [showLog, setShowLog] = useState(false);
  if (jobs.length === 0) return null;

  const w = WORDS[action];
  const running = jobs.find((j) => j.status === "running");
  const waiting = jobs.filter((j) => j.status === "queued");
  const failed = jobs.filter((j) => j.status === "failed");
  const stopped = jobs.filter((j) => j.status === "cancelled");
  const changed = jobs.filter((j) => j.status === "done" && !j.outcome?.unchanged);
  const restart = jobs.some((j) => j.outcome?.restartNeeded);
  const active = running || waiting.length > 0;

  async function stop(job: Job) {
    const ok = await confirm({
      title: `Stop ${w.doing.toLowerCase()} ${job.pkg.name}?`,
      message: `Stopping in the middle can leave ${job.pkg.name} half-${w.done}. You can ${w.verb} it again afterwards.`,
      confirmLabel: "Stop",
      danger: true,
    });
    if (ok) cancelJob(job.key);
  }

  async function stopAll() {
    const ok = await confirm({
      title: `Stop all ${action === "install" ? "installations" : "updates"}?`,
      message: `${waiting.length ? `${plural(waiting.length)} waiting won't be ${w.done}. ` : ""}${running ? `${running.pkg.name} is stopped in the middle, which can leave it half-${w.done}.` : ""}`,
      confirmLabel: "Stop all",
      danger: true,
    });
    if (ok) cancelAll(action);
  }

  let body;
  if (active) {
    const position = jobs.filter((j) => !isActive(j)).length + 1;
    const pct = running?.progress != null ? Math.round(running.progress * 100) : null;
    body = (
      <>
        <div className="queue-head">
          {running ? <AppAvatar name={running.pkg.name} size="md" /> : <span className="spinner" />}
          <div className="queue-title">
            <strong>
              {running ? `${w.doing} ${running.pkg.name}` : "Starting…"}
              {jobs.length > 1 && <span className="queue-step"> {position} of {jobs.length}</span>}
            </strong>
            <span className="muted small">
              {running ? phaseLabel(running) : "Waiting"}
              {pct !== null && ` · ${pct}%`}
              {waiting.length > 0 && ` · ${plural(waiting.length)} waiting`}
            </span>
          </div>
          {running && jobs.length > 1 && (
            <button className="btn btn-sm btn-ghost" onClick={() => stop(running)} disabled={running.stopping}>
              Skip this one
            </button>
          )}
          <button className="btn btn-sm btn-danger-ghost" onClick={jobs.length > 1 ? stopAll : () => running && stop(running)} disabled={running?.stopping}>
            <Square size={12} /> {jobs.length > 1 ? "Stop all" : "Stop"}
          </button>
        </div>
        {pct !== null ? (
          <div className="queue-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${running?.pkg.name} progress`}>
            <span style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <div className="progress" role="progressbar" aria-label="Working" />
        )}
        <div className="queue-foot">
          <span className="queue-line" title={running?.line}>
            {running?.line || "Windows may ask for permission for some apps. Look for a prompt on the taskbar if nothing happens."}
          </span>
          {running && (
            <button className="btn btn-sm btn-ghost" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
              <ChevronDown size={14} className={`chev ${showLog ? "open-down" : ""}`} /> {showLog ? "Hide details" : "Details"}
            </button>
          )}
        </div>
        {running && showLog && <pre className="output queue-log">{running.log || "Waiting for winget…"}</pre>}
      </>
    );
  } else {
    const total = jobs.length;
    const good = total - failed.length - stopped.length;
    const tone = failed.length === 0 && stopped.length === 0 ? "ok" : good === 0 ? "bad" : "warn";
    const one = jobs[0];
    const title =
      total === 1
        ? one.status === "done"
          ? one.outcome?.unchanged
            ? `${one.pkg.name}: ${one.outcome.message.replace(/\.$/, "").toLowerCase()}`
            : `${one.pkg.name} was ${w.done}`
          : one.status === "cancelled"
            ? `${one.pkg.name} was stopped`
            : `${one.pkg.name} couldn't be ${w.done}`
        : tone === "ok"
          ? changed.length === total
            ? `All ${total} apps were ${w.done}`
            : `${plural(changed.length)} ${w.done}, ${good - changed.length} already up to date`
          : `${good} of ${total} apps ${w.done}`;
    const notes =
      total === 1
        ? []
        : [failed.length > 0 && `${plural(failed.length)} couldn't be ${w.done}.`, stopped.length > 0 && `${plural(stopped.length)} stopped.`].filter(Boolean);
    body = (
      <>
        <div className="queue-head">
          <span className={`queue-icon ${tone}`}>{tone === "ok" ? <CircleCheck size={20} /> : <TriangleAlert size={20} />}</span>
          <div className="queue-title">
            <strong>{title}</strong>
            {notes.length > 0 && <span className="muted small">{notes.join(" ")}</span>}
          </div>
          {(failed.length > 0 || stopped.length > 0) && (
            <button className="btn btn-sm" onClick={() => onRetry([...failed, ...stopped])}>
              <RotateCcw size={14} /> Try {failed.length + stopped.length === 1 ? "it" : "them"} again
            </button>
          )}
          <button className="btn btn-sm" onClick={() => dismissFinished(action)}>
            Done
          </button>
        </div>
        {restart && (
          <div className="note note-info">
            <TriangleAlert size={16} />
            <span>Restart your PC to finish. Some apps finish their {w.noun} when Windows starts again.</span>
          </div>
        )}
        {failed.length > 0 && (
          <ul className="queue-failures">
            {failed.map((j) => (
              <li key={j.key}>
                <CircleX size={16} className="danger" />
                <span className="queue-failure-text">
                  <strong>{j.pkg.name}</strong>
                  <span className="muted">{failureText(j)}</span>
                </span>
                <button className="btn btn-sm btn-ghost" onClick={() => setDetails(j)}>
                  Details
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className={`card queue-panel ${active ? "active" : ""}`} aria-live="polite" aria-label={`${w.doing} apps`}>
      {body}
      {details && <JobDetails job={details} onClose={() => setDetails(null)} />}
    </section>
  );
}

/** What winget said for one app, for when it didn't work. */
export function JobDetails({ job, onClose }: { job: Job; onClose: () => void }) {
  const toast = useToast();
  const text = job.log || job.error || "";
  const copy = () =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast("Copied", "success"))
      .catch(() => toast("Couldn't copy", "error"));
  return (
    <Modal
      title={job.pkg.name}
      onClose={onClose}
      wide
      footer={
        <>
          {text && (
            <button className="btn" onClick={copy}>
              <Copy size={14} /> Copy details
            </button>
          )}
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="confirm-body">
        <div className={`note ${job.status === "failed" ? "note-danger" : "note-info"}`}>
          {job.status === "failed" ? <CircleX size={16} /> : <CircleCheck size={16} />}
          <span>{job.status === "failed" ? failureText(job) : job.outcome?.message}</span>
        </div>
        <dl className="apps-facts">
          <dt>winget id</dt>
          <dd className="mono">{job.pkg.id}</dd>
          {job.outcome?.code && (
            <>
              <dt>Result code</dt>
              <dd className="mono">{job.outcome.code}</dd>
            </>
          )}
        </dl>
        {text && <pre className="output queue-log">{text}</pre>}
      </div>
    </Modal>
  );
}
