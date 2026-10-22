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
  | { type: "serviceStartup"; name: string; displayName: string; startup: ServiceStartup }
  | { type: "unknown" };

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

  services: () => invoke<ServiceInfo[]>("list_services"),
  service: (name: string) => invoke<ServiceInfo>("get_service", { name }),
  serviceDetails: (name: string) => invoke<ServiceDetails>("get_service_details", { name }),
  /** Waits (up to about 30 seconds) until the service has started or stopped. */
  controlService: (name: string, action: ServiceAction) => invoke<ServiceActionResult>("control_service", { name, action }),
  setServiceStartup: (name: string, startup: ServiceStartup) => invoke<ServiceActionResult>("set_service_startup", { name, startup }),

  activity: () => invoke<ActionRecord[]>("list_activity"),
  undoActivity: (id: string) => invoke<void>("undo_activity", { id }),
  clearActivity: () => invoke<void>("clear_activity"),
};

/** Tauri rejects with a plain string from Rust `Err(String)`. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}

/** Startup sources that apply to all users and need administrator rights to change. */
export const ADMIN_SOURCES: StartupSource[] = ["machineRun", "machineRun32", "machineFolder"];
