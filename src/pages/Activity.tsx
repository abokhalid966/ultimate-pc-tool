import { RefreshCw, Undo2 } from "lucide-react";
import { ActionRecord, api, errorText } from "../api";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";

export function Activity() {
  const toast = useToast();
  const { data: records, reload } = useAsync(api.activity, [] as ActionRecord[]);

  async function undo(r: ActionRecord) {
    try {
      await api.undoActivity(r.id);
      toast(`Undid: ${r.description}`, "success");
      reload();
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  async function clear() {
    if (!confirm("Clear the whole activity history? Undo will no longer be possible for these entries.")) return;
    await api.clearActivity();
    reload();
  }

  return (
    <div className="page page-fill">
      <header className="page-header">
        <div>
          <h1>Activity</h1>
          <p className="muted">Everything this app changed on your PC, newest first.</p>
        </div>
        <div className="toolbar">
          <button className="btn" onClick={reload}>
            <RefreshCw size={16} /> Refresh
          </button>
          <button className="btn btn-danger-ghost" onClick={clear} disabled={records.length === 0}>
            Clear history
          </button>
        </div>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Area</th>
              <th>What happened</th>
              <th className="num"></th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id} className={r.undone ? "dim" : ""}>
                <td className="muted small nowrap">{new Date(r.timestamp).toLocaleString()}</td>
                <td>
                  <span className="pill">{r.category}</span>
                </td>
                <td>
                  {r.description}
                  {r.undone && <span className="muted"> (undone)</span>}
                </td>
                <td className="num">
                  {r.undo != null && !r.undone && (
                    <button className="btn btn-sm" onClick={() => undo(r)}>
                      <Undo2 size={14} /> Undo
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {records.length === 0 && <div className="empty">Nothing yet. Changes you make will show up here.</div>}
      </div>
    </div>
  );
}
