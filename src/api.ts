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
  /** Optimo itself or its WebView2 helper processes. */
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

// ---- Services ----

export type ServiceStartup = "automatic" | "automaticDelayed" | "manual" | "disabled";
export type ServiceStatus = "running" | "stopped" | "starting" | "stopping" | "paused" | "pausing" | "resuming";
export type ServicePublisher = "microsoft" | "thirdParty" | "unknown";
/** `protected`: Windows needs it, so it can't be stopped or disabled. `important`: allowed, with a warning. */
export type ServiceSafety = "protected" | "important" | "normal";
export type ServiceAction = "start" | "stop" | "restart";

export interface ServiceInfo {
  /** Key name, e.g. "Spooler". */
  name: string;
  displayName: string;
  description: string | null;
  /** Plain-language summary for well-known services. */
  summary: string | null;
  status: ServiceStatus;
  /** `null` when Windows doesn't let the app read the service's settings. */
  startup: ServiceStartup | null;
  pid: number | null;
  /** Program file, or for svchost.exe-hosted services the DLL that holds the service. */
  program: string | null;
  commandLine: string | null;
  account: string | null;
  publisher: ServicePublisher;
  company: string | null;
  safety: ServiceSafety;
  /** Why it's protected, or what breaks when it stops. */
  safetyNote: string | null;
  /** Running and accepts the stop command. */
  canStop: boolean;
  sharedProcess: boolean;
  /** Key names of services it needs; load-order groups start with "+". */
  dependencies: string[];
  /** For a per-user copy (e.g. "CDPUserSvc_4f2a1"), the service it was made from. */
  template: string | null;
}

export interface ServiceLink {
  name: string;
  displayName: string;
  status: ServiceStatus | null;
  group: boolean;
}

export interface ServiceDetails {
  /** Services this one needs. */
  dependencies: ServiceLink[];
  /** Services that need this one (they stop when it stops). */
  dependents: ServiceLink[];
}

export interface ServiceActionResult {
  /** The service as it is afterwards. */
  service: ServiceInfo | null;
  /** Still starting or stopping when the wait ran out; Windows keeps going. */
  timedOut: boolean;
  /** Display names of services stopped (or, for a restart, started again) along with it. */
  also: string[];
  /** Something worth telling the user, e.g. that it stopped again by itself. */
  note: string | null;
  /** Activity entry for an Undo button (startup type changes). */
  activityId: string | null;
}

export type Undo =
  | { type: "startupToggle"; source: StartupSource; name: string; enabled: boolean }
  | { type: "priority"; pid: number; startTime: number; name: string; previous: Priority }
  | { type: "restoreCommand"; command: SavedCommand }
  | { type: "powerPlan"; guid: string; name: string }
  | { type: "serviceStartup"; name: string; displayName: string; startup: ServiceStartup }
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

// ---- PC health ----

export type HealthSeverity = "critical" | "warning" | "tip";

/** What a fix button does. */
export type FixKind =
  | { kind: "endProcess"; payload: { name: string; targets: ProcessTarget[] } }
  | { kind: "openPage"; payload: { page: "processes" | "startup"; sort: "cpu" | "memory" | "io" | null; query: string | null } }
  | { kind: "cleanTemp"; payload: { bytes: number } }
  | { kind: "setPowerPlan"; payload: { guid: string; name: string } }
  | { kind: "restart" }
  | { kind: "openSettings"; payload: { page: string } };

export type FixAction = FixKind & {
  label: string;
  /** Changes nothing that can't be undone or that anyone would miss: "Fix all safe items" runs it. */
  safe: boolean;
};

export interface HealthIssue {
  id: string;
  severity: HealthSeverity;
  title: string;
  explanation: string;
  /** Numbers and names for people who want them. */
  detail: string;
  /** Score points this issue costs; fixing it gives them back. */
  points: number;
  action: FixAction | null;
  alternatives: FixAction[];
}

export interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "issue" | "skipped";
  summary: string;
}

export interface HealthReport {
  score: number;
  /** Most important first. */
  issues: HealthIssue[];
  checks: HealthCheck[];
  checkedAt: number;
  durationMs: number;
}

