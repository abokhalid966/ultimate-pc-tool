import { useEffect } from "react";
import {
  Bug,
  CircleAlert,
  CircleCheck,
  Download,
  FileClock,
  FileWarning,
  FolderClock,
  Globe,
  HardDrive,
  Images,
  Info,
  LucideIcon,
  RefreshCw,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { CleanupCategory, CleanupKind, CleanupResult, DiskInfo } from "../../api";
import { useConfirm } from "../../components/Confirm";
import { ErrorState } from "../../components/EmptyState";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { bytes, driveLabel } from "../../format";
import { useOnRefresh } from "../../hooks/useRefresh";
import { cleanable, dismissCleanupSummary, measureCleanup, runCleanup, setAllCategories, toggleCategory, useStorageState } from "./state";

const LOOK: Record<CleanupKind, { icon: LucideIcon; color: string }> = {
  userTemp: { icon: FileClock, color: "var(--cat-cleanup)" },
  windowsTemp: { icon: FolderClock, color: "var(--cat-cleanup)" },
  thumbnails: { icon: Images, color: "var(--cat-apps)" },
  recycleBin: { icon: Trash2, color: "var(--cat-repair)" },
  edge: { icon: Globe, color: "var(--cat-network)" },
  chrome: { icon: Globe, color: "var(--cat-network)" },
  brave: { icon: Globe, color: "var(--cat-network)" },
  firefox: { icon: Globe, color: "var(--cat-network)" },
  errorReports: { icon: FileWarning, color: "var(--cat-system)" },
  systemErrorReports: { icon: Bug, color: "var(--cat-system)" },
  deliveryOptimization: { icon: Share2, color: "var(--cat-system)" },
  windowsUpdate: { icon: Download, color: "var(--cat-system)" },
};

/** Same order as the backend, so rows never jump around while sizes stream in. */
const ORDER = Object.keys(LOOK) as CleanupKind[];

const GROUPS: { id: CleanupCategory["group"]; title: string; hint?: string }[] = [
  { id: "files", title: "Temporary files" },
  { id: "browsers", title: "Web browsers", hint: "Only caches: you stay signed in to your websites" },
  { id: "windows", title: "Windows" },
];

const BROWSER_SHORT: Partial<Record<CleanupKind, string>> = { edge: "Edge", chrome: "Chrome", brave: "Brave", firefox: "Firefox" };

interface Props {
  elevated: boolean;
  onRestartAsAdmin: () => void;
  disks: DiskInfo[];
}

export function CleanupTab({ elevated, onRestartAsAdmin, disks }: Props) {
  const { cleanup } = useStorageState();
  const toast = useToast();
  const confirm = useConfirm();
  const { categories, measuring, cleaning, summary } = cleanup;

  useEffect(() => {
    if (!cleanup.measuredOnce || cleanup.stale) measureCleanup();
    // Only when the tab opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useOnRefresh(() => {
    if (!cleaning) measureCleanup();
  });

  const sorted = [...categories].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const selected = sorted.filter((c) => cleanup.selected.includes(c.kind) && cleanable(c));
  const selectedBytes = selected.reduce((s, c) => s + c.bytes, 0);
  const freeable = sorted.filter(cleanable).reduce((s, c) => s + c.bytes, 0);
  const adminLocked = elevated ? [] : sorted.filter((c) => c.needsAdmin);
  const adminBytes = adminLocked.reduce((s, c) => s + c.bytes, 0);
  const systemDisk = disks.find((d) => /^c:/i.test(d.mount)) ?? disks[0];
  const busy = cleaning !== null;
  const firstLoad = categories.length === 0 && (measuring || !cleanup.measuredOnce);

  async function clean() {
    if (selected.length === 0) return;
    const names = selected.map((c) => c.label);
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    const ok = await confirm({
      title: selected.length === 1 ? `Clean ${selected[0].label}?` : `Clean ${selected.length} items?`,
      message: (
        <>
          About <strong>{bytes(selectedBytes)}</strong> will be removed from {list}. Files that are in use, and temporary files from the last day, are
          kept.
        </>
      ),
      warning: selected.some((c) => c.kind === "recycleBin") ? "Emptying the Recycle Bin can't be undone. The files in it are deleted for good." : null,
      confirmLabel: `Free ${bytes(selectedBytes)}`,
    });
    if (!ok) return;
    try {
      const s = await runCleanup();
      const failed = s.results.filter((r) => r.error);
      if (s.bytes > 0 || s.files > 0) {
        toast(`Freed ${bytes(s.bytes)}.${failed.length ? ` ${failed.length} could not be cleaned: see the list.` : ""}`, failed.length ? "error" : "success");
      } else if (failed.length) {
        toast(failed[0].error!, "error");
      } else {
        toast("Nothing needed cleaning. Files in use and recent temporary files were kept.", "info");
      }
    } catch (e) {
      toast(String(e), "error");
    }
  }

  const results = new Map<CleanupKind, CleanupResult>((cleaning?.results ?? summary?.results ?? []).map((r) => [r.kind, r]));

  return (
    <div className="storage-tab">
      <section className="card clean-hero" aria-live="polite">
        <div className="clean-hero-main">
          <span className={`clean-hero-icon ${summary ? "done" : ""}`} aria-hidden="true">
            {summary ? <CircleCheck size={24} /> : <Sparkles size={24} />}
          </span>
          <div className="clean-hero-text">
            {cleaning ? (
              <CleaningStatus categories={sorted} cleaning={cleaning} />
            ) : summary ? (
              <>
                <h2>Freed {bytes(summary.bytes)}</h2>
                <p>
                  {summary.files.toLocaleString()} {summary.files === 1 ? "file was" : "files were"} removed.
                  {summary.skipped > 0 && ` ${summary.skipped.toLocaleString()} in use or from the last day ${summary.skipped === 1 ? "was" : "were"} kept.`}
                </p>
              </>
            ) : firstLoad ? (
              <>
                <h2>Checking what can be cleaned…</h2>
                <p>This only looks. Nothing is deleted until you choose.</p>
              </>
            ) : cleanup.error ? (
              <>
                <h2>Couldn't check this PC</h2>
                <p>{cleanup.error}</p>
              </>
            ) : freeable > 0 ? (
              <>
                <h2>
                  <span className="num-text">{bytes(freeable)}</span> can be freed
                </h2>
                <p>{selected.length > 0 ? `${bytes(selectedBytes)} selected in ${selected.length} ${selected.length === 1 ? "item" : "items"}` : "Tick what you'd like to clean below."}</p>
              </>
            ) : (
              <>
                <h2>Nothing to clean right now</h2>
                <p>{adminBytes > 0 ? "Windows' own folders can be cleaned as administrator." : "Temporary files and caches are already tidy."}</p>
              </>
            )}
            {(firstLoad || (measuring && !cleaning)) && <div className="progress clean-hero-progress" aria-label="Checking" />}
          </div>
          {systemDisk && <DriveMeter disk={systemDisk} />}
        </div>
        <div className="clean-hero-actions">
          <span className="clean-hero-links">
            <button className="btn-link" onClick={() => setAllCategories(true)} disabled={busy || firstLoad}>
              Select all
            </button>
            <span aria-hidden="true">·</span>
            <button className="btn-link" onClick={() => setAllCategories(false)} disabled={busy || firstLoad || selected.length === 0}>
              Clear
            </button>
          </span>
          <span className="spacer" />
          {summary ? (
            <button
              className="btn"
              onClick={() => {
                dismissCleanupSummary();
                measureCleanup();
              }}
            >
              <RefreshCw size={16} /> Check again
            </button>
          ) : (
            <button className="btn" onClick={() => measureCleanup()} disabled={busy || measuring} title="Measure everything again">
              <RefreshCw size={16} className={measuring ? "spin" : undefined} /> Check again
            </button>
          )}
          <button className="btn btn-primary" onClick={clean} disabled={busy || measuring || selected.length === 0}>
            {busy ? <span className="spinner" /> : <Sparkles size={16} />}
            {busy ? "Cleaning…" : selected.length ? `Clean selected (${bytes(selectedBytes)})` : "Clean selected"}
          </button>
        </div>
      </section>

      {adminLocked.length > 0 && (
        <div className="note note-info">
          <ShieldAlert size={16} />
          <span>
            {adminBytes > 0 ? `About ${bytes(adminBytes)} more` : "More space"} can be freed in Windows' own folders, which only an administrator can clean.
          </span>
          <button className="btn btn-sm" onClick={onRestartAsAdmin}>
            <ShieldCheck size={14} /> Restart as administrator
          </button>
        </div>
      )}

      {cleanup.error && categories.length === 0 ? (
        <div className="card">
          <ErrorState what="the cleanup list" message={cleanup.error} onRetry={() => measureCleanup()} />
        </div>
      ) : (
        GROUPS.map((g) => {
          const rows = sorted.filter((c) => c.group === g.id);
          if (rows.length === 0 && !firstLoad) return null;
          return (
            <section key={g.id} className="clean-group" aria-label={g.title}>
              <h3 className="section-title">
                {g.title}
                {g.hint && <span className="count">{g.hint}</span>}
              </h3>
              <div className="card fix-list">
                {rows.length === 0
                  ? Array.from({ length: g.id === "browsers" ? 1 : 2 }, (_, i) => <SkeletonRow key={i} />)
                  : rows.map((c) => (
                      <CategoryRow
                        key={c.kind}
                        c={c}
                        checked={cleanup.selected.includes(c.kind) && cleanable(c)}
                        disabled={busy || !cleanable(c)}
                        state={cleaning ? (cleaning.current === c.kind ? "cleaning" : results.has(c.kind) ? "done" : selected.includes(c) ? "waiting" : null) : results.has(c.kind) ? "done" : null}
                        result={results.get(c.kind)}
                        elevated={elevated}
                      />
                    ))}
              </div>
            </section>
          );
        })
      )}

      <p className="storage-foot">
        <Info size={14} />
        Cleanup only removes files that Windows and your apps make again when needed. They don't go to the Recycle Bin.
      </p>
    </div>
  );
}

function CleaningStatus({ categories, cleaning }: { categories: CleanupCategory[]; cleaning: NonNullable<ReturnType<typeof useStorageState>["cleanup"]["cleaning"]> }) {
  const current = categories.find((c) => c.kind === cleaning.current);
  const freed = cleaning.results.reduce((s, r) => s + r.bytes, 0);
  const pct = cleaning.plannedBytes > 0 ? Math.min(100, (freed / cleaning.plannedBytes) * 100) : 0;
  return (
    <>
      <h2>{current ? `Cleaning ${current.label}…` : "Cleaning…"}</h2>
      <p>{bytes(freed)} freed so far</p>
      <div className="bar clean-hero-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Cleaning">
        <span className="bar-fill ok" style={{ width: `${Math.max(pct, 3)}%`, display: "block" }} />
      </div>
    </>
  );
}

function DriveMeter({ disk }: { disk: DiskInfo }) {
  const used = disk.totalBytes - disk.availableBytes;
  const usedPct = disk.totalBytes ? (used / disk.totalBytes) * 100 : 0;
  const tone = usedPct >= 90 ? "danger" : usedPct >= 80 ? "warn" : "ok";
  return (
    <div className="clean-drive">
      <div className="clean-drive-head">
        <HardDrive size={15} />
        <strong className="truncate">{driveLabel(disk)}</strong>
      </div>
      <div className="bar" role="meter" aria-valuenow={Math.round(usedPct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${driveLabel(disk)} used`}>
        <span className={`bar-fill ${tone}`} style={{ width: `${usedPct}%`, display: "block" }} />
      </div>
      <span className="muted small">
        {bytes(disk.availableBytes)} free of {bytes(disk.totalBytes)}
      </span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="clean-row" aria-hidden="true">
      <Skeleton width={16} height={16} radius={4} />
      <Skeleton width={36} height={36} radius={8} />
      <span>
        <Skeleton width="38%" height={14} />
        <Skeleton width="72%" height={11} style={{ marginTop: 8 }} />
      </span>
      <Skeleton width={64} height={14} />
    </div>
  );
}

interface RowProps {
  c: CleanupCategory;
  checked: boolean;
  disabled: boolean;
  state: "waiting" | "cleaning" | "done" | null;
  result?: CleanupResult;
  elevated: boolean;
}

function CategoryRow({ c, checked, disabled, state, result, elevated }: RowProps) {
  const look = LOOK[c.kind];
  const Icon = look.icon;
  const browser = BROWSER_SHORT[c.kind];
  const browserOpen = browser && c.blocked && !c.needsAdmin;
  const empty = !c.unmeasured && c.bytes === 0 && !result;
  const locations = c.locations.join("\n");
  return (
    <label className={`clean-row ${disabled && !state ? "disabled" : ""} ${empty ? "empty" : ""} ${state === "cleaning" ? "running" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => toggleCategory(c.kind, e.target.checked)} aria-describedby={`clean-desc-${c.kind}`} />
      <span className="cmd-icon" style={{ "--cat": look.color } as React.CSSProperties} aria-hidden="true">
        <Icon size={18} />
      </span>
      <span className="clean-text">
        <span className="fix-name">
          <strong>{c.label}</strong>
          {c.needsAdmin && (
            <span className={`pill pill-sm ${elevated ? "pill-outline" : "pill-warn"}`} title={elevated ? "Needs administrator rights: you have them" : (c.blocked ?? undefined)}>
              <ShieldAlert size={12} /> Admin
            </span>
          )}
          {browserOpen && (
            <span className="pill pill-sm pill-warn" title={c.blocked ?? undefined}>
              Close {browser} first
            </span>
          )}
        </span>
        <span className="fix-desc" id={`clean-desc-${c.kind}`}>
          {browserOpen ? c.blocked : c.description}
        </span>
        {c.locations.length > 0 && (
          <span className="clean-where truncate" title={locations}>
            {c.locations[0]}
            {c.locations.length > 1 && ` and ${c.locations.length - 1} more`}
          </span>
        )}
      </span>
      <span className="clean-size">
        {state === "cleaning" ? (
          <span className="clean-state">
            <span className="spinner" /> Cleaning
          </span>
        ) : state === "waiting" ? (
          <span className="muted small">Waiting</span>
        ) : result ? (
          result.error ? (
            <span className="pill pill-danger" title={result.error}>
              <CircleAlert size={13} /> Not cleaned
            </span>
          ) : (
            <>
              <span className="pill pill-ok">
                <CircleCheck size={13} /> {result.bytes > 0 ? `Freed ${bytes(result.bytes)}` : "Done"}
              </span>
              {result.skipped > 0 && <span className="muted small">{result.skipped.toLocaleString()} kept</span>}
            </>
          )
        ) : c.unmeasured ? (
          <>
            <strong>—</strong>
            <span className="muted small" title="Windows only lets an administrator look inside these folders.">
              Size unknown
            </span>
          </>
        ) : c.bytes === 0 ? (
          <span className="muted small">Nothing to clean</span>
        ) : (
          <>
            <strong className="num-text">{bytes(c.bytes)}</strong>
            <span className="muted small">
              {c.files.toLocaleString()} {c.kind === "recycleBin" ? (c.files === 1 ? "item" : "items") : c.files === 1 ? "file" : "files"}
            </span>
          </>
        )}
      </span>
    </label>
  );
}
