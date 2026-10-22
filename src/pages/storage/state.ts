// State of the Storage page, kept outside React so a scan or cleanup keeps going (and its result
// is still there) when the user switches to another page and back.
import { useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, CleanupCategory, CleanupKind, CleanupResult, CleanupRunEvent, CleanupSummary, errorText, FolderView, ScanEvent, ScanSummary } from "../../api";

export type StorageTab = "cleanup" | "finder";

export interface CleanupState {
  /** In the order the backend lists them; missing until measured. */
  categories: CleanupCategory[];
  measuring: boolean;
  measuredOnce: boolean;
  error: string | null;
  selected: CleanupKind[];
  /** Set while cleaning: the category being cleaned and the results so far. */
  cleaning: { current: CleanupKind | null; results: CleanupResult[]; plannedBytes: number } | null;
  /** The last cleanup, shown until the next scan. */
  summary: CleanupSummary | null;
  /** Something changed sizes (e.g. a file went to the Recycle Bin): measure again on the next visit. */
  stale: boolean;
}

/** What is being scanned: a drive (with its used space, for a real progress bar) or a folder. */
export interface ScanTarget {
  path: string;
  label: string;
  usedBytes: number | null;
}

export interface FinderState {
  phase: "choose" | "scanning" | "results";
  target: ScanTarget | null;
  scanId: string | null;
  startedAt: number;
  progress: Extract<ScanEvent, { type: "progress" }> | null;
  stopping: boolean;
  summary: ScanSummary | null;
  view: FolderView | null;
  loadingNode: number | null;
  error: string | null;
  /** Something was restored with Undo since the scan, so sizes may be off. */
  stale: boolean;
}

interface State {
  tab: StorageTab;
  cleanup: CleanupState;
  finder: FinderState;
}

let state: State = {
  tab: "cleanup",
  cleanup: { categories: [], measuring: false, measuredOnce: false, error: null, selected: [], cleaning: null, summary: null, stale: false },
  finder: { phase: "choose", target: null, scanId: null, startedAt: 0, progress: null, stopping: false, summary: null, view: null, loadingNode: null, error: null, stale: false },
};
const listeners = new Set<() => void>();

function set(change: (s: State) => Partial<State>) {
  state = { ...state, ...change(state) };
  listeners.forEach((l) => l());
}
const setCleanup = (change: (c: CleanupState) => Partial<CleanupState>) => set((s) => ({ cleanup: { ...s.cleanup, ...change(s.cleanup) } }));
const setFinder = (change: (f: FinderState) => Partial<FinderState>) => set((s) => ({ finder: { ...s.finder, ...change(s.finder) } }));