export type HealthEvent = { type: "progress"; percent: number; step: string };

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

  /** The "Why is my PC slow?" check: about five seconds, with progress on `onEvent`. */
  runHealthCheck: (onEvent: Channel<HealthEvent>) => invoke<HealthReport>("run_health_check", { onEvent }),
  /** Returns the activity entry id (for Undo), or null when that plan was already active. */
  setPowerPlan: (guid: string) => invoke<string | null>("set_power_plan", { guid }),
  restartPc: () => invoke<void>("restart_pc"),
  /** `page`: windowsupdate, storagesense, powersleep or batterysaver. */
  openWindowsSettings: (page: string) => invoke<void>("open_windows_settings", { page }),
  services: () => invoke<ServiceInfo[]>("list_services"),
  service: (name: string) => invoke<ServiceInfo>("get_service", { name }),
  serviceDetails: (name: string) => invoke<ServiceDetails>("get_service_details", { name }),
  /** Waits (up to about 30 seconds) until the service has started or stopped. */
  controlService: (name: string, action: ServiceAction) => invoke<ServiceActionResult>("control_service", { name, action }),
  setServiceStartup: (name: string, startup: ServiceStartup) => invoke<ServiceActionResult>("set_service_startup", { name, startup }),

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

// ---- Apps (installed programs, winget updates and installs) ----

export type AppScope = "machine" | "user";

export interface InstalledApp {
  /** Where the entry lives, e.g. `HKLM64\{GUID}`; uninstalling looks the command up again from it. */
  id: string;
  name: string;
  publisher: string | null;
  version: string | null;
  /** The installer's own estimate. */
  sizeBytes: number | null;
  /** YYYY-MM-DD */
  installDate: string | null;
  location: string | null;
  /** "machine" apps are installed for everyone, so removing them needs administrator rights. */
  scope: AppScope;
  canUninstall: boolean;
  canQuiet: boolean;
  /** Optimo itself. */
  isSelf: boolean;
}

export interface UninstallOutcome {
  removed: boolean;
  /** The uninstaller may still be open (it handed over to another window). */
  pending: boolean;
  cancelled: boolean;
  restartNeeded: boolean;
  message: string | null;
}

export interface AppUpgrade {
  name: string;
  id: string;
  /** winget shortened the id in its table; it is matched as a prefix. */
  partialId: boolean;
  version: string;
  available: string;
  source: string | null;
  /** Pinned or update-only-when-asked: "Update all" leaves it out. */
  explicit: boolean;
}

export interface UpgradeList {
  wingetMissing: boolean;
  upgrades: AppUpgrade[];
}

export interface WingetInstalled {
  wingetMissing: boolean;
  packages: { name: string; id: string; partialId: boolean }[];
}

export type WingetAction = "install" | "upgrade";

export interface WingetPackage {
  id: string;
  name: string;
  source?: string | null;
  partialId?: boolean;
  /** The version being installed, for the activity log. */
  version?: string | null;
}

export interface WingetOutcome {
  ok: boolean;
  /** Already installed or already up to date. */
  unchanged: boolean;
  restartNeeded: boolean;
  stopped: StopReason | null;
  message: string;
  code: string | null;
  /** winget's output without spinners and progress bars. */
  output: string;
}

export const appsApi = {
  installed: () => invoke<InstalledApp[]>("list_installed_apps"),
  uninstall: (id: string, quiet: boolean) => invoke<UninstallOutcome>("uninstall_app", { id, quiet }),
  stillInstalled: (id: string) => invoke<boolean>("app_still_installed", { id }),
  openFolder: (path: string) => invoke<void>("open_app_folder", { path }),
  upgrades: () => invoke<UpgradeList>("winget_list_upgrades"),
  wingetInstalled: () => invoke<WingetInstalled>("winget_list_installed"),
  /** Output arrives on `onEvent`; stop a run with `api.cancelCommand(runId)`. */
  wingetRun: (runId: string, action: WingetAction, pkg: WingetPackage, onEvent: Channel<RunEvent>) =>
    invoke<WingetOutcome>("winget_run", { runId, action, pkg, onEvent }),
  openAppInstaller: () => invoke<void>("open_app_installer_page"),
};
