import { Fragment } from "react";
import { Brush, CircleX, Gauge, HeartPulse, History, LayoutGrid, LucideIcon, Power, RefreshCw, ServerCog, Trash2, Undo2, Zap } from "lucide-react";
import { ActionRecord, ADMIN_SOURCES, api, errorText, Undo } from "../api";
import { useConfirm } from "../components/Confirm";
import { EmptyState, ErrorState } from "../components/EmptyState";
import { Menu } from "../components/Menu";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { dayLabel, relativeTime } from "../format";
import { useAsync } from "../hooks/useAsync";
import { useOnRefresh } from "../hooks/useRefresh";

/** Undoing an all-users startup change or a service change needs administrator rights. */
const needsAdmin = (undo: Undo) => (undo.type === "startupToggle" && ADMIN_SOURCES.includes(undo.source)) || undo.type === "serviceStartup";

const LOOKS: Record<string, { icon: LucideIcon; color: string }> = {
  startup: { icon: Power, color: "var(--cat-system)" },
  processes: { icon: CircleX, color: "var(--cat-repair)" },
  commands: { icon: Zap, color: "var(--cat-apps)" },
  cleanup: { icon: Brush, color: "var(--cat-cleanup)" },
  "pc health": { icon: HeartPulse, color: "var(--cat-repair)" },
  apps: { icon: LayoutGrid, color: "var(--cat-apps)" },
  services: { icon: ServerCog, color: "var(--cat-network)" },
};
const lookFor = (category: string) => LOOKS[category.toLowerCase()] ?? { icon: Gauge, color: "var(--text-2)" };

export function Activity({ elevated }: { elevated: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: records, error, loading, loaded, reload } = useAsync(api.activity, [] as ActionRecord[]);
  useOnRefresh(reload);

  async function undo(r: ActionRecord) {
    try {
      await api.undoActivity(r.id);
      toast(`Undone: ${r.description}`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      reload();
    }
  }

  async function clear() {
    // The log can't be restored afterwards, so this one still asks.
    const ok = await confirm({
      title: "Clear the activity history?",
      message: "Undo will no longer be possible for these changes. Nothing on your PC is changed back.",
      confirmLabel: "Clear history",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.clearActivity();
      toast("Activity history cleared", "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      reload();
    }
  }

  let lastDay = "";
  return (
    <div className="page page-fill">
      <PageHeader
        title="Activity"
        subtitle="Everything this app changed on your PC, newest first. Most changes can be undone."
        actions={
          <>
            <button className="btn" onClick={reload} disabled={loading}>
              <RefreshCw size={16} className={loading ? "spin" : undefined} /> Refresh
            </button>
            <Menu
              label="More options"
              items={[{ label: "Clear history…", icon: Trash2, onSelect: clear, danger: true, disabled: records.length === 0 }]}
            />
          </>
        }
      />
      <div className="table-wrap activity-list" role="list" aria-label="Activity">
        {error && records.length === 0 ? (
          <ErrorState what="the activity history" message={error} onRetry={reload} />
        ) : !loaded ? (
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="activity-row" aria-hidden="true">
              <Skeleton width={32} height={32} radius={8} />
              <div>
                <Skeleton width={`${50 + i * 7}%`} />
                <Skeleton width="30%" height={10} />
              </div>
              <Skeleton width={60} />
              <span />
            </div>
          ))
        ) : records.length === 0 ? (
          <EmptyState icon={History} title="Nothing here yet" body="When you turn off a startup app, end a process or run a fix, it shows up here so you can undo it." />
        ) : (
          records.map((r) => {
            const when = new Date(r.timestamp);
            const day = dayLabel(when);
            const header = day !== lastDay ? day : null;
            lastDay = day;
            const canUndo = r.undo != null && r.undo.type !== "unknown" && !r.undone;
            const blocked = canUndo && !elevated && needsAdmin(r.undo!);
            const look = lookFor(r.category);
            const Icon = look.icon;
            return (
              <Fragment key={r.id}>
                {header && (
                  <div className="activity-day" role="presentation">
                    {header}
                  </div>
                )}
                <div className="activity-row" role="listitem">
                  <span className="activity-icon" style={{ "--cat": look.color } as React.CSSProperties} title={r.category}>
                    <Icon size={16} />
                  </span>
                  <div className="activity-text">
                    <div>
                      <span className={r.undone ? "muted" : undefined}>{r.description}</span>
                      {r.undone && <span className="pill pill-sm">Undone</span>}
                    </div>
                    {r.detail && (
                      <div className="activity-detail" title={r.detail}>
                        {r.detail}
                      </div>
                    )}
                  </div>
                  <span className="activity-time" title={when.toLocaleString()}>
                    {relativeTime(when)}
                  </span>
                  <span>
                    {canUndo && (
                      <button
                        className="btn btn-sm"
                        onClick={() => undo(r)}
                        disabled={blocked}
                        title={blocked ? "Needs administrator: use Restart as administrator" : "Change this back"}
                      >
                        <Undo2 size={14} /> Undo
                      </button>
                    )}
                  </span>
                </div>
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}
