import { Channel, invoke } from "@tauri-apps/api/core";

export interface DiskInfo {
  name: string;
  mount: string;
  fileSystem: string;
  totalBytes: number;
  availableBytes: number;
  removable: boolean;
}

export interface Metrics {
  timestampMs: number;
  cpuName: string;
  cpuTotal: number;
  cpuPerCore: number[];
  cpuFreqMhz: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  netRxBps: number;
  netTxBps: number;
  diskReadBps: number;
  diskWriteBps: number;
  disks: DiskInfo[];
  temps: { label: string; celsius: number }[];
  processCount: number;
  uptimeSecs: number;
}

export interface SystemOverview {
  hostName: string;
  osName: string;
  osVersion: string;
  kernelVersion: string;
  cpuName: string;
  physicalCores: number;
  logicalCores: number;
  memTotal: number;
}

export interface AppInfo {
  elevated: boolean;
  version: string;
}

export type CloseAction = "tray" | "quit";

export interface Settings {
  /** `null` until the user chooses; the app asks the first time the window is closed. */
  closeAction: CloseAction | null;
}

export interface ProcessInfo {
  pid: number;
  parentPid: number | null;
  name: string;
  cpu: number;
  memory: number;
  /** Bytes per second of all I/O (disk, network, pipes): Windows doesn't split it per process. */
  ioRead: number;
  ioWrite: number;
  exe: string | null;
  startTime: number;
  /** Why this process can't be ended or re-prioritised. */
  protected: string | null;
  /** What breaks if this process is ended (allowed after a confirmation). */
  warning: string | null;
  /** Ultimate PC Tool itself or its WebView2 helper processes. */
  isSelf: boolean;
}

/** A process as the UI saw it; `startTime` tells it apart from a later process with the same PID. */
export interface ProcessTarget {
  pid: number;
  startTime: number;
}

export interface ProcessDetails {
  exe: string | null;
  cmd: string | null;
  priority: Priority | null;
}

export interface KillSummary {
  ended: number;
  alreadyGone: number;
  failed: string[];
}

export interface PriorityChange {
  previous: Priority | null;
  /** What Windows actually applied. */
  applied: Priority | null;
}

export type Priority = "idle" | "belowNormal" | "normal" | "aboveNormal" | "high" | "realtime";
export type Shell = "powershell" | "cmd";
export type Risk = "safe" | "caution" | "danger";

export interface SavedCommand {
  id: string;
  name: string;
  description: string;
  command: string;
  shell: Shell;
  admin: boolean;
  category: string;
  risk: Risk;
  /** Plain-language note shown before running a risky command. */
  warning: string | null;
}

export type StopReason = "cancelled" | "timedOut";

export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  /** The command was handed to an administrator window, so no output is captured. */
  elevated: boolean;
  stopped: StopReason | null;
  /** Only the last part of a very long output was kept. */
  truncated: boolean;
}

/** Live output while a command runs. */
export type RunEvent = { type: "output"; stderr: boolean; data: string };

export type TermEvent = { type: "output"; data: string } | { type: "exit"; code: number | null };

export interface CleanReport {
  folder: string;
  files: number;
  bytes: number;
  skipped: number;
}

export type StartupSource = "userRun" | "machineRun" | "machineRun32" | "userFolder" | "machineFolder";

export interface StartupItem {
  name: string;
  command: string;
  source: StartupSource;
  location: string;
  enabled: boolean;
  needsAdmin: boolean;
}

export type Undo =
  | { type: "startupToggle"; source: StartupSource; name: string; enabled: boolean }
  | { type: "priority"; pid: number; startTime: number; name: string; previous: Priority }
  | { type: "restoreCommand"; command: SavedCommand }
  | { type: "restoreFromRecycleBin"; paths: string[]; deletedAt: number }
  | { type: "unknown" };

// ---- Storage ----

