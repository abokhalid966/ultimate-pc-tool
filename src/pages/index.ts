import { Activity, Gauge, LayoutGrid, ListTree, Power, Settings, SquareTerminal, Zap } from "lucide-react";

export type PageId = "dashboard" | "processes" | "commands" | "terminal" | "startup" | "apps" | "activity" | "settings";

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
  { id: "processes", label: "Processes", description: "See and end running apps", icon: ListTree, section: "Monitor" },
  { id: "startup", label: "Startup apps", description: "Choose what starts with Windows", icon: Power, section: "Manage" },
  { id: "apps", label: "Apps", description: "Uninstall, update and install apps", icon: LayoutGrid, section: "Manage" },
  { id: "commands", label: "Quick fixes", description: "One-click fixes and your saved commands", icon: Zap, section: "Tools" },
  { id: "terminal", label: "Terminal", description: "PowerShell, Command Prompt and WSL", icon: SquareTerminal, section: "Tools" },
  { id: "activity", label: "Activity", description: "History of changes, with undo", icon: Activity, section: "History" },
  { id: "settings", label: "Settings", description: "Theme, close button and app info", icon: Settings, section: null },
];

export const SECTIONS = ["Monitor", "Manage", "Tools", "History"] as const;
