import { Activity, CalendarClock, EyeOff, Gauge, HardDrive, HeartPulse, Info, LayoutGrid, ListTree, Power, Rocket, ServerCog, Settings, SquareTerminal, Wifi, Zap } from "lucide-react";

export type PageId = "dashboard" | "health" | "processes" | "sysinfo" | "network" | "boost" | "privacy" | "commands" | "automations" | "terminal" | "startup" | "apps" | "services" | "storage" | "activity" | "settings";

export interface PageInfo {
  id: PageId;
  label: string;
  description: string;
  icon: typeof Gauge;
  /** Sidebar group; Settings sits apart at the bottom. */
  section: "Monitor" | "Manage" | "Tools" | "History" | null;
}

/** In sidebar order; Ctrl+1..9 follow this order too. */
export const PAGES: PageInfo[] = [
  { id: "dashboard", label: "Dashboard", description: "How your PC is doing right now", icon: Gauge, section: "Monitor" },
  { id: "health", label: "PC health", description: "Find out why your PC is slow, and fix it", icon: HeartPulse, section: "Monitor" },
  { id: "processes", label: "Processes", description: "See and end running apps", icon: ListTree, section: "Monitor" },
  { id: "sysinfo", label: "System info", description: "What's inside your PC: processor, memory, graphics, drives", icon: Info, section: "Monitor" },
  { id: "network", label: "Network", description: "Internet speed test, DNS and apps that are online", icon: Wifi, section: "Monitor" },
  { id: "startup", label: "Startup apps", description: "Choose what starts with Windows", icon: Power, section: "Manage" },
  { id: "apps", label: "Apps", description: "Uninstall, update and install apps", icon: LayoutGrid, section: "Manage" },
  { id: "services", label: "Services", description: "Background programs for Windows and your apps", icon: ServerCog, section: "Manage" },
  { id: "storage", label: "Storage", description: "Free up disk space and see what fills your drives", icon: HardDrive, section: "Manage" },
  { id: "privacy", label: "Privacy", description: "Turn off ads and tracking, remove preinstalled apps", icon: EyeOff, section: "Manage" },
  { id: "boost", label: "Boost", description: "One-click game mode: more power, fewer background apps", icon: Rocket, section: "Tools" },
  { id: "commands", label: "Quick fixes", description: "One-click fixes and your saved commands", icon: Zap, section: "Tools" },
  { id: "automations", label: "Automations", description: "Run cleanups, update checks and fixes on a schedule", icon: CalendarClock, section: "Tools" },
  { id: "terminal", label: "Terminal", description: "PowerShell, Command Prompt and WSL", icon: SquareTerminal, section: "Tools" },
  { id: "activity", label: "Activity", description: "History of changes, with undo", icon: Activity, section: "History" },
  { id: "settings", label: "Settings", description: "Theme, start with Windows, alerts and overlay", icon: Settings, section: null },
];

export const SECTIONS = ["Monitor", "Manage", "Tools", "History"] as const;