export type CleanupKind =
  | "userTemp"
  | "windowsTemp"
  | "thumbnails"
  | "recycleBin"
  | "edge"
  | "chrome"
  | "brave"
  | "firefox"
  | "errorReports"
  | "systemErrorReports"
  | "deliveryOptimization"
  | "windowsUpdate";

export interface CleanupCategory {
  kind: CleanupKind;
  label: string;
  description: string;
  group: "files" | "browsers" | "windows";
  needsAdmin: boolean;
  /** Ticked when the page opens. */
  suggested: boolean;
  /** The folders or files it covers. */
  locations: string[];
  present: boolean;
  bytes: number;
  files: number;
  /** Why it can't be cleaned right now (a browser is open, administrator rights needed). */
  blocked: string | null;
  /** The size couldn't be measured. */
  unmeasured: boolean;
}

export interface CleanupResult {
  kind: CleanupKind;
  label: string;
  files: number;
  bytes: number;
  /** Files left alone because they are new or in use. */
  skipped: number;
  error: string | null;
}

export type CleanupRunEvent = { type: "started"; kind: CleanupKind } | { type: "finished"; result: CleanupResult };

export interface CleanupSummary {
  results: CleanupResult[];
  bytes: number;
  files: number;
  skipped: number;
}

export type ScanEvent = { type: "progress"; files: number; folders: number; bytes: number; denied: number; current: string };

export interface FolderEntry {
  node: number;
  name: string;
  path: string;
  bytes: number;
  files: number;
  folders: number;
  denied: boolean;
  hasChildren: boolean;
}

export interface FileEntry {
  /** The folder the file is in. */
  dir: number;
  name: string;
  path: string;
  bytes: number;
  modifiedMs: number | null;
}

export interface FolderView {
  node: number;
  name: string;
  path: string;
  bytes: number;
  files: number;
  folders: number;
  /** Files directly in this folder. */
  ownBytes: number;
  ownFiles: number;
  denied: boolean;
  crumbs: { node: number; name: string }[];
  children: FolderEntry[];
  otherCount: number;
  otherBytes: number;
  largestFiles: FileEntry[];
}

export interface ScanSummary {
  scanId: string;
  root: string;
  bytes: number;
  files: number;
  folders: number;
  /** Folders Windows wouldn't open. */
  denied: number;
  links: number;
  /** Stopped early: sizes only include what was read. */
  cancelled: boolean;
  elapsedMs: number;
  view: FolderView;
}

export type DeleteTarget = { type: "folder"; node: number } | { type: "file"; dir: number; name: string };

export interface DeleteCheck {
  path: string;
  name: string;
  isFolder: boolean;
  bytes: number;
  files: number;
  blocked: string | null;
  warning: string | null;
}

export interface DeleteResult {
  path: string;
  bytes: number;
  activityId: string | null;
}

export interface ActionRecord {
  id: string;
  timestamp: string;
  category: string;
  description: string;
  /** Exact command text or other specifics. */
  detail: string | null;
  undo: Undo | null;
  undone: boolean;
}

let runCounter = 0;
export const newRunId = () => `run-${Date.now()}-${++runCounter}`;

const target = ({ pid, startTime }: ProcessTarget): ProcessTarget => ({ pid, startTime });

