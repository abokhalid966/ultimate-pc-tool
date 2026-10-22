import { useMemo, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  Disc,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Files,
  Folder,
  FolderOpen,
  FolderSearch,
  HardDrive,
  History,
  Info,
  Lock,
  LucideIcon,
  Package,
  RefreshCw,
  ShieldCheck,
  Square,
  Trash2,
  TriangleAlert,
  Usb,
} from "lucide-react";
import { api, DeleteTarget, DiskInfo, errorText, FileEntry, FolderEntry, FolderView } from "../../api";
import { useConfirm } from "../../components/Confirm";
import { EmptyState } from "../../components/EmptyState";
import { Menu, MenuEntry } from "../../components/Menu";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { bytes, clock, driveLabel, mountLabel } from "../../format";
import { useOnRefresh } from "../../hooks/useRefresh";
import {
  chooseAnother,
  FinderState,
  invalidateCleanup,
  markStale,
  openFolder,
  refreshView,
  ScanTarget,
  showLastResults,
  startScan,
  stopScan,
  useStorageState,
} from "./state";
import { Treemap, TreemapItem } from "./Treemap";

/** Biggest folders drawn in the map; the rest are summed into one tile. */
const MAP_TILES = 24;
const FILES_SHOWN = 12;

export function SpaceFinder({ disks }: { disks: DiskInfo[] }) {
  const { finder } = useStorageState();
  if (finder.phase === "scanning") return <Scanning finder={finder} />;
  if (finder.phase === "results" && finder.summary && finder.view) return <Results finder={finder} view={finder.view} />;
  return <ChooseTarget finder={finder} disks={disks} />;
}

const driveTarget = (d: DiskInfo): ScanTarget => ({ path: d.mount, label: driveLabel(d), usedBytes: Math.max(0, d.totalBytes - d.availableBytes) });

// ---- Choose a drive or folder ----

