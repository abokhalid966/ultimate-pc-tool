import { useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, errorText, HealthEvent, HealthReport } from "../api";

/** What happened to an issue after its fix ran. */
export interface FixResult {
  /** e.g. "Switched to Balanced" */
  text: string;
  /** Activity entry id for Undo, when the change can be undone. */
  undoId?: string | null;
}

export interface HealthState {
  report: HealthReport | null;
  running: boolean;
  percent: number;
  step: string;
  error: string | null;
  /** Issue id -> outcome, for the current report. */
  fixed: Record<string, FixResult>;
}

const STORAGE_KEY = "health-last-report";

/** The last report survives page switches (module state) and restarts (localStorage). */
function load(): Pick<HealthState, "report" | "fixed"> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved && typeof saved.report?.score === "number" && Array.isArray(saved.report.issues)) {
      return { report: saved.report, fixed: saved.fixed && typeof saved.fixed === "object" ? saved.fixed : {} };
    }
  } catch {
    /* storage unavailable or damaged */
  }
  return { report: null, fixed: {} };
}

function save(s: HealthState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ report: s.report, fixed: s.fixed }));
  } catch {
    /* storage unavailable */
  }
}

let state: HealthState = { ...load(), running: false, percent: 0, step: "", error: null };
const listeners = new Set<() => void>();

function set(patch: Partial<HealthState>, persist = false) {
  state = { ...state, ...patch };
  if (persist) save(state);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useHealthCheck = () => useSyncExternalStore(subscribe, () => state);

/** The current state outside React, e.g. inside an event handler. */
export const getHealthState = () => state;

/** Starts the speed check unless one is running. Keeps going if the user leaves the page. */
export async function startHealthCheck() {
  if (state.running) return;
  set({ running: true, percent: 0, step: "Getting ready…", error: null });
  const channel = new Channel<HealthEvent>();
  channel.onmessage = (e) => {
    if (e.type === "progress" && state.running) set({ percent: Math.max(state.percent, e.percent), step: e.step });
  };
  try {
    const report = await api.runHealthCheck(channel);
    set({ report, fixed: {}, running: false, percent: 100, step: "" }, true);
  } catch (e) {
    set({ running: false, error: errorText(e) });
  }
}

export function markFixed(id: string, result: FixResult) {
  set({ fixed: { ...state.fixed, [id]: result } }, true);
}

export function markUndone(id: string) {
  const fixed = { ...state.fixed };
  delete fixed[id];
  set({ fixed }, true);
}

/** The score with the points of fixed issues given back. */
export function currentScore(s: Pick<HealthState, "report" | "fixed">): number {
  if (!s.report) return 0;
  const back = s.report.issues.filter((i) => s.fixed[i.id]).reduce((sum, i) => sum + i.points, 0);
  return Math.min(100, s.report.score + back);
}
