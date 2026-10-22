import { useMemo, useState } from "react";
import { Power, RefreshCw, SearchX, ShieldAlert, ShieldCheck } from "lucide-react";
import { api, errorText, StartupItem, StartupSource } from "../api";
import { EmptyState, ErrorState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { SearchBox } from "../components/SearchBox";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { nameHue } from "../format";
import { useAsync } from "../hooks/useAsync";
import { useOnRefresh } from "../hooks/useRefresh";

const ADMIN_HINT = "Applies to all users, so it needs administrator rights. Use Restart as administrator to change it.";

/** Short labels for where an entry lives; the full location is in the tooltip. */
const SOURCE_LABEL: Record<StartupSource, string> = {
  userRun: "This user",
  machineRun: "All users",
  machineRun32: "All users",
  userFolder: "Startup folder",
  machineFolder: "Startup folder",
};

/** Plain-language hints for well-known entries (matched on the entry name, case-insensitive). */
const KEEP_ON = /securityhealth|windowsdefender|msmpeng|rtkaud|rthdvcpl|realtek|nahimic|waves|maxxaudio|synaptics|syntp|etdctrl|elantech|igfx|nvidia|amd(?!.*launcher)|radeon|bluetooth|touchpad|onedrive/i;
const SAFE_OFF = /spotify|discord|steam|epic|teams|skype|zoom|slack|dropbox|adobe|ccleaner|utorrent|bittorrent|opera|edgeautolaunch|msedge|origin|battle\.net|ubisoft|gog|whatsapp|telegram|cortana|itunes/i;

function hint(item: StartupItem): { text: string; tone: "keep" | "safe" } | null {
  if (KEEP_ON.test(item.name)) {
    return /onedrive/i.test(item.name)
      ? { text: "Keeps files in sync", tone: "keep" }
      : { text: "Recommended: keep on", tone: "keep" };
  }
  if (SAFE_OFF.test(item.name) || SAFE_OFF.test(item.command)) return { text: "Usually safe to turn off", tone: "safe" };
  return null;
}

const keyOf = (i: StartupItem) => `${i.source}:${i.name}`;

export function Startup({ elevated, onRestartAsAdmin }: { elevated: boolean; onRestartAsAdmin: () => void }) {
  const toast = useToast();
  const { data: items, setData, reload, loading, loaded, error } = useAsync(api.startupItems, [] as StartupItem[]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ key: string; n: number } | null>(null);
  useOnRefresh(reload);

  // Sorted by name only, so a row stays put when it's switched on or off.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.command.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [items, query]);

  const enabledCount = items.filter((i) => i.enabled).length;
  const lockedCount = elevated ? 0 : items.filter((i) => i.needsAdmin).length;

  const setEnabled = (item: StartupItem, enabled: boolean) =>
    setData((list) => list.map((i) => (keyOf(i) === keyOf(item) ? { ...i, enabled } : i)));

  async function toggle(item: StartupItem) {
    const key = keyOf(item);
    const next = !item.enabled;
    setBusy(key);
    try {
      await api.setStartupEnabled(item.source, item.name, next);
      setEnabled(item, next);
      setFlash((f) => ({ key, n: (f?.n ?? 0) + 1 }));
      toast(`${item.name} ${next ? "will start with Windows" : "won't start with Windows any more"}.`, "success", {
        action: {
          label: "Undo",
          run: () => undo(item, next),
        },
      });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  /** Reverts through the activity log, so the history shows the change as undone. */
  async function undo(item: StartupItem, changedTo: boolean) {
    try {
      const records = await api.activity();
      const record = records.find(
        (r) => !r.undone && r.undo?.type === "startupToggle" && r.undo.source === item.source && r.undo.name === item.name && r.undo.enabled === !changedTo,
      );
      if (record) await api.undoActivity(record.id);
      else await api.setStartupEnabled(item.source, item.name, !changedTo);
      setEnabled(item, !changedTo);
      setFlash((f) => ({ key: keyOf(item), n: (f?.n ?? 0) + 1 }));
      toast(`Undone: ${item.name} is ${changedTo ? "off" : "on"} again.`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  return (
    <div className="page page-fill">
      <PageHeader
        title="Startup apps"
        subtitle={
          loaded
            ? `${enabledCount} of ${items.length} apps start when you sign in. Turning one off never deletes it, and you can turn it back on any time.`
            : "Choose which apps start when you sign in to Windows."
        }
        actions={
          <>
            <SearchBox value={query} onChange={setQuery} placeholder="Search startup apps" />
            <button className="btn" onClick={reload} disabled={loading} title="Read the list again">
              <RefreshCw size={16} className={loading ? "spin" : undefined} /> Refresh
            </button>
          </>
        }
      />

      {lockedCount > 0 && (
        <div className="note note-info">
          <ShieldAlert size={16} />
          <span>
            {lockedCount} {lockedCount === 1 ? "app applies" : "apps apply"} to everyone who uses this PC, so {lockedCount === 1 ? "it" : "they"} can
            only be changed as administrator.
          </span>
          <button className="btn btn-sm" onClick={onRestartAsAdmin}>
            <ShieldCheck size={14} /> Restart as administrator
          </button>
        </div>
      )}

      <div className="table-wrap">
        {error && items.length === 0 ? (
          <ErrorState what="startup apps" message={error} onRetry={reload} />
        ) : (
          <>
            <table className="table table-fixed" aria-label="Startup apps">
              <thead>
                <tr>
                  <th>App</th>
                  <th className="col-optional" style={{ width: 160 }}>
                    Applies to
                  </th>
                  <th style={{ width: 172 }}>Starts with Windows</th>
                </tr>
              </thead>
              <tbody>
                {!loaded &&
                  Array.from({ length: 4 }, (_, i) => (
                    <tr key={i} aria-hidden="true">
                      <td className="startup-cell">
                        <span className="name-flex">
                          <Skeleton width={24} height={24} radius={6} />
                          <span style={{ flex: 1 }}>
                            <Skeleton width={`${40 + i * 8}%`} />
                            <Skeleton width="70%" height={10} />
                          </span>
                        </span>
                      </td>
                      <td className="col-optional">
                        <Skeleton width={80} height={20} radius={10} />
                      </td>
                      <td>
                        <Skeleton width={40} height={20} radius={10} />
                      </td>
                    </tr>
                  ))}
                {filtered.map((item) => {
                  const key = keyOf(item);
                  const locked = item.needsAdmin && !elevated;
                  const h = hint(item);
                  return (
                    <tr key={key} className={`${item.enabled ? "" : "off"} ${flash?.key === key ? (flash.n % 2 ? "flash-b" : "flash-a") : ""}`}>
                      <td className="startup-cell">
                        <span className="name-flex">
                          <span className="app-avatar" style={{ "--avatar-h": nameHue(item.name) } as React.CSSProperties} aria-hidden="true">
                            {item.name.charAt(0).toUpperCase()}
                          </span>
                          <span className="startup-name">
                            <span className="startup-name-line">
                              <strong>{item.name}</strong>
                              {h && <span className={`pill pill-sm ${h.tone === "keep" ? "pill-accent" : ""}`}>{h.text}</span>}
                            </span>
                            <span className="startup-cmd truncate" title={item.command}>
                              {item.command}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td className="col-optional">
                        <span className="pill pill-outline" title={item.location}>
                          {item.needsAdmin && <ShieldAlert size={12} />}
                          {SOURCE_LABEL[item.source] ?? item.location}
                        </span>
                      </td>
                      <td>
                        <label className="switch" title={locked ? ADMIN_HINT : item.enabled ? "Turn off" : "Turn on"}>
                          <input
                            type="checkbox"
                            role="switch"
                            aria-label={`${item.name} starts with Windows`}
                            checked={item.enabled}
                            disabled={busy === key || locked}
                            onChange={() => toggle(item)}
                          />
                          <span className="slider" />
                          <span className="switch-label">{busy === key ? <span className="spinner" /> : locked ? "Admin" : item.enabled ? "On" : "Off"}</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {loaded &&
              filtered.length === 0 &&
              (query ? (
                <EmptyState
                  icon={SearchX}
                  title={`No results for “${query}”`}
                  actions={
                    <button className="btn" onClick={() => setQuery("")}>
                      Clear search
                    </button>
                  }
                />
              ) : (
                <EmptyState icon={Power} title="No startup apps found" body="Nothing is set to start when you sign in. That's the fastest way to start Windows." />
              ))}
          </>
        )}
      </div>
    </div>
  );
}