function ChooseTarget({ finder, disks }: { finder: FinderState; disks: DiskInfo[] }) {
  const toast = useToast();
  const sorted = [...disks].sort((a, b) => a.mount.localeCompare(b.mount));

  async function pickFolder() {
    try {
      const path = await api.pickFolder();
      if (!path) return;
      const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
      startScan({ path, label: name, usedBytes: null });
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  return (
    <div className="storage-tab">
      {finder.error && (
        <div className="note note-danger" role="alert">
          <TriangleAlert size={16} />
          <span>{finder.error}</span>
        </div>
      )}
      {finder.summary && (
        <div className="note note-info">
          <History size={16} />
          <span>Your last scan of {finder.target?.label ?? finder.summary.root} is still here.</span>
          <button className="btn btn-sm" onClick={showLastResults}>
            Show results
          </button>
        </div>
      )}

      <section>
        <h3 className="section-title">Choose what to scan</h3>
        <div className="finder-targets">
          {sorted.length === 0
            ? Array.from({ length: 2 }, (_, i) => (
                <div key={i} className="card finder-target" aria-hidden="true">
                  <Skeleton width={40} height={40} radius={8} />
                  <span style={{ flex: 1 }}>
                    <Skeleton width="55%" height={14} />
                    <Skeleton width="100%" height={6} style={{ marginTop: 12 }} />
                    <Skeleton width="40%" height={11} style={{ marginTop: 10 }} />
                  </span>
                </div>
              ))
            : sorted.map((d) => {
                const usedPct = d.totalBytes ? ((d.totalBytes - d.availableBytes) / d.totalBytes) * 100 : 0;
                const tone = usedPct >= 90 ? "danger" : usedPct >= 80 ? "warn" : "ok";
                const Icon = d.removable ? Usb : HardDrive;
                return (
                  <button key={d.mount} className="card finder-target" onClick={() => startScan(driveTarget(d))}>
                    <span className="finder-target-icon">
                      <Icon size={20} />
                    </span>
                    <span className="finder-target-text">
                      <span className="finder-target-name">
                        <strong className="truncate">{driveLabel(d)}</strong>
                        <span className="finder-go">
                          Scan <ChevronRight size={14} />
                        </span>
                      </span>
                      <span className="bar" role="meter" aria-valuenow={Math.round(usedPct)} aria-valuemin={0} aria-valuemax={100} aria-label={`${driveLabel(d)} used`}>
                        <span className={`bar-fill ${tone}`} style={{ width: `${usedPct}%`, display: "block" }} />
                      </span>
                      <span className="muted small">
                        {bytes(d.totalBytes - d.availableBytes)} used · {bytes(d.availableBytes)} free of {bytes(d.totalBytes)}
                      </span>
                    </span>
                  </button>
                );
              })}
          <button className="card finder-target finder-folder" onClick={pickFolder}>
            <span className="finder-target-icon">
              <FolderSearch size={20} />
            </span>
            <span className="finder-target-text">
              <span className="finder-target-name">
                <strong>A folder</strong>
                <span className="finder-go">
                  Choose <ChevronRight size={14} />
                </span>
              </span>
              <span className="muted small">Pick any folder, like Downloads or Videos, for a quicker scan.</span>
            </span>
          </button>
        </div>
      </section>

      <p className="storage-foot">
        <ShieldCheck size={14} />
        Scanning only reads sizes. Nothing changes unless you choose to delete something, and deleted items go to the Recycle Bin.
      </p>
    </div>
  );
}

// ---- Scanning ----

function Scanning({ finder }: { finder: FinderState }) {
  const p = finder.progress;
  const used = finder.target?.usedBytes ?? null;
  const pct = used && p ? Math.min(99, (p.bytes / used) * 100) : null;
  const [now, setNow] = useState(Date.now());
  useMemo(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="storage-tab">
      <section className="card scan-card" aria-live="polite" aria-busy="true">
        <div className="scan-head">
          <span className="scan-icon" aria-hidden="true">
            <FolderSearch size={22} />
          </span>
          <div className="scan-title">
            <h2>{finder.stopping ? "Stopping…" : `Scanning ${finder.target?.label ?? "folder"}…`}</h2>
            <p>A big drive can take a minute or two. You can keep using the app meanwhile.</p>
          </div>
          <button className="btn" onClick={stopScan} disabled={finder.stopping}>
            <Square size={14} /> Stop
          </button>
        </div>
        {pct === null ? (
          <div className="progress" aria-label="Scanning" />
        ) : (
          <div className="bar scan-bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Scanned">
            <span className="bar-fill ok" style={{ width: `${Math.max(pct, 2)}%`, display: "block" }} />
          </div>
        )}
        <dl className="scan-stats">
          <div>
            <dt>Found</dt>
            <dd className="num-text">{bytes(p?.bytes ?? 0)}</dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd className="num-text">{(p?.files ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Folders</dt>
            <dd className="num-text">{(p?.folders ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Time</dt>
            <dd className="num-text">{clock(now - finder.startedAt)}</dd>
          </div>
        </dl>
        <div className="scan-current truncate" title={p?.current}>
          {p?.current ?? finder.target?.path}
        </div>
      </section>
    </div>
  );
}

// ---- Results ----

const VIDEO = /\.(mp4|mkv|avi|mov|wmv|webm|m4v|flv|mpg|mpeg|ts)$/i;
const IMAGE = /\.(jpe?g|png|gif|bmp|webp|heic|tiff?|raw|cr2|nef|psd)$/i;
const AUDIO = /\.(mp3|wav|flac|aac|m4a|ogg|wma)$/i;
const ARCHIVE = /\.(zip|rar|7z|tar|gz|bz2|xz|cab)$/i;
const DISK = /\.(iso|img|vhdx?|vmdk|vdi|wim|esd)$/i;
const SETUP = /\.(exe|msi|msix|appx|msixbundle)$/i;
const TEXT = /\.(txt|log|pdf|docx?|xlsx?|pptx?|csv|json|xml)$/i;

function fileIcon(name: string): LucideIcon {
  if (VIDEO.test(name)) return FileVideo;
  if (IMAGE.test(name)) return FileImage;
  if (AUDIO.test(name)) return FileAudio;
  if (ARCHIVE.test(name)) return FileArchive;
  if (DISK.test(name)) return Disc;
  if (SETUP.test(name)) return Package;
  if (TEXT.test(name)) return FileText;
  return File;
}

const share = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const pctText = (p: number) => (p >= 10 || p === 0 ? `${Math.round(p)}%` : p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`);

function Results({ finder, view }: { finder: FinderState; view: FolderView }) {
  const toast = useToast();
  const confirm = useConfirm();
  const summary = finder.summary!;
  const [busy, setBusy] = useState<string | null>(null);
  const [allFiles, setAllFiles] = useState(false);
  const atRoot = view.crumbs.length <= 1;
  useOnRefresh(() => finder.target && startScan(finder.target));

  const open = (node: number) => openFolder(node).catch((e) => toast(String(e), "error"));
  const reveal = (path: string) => api.revealInExplorer(path).catch((e) => toast(errorText(e), "error"));

  async function remove(target: DeleteTarget, key: string) {
    const scanId = finder.scanId!;
    let check;
    try {
      check = await api.checkStorageDelete(scanId, target);
    } catch (e) {
      toast(errorText(e), "error");
      return;
    }
    if (check.blocked) {
      toast(`“${check.name}” can't be deleted here. ${check.blocked}`, "error");
      return;
    }
    const ok = await confirm({
      title: `Move “${check.name}” to the Recycle Bin?`,
      message: (
        <>
          {check.isFolder ? (
            <>
              This folder holds <strong>{bytes(check.bytes)}</strong> in {check.files.toLocaleString()} {check.files === 1 ? "file" : "files"}.
            </>
          ) : (
            <>
              This file is <strong>{bytes(check.bytes)}</strong>.
            </>
          )}{" "}
          You can put it back from the Recycle Bin, or with Undo.
        </>
      ),
      warning: check.warning,
      code: check.path,
      confirmLabel: "Move to Recycle Bin",
      danger: true,
    });
    if (!ok) return;
    setBusy(key);
    try {
      const r = await api.storageDelete(scanId, target);
      invalidateCleanup();
      await refreshView();
      toast(`Moved “${check.name}” to the Recycle Bin. Empty the Recycle Bin on the Cleanup tab to free ${bytes(r.bytes)}.`, "success", {
        action: r.activityId ? { label: "Undo", run: () => undo(r.activityId!, check.name) } : undefined,
      });
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(null);
    }
  }

  async function undo(activityId: string, name: string) {
    try {
      await api.undoActivity(activityId);
      markStale();
      invalidateCleanup();
      toast(`“${name}” is back where it was.`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    }
  }

  const mapItems = useMemo<TreemapItem[]>(() => {
    const folders = view.children.slice(0, MAP_TILES);
    const rest = view.children.slice(MAP_TILES).reduce((s, c) => s + c.bytes, 0) + view.otherBytes;
    const restCount = Math.max(0, view.children.length - MAP_TILES) + view.otherCount;
    return [
      ...folders.map((c) => ({ key: `n${c.node}`, label: c.name, bytes: c.bytes, kind: "folder" as const, node: c.hasChildren || c.files > 0 ? c.node : undefined })),
      { key: "files", label: `Files in ${view.name}`, bytes: view.ownBytes, kind: "files" as const },
      { key: "other", label: `${restCount} smaller ${restCount === 1 ? "folder" : "folders"}`, bytes: rest, kind: "other" as const },
    ];
  }, [view]);

  const files = allFiles ? view.largestFiles : view.largestFiles.slice(0, FILES_SHOWN);
  const parent = view.crumbs[view.crumbs.length - 2];

  return (
    <div className="storage-tab">
      <div className="card finder-bar">
        <button className="icon-btn" onClick={() => parent && open(parent.node)} disabled={atRoot} aria-label="Up one folder" title="Up one folder">
          <ArrowUp size={16} />
        </button>
        <nav className="crumbs" aria-label="Folder path">
          {view.crumbs.map((c, i) => {
            const last = i === view.crumbs.length - 1;
            return (
              <span key={c.node} className="crumb">
                {i > 0 && <ChevronRight size={14} className="crumb-sep" aria-hidden="true" />}
                {last ? (
                  <strong aria-current="location">{c.name}</strong>
                ) : (
                  <button className="crumb-btn" onClick={() => open(c.node)}>
                    {i === 0 && <HardDrive size={14} />}
                    {c.name}
                  </button>
                )}
              </span>
            );
          })}
          {finder.loadingNode !== null && <span className="spinner" aria-label="Loading" />}
        </nav>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => finder.target && startScan(finder.target)} title="Read every size again">
          <RefreshCw size={14} /> Scan again
        </button>
        <button className="btn btn-sm" onClick={chooseAnother}>
          <HardDrive size={14} /> Other drive or folder
        </button>
      </div>

      {summary.cancelled && (
        <div className="note note-warn">
          <TriangleAlert size={16} />
          <span>You stopped the scan early, so the sizes only include the folders read so far.</span>
        </div>
      )}
      {finder.stale && (
        <div className="note note-info">
          <Info size={16} />
          <span>Something was put back since this scan, so a few sizes may be out of date.</span>
          <button className="btn btn-sm" onClick={() => finder.target && startScan(finder.target)}>
            <RefreshCw size={14} /> Scan again
          </button>
        </div>
      )}

      <section className="card finder-map-card">
        <div className="finder-headline">
          <div>
            <h2 className="num-text">{bytes(view.bytes)}</h2>
            <p className="muted">
              in {atRoot ? mountLabel(view.name) : view.name} · {view.files.toLocaleString()} files in {view.folders.toLocaleString()} folders
              {!atRoot && summary.bytes > 0 && ` · ${pctText(share(view.bytes, summary.bytes))} of everything scanned`}
            </p>
          </div>
          <p className="muted small finder-scan-info">
            Scanned in {Math.max(1, Math.round(summary.elapsedMs / 1000))} s
            {summary.denied > 0 && (
              <span title="Windows keeps some system folders private. Their sizes aren't included.">
                {" "}
                · <Lock size={11} /> {summary.denied.toLocaleString()} {summary.denied === 1 ? "folder" : "folders"} off-limits
              </span>
            )}
          </p>
        </div>
        {view.bytes > 0 ? (
          <Treemap items={mapItems} total={view.bytes} onOpen={open} label={`Map of the biggest folders in ${view.name}`} />
        ) : (
          <EmptyState icon={FolderOpen} title="This folder is empty" />
        )}
      </section>

      <div className="finder-lists">
        <section className="card finder-list" aria-label="Biggest folders">
          <div className="card-header">
            <h3>Biggest folders</h3>
            <span className="muted">{(view.children.length + view.otherCount).toLocaleString()} folders</span>
          </div>
          {view.children.length === 0 && view.ownFiles === 0 ? (
            <p className="muted small finder-none">No folders here.</p>
          ) : (
            <ul className="size-list">
              {view.children.map((c) => (
                <FolderRow key={c.node} c={c} total={view.bytes} busy={busy === `n${c.node}`} onOpen={open} onReveal={reveal} onDelete={() => remove({ type: "folder", node: c.node }, `n${c.node}`)} />
              ))}
              {view.otherCount > 0 && (
                <li className="size-row static">
                  <span className="size-icon">
                    <Folder size={16} />
                  </span>
                  <span className="size-main">
                    <span className="size-name muted">
                      {view.otherCount.toLocaleString()} smaller {view.otherCount === 1 ? "folder" : "folders"}
                    </span>
                    <SizeBar pct={share(view.otherBytes, view.bytes)} muted />
                  </span>
                  <span className="size-num">{bytes(view.otherBytes)}</span>
                  <span className="size-pct">{pctText(share(view.otherBytes, view.bytes))}</span>
                  <span className="size-menu" />
                </li>
              )}
              {view.ownFiles > 0 && (
                <li className="size-row static">
                  <span className="size-icon">
                    <Files size={16} />
                  </span>
                  <span className="size-main">
                    <span className="size-name muted">
                      {view.ownFiles.toLocaleString()} {view.ownFiles === 1 ? "file" : "files"} directly in this folder
                    </span>
                    <SizeBar pct={share(view.ownBytes, view.bytes)} muted />
                  </span>
                  <span className="size-num">{bytes(view.ownBytes)}</span>
                  <span className="size-pct">{pctText(share(view.ownBytes, view.bytes))}</span>
                  <span className="size-menu" />
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="card finder-list" aria-label="Largest files">
          <div className="card-header">
            <h3>Largest files</h3>
            <span className="muted truncate">{atRoot ? "anywhere in the scan" : `inside ${view.name}`}</span>
          </div>
          {view.largestFiles.length === 0 ? (
            <p className="muted small finder-none">No large files here.</p>
          ) : (
            <>
              <ul className="size-list">
                {files.map((f) => (
                  <FileRow
                    key={`${f.dir}/${f.name}`}
                    f={f}
                    base={view.path}
                    busy={busy === `f${f.dir}/${f.name}`}
                    onOpenFolder={open}
                    onReveal={reveal}
                    onDelete={() => remove({ type: "file", dir: f.dir, name: f.name }, `f${f.dir}/${f.name}`)}
                  />
                ))}
              </ul>
              {view.largestFiles.length > FILES_SHOWN && (
                <button className="btn btn-ghost btn-sm finder-more" onClick={() => setAllFiles((v) => !v)}>
                  {allFiles ? "Show fewer" : `Show ${view.largestFiles.length - FILES_SHOWN} more`}
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function SizeBar({ pct, muted }: { pct: number; muted?: boolean }) {
  return (
    <span className="size-bar" aria-hidden="true">
      <span className={muted ? "muted-fill" : undefined} style={{ width: `${Math.max(pct, pct > 0 ? 0.8 : 0)}%` }} />
    </span>
  );
}

interface FolderRowProps {
  c: FolderEntry;
  total: number;
  busy: boolean;
  onOpen: (node: number) => void;
  onReveal: (path: string) => void;
  onDelete: () => void;
}

function FolderRow({ c, total, busy, onOpen, onReveal, onDelete }: FolderRowProps) {
  const openable = c.hasChildren || c.files > 0;
  const pct = share(c.bytes, total);
  const items: MenuEntry[] = [
    { label: "Open", icon: FolderOpen, onSelect: () => onOpen(c.node), disabled: !openable },
    { label: "Show in File Explorer", icon: ExternalLink, onSelect: () => onReveal(c.path) },
    "separator",
    { label: "Move to Recycle Bin…", icon: Trash2, onSelect: onDelete, danger: true },
  ];
  return (
    <li
      className={`size-row ${openable ? "clickable" : ""}`}
      onClick={() => openable && onOpen(c.node)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && openable) {
          e.preventDefault();
          onOpen(c.node);
        }
      }}
      tabIndex={openable ? 0 : -1}
      title={c.path}
    >
      <span className="size-icon folder">{c.denied ? <Lock size={16} /> : <Folder size={16} />}</span>
      <span className="size-main">
        <span className="size-name">
          <span className="truncate">{c.name}</span>
          {c.denied && <span className="muted small nowrap">Windows kept it private</span>}
        </span>
        <SizeBar pct={pct} />
      </span>
      <span className="size-num">{busy ? <span className="spinner" /> : bytes(c.bytes)}</span>
      <span className="size-pct">{pctText(pct)}</span>
      <span className="size-menu" onClick={(e) => e.stopPropagation()}>
        <Menu items={items} label={`Actions for ${c.name}`} className="icon-btn icon-btn-sm" />
      </span>
    </li>
  );
}

interface FileRowProps {
  f: FileEntry;
  base: string;
  busy: boolean;
  onOpenFolder: (node: number) => void;
  onReveal: (path: string) => void;
  onDelete: () => void;
}

function FileRow({ f, base, busy, onOpenFolder, onReveal, onDelete }: FileRowProps) {
  const Icon = fileIcon(f.name);
  const dir = f.path.slice(0, Math.max(0, f.path.length - f.name.length - 1));
  const rel = dir.length > base.length ? dir.slice(base.replace(/[\\/]+$/, "").length + 1) : "";
  const changed = f.modifiedMs ? new Date(f.modifiedMs).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null;
  const items: MenuEntry[] = [
    { label: "Show in File Explorer", icon: ExternalLink, onSelect: () => onReveal(f.path) },
    { label: "Open its folder here", icon: FolderOpen, onSelect: () => onOpenFolder(f.dir) },
    "separator",
    { label: "Move to Recycle Bin…", icon: Trash2, onSelect: onDelete, danger: true },
  ];
  return (
    <li className="size-row file" title={`${f.path}${changed ? `\nChanged ${changed}` : ""}`}>
      <span className="size-icon">
        <Icon size={16} />
      </span>
      <span className="size-main">
        <span className="size-name">
          <span className="truncate">{f.name}</span>
        </span>
        <span className="size-path truncate">{rel ? rel : "In this folder"}</span>
      </span>
      <span className="size-num">{busy ? <span className="spinner" /> : bytes(f.bytes)}</span>
      <span className="size-menu">
        <Menu items={items} label={`Actions for ${f.name}`} className="icon-btn icon-btn-sm" />
      </span>
    </li>
  );
}
