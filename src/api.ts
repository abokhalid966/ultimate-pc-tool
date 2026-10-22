import { invoke } from "@tauri-apps/api/core";

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

export interface ProcessInfo {
  pid: number;
  parentPid: number | null;
  name: string;
  cpu: number;
  memory: number;
  diskRead: number;
  diskWrite: number;
  exe: string | null;
  cmd: string;
  status: string;
  startTime: number;
}

export type Priority = "idle" | "belowNormal" | "normal" | "aboveNormal" | "high" | "realtime";
export type Shell = "powershell" | "cmd";

export interface SavedCommand {
  id: string;
  name: string;
  description: string;
  command: string;
  shell: Shell;
  admin: boolean;
  category: string;
}

export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  elevated: boolean;
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

export interface ActionRecord {
  id: string;
  timestamp: string;
  category: string;
  description: string;
  undo: unknown | null;
  undone: boolean;
}

export const api = {
  overview: () => invoke<SystemOverview>("get_overview"),
  metrics: () => invoke<Metrics>("get_metrics"),

  processes: () => invoke<ProcessInfo[]>("list_processes"),
  killProcess: (pid: number, name: string) => invoke<void>("kill_process", { pid, name }),
  setPriority: (pid: number, name: string, priority: Priority) =>
    invoke<void>("set_process_priority", { pid, name, priority }),
  openFileLocation: (path: string) => invoke<void>("open_file_location", { path }),

  commands: () => invoke<SavedCommand[]>("list_commands"),
  saveCommand: (command: SavedCommand) => invoke<SavedCommand>("save_command", { command }),
  deleteCommand: (id: string) => invoke<void>("delete_command", { id }),
  runCommand: (command: string, shell: Shell, admin: boolean, label: string) =>
    invoke<CommandOutput>("run_command", { command, shell, admin, label }),

  terminalSpawn: (shell: string, rows: number, cols: number) =>
    invoke<number>("terminal_spawn", { shell, rows, cols }),
  terminalWrite: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
  terminalResize: (id: number, rows: number, cols: number) => invoke<void>("terminal_resize", { id, rows, cols }),
  terminalClose: (id: number) => invoke<void>("terminal_close", { id }),

  startupItems: () => invoke<StartupItem[]>("list_startup_items"),
  setStartupEnabled: (source: StartupSource, name: string, enabled: boolean) =>
    invoke<void>("set_startup_enabled", { source, name, enabled }),

  activity: () => invoke<ActionRecord[]>("list_activity"),
  undoActivity: (id: string) => invoke<void>("undo_activity", { id }),
  clearActivity: () => invoke<void>("clear_activity"),
};

/** Tauri rejects with a plain string from Rust `Err(String)`. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
