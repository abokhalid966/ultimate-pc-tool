import { CircleCheck, CircleX, Clock, PackageX, RefreshCw, Square, Store } from "lucide-react";
import { appsApi, errorText } from "../../api";
import { EmptyState } from "../../components/EmptyState";
import { useToast } from "../../components/Toast";
import { nameHue } from "../../format";
import { failureText, Job } from "./queue";

export function AppAvatar({ name, size = "sm" }: { name: string; size?: "sm" | "md" }) {
  const letter = name.replace(/^[^\p{L}\p{N}]+/u, "").charAt(0).toUpperCase() || "?";
  return (
    <span className={`app-avatar ${size === "md" ? "md" : ""}`} style={{ "--avatar-h": nameHue(name) } as React.CSSProperties} aria-hidden="true">
      {letter}
    </span>
  );
}

/** "Mar 3, 2024" from "2024-03-03". */
export function formatDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Shown when Windows Package Manager isn't on this PC: links to App Installer in the Store. */
export function WingetMissing({ what, onRetry }: { what: string; onRetry: () => void }) {
  const toast = useToast();
  return (
    <EmptyState
      icon={PackageX}
      title={`${what} need the free App Installer from Microsoft`}
      body="Optimo uses Windows Package Manager (winget), which comes with App Installer. It's free in the Microsoft Store and takes a minute to install. Come back here afterwards."
      actions={
        <>
          <button className="btn btn-primary" onClick={() => appsApi.openAppInstaller().catch((e) => toast(errorText(e), "error"))}>
            <Store size={16} /> Get App Installer
          </button>
          <button className="btn" onClick={onRetry}>
            <RefreshCw size={16} /> Check again
          </button>
        </>
      }
    />
  );
}

const PHASE: Record<Job["phase"], string> = {
  preparing: "Getting ready",
  downloading: "Downloading",
  verifying: "Checking the download",
  installing: "Installing",
};

export const phaseLabel = (j: Job) => (j.stopping ? "Stopping" : j.action === "upgrade" && j.phase === "installing" ? "Updating" : PHASE[j.phase]);

/** A job's state in a table row or card: waiting, live progress, or the result. */
export function JobChip({ job, onShowDetails }: { job: Job; onShowDetails?: () => void }) {
  const done = job.action === "install" ? "Installed" : "Updated";
  switch (job.status) {
    case "queued":
      return (
        <span className="pill pill-sm">
          <Clock size={12} /> Waiting
        </span>
      );
    case "running":
      return (
        <span className="job-live" title={job.line || undefined}>
          <span className="spinner" />
          <span className="job-live-text">
            {phaseLabel(job)}
            {job.progress !== null && ` ${Math.round(job.progress * 100)}%`}
          </span>
        </span>
      );
    case "done":
      return (
        <span className={`pill pill-sm ${job.outcome?.unchanged ? "" : "pill-ok"}`} title={job.outcome?.message}>
          <CircleCheck size={12} /> {job.outcome?.unchanged ? job.outcome.message.replace(/\.$/, "") : done}
        </span>
      );
    case "cancelled":
      return (
        <span className="pill pill-sm">
          <Square size={11} /> Stopped
        </span>
      );
    case "failed":
      return (
        <button className="pill pill-sm pill-danger" title={`${failureText(job)} Click for details.`} onClick={onShowDetails}>
          <CircleX size={12} /> Didn't work
        </button>
      );
  }
}
