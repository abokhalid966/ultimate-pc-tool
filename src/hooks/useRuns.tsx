import { createContext, ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { api, CommandOutput, errorText, newRunId, RunEvent, SavedCommand, Shell } from "../api";
import { useToast } from "../components/Toast";

export interface Run {
  id: string;
  /** The saved command this run came from. */
  cmdId: string;
  shell: Shell;
  name: string;
  command: string;
  admin: boolean;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  /** Live output while running; replaced by the final output when done. */
  stdout: string;
  stderr: string;
  output?: CommandOutput;
  error?: string;
  stopping?: boolean;
}

interface Runs {
  runs: Run[];
  start: (cmd: SavedCommand, command: string) => void;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
}

const RunsContext = createContext<Runs>({ runs: [], start: () => {}, cancel: () => {}, dismiss: () => {} });

/** Command runs, kept above the pages so results survive switching pages. */
export const useRuns = () => useContext(RunsContext);

const MAX_RUNS = 10;
/** Live output kept per stream while a command runs (the final result has the full capped text). */
const LIVE_CAP = 512 * 1024;

const append = (text: string, more: string) => {
  const next = text + more;
  return next.length > LIVE_CAP ? next.slice(next.length - LIVE_CAP) : next;
};

export function RunsProvider({ children, notify }: { children: ReactNode; notify: boolean }) {
  const toast = useToast();
  const [runs, setRuns] = useState<Run[]>([]);
  // Read when a run finishes, so it uses the page the user is on at that moment.
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const patch = useCallback((id: string, change: (r: Run) => Partial<Run>) => {
    setRuns((list) => list.map((r) => (r.id === id ? { ...r, ...change(r) } : r)));
  }, []);

  const start = useCallback(
    (cmd: SavedCommand, command: string) => {
      const id = newRunId();
      const run: Run = { id, cmdId: cmd.id, shell: cmd.shell, name: cmd.name, command, admin: cmd.admin, status: "running", startedAt: Date.now(), stdout: "", stderr: "" };
      setRuns((list) => {
        // Drop the oldest finished runs beyond the limit; running ones always stay.
        const next = [run, ...list];
        const finished = next.filter((r) => r.status !== "running");
        const drop = new Set(finished.slice(Math.max(0, MAX_RUNS - (next.length - finished.length))).map((r) => r.id));
        return next.filter((r) => !drop.has(r.id));
      });

      const channel = new Channel<RunEvent>();
      channel.onmessage = (e) =>
        patch(id, (r) => (e.stderr ? { stderr: append(r.stderr, e.data) } : { stdout: append(r.stdout, e.data) }));

      api
        .runCommand(command, cmd.shell, cmd.admin, cmd.name, { runId: id, onEvent: channel })
        .then((output) => {
          patch(id, () => ({ status: "done", output, stdout: output.stdout, stderr: output.stderr, finishedAt: Date.now() }));
          if (notifyRef.current && !output.elevated) {
            const failed = output.stopped !== null || output.code !== 0;
            toast(`${failed ? "Finished with problems" : "Finished"}: ${cmd.name}. See Quick fixes for the output.`, failed ? "error" : "success");
          }
        })
        .catch((e) => {
          patch(id, () => ({ status: "error", error: errorText(e), finishedAt: Date.now() }));
          if (notifyRef.current) toast(`${cmd.name}: ${errorText(e)}`, "error");
        });
    },
    [patch, toast],
  );

  const cancel = useCallback(
    (id: string) => {
      patch(id, () => ({ stopping: true }));
      api.cancelCommand(id).catch(() => {});
    },
    [patch],
  );

  const dismiss = useCallback((id: string) => setRuns((list) => list.filter((r) => r.id !== id)), []);

  const value = useMemo(() => ({ runs, start, cancel, dismiss }), [runs, start, cancel, dismiss]);
  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>;
}
