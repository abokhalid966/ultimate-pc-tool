import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, FolderOpen, PackageOpen, RefreshCw, SearchX, ShieldCheck, Trash2, X, Zap } from "lucide-react";
import { appsApi, errorText, InstalledApp } from "../../api";
import { useConfirm } from "../../components/Confirm";
import { EmptyState, ErrorState } from "../../components/EmptyState";
import { Menu } from "../../components/Menu";
import { SearchBox } from "../../components/SearchBox";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { bytes } from "../../format";
import { useOnRefresh } from "../../hooks/useRefresh";
import { AppAvatar, formatDate } from "./common";
import { appRemoved, installedApps } from "./data";

type SortKey = "name" | "size" | "date";

/** After an uninstaller hands over to another window, the list is checked this often, this long. */
const WATCH_EVERY = 2500;
const WATCH_FOR = 10 * 60 * 1000;

interface Busy {
  id: string;
  /** "running": waiting for the uninstaller to close; "watching": it handed over, so the list is checked. */
  phase: "running" | "watching";
}

interface Props {
  tabs: ReactNode;
  elevated: boolean;
  onRestartAsAdmin: () => void;
}

export function InstalledTab({ tabs, elevated, onRestartAsAdmin }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading } = installedApps.use(false);
  const apps = useMemo(() => data ?? [], [data]);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "name", desc: false });
  const [busy, setBusy] = useState<Busy | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const watch = useRef<number | null>(null);

  // The registry is quick to read, so the list is fresh every time the tab opens.
  useEffect(() => {
    void installedApps.reload();
    return () => {
      if (watch.current) clearInterval(watch.current);
    };
  }, []);
  useOnRefresh(() => void installedApps.reload());

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = apps.filter((a) => !gone.has(a.id) && (!q || a.name.toLowerCase().includes(q) || a.publisher?.toLowerCase().includes(q)));
    const dir = sort.desc ? -1 : 1;
    const byName = (a: InstalledApp, b: InstalledApp) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return list.sort((a, b) => {
      if (sort.key === "name") return dir * byName(a, b);
      // Apps without a size or date go last either way.
      const va = sort.key === "size" ? a.sizeBytes : a.installDate;
      const vb = sort.key === "size" ? b.sizeBytes : b.installDate;
      if (va === vb) return byName(a, b);
      if (va === null) return 1;
      if (vb === null) return -1;
      return dir * (va < vb ? -1 : 1);
    });
  }, [apps, query, sort, gone]);

  const largest = useMemo(() => Math.max(1, ...apps.map((a) => a.sizeBytes ?? 0)), [apps]);

  const stopWatching = () => {
    if (watch.current) clearInterval(watch.current);
    watch.current = null;
  };

  const removed = (app: InstalledApp, restart: boolean) => {
    setGone((g) => new Set(g).add(app.id));
    toast(`${app.name} was uninstalled.${restart ? " Restart your PC to finish removing it." : ""}`, "success");
    appRemoved();
  };

  /** The uninstaller handed over to another window: check now and then until the app is gone. */
  function watchFor(app: InstalledApp) {
    setBusy({ id: app.id, phase: "watching" });
    const started = Date.now();
    stopWatching();
    watch.current = window.setInterval(async () => {
      const still = await appsApi.stillInstalled(app.id).catch(() => true);
      if (!still) {
        stopWatching();
        setBusy(null);
        removed(app, false);
      } else if (Date.now() - started > WATCH_FOR) {
        stopWatching();
        setBusy(null);
      }
    }, WATCH_EVERY);
  }

  async function uninstall(app: InstalledApp, quiet: boolean) {
    const needsAdmin = app.scope === "machine" && !elevated;
    const ok = await confirm({
      title: quiet ? `Uninstall ${app.name} quietly?` : `Uninstall ${app.name}?`,
      message: (
        <>
          <p>
            {quiet
              ? `${app.name} is removed without any questions or windows.`
              : `Windows opens ${app.name}'s own uninstaller. Follow its steps to finish.`}{" "}
            Your documents and photos aren't touched.
          </p>
          <dl className="apps-facts">
            {app.publisher && (
              <>
                <dt>Publisher</dt>
                <dd>{app.publisher}</dd>
              </>
            )}
            {app.version && (
              <>
                <dt>Version</dt>
                <dd>{app.version}</dd>
              </>
            )}
            {app.sizeBytes ? (
              <>
                <dt>Size</dt>
                <dd>{bytes(app.sizeBytes)}</dd>
              </>
            ) : null}
          </dl>
          <p className="muted small">This can't be undone here. To get the app back later, install it again.</p>
        </>
      ),
      badge: needsAdmin && (
        <span className="pill pill-warn">
          <ShieldCheck size={12} /> Windows will ask for administrator permission
        </span>
      ),
      confirmLabel: quiet ? "Uninstall quietly" : "Uninstall",
      danger: true,
    });
    if (!ok) return;

    setBusy({ id: app.id, phase: "running" });
    try {
      const r = await appsApi.uninstall(app.id, quiet);
      if (r.removed) {
        setBusy(null);
        removed(app, r.restartNeeded);
      } else if (r.cancelled) {
        setBusy(null);
        toast(`Uninstall cancelled. ${app.name} is still installed.`, "info");
      } else if (r.message) {
        setBusy(null);
        toast(`${app.name}: ${r.message}`, "error");
      } else if (r.restartNeeded) {
        setBusy(null);
        toast(`Restart your PC to finish uninstalling ${app.name}.`, "info");
      } else {
        watchFor(app);
      }
    } catch (e) {
      setBusy(null);
      const text = errorText(e);
      const declined = text.startsWith("You chose No");
      toast(text, declined ? "info" : "error", declined && !elevated ? { action: { label: "Restart as administrator", run: onRestartAsAdmin } } : undefined);
    }
  }

  const header = (key: SortKey, label: string, className = "") => {
    const sorted = sort.key === key;
    return (
      <th className={`${className} ${sorted ? "sorted" : ""}`} aria-sort={sorted ? (sort.desc ? "descending" : "ascending") : "none"}>
        <button className="th-btn" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}>
          {label}
          {sorted && (sort.desc ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
        </button>
      </th>
    );
  };

  const loaded = data !== undefined;

  return (
    <>
      <div className="apps-bar">
        {tabs}
        <span className="spacer" />
        <SearchBox value={query} onChange={setQuery} placeholder="Search apps" />
        <button className="btn" onClick={() => installedApps.reload()} disabled={loading} title="Read the list again" aria-label="Refresh">
          <RefreshCw size={16} className={loading ? "spin" : undefined} /> <span className="apps-wide-only">Refresh</span>
        </button>
      </div>

      <div className="table-wrap apps-table-wrap">
        {error && !loaded ? (
          <ErrorState what="your apps" message={error} onRetry={() => installedApps.reload()} />
        ) : (
          <>
            <table className="table table-fixed apps-table" aria-label="Installed apps">
              <thead>
                <tr>
                  {header("name", "App")}
                  <th className="apps-col-publisher">Publisher</th>
                  {header("size", "Size", "num apps-col-size")}
                  {header("date", "Installed", "apps-col-date")}
                  <th className="apps-col-actions">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!loaded &&
                  Array.from({ length: 7 }, (_, i) => (
                    <tr key={i} aria-hidden="true">
                      <td>
                        <span className="name-flex">
                          <Skeleton width={24} height={24} radius={6} />
                          <span style={{ flex: 1 }}>
                            <Skeleton width={`${35 + ((i * 13) % 40)}%`} />
                            <Skeleton width="30%" height={10} style={{ marginTop: 5 }} />
                          </span>
                        </span>
                      </td>
                      <td className="apps-col-publisher">
                        <Skeleton width="60%" />
                      </td>
                      <td className="apps-col-size">
                        <Skeleton width={50} style={{ marginLeft: "auto" }} />
                      </td>
                      <td className="apps-col-date">
                        <Skeleton width={80} />
                      </td>
                      <td className="apps-col-actions">
                        <Skeleton width={84} height={26} radius={6} style={{ marginLeft: "auto" }} />
                      </td>
                    </tr>
                  ))}
                {visible.map((app) => (
                  <AppRow
                    key={app.id}
                    app={app}
                    largest={largest}
                    busy={busy?.id === app.id ? busy.phase : null}
                    blocked={!!busy && busy.id !== app.id}
                    onUninstall={(quiet) => uninstall(app, quiet)}
                    onStopWatching={() => {
                      stopWatching();
                      setBusy(null);
                      void installedApps.reload();
                    }}
                  />
                ))}
              </tbody>
            </table>
            {loaded &&
              visible.length === 0 &&
              (query ? (
                <EmptyState
                  icon={SearchX}
                  title={`No apps match “${query}”`}
                  body="Try part of the name, like “chrome” or “office”, or the publisher."
                  actions={
                    <button className="btn" onClick={() => setQuery("")}>
                      Clear search
                    </button>
                  }
                />
              ) : (
                <EmptyState icon={PackageOpen} title="No apps found" body="Windows didn't list any installed apps. Try Refresh." />
              ))}
          </>
        )}
      </div>
    </>
  );
}

