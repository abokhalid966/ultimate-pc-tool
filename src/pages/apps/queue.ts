import { useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, appsApi, errorText, newRunId, RunEvent, WingetAction, WingetOutcome, WingetPackage } from "../../api";
import { parseProgress, Phase, phaseOf, Screen } from "./screen";

// Installs and updates run one at a time (installers can't run side by side), in a queue that
// lives outside React, so leaving the Apps page doesn't lose a run or its progress.

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  /** `${action}:${id}`: one job per app and action at a time. */
  key: string;
  runId: string;
  action: WingetAction;
  pkg: WingetPackage;
  status: JobStatus;
  /** 0 to 1 while a download shows its size, else null. */
  progress: number | null;
  phase: Phase;
  /** winget's latest line, shown as small print. */
  line: string;
  log: string;
  outcome?: WingetOutcome;
  error?: string;
  stopping?: boolean;
}

interface State {
  jobs: Job[];
}

let state: State = { jobs: [] };
const listeners = new Set<() => void>();
const doneListeners = new Set<(job: Job) => void>();
let pumping = false;

function set(next: State) {
  state = next;
  listeners.forEach((l) => l());
}

function patch(key: string, change: Partial<Job>) {
  set({ jobs: state.jobs.map((j) => (j.key === key ? { ...j, ...change } : j)) });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Jobs waiting, running, or finished and not yet dismissed, in queue order. */
export function useQueue(): Job[] {
  return useSyncExternalStore(subscribe, () => state.jobs);
}

/** Called once per finished job (done, failed or cancelled). */
export function onJobFinished(listener: (job: Job) => void) {
  doneListeners.add(listener);
  return () => {
    doneListeners.delete(listener);
  };
}

export const isActive = (j: Job) => j.status === "queued" || j.status === "running";
/** Whether winget is busy with (or about to run) any job. */
export const queueBusy = () => state.jobs.some(isActive);
export const jobKey = (action: WingetAction, id: string) => `${action}:${id}`;

/** Adds apps to the queue; ones already waiting or running are skipped. Returns how many were added. */
export function enqueue(action: WingetAction, pkgs: WingetPackage[]): number {
  const busy = new Set(state.jobs.filter(isActive).map((j) => j.key));
  const fresh = pkgs.filter((p) => !busy.has(jobKey(action, p.id)));
  if (fresh.length === 0) return 0;
  const keys = new Set(fresh.map((p) => jobKey(action, p.id)));
  // A new run replaces the finished results of earlier ones for the same apps.
  const kept = state.jobs.filter((j) => !keys.has(j.key));
  const jobs: Job[] = fresh.map((pkg) => ({
    key: jobKey(action, pkg.id),
    runId: newRunId(),
    action,
    pkg,
    status: "queued",
    progress: null,
    phase: "preparing",
    line: "",
    log: "",
  }));
  set({ jobs: [...kept, ...jobs] });
  void pump();
  return fresh.length;
}

/** Stops one app: taken off the queue if it hasn't started, else its run is stopped. */
export function cancelJob(key: string) {
  const job = state.jobs.find((j) => j.key === key);
  if (!job) return;
  if (job.status === "queued") {
    patch(key, { status: "cancelled", outcome: undefined });
    doneListeners.forEach((l) => l({ ...job, status: "cancelled" }));
  } else if (job.status === "running" && !job.stopping) {
    patch(key, { stopping: true });
    api.cancelCommand(job.runId).catch(() => {});
  }
}

/** Stops everything of one kind: waiting apps are dropped and the running one is stopped. */
export function cancelAll(action: WingetAction) {
  for (const j of state.jobs) if (j.action === action && isActive(j)) cancelJob(j.key);
}

/** Clears finished results of one kind from view. */
export function dismissFinished(action: WingetAction) {
  set({ jobs: state.jobs.filter((j) => j.action !== action || isActive(j)) });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = state.jobs.find((j) => j.status === "queued");
      if (!job) break;
      await runJob(job);
    }
  } finally {
    pumping = false;
  }
}

async function runJob(job: Job) {
  patch(job.key, { status: "running" });
  const screen = new Screen();
  let last = 0;
  const channel = new Channel<RunEvent>();
  channel.onmessage = (e) => {
    screen.write(e.data);
    // Progress redraws many times a second; a few updates a second are plenty.
    const now = Date.now();
    if (now - last < 120) return;
    last = now;
    patch(job.key, { line: screen.status, progress: parseProgress(screen.current), phase: phaseOf(screen.current, screen.status), log: screen.text() });
  };

  let finished: Job;
  try {
    const outcome = await appsApi.wingetRun(job.runId, job.action, job.pkg, channel);
    const status: JobStatus = outcome.ok ? "done" : outcome.stopped === "cancelled" ? "cancelled" : "failed";
    finished = { ...current(job.key), status, outcome, log: outcome.output || screen.text(), progress: null, stopping: false };
  } catch (e) {
    finished = { ...current(job.key), status: "failed", error: errorText(e), progress: null, stopping: false };
  }
  patch(job.key, finished);
  doneListeners.forEach((l) => l(finished));
}

const current = (key: string) => state.jobs.find((j) => j.key === key)!;

/** "Couldn't run" text for a finished job. */
export const failureText = (j: Job) => j.error ?? j.outcome?.message ?? "Something went wrong.";
