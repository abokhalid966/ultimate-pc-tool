import { useState } from "react";
import { FileCog, Folder, RefreshCw, ShieldCheck } from "lucide-react";
import { api, appsApi, errorText, InstalledApp, Leftover } from "../../api";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toast";
import { bytes } from "../../format";

interface Props {
  app: InstalledApp;
  items: Leftover[];
  elevated: boolean;
  onRestartAsAdmin: () => void;
  onClose: () => void;
}

/** After an uninstall: what the app left behind, ready to remove with one click (and undo). */
export function LeftoversDialog({ app, items, elevated, onRestartAsAdmin, onClose }: Props) {
  const toast = useToast();
  const usable = items.filter((i) => elevated || !i.needsAdmin);
  const [picked, setPicked] = useState<Set<number>>(new Set(usable.map((i) => i.id)));
  const [busy, setBusy] = useState(false);
  const size = items.filter((i) => picked.has(i.id)).reduce((sum, i) => sum + i.bytes, 0);
  const locked = items.length - usable.length;

  const toggle = (id: number, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const remove = async () => {
    setBusy(true);
    try {
      const r = await appsApi.removeLeftovers([...picked], app.name);
      if (r.removed > 0) {
        const id = r.activityId;
        toast(`Removed ${r.removed} ${r.removed === 1 ? "leftover" : "leftovers"} of ${app.name}${r.bytes > 0 ? ` and freed ${bytes(r.bytes)}` : ""}.`, "success", id ? { action: { label: "Undo", run: () => api.undoActivity(id).then(() => toast("Put back.", "success"), (e) => toast(errorText(e), "error")) } } : undefined);
      }
      r.failed.slice(0, 3).forEach((f) => toast(`${f.path}: ${f.error}`, "error"));
      onClose();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`${app.name} left some things behind`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Keep them
          </button>
          <button className="btn btn-primary" onClick={remove} disabled={busy || picked.size === 0} autoFocus>
            {busy && <RefreshCw size={15} className="spin" />} Remove {picked.size} {picked.size === 1 ? "item" : "items"}
            {size > 0 ? ` (${bytes(size)})` : ""}
          </button>
        </>
      }
    >
      <p>
        The uninstaller is done, but these folders and settings are still on your PC. Folders go to the Recycle Bin and settings are backed up, so you can undo
        this from the notification or the Activity page.
      </p>
      <ul className="leftovers">
        {items.map((i) => {
          const disabled = i.needsAdmin && !elevated;
          return (
            <li key={i.id} className={disabled ? "disabled" : undefined}>
              <label className="check">
                <input type="checkbox" checked={picked.has(i.id)} disabled={disabled || busy} onChange={(e) => toggle(i.id, e.target.checked)} />
                <span className="leftover-icon">{i.kind === "folder" ? <Folder size={15} /> : <FileCog size={15} />}</span>
                <span className="leftover-text">
                  <span className="leftover-path" title={i.path}>
                    {i.path}
                  </span>
                  <span className="muted small">
                    {i.note}
                    {i.bytes > 0 && ` · ${bytes(i.bytes)}`}
                  </span>
                </span>
              </label>
              {disabled && <span className="pill pill-sm pill-outline">Administrator</span>}
            </li>
          );
        })}
      </ul>
      {locked > 0 && (
        <p className="muted small">
          {locked} {locked === 1 ? "item needs" : "items need"} administrator rights.{" "}
          <button className="btn btn-sm btn-ghost" onClick={onRestartAsAdmin}>
            <ShieldCheck size={14} /> Restart as administrator
          </button>
        </p>
      )}
    </Modal>
  );
}
