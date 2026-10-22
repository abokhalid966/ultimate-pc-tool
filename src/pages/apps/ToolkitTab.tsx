import { ReactNode, useMemo, useState } from "react";
import {
  CircleCheck,
  Clapperboard,
  Code,
  Download,
  Gamepad2,
  Globe,
  LucideIcon,
  MessageCircle,
  NotebookPen,
  SearchX,
  ShieldCheck,
  Sparkles,
  Store,
  Wrench,
  X,
} from "lucide-react";
import { appsApi, errorText, WingetPackage } from "../../api";
import { useConfirm } from "../../components/Confirm";
import { EmptyState } from "../../components/EmptyState";
import { SearchBox } from "../../components/SearchBox";
import { useToast } from "../../components/Toast";
import { CATALOG, CATALOG_CATEGORIES, CatalogApp, CatalogCategory } from "../../data/appCatalog";
import { AppAvatar, JobChip } from "./common";
import { installedApps, wingetInstalled } from "./data";
import { installedCatalogIds } from "./match";
import { JobDetails, QueuePanel } from "./QueuePanel";
import { enqueue, isActive, Job, jobKey, useQueue } from "./queue";

const CATEGORY_LOOK: Record<CatalogCategory, { icon: LucideIcon; color: string }> = {
  Browsers: { icon: Globe, color: "var(--cat-system)" },
  Communication: { icon: MessageCircle, color: "var(--cat-network)" },
  Media: { icon: Clapperboard, color: "var(--cat-cleanup)" },
  Productivity: { icon: NotebookPen, color: "var(--cat-mine)" },
  Developer: { icon: Code, color: "var(--cat-apps)" },
  Utilities: { icon: Wrench, color: "var(--cat-repair)" },
  Gaming: { icon: Gamepad2, color: "var(--cat-apps)" },
  Security: { icon: ShieldCheck, color: "var(--cat-network)" },
};

const toPackage = (a: CatalogApp): WingetPackage => ({ id: a.id, name: a.name, source: a.source ?? "winget" });