export const api = {
  appInfo: () => invoke<AppInfo>("get_app_info"),
  restartAsAdmin: () => invoke<void>("restart_as_admin"),
  takeNotices: () => invoke<string[]>("take_notices"),
  settings: () => invoke<Settings>("get_settings"),
  setCloseAction: (action: CloseAction | null) => invoke<void>("set_close_action", { action }),
  closeMainWindow: (action: CloseAction, remember: boolean) => invoke<void>("close_main_window", { action, remember }),

  overview: () => invoke<SystemOverview>("get_overview"),
  metrics: () => invoke<Metrics>("get_metrics"),

  processes: () => invoke<ProcessInfo[]>("list_processes"),
  processDetails: (p: ProcessTarget) => invoke<ProcessDetails>("get_process_details", { ...target(p) }),
  /** Ends processes of one app (`name`); ones that already exited count as ended. */
  killProcesses: (name: string, targets: ProcessTarget[]) =>
    invoke<KillSummary>("kill_processes", { name, targets: targets.map(target) }),
  setPriority: (p: ProcessInfo, priority: Priority) =>
    invoke<PriorityChange>("set_process_priority", { ...target(p), name: p.name, priority }),
  openFileLocation: (path: string) => invoke<void>("open_file_location", { path }),

  commands: () => invoke<SavedCommand[]>("list_commands"),
  saveCommand: (command: SavedCommand) => invoke<SavedCommand>("save_command", { command }),
  /** Returns the activity entry id, for an Undo button. */
  deleteCommand: (id: string) => invoke<string | null>("delete_command", { id }),
  restoreBuiltinCommands: () => invoke<number>("restore_builtin_commands"),
  runCommand: (
    command: string,
    shell: Shell,
    admin: boolean,
    label: string,
    opts: { runId?: string; onEvent?: Channel<RunEvent> } = {},
  ) =>
    invoke<CommandOutput>("run_command", {
      runId: opts.runId ?? newRunId(),
      command,
      shell,
      admin,
      label,
      onEvent: opts.onEvent ?? new Channel<RunEvent>(),
    }),
  cancelCommand: (runId: string) => invoke<void>("cancel_command", { runId }),
  cleanTemp: (dryRun: boolean) => invoke<CleanReport>("clean_temp", { dryRun }),

  /** Output arrives on `onEvent`, which exists before the shell starts, so nothing is lost. */
  terminalSpawn: (shell: string, rows: number, cols: number, onEvent: Channel<TermEvent>) =>
    invoke<number>("terminal_spawn", { shell, rows, cols, onEvent }),
  terminalWrite: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: number, rows: number, cols: number) => invoke<void>("terminal_resize", { id, rows, cols }),
  terminalClose: (id: number) => invoke<void>("terminal_close", { id }),

  startupItems: () => invoke<StartupItem[]>("list_startup_items"),
  setStartupEnabled: (source: StartupSource, name: string, enabled: boolean) =>
    invoke<void>("set_startup_enabled", { source, name, enabled }),

  activity: () => invoke<ActionRecord[]>("list_activity"),
  undoActivity: (id: string) => invoke<void>("undo_activity", { id }),
  clearActivity: () => invoke<void>("clear_activity"),

  /** Each category also arrives on `onEvent` as soon as it's measured. */
  cleanupScan: (onEvent: Channel<CleanupCategory>) => invoke<CleanupCategory[]>("storage_cleanup_scan", { onEvent }),
  cleanupRun: (kinds: CleanupKind[], onEvent: Channel<CleanupRunEvent>) => invoke<CleanupSummary>("storage_cleanup_run", { kinds, onEvent }),
  storageScan: (scanId: string, path: string, onEvent: Channel<ScanEvent>) => invoke<ScanSummary>("storage_scan", { scanId, path, onEvent }),
  cancelStorageScan: (scanId: string) => invoke<void>("storage_cancel_scan", { scanId }),
  storageFolder: (scanId: string, node: number) => invoke<FolderView>("storage_folder", { scanId, node }),
  checkStorageDelete: (scanId: string, target: DeleteTarget) => invoke<DeleteCheck>("storage_check_delete", { scanId, target }),
  /** Moves to the Recycle Bin; returns the activity entry id for Undo. */
  storageDelete: (scanId: string, target: DeleteTarget) => invoke<DeleteResult>("storage_delete", { scanId, target }),
  revealInExplorer: (path: string) => invoke<void>("storage_reveal", { path }),
  pickFolder: () => invoke<string | null>("storage_pick_folder"),
};

/** Tauri rejects with a plain string from Rust `Err(String)`. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

/** Startup sources that apply to all users and need administrator rights to change. */
export const ADMIN_SOURCES: StartupSource[] = ["machineRun", "machineRun32", "machineFolder"];
