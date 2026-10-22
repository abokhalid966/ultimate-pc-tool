import { useState, useSyncExternalStore } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Copy, FolderOpen, FolderSearch, RefreshCw, Trash2, X } from "lucide-react";
import { api, DupeEvent, DupeResult, errorText } from "../../api";
import { useConfirm } from "../../components/Confirm";
import { EmptyState } from "../../components/EmptyState";
import { Segmented } from "../../components/Segmented";
import { useToast } from "../../components/Toast";
import { bytes } from "../../format";

const SIZES = [
  { value: "100000", label: "100 KB" },
  { value: "1000000", label: "1 MB" },
  { value: "10000000", label: "10 MB" },
  { value: "100000000", label: "100 MB" },
];
const PAGE = 60;

interface DupState {
  phase: "idle" | "running" | "done";
  /** null: the user's own folder. */
  folder: string | null;
  minSize: string;
  progress: DupeEvent | null;
  stopping: boolean;
  result: DupeResult | null;
  picked: string[];
  error: string | null;
}

// Kept outside React so a search keeps going while another page is open.
let state: DupState = { phase: "idle", folder: null, minSize: "1000000", progress: null, stopping: false, result: null, picked: [], error: null };
const subs = new Set<() => void>();
const set = (patch: Partial<DupState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

function start() {
  set({ phase: "running", progress: null, stopping: false, result: null, picked: [], error: null });
  const channel = new Channel<DupeEvent>();
  channel.onmessage = (e) => set({ progress: e });
  api.findDuplicates(state.folder, Number(state.minSize), channel).then(
    (result) => set({ phase: "done", result }),
    (e) => set({ phase: "idle", error: errorText(e) }),
  );
}

/** Every copy except the oldest in each group, which is most likely the original. */
const extraCopies = (r: DupeResult) => r.groups.flatMap((g) => g.files.slice(1).map((f) => f.path));
const split = (path: string) => {
  const i = path.lastIndexOf("\\");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
};

export function DuplicatesTab() {
  const s = useSyncExternalStore(subscribe, () => state);
  const toast = useToast();
  const confirm = useConfirm();
  const [shown, setShown] = useState(PAGE);
  const [deleting, setDeleting] = useState(false);
  const r = s.result;
  const picked = new Set(s.picked);

  const choose = () =>
    api
      .pickFolder()
      .then((folder) => folder && set({ folder }))
      .catch((e) => toast(errorText(e), "error"));

  const toggle = (path: string, on: boolean, group: string[]) => {
    if (on && group.every((p) => p === path || picked.has(p))) {
      toast("Keep at least one copy. The last one can't be selected.", "info");
      return;
    }
    set({ picked: on ? [...s.picked, path] : s.picked.filter((p) => p !== path) });
  };

  const remove = async () => {
    if (!r) return;
    const size = r.groups.reduce((sum, g) => sum + g.size * g.files.filter((f) => picked.has(f.path)).length, 0);
    const ok = await confirm({
      title: `Move ${s.picked.length} ${s.picked.length === 1 ? "copy" : "copies"} to the Recycle Bin?`,
      message: `This frees about ${bytes(size)}. One copy of every file is kept. You can undo this, or restore them from the Recycle Bin.`,
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await api.deleteDuplicates(s.picked);
      const gone = new Set(res.deleted);
      const groups = r.groups.map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.path)) })).filter((g) => g.files.length > 1);
      set({ result: { ...r, groups, wasted: groups.reduce((sum, g) => sum + g.size * (g.files.length - 1), 0) }, picked: s.picked.filter((p) => !gone.has(p)) });
      if (res.deleted.length > 0) {
        const id = res.activityId;
        toast(`Moved ${res.deleted.length} ${res.deleted.length === 1 ? "copy" : "copies"} to the Recycle Bin and freed ${bytes(res.bytes)}.`, "success", id ? { action: { label: "Undo", run: () => api.undoActivity(id).then(() => toast("Put back. Search again to see them.", "success"), (e) => toast(errorText(e), "error")) } } : undefined);
      }
      res.failed.slice(0, 3).forEach((f) => toast(`${split(f.path)[1]}: ${f.error}`, "error"));
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      {s.phase !== "running" && (
        <section className="card dup-setup">
          <div>
            <div className="muted small">Look in</div>
            <div className="dup-folder">
              <strong>{s.folder ?? "Your files"}</strong>
              {!s.folder && <span className="muted small"> (Documents, Downloads, Pictures, Videos, Desktop and the rest of your user folder)</span>}
            </div>
            <div className="dup-folder-actions">
              <button className="btn btn-sm" onClick={choose}>
                <FolderOpen size={14} /> Choose folder
              </button>
              {s.folder && (
                <button className="btn btn-sm btn-ghost" onClick={() => set({ folder: null })}>
                  Use my files
                </button>
              )}
            </div>
          </div>
          <div>
            <div className="muted small">Skip files smaller than</div>
            <Segmented label="Skip files smaller than" value={s.minSize} onChange={(minSize) => set({ minSize })} options={SIZES} />
          </div>
          <button className="btn btn-primary" onClick={start}>
            <FolderSearch size={16} /> {r ? "Search again" : "Find duplicates"}
          </button>
        </section>
      )}

      {s.error && <div className="card"><EmptyState icon={X} tone="danger" title="Couldn't search for duplicates" body={s.error} /></div>}

      {s.phase === "running" && (
        <section className="card dup-progress">
          <RefreshCw size={20} className="spin" />
          <div>
            <strong>
              {s.progress?.type === "comparing"
                ? `Comparing files: ${s.progress.done.toLocaleString()} of ${s.progress.total.toLocaleString()}`
                : `Looking through files: ${(s.progress?.type === "scanning" ? s.progress.files : 0).toLocaleString()} so far`}
            </strong>
            <div className="muted small dup-current">{s.progress?.type === "scanning" ? s.progress.current : "Files with the same size are read and compared byte for byte."}</div>
          </div>
          <button
            className="btn btn-sm"
            disabled={s.stopping}
            onClick={() => {
              set({ stopping: true });
              api.cancelDuplicates();
            }}
          >
            Stop
          </button>
        </section>
      )}

      {s.phase === "done" && r && (
        r.groups.length === 0 ? (
          <div className="card">
            <EmptyState icon={Copy} title="No duplicates found" body={`Checked ${r.scanned.toLocaleString()} files in ${r.root}.${r.cancelled ? " The search was stopped early." : ""}`} />
          </div>
        ) : (
          <>
            <section className="card dup-summary">
              <div>
                <strong>
                  {r.groups.length.toLocaleString()} {r.groups.length === 1 ? "file has" : "files have"} copies. The extra copies use {bytes(r.wasted)}.
                </strong>
                <p className="muted small">
                  Checked {r.scanned.toLocaleString()} files{r.cancelled ? " before you stopped the search" : ""}. Biggest savings first.
                  {r.truncated ? " Only the top 2,000 are shown." : ""}
                </p>
              </div>
              <button className="btn" onClick={() => set({ picked: extraCopies(r) })} disabled={deleting} title="Keeps the oldest copy of each file">
                Select extra copies
              </button>
              <button className="btn btn-danger" onClick={remove} disabled={s.picked.length === 0 || deleting}>
                {deleting ? <RefreshCw size={16} className="spin" /> : <Trash2 size={16} />} Move {s.picked.length || ""} to Recycle Bin
              </button>
            </section>
            {r.groups.slice(0, shown).map((g) => {
              const paths = g.files.map((f) => f.path);
              return (
                <section key={paths[0]} className="card dup-group">
                  <div className="dup-group-head">
                    <strong>{split(g.files[0].path)[1]}</strong>
                    <span className="muted small">
                      {g.files.length} copies · {bytes(g.size)} each
                    </span>
                  </div>
                  <ul>
                    {g.files.map((f, i) => {
                      const [dir, name] = split(f.path);
                      return (
                        <li key={f.path}>
                          <label className="check">
                            <input type="checkbox" checked={picked.has(f.path)} disabled={deleting} onChange={(e) => toggle(f.path, e.target.checked, paths)} />
                            <span className="dup-path" title={f.path}>
                              <span className="muted">{dir}</span>
                              {name}
                            </span>
                          </label>
                          {i === 0 && <span className="pill pill-sm">Oldest</span>}
                          <span className="muted small dup-date">{f.modified ? new Date(f.modified).toLocaleDateString() : ""}</span>
                          <button className="btn btn-sm btn-ghost" onClick={() => api.revealInExplorer(f.path).catch((e) => toast(errorText(e), "error"))} title="Show in File Explorer">
                            <FolderOpen size={14} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            {r.groups.length > shown && (
              <button className="btn" style={{ alignSelf: "center" }} onClick={() => setShown((n) => n + PAGE)}>
                Show more ({r.groups.length - shown} left)
              </button>
            )}
          </>
        )
      )}
    </>
  );
}
