import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, Metrics } from "../api";

export const HISTORY_LENGTH = 60;

export interface MetricsState {
  latest: Metrics | null;
  history: Metrics[];
}

/** Latest sample pushed by the Rust sampler plus a rolling one-minute history. */
export function useMetrics(): MetricsState {
  const [state, setState] = useState<MetricsState>({ latest: null, history: [] });

  useEffect(() => {
    const push = (m: Metrics) =>
      setState((s) => ({ latest: m, history: [...s.history, m].slice(-HISTORY_LENGTH) }));

    api.metrics().then((m) => m.timestampMs > 0 && push(m)).catch(() => {});
    const unlisten = listen<Metrics>("metrics://update", (e) => push(e.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return state;
}
