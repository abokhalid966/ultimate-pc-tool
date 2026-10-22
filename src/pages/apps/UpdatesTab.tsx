import { ReactNode, useMemo, useState } from "react";
import { ArrowRight, CircleCheck, Download, Pin, RefreshCw } from "lucide-react";
import { AppUpgrade, WingetPackage } from "../../api";
import { useConfirm } from "../../components/Confirm";
import { EmptyState, ErrorState } from "../../components/EmptyState";
import { Skeleton } from "../../components/Skeleton";
import { useOnRefresh } from "../../hooks/useRefresh";
import { AppAvatar, JobChip, WingetMissing } from "./common";
import { upgradeList } from "./data";
import { JobDetails, QueuePanel } from "./QueuePanel";
import { enqueue, isActive, Job, jobKey, useQueue } from "./queue";

const toPackage = (u: AppUpgrade): WingetPackage => ({ id: u.id, name: u.name, source: u.source, partialId: u.partialId, version: u.available });
const sourceLabel = (s: string | null) => (s === "msstore" ? "Microsoft Store" : s === "winget" ? "winget" : (s ?? ""));

export function UpdatesTab({ tabs }: { tabs: ReactNode }) {
  const confirm = useConfirm();
  const { data, error, loading } = upgradeList.use();
  const queue = useQueue();
  const [details, setDetails] = useState<Job | null>(null);
  useOnRefresh(() => void upgradeList.reload());

  const jobs = useMemo(() => queue.filter((j) => j.action === "upgrade"), [queue]);
  const jobFor = (u: AppUpgrade) => jobs.find((j) => j.key === jobKey("upgrade", u.id));
  const upgrades = data?.upgrades ?? [];
  const updated = (u: AppUpgrade) => jobFor(u)?.status === "done";
  const remaining = upgrades.filter((u) => !updated(u));
  const forAll = remaining.filter((u) => !u.explicit && !(jobFor(u) && isActive(jobFor(u)!)));
  const busy = jobs.some(isActive);

  async function updateAll() {
    const ok = await confirm({
      title: `Update ${forAll.length} app${forAll.length === 1 ? "" : "s"}?`,
      message: (
        <>
          <p>They're updated one after another, straight from each publisher. Apps being updated may close for a moment, so save your work in them first.</p>
          <ul className="apps-confirm-list">
            {forAll.slice(0, 8).map((u) => (
              <li key={u.id}>
                {u.name} <span className="muted">to {u.available}</span>
              </li>
            ))}
            {forAll.length > 8 && <li className="muted">and {forAll.length - 8} more</li>}
          </ul>
          <p className="muted small">Some updates may ask for permission. By updating, you accept each app's license terms.</p>
        </>
      ),
      confirmLabel: "Update all",
    });
    if (ok) enqueue("upgrade", forAll.map(toPackage));
  }

  const update = (u: AppUpgrade) => enqueue("upgrade", [toPackage(u)]);

  const checking = loading && !data;
  const intro =
    data && !data.wingetMissing && upgrades.length > 0
      ? `${remaining.length === 0 ? "Everything is up to date now" : `${remaining.length} update${remaining.length === 1 ? "" : "s"} available`}. Updates come straight from each app's publisher through Windows Package Manager.`
      : null;

  return (
    <>
      <div className="apps-bar">
        {tabs}
        <span className="spacer" />
        <button
          className="btn"
          onClick={() => upgradeList.reload()}
          disabled={loading || busy}
          title={busy ? "Wait for the updates to finish" : "Ask winget again"}
          aria-label={loading ? "Checking for updates" : "Check again"}
        >
          <RefreshCw size={16} className={loading ? "spin" : undefined} /> <span className="apps-wide-only">{loading ? "Checking…" : "Check again"}</span>
        </button>
        {data && !data.wingetMissing && upgrades.length > 0 && (
          <button className="btn btn-primary" onClick={updateAll} disabled={forAll.length === 0}>
            <Download size={16} /> {forAll.length > 0 ? `Update all (${forAll.length})` : "Update all"}
          </button>
        )}
      </div>

      <QueuePanel action="upgrade" jobs={jobs} onRetry={(list) => enqueue("upgrade", list.map((j) => j.pkg))} />

      {data?.wingetMissing ? (
        <div className="card apps-state-card">
          <WingetMissing what="App updates" onRetry={() => upgradeList.reload()} />
        </div>
      ) : error && !data ? (
        <div className="card apps-state-card">
          <ErrorState what="app updates" message={error} onRetry={() => upgradeList.reload()} />
        </div>
      ) : data && upgrades.length === 0 ? (
        <div className="card apps-state-card">
          <EmptyState
            icon={CircleCheck}
            title="All your apps are up to date"
            body="Windows Package Manager found no updates for the apps it knows. Apps from elsewhere, like games in their own launchers, update themselves."
            actions={
              <button className="btn" onClick={() => upgradeList.reload()} disabled={loading}>
                <RefreshCw size={16} className={loading ? "spin" : undefined} /> Check again
              </button>
            }
          />
        </div>
      ) : (
        <div className="table-wrap apps-table-wrap">
          {intro && <div className="apps-table-intro">{intro}</div>}
          {checking && (
            <div className="apps-checking" role="status">
              <span className="spinner" /> Checking for updates… This can take up to a minute the first time.
            </div>
          )}
          <table className="table table-fixed apps-table" aria-label="App updates">
            <thead>
              <tr>
                <th>App</th>
                <th className="apps-col-version">Version</th>
                <th className="apps-col-source">From</th>
                <th className="apps-col-actions">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {checking &&
                Array.from({ length: 5 }, (_, i) => (
                  <tr key={i} aria-hidden="true">
                    <td>
                      <span className="name-flex">
                        <Skeleton width={24} height={24} radius={6} />
                        <span style={{ flex: 1 }}>
                          <Skeleton width={`${30 + ((i * 17) % 35)}%`} />
                          <Skeleton width="25%" height={10} style={{ marginTop: 5 }} />
                        </span>
                      </span>
                    </td>
                    <td className="apps-col-version">
                      <Skeleton width="70%" />
                    </td>
                    <td className="apps-col-source">
                      <Skeleton width={50} />
                    </td>
                    <td className="apps-col-actions">
                      <Skeleton width={76} height={26} radius={6} style={{ marginLeft: "auto" }} />
                    </td>
                  </tr>
                ))}
              {upgrades.map((u) => {
                const job = jobFor(u);
                const showButton = !job || job.status === "failed" || job.status === "cancelled";
                return (
                  <tr key={u.id} className={job?.status === "done" ? "off" : undefined}>
                    <td>
                      <span className="name-flex">
                        <AppAvatar name={u.name} />
                        <span className="apps-name">
                          <span className="apps-name-line">
                            <strong className="truncate" title={u.name}>
                              {u.name}
                            </strong>
                            {u.explicit && (
                              <span className="pill pill-sm pill-outline" title="winget only updates this app when it's picked on its own (it's pinned, or its publisher asks for that), so Update all skips it.">
                                <Pin size={11} /> Update on its own
                              </span>
                            )}
                          </span>
                          <span className="apps-meta truncate mono" title={u.id}>
                            {u.id}
                            {u.partialId && "…"}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="apps-col-version">
                      <span className="apps-version">
                        <span className="truncate" title={u.version}>
                          {u.version}
                        </span>
                        <ArrowRight size={13} className="subtle" aria-label="to" />
                        <strong className="truncate" title={u.available}>
                          {u.available}
                        </strong>
                      </span>
                    </td>
                    <td className="apps-col-source">
                      <span className="muted small">{sourceLabel(u.source)}</span>
                    </td>
                    <td className="apps-col-actions">
                      <span className="apps-actions">
                        {job && job.status !== "cancelled" && <JobChip job={job} onShowDetails={() => setDetails(job)} />}
                        {showButton && (
                          <button className="btn btn-sm" onClick={() => update(u)} aria-label={`Update ${u.name}`}>
                            <Download size={14} /> {job?.status === "failed" ? "Retry" : "Update"}
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {details && <JobDetails job={details} onClose={() => setDetails(null)} />}
    </>
  );
}
