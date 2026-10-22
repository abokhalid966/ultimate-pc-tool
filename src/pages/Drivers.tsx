import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { api, DriverLink, DriverReport, errorText } from "../api";
import { EmptyState } from "../components/EmptyState";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { useOnRefresh } from "../hooks/useRefresh";
import "./drivers/drivers.css";

const WINDOWS_UPDATE = "ms-settings:windowsupdate-optionalupdates";
/** Read once per run; Refresh reads again. */
let cached: DriverReport | null = null;

const ageText = (days: number | null) => {
  if (days === null) return "";
  if (days < 60) return "New";
  if (days < 365) return `${Math.round(days / 30)} months old`;
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} old`;
};

export function Drivers() {
  const toast = useToast();
  const [report, setReport] = useState<DriverReport | null>(cached);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [show, setShow] = useState<"attention" | "all">("attention");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .drivers()
      .then((r) => {
        cached = r;
        setReport(r);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!cached) load();
  }, [load]);
  useOnRefresh(load);

  const open = (link: DriverLink) => api.openDriverLink(link.url).catch((e) => toast(errorText(e), "error"));
  const old = report?.drivers.filter((d) => d.old) ?? [];
  const rows = show === "all" ? report?.drivers ?? [] : old;
  const issues = (report?.problems.length ?? 0) + old.length;

  return (
    <div className="page">
      <PageHeader
        title="Drivers"
        subtitle="Find devices that aren't working and drivers that may be out of date, with the right place to get new ones."
        actions={
          <>
            <button className="btn" onClick={load} disabled={loading}>
              <RefreshCw size={16} className={loading ? "spin" : undefined} /> Check again
            </button>
            <button className="btn" onClick={() => open({ label: "Windows Update", url: WINDOWS_UPDATE })} title="Optional updates often include drivers">
              <ExternalLink size={16} /> Windows Update
            </button>
          </>
        }
      />
      {error && !report ? (
        <div className="card">
          <EmptyState icon={CircleAlert} tone="danger" title="Couldn't read your drivers" body={error} actions={<button className="btn" onClick={load}>Try again</button>} />
        </div>
      ) : !report ? (
        <section className="card">
          <p className="muted small" style={{ marginTop: 0 }}>
            Checking your devices and drivers. This takes a few seconds.
          </p>
          <Skeleton height={14} />
          <Skeleton height={14} width="60%" style={{ marginTop: 10 }} />
        </section>
      ) : (
        <>
          <section className="card drv-summary">
            {issues === 0 ? <CircleCheck size={24} className="text-ok" /> : <TriangleAlert size={24} className="text-warn" />}
            <div>
              <strong>
                {issues === 0
                  ? "Your drivers look fine"
                  : [
                      report.problems.length > 0 && `${report.problems.length} ${report.problems.length === 1 ? "device needs" : "devices need"} attention`,
                      old.length > 0 && `${old.length} ${old.length === 1 ? "driver" : "drivers"} may be out of date`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
              </strong>
              <p className="muted small">
                Checked {report.drivers.length} drivers from device makers. Windows keeps its own drivers up to date through Windows Update.
              </p>
            </div>
            {report.makerLink && (
              <button className="btn" onClick={() => open(report.makerLink!)} title={`Driver downloads for ${report.maker}`}>
                <ExternalLink size={16} /> {report.makerLink.label}
              </button>
            )}
          </section>

          {report.problems.length > 0 && (
            <section className="card">
              <h3 className="drv-h">Devices that need attention</h3>
              <ul className="drv-problems">
                {report.problems.map((p, i) => (
                  <li key={i}>
                    <CircleAlert size={16} className="text-danger" />
                    <div>
                      <strong>{p.name || "Unknown device"}</strong>
                      <span className="muted small">
                        {p.message} · {p.category}
                      </span>
                    </div>
                    <button className="btn btn-sm" onClick={() => open(p.download)}>
                      <ExternalLink size={14} /> {p.download.label}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <div className="drv-table-head">
              <h3 className="drv-h">{show === "all" ? "All drivers" : "Drivers that may be out of date"}</h3>
              <Segmented
                label="Show"
                value={show}
                onChange={setShow}
                options={[
                  { value: "attention", label: `Out of date (${old.length})` },
                  { value: "all", label: `All (${report.drivers.length})` },
                ]}
              />
            </div>
            {rows.length === 0 ? (
              <p className="muted small">No old drivers found. Optional driver updates may still show up in Windows Update.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Type</th>
                    <th>Version</th>
                    <th>Date</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d, i) => (
                    <tr key={`${d.name}-${i}`}>
                      <td>
                        {d.name}
                        <div className="muted small">{d.provider}</div>
                      </td>
                      <td>{d.category}</td>
                      <td className="drv-version">{d.version}</td>
                      <td>
                        {d.date || "Unknown"}
                        {d.ageDays !== null && <div className={`small ${d.old ? "text-warn" : "muted"}`}>{ageText(d.ageDays)}</div>}
                      </td>
                      <td className="drv-action">
                        <button className={`btn btn-sm ${d.old ? "" : "btn-ghost"}`} onClick={() => open(d.download)} title={`Open ${d.download.label}`}>
                          <ExternalLink size={14} /> {d.old ? "Get update" : "Download page"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted small drv-note">
              "Out of date" means the driver is older than about 9 months for graphics cards or 3 years for other parts. Get drivers only from the
              links here or from Windows Update, never from "driver updater" sites.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