export function useStorageState(): State {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const setTab = (tab: StorageTab) => set(() => ({ tab }));

// ---- Cleanup ----

/** Can be ticked: something to clean and nothing in the way. */
export const cleanable = (c: CleanupCategory) => !c.blocked && c.bytes > 0;

export async function measureCleanup() {
  if (state.cleanup.measuring) return;
  const previous = new Set(state.cleanup.selected);
  const first = !state.cleanup.measuredOnce;
  setCleanup(() => ({ measuring: true, error: null, summary: null, stale: false }));
  const channel = new Channel<CleanupCategory>();
  channel.onmessage = (c) =>
    setCleanup((s) => ({ categories: s.categories.some((x) => x.kind === c.kind) ? s.categories.map((x) => (x.kind === c.kind ? c : x)) : [...s.categories, c] }));
  try {
    const list = await api.cleanupScan(channel);
    // First time: the suggested ones. Later: keep the user's choice where it still applies.
    const selected = list.filter((c) => cleanable(c) && (first ? c.suggested : previous.has(c.kind))).map((c) => c.kind);
    setCleanup(() => ({ categories: list, selected, measuring: false, measuredOnce: true }));
  } catch (e) {
    setCleanup(() => ({ measuring: false, measuredOnce: true, error: errorText(e) }));
  }
}

export function toggleCategory(kind: CleanupKind, on: boolean) {
  setCleanup((s) => ({ selected: on ? [...new Set([...s.selected, kind])] : s.selected.filter((k) => k !== kind) }));
}

export function setAllCategories(on: boolean) {
  setCleanup((s) => ({ selected: on ? s.categories.filter(cleanable).map((c) => c.kind) : [] }));
}

/** Cleans the selected categories. Resolves with the summary, or throws the error text. */
export async function runCleanup(): Promise<CleanupSummary> {
  const kinds = state.cleanup.selected;
  const plannedBytes = state.cleanup.categories.filter((c) => kinds.includes(c.kind)).reduce((s, c) => s + c.bytes, 0);
  setCleanup(() => ({ cleaning: { current: null, results: [], plannedBytes }, summary: null }));
  const channel = new Channel<CleanupRunEvent>();
  channel.onmessage = (e) =>
    setCleanup((s) => {
      if (!s.cleaning) return {};
      return e.type === "started"
        ? { cleaning: { ...s.cleaning, current: e.kind } }
        : { cleaning: { ...s.cleaning, current: null, results: [...s.cleaning.results.filter((r) => r.kind !== e.result.kind), e.result] } };
    });
  try {
    const summary = await api.cleanupRun(kinds, channel);
    // What's left to clean, measured again so the list shows the new sizes.
    setCleanup((s) => ({
      cleaning: null,
      summary,
      selected: [],
      categories: s.categories.map((c) => {
        const r = summary.results.find((x) => x.kind === c.kind);
        return r && !r.error ? { ...c, bytes: Math.max(0, c.bytes - r.bytes), files: Math.max(0, c.files - r.files) } : c;
      }),
    }));
    return summary;
  } catch (e) {
    setCleanup(() => ({ cleaning: null }));
    throw errorText(e);
  }
}

export const dismissCleanupSummary = () => setCleanup(() => ({ summary: null }));
export const invalidateCleanup = () => setCleanup(() => ({ stale: true }));

// ---- Space finder ----

let scanCounter = 0;

export async function startScan(target: ScanTarget) {
  const scanId = `scan-${Date.now()}-${++scanCounter}`;
  // The backend lets go of the previous results when a new scan starts.
  setFinder(() => ({ phase: "scanning", target, scanId, startedAt: Date.now(), progress: null, stopping: false, error: null, stale: false, summary: null, view: null }));
  const channel = new Channel<ScanEvent>();
  channel.onmessage = (e) => {
    if (state.finder.scanId === scanId) setFinder(() => ({ progress: e }));
  };
  try {
    const summary = await api.storageScan(scanId, target.path, channel);
    if (state.finder.scanId !== scanId) return;
    setFinder(() => ({ phase: "results", summary, view: summary.view, stopping: false }));
  } catch (e) {
    if (state.finder.scanId !== scanId) return;
    setFinder(() => ({ phase: "choose", error: errorText(e), stopping: false, scanId: null }));
  }
}

export function stopScan() {
  const id = state.finder.scanId;
  if (!id || state.finder.phase !== "scanning") return;
  setFinder(() => ({ stopping: true }));
  api.cancelStorageScan(id).catch(() => {});
}

/** Back to choosing a drive or folder. The last results stay in memory until the next scan. */
export const chooseAnother = () => setFinder(() => ({ phase: "choose", error: null }));
export const showLastResults = () => setFinder((f) => (f.summary ? { phase: "results", error: null } : {}));

export async function openFolder(node: number) {
  const { scanId } = state.finder;
  if (!scanId) return;
  setFinder(() => ({ loadingNode: node }));
  try {
    const view = await api.storageFolder(scanId, node);
    setFinder(() => ({ view, loadingNode: null }));
  } catch (e) {
    setFinder(() => ({ loadingNode: null }));
    throw errorText(e);
  }
}

/** Reloads the current folder after something in it was deleted. */
export async function refreshView() {
  const { scanId, view } = state.finder;
  if (!scanId || !view) return;
  try {
    const next = await api.storageFolder(scanId, view.node);
    setFinder(() => ({ view: next }));
  } catch {
    // The folder itself is gone: go back to the scanned folder.
    const root = await api.storageFolder(scanId, 0).catch(() => null);
    if (root) setFinder(() => ({ view: root }));
  }
}

export const markStale = () => setFinder(() => ({ stale: true }));
