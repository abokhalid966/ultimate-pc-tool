import { useMemo, useState } from "react";
import { RefreshCw, Search, ShieldAlert } from "lucide-react";
import { api, errorText, StartupItem } from "../api";
import { useToast } from "../components/Toast";
import { useAsync } from "../hooks/useAsync";

export function Startup() {
  const toast = useToast();
  const { data: items, reload, loading } = useAsync(api.startupItems, [] as StartupItem[]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.command.toLowerCase().includes(q))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  }, [items, query]);

  const enabledCount = items.filter((i) => i.enabled).length;

  async function toggle(item: StartupItem) {
    const key = `${item.source}:${item.name}`;
    setBusy(key);
    try {
      await api.setStartupEnabled(item.source, item.name, !item.enabled);
      toast(`${item.enabled ? "Disabled" : "Enabled"} ${item.name}. You can undo this in Activity.`, "success");
      await reload();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="page page-fill">
      <header className="page-header">
        <div>
          <h1>Startup apps</h1>
          <p className="muted">
            {enabledCount} of {items.length} apps start with Windows. Disabling never deletes anything, and every change can be undone.
          </p>
        </div>
        <div className="toolbar">
          <label className="search">
            <Search size={16} />
            <input placeholder="Search startup apps" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="btn" onClick={reload} disabled={loading}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>
      </header>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Command</th>
              <th>Location</th>
              <th className="num">Starts with Windows</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const key = `${item.source}:${item.name}`;
              return (
                <tr key={key} className={item.enabled ? "" : "dim"}>
                  <td className="name-cell">
                    {item.name}
                    {item.needsAdmin && (
                      <span title="Applies to all users, needs administrator rights to change">
                        <ShieldAlert size={13} className="inline-icon warn" />
                      </span>
                    )}
                  </td>
                  <td className="mono small truncate" title={item.command}>
                    {item.command}
                  </td>
                  <td className="muted small">{item.location}</td>
                  <td className="num">
                    <label className="switch">
                      <input type="checkbox" checked={item.enabled} disabled={busy === key} onChange={() => toggle(item)} />
                      <span className="slider" />
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && filtered.length === 0 && <div className="empty">No startup apps found.</div>}
      </div>
    </div>
  );
}