export function ToolkitTab({ tabs, elevated }: { tabs: ReactNode; elevated: boolean }) {
  const confirm = useConfirm();
  const toast = useToast();
  const programs = installedApps.use();
  const winget = wingetInstalled.use();
  const queue = useQueue();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [details, setDetails] = useState<Job | null>(null);

  const jobs = useMemo(() => queue.filter((j) => j.action === "install"), [queue]);
  const jobFor = (a: CatalogApp) => jobs.find((j) => j.key === jobKey("install", a.id));

  const installed = useMemo(
    () => installedCatalogIds(CATALOG, winget.data?.packages ?? [], (programs.data ?? []).map((p) => p.name)),
    [winget.data, programs.data],
  );
  const isInstalled = (a: CatalogApp) => installed.has(a.id) || jobFor(a)?.status === "done";
  const wingetMissing = !!winget.data?.wingetMissing;
  const checking = (winget.loading && !winget.data) || (programs.loading && !programs.data);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (a: CatalogApp) => !q || [a.name, a.description, a.category].some((f) => f.toLowerCase().includes(q));
    return CATALOG_CATEGORIES.map((category) => ({ category, apps: CATALOG.filter((a) => a.category === category && match(a)) })).filter((g) => g.apps.length);
  }, [query]);

  // Apps that finished installing (or were found installed) drop out of the selection.
  const picked = CATALOG.filter((a) => selected.has(a.id) && !isInstalled(a) && !(jobFor(a) && isActive(jobFor(a)!)));

  const toggle = (a: CatalogApp) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(a.id)) next.delete(a.id);
      else next.add(a.id);
      return next;
    });

  async function install() {
    if (picked.length === 0) return;
    const ok = await confirm({
      title: `Install ${picked.length} app${picked.length === 1 ? "" : "s"}?`,
      message: (
        <>
          <p>They're downloaded straight from each publisher and installed one after another. You can keep using your PC meanwhile.</p>
          <ul className="apps-confirm-list">
            {picked.slice(0, 10).map((a) => (
              <li key={a.id}>{a.name}</li>
            ))}
            {picked.length > 10 && <li className="muted">and {picked.length - 10} more</li>}
          </ul>
          <p className="muted small">Some apps may ask for permission. By installing, you accept each app's license terms.</p>
        </>
      ),
      warning: elevated && picked.some((a) => a.note?.includes("administrator")) ? picked.find((a) => a.note?.includes("administrator"))!.note : null,
      confirmLabel: picked.length === 1 ? "Install" : `Install ${picked.length} apps`,
    });
    if (!ok) return;
    enqueue("install", picked.map(toPackage));
    setSelected(new Set());
  }

  const openStore = () => appsApi.openAppInstaller().catch((e) => toast(errorText(e), "error"));

  return (
    <>
      <div className="apps-bar">
        {tabs}
        <span className="spacer" />
        {checking && (
          <span className="apps-hint" role="status" title="Checking which apps you already have…">
            <span className="spinner" /> <span className="apps-wide-only">Checking which apps you already have…</span>
          </span>
        )}
        <SearchBox value={query} onChange={setQuery} placeholder="Search the toolkit" />
      </div>

      {wingetMissing ? (
        <div className="note note-warn">
          <Store size={16} />
          <span>
            Installing needs the free App Installer from Microsoft (it includes Windows Package Manager). Get it from the Microsoft Store, then come
            back here.
          </span>
          <button className="btn btn-sm" onClick={openStore}>
            <Store size={14} /> Get App Installer
          </button>
        </div>
      ) : (
        jobs.length === 0 && (
          <div className="note note-info kit-intro">
            <Sparkles size={16} />
            <span>
              Setting up a new PC? Tick the apps you want and press <strong>Install</strong>. Each one comes straight from its publisher and installs
              by itself, one after another.
            </span>
          </div>
        )
      )}

      <QueuePanel action="install" jobs={jobs} onRetry={(list) => enqueue("install", list.map((j) => j.pkg))} />

      <div className="scroll kit-scroll">
        {groups.map(({ category, apps }) => {
          const look = CATEGORY_LOOK[category];
          const Icon = look.icon;
          return (
            <section key={category} className="kit-section" style={{ "--cat": look.color } as React.CSSProperties}>
              <h2 className="section-title">
                <span className="kit-section-icon">
                  <Icon size={14} />
                </span>
                {category} <span className="count">{apps.length}</span>
              </h2>
              <div className="kit-grid">
                {apps.map((a) => {
                  const job = jobFor(a);
                  const have = isInstalled(a);
                  const locked = have || wingetMissing || (!!job && isActive(job));
                  const checked = selected.has(a.id) && !locked;
                  return (
                    <label key={a.id} className={`kit-card ${checked ? "selected" : ""} ${locked ? "locked" : ""}`} title={a.note}>
                      <input
                        type="checkbox"
                        checked={checked || (!!job && isActive(job))}
                        disabled={locked}
                        onChange={() => toggle(a)}
                        aria-label={`Install ${a.name}`}
                      />
                      <AppAvatar name={a.name} size="md" />
                      <span className="kit-text">
                        <span className="kit-name">
                          <strong>{a.name}</strong>
                          {job && job.status !== "cancelled" ? (
                            <JobChip job={job} onShowDetails={() => setDetails(job)} />
                          ) : (
                            have && (
                              <span className="pill pill-sm pill-ok">
                                <CircleCheck size={12} /> Installed
                              </span>
                            )
                          )}
                        </span>
                        <span className="kit-desc">{a.description}</span>
                        {a.note && elevated && <span className="kit-note">{a.note}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          );
        })}
        {groups.length === 0 && (
          <EmptyState
            icon={SearchX}
            title={`Nothing in the toolkit matches “${query}”`}
            body="Try another word, like “browser”, “music” or “zip”."
            actions={
              <button className="btn" onClick={() => setQuery("")}>
                Clear search
              </button>
            }
          />
        )}
      </div>

      <div className={`kit-actionbar ${picked.length ? "has-picks" : ""}`}>
        <span className="kit-picks">
          {picked.length === 0 ? (
            <span className="muted">Tick the apps you want to install.</span>
          ) : (
            <>
              <strong>
                {picked.length} app{picked.length === 1 ? "" : "s"} selected
              </strong>
              <span className="muted truncate">{picked.map((a) => a.name).join(", ")}</span>
            </>
          )}
        </span>
        {picked.length > 0 && (
          <button className="btn btn-ghost" onClick={() => setSelected(new Set())}>
            <X size={16} /> Clear
          </button>
        )}
        <button className="btn btn-primary" onClick={install} disabled={picked.length === 0 || wingetMissing}>
          <Download size={16} /> {picked.length > 1 ? `Install ${picked.length} apps` : "Install"}
        </button>
      </div>
      {details && <JobDetails job={details} onClose={() => setDetails(null)} />}
    </>
  );
}
