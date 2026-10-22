import { useEffect, useSyncExternalStore } from "react";
import { appsApi, errorText } from "../../api";
import { onJobFinished, queueBusy } from "./queue";

export interface ResourceState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
}

/**
 * A list loaded on first use and kept while the app runs, so switching tabs or pages shows it at
 * once instead of asking winget again (which can take a while).
 */
function resource<T>(load: () => Promise<T>) {
  let snap: ResourceState<T> = { data: undefined, error: null, loading: false };
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const set = (change: Partial<ResourceState<T>>) => {
    snap = { ...snap, ...change };
    listeners.forEach((l) => l());
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };

  const reload = () => {
    if (!inflight) {
      set({ loading: true });
      inflight = load()
        .then(
          (data) => set({ data, error: null, loading: false }),
          (e) => set({ error: errorText(e), loading: false }),
        )
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };

  return {
    reload,
    get: () => snap,
    update: (f: (data: T) => T) => snap.data !== undefined && set({ data: f(snap.data) }),
    /** The current state; loads it the first time unless `autoload` is false. */
    use(autoload = true) {
      const state = useSyncExternalStore(subscribe, () => snap);
      useEffect(() => {
        if (autoload && snap.data === undefined && !snap.loading && !snap.error) void reload();
      }, [autoload]);
      return state;
    },
  };
}

export const installedApps = resource(appsApi.installed);
export const upgradeList = resource(appsApi.upgrades);
export const wingetInstalled = resource(appsApi.wingetInstalled);

// Keep the lists in step with what the queue just changed.
onJobFinished((job) => {
  if (!job.outcome?.ok) return;
  if (installedApps.get().data) void installedApps.reload();
  if (job.action === "install") {
    wingetInstalled.update((d) => ({ ...d, packages: [...d.packages, { name: job.pkg.name, id: job.pkg.id, partialId: false }] }));
  }
});

/**
 * An app was uninstalled. What winget reported (installed apps, updates) may include it, so ask
 * again in the background — unless the queue is using winget right now.
 */
export function appRemoved() {
  void installedApps.reload();
  if (queueBusy()) return;
  if (wingetInstalled.get().data) void wingetInstalled.reload();
  if (upgradeList.get().data) void upgradeList.reload();
}