function AppRow({
  app,
  largest,
  busy,
  blocked,
  onUninstall,
  onStopWatching,
}: {
  app: InstalledApp;
  largest: number;
  busy: Busy["phase"] | null;
  blocked: boolean;
  onUninstall: (quiet: boolean) => void;
  onStopWatching: () => void;
}) {
  const toast = useToast();
  const why = app.isSelf
    ? "To remove Ultimate PC Tool, use Settings > Apps > Installed apps in Windows."
    : !app.canUninstall
      ? "This app's installer doesn't allow removing it here."
      : blocked
        ? "Wait for the current uninstall to finish first."
        : undefined;
  const meta = [app.version && `Version ${app.version}`, app.scope === "user" ? "Just for you" : null].filter(Boolean).join(" · ");

  return (
    <tr className={busy ? "apps-row-busy" : undefined}>
      <td>
        <span className="name-flex">
          <AppAvatar name={app.name} />
          <span className="apps-name">
            <span className="apps-name-line">
              <strong className="truncate" title={app.name}>
                {app.name}
              </strong>
              {app.isSelf && <span className="pill pill-sm pill-accent">This app</span>}
            </span>
            {meta && <span className="apps-meta truncate">{meta}</span>}
          </span>
        </span>
      </td>
      <td className="apps-col-publisher">
        <span className="truncate muted" title={app.publisher ?? undefined} style={{ display: "block" }}>
          {app.publisher ?? "—"}
        </span>
      </td>
      <td className="num apps-col-size">
        {app.sizeBytes ? (
          <span className="apps-size" title="Size reported by the app's installer">
            {bytes(app.sizeBytes)}
            <span className="apps-size-bar" aria-hidden="true">
              <span style={{ width: `${Math.max(2, (app.sizeBytes / largest) * 100)}%` }} />
            </span>
          </span>
        ) : (
          <span className="subtle">—</span>
        )}
      </td>
      <td className="apps-col-date">{app.installDate ? formatDate(app.installDate) : <span className="subtle">—</span>}</td>
      <td className="apps-col-actions">
        <span className="apps-actions">
          {busy === "running" ? (
            <span className="job-live" title="Follow the steps in the uninstaller's window.">
              <span className="spinner" /> <span className="job-live-text">Uninstalling…</span>
            </span>
          ) : busy === "watching" ? (
            <>
              <span className="job-live" title="The uninstaller is still open in its own window. This row updates when it's done.">
                <span className="spinner" /> <span className="job-live-text">Finishing…</span>
              </span>
              <button className="icon-btn icon-btn-sm" onClick={onStopWatching} title="Stop waiting" aria-label={`Stop waiting for ${app.name}'s uninstaller`}>
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-sm apps-uninstall"
                onClick={() => onUninstall(false)}
                disabled={!!why}
                title={why ?? `Uninstall ${app.name}`}
                aria-label={`Uninstall ${app.name}`}
              >
                <Trash2 size={14} /> Uninstall
              </button>
              <Menu
                label={`More actions for ${app.name}`}
                className="icon-btn icon-btn-sm"
                items={[
                  {
                    label: "Uninstall quietly",
                    icon: Zap,
                    hint: "No questions",
                    onSelect: () => onUninstall(true),
                    disabled: !!why || !app.canQuiet,
                    title: !app.canQuiet ? "This app doesn't offer a quiet uninstall." : why,
                  },
                  {
                    label: "Open install folder",
                    icon: FolderOpen,
                    onSelect: () => app.location && appsApi.openFolder(app.location).catch((e) => toast(errorText(e), "error")),
                    disabled: !app.location,
                    title: app.location ?? "The app didn't say where it's installed.",
                  },
                ]}
              />
            </>
          )}
        </span>
      </td>
    </tr>
  );
}
