import { Activity, Gauge, HeartPulse, ListTree, Power, Settings, SquareTerminal, Zap } from "lucide-react";

export type PageId = "dashboard" | "health" | "processes" | "commands" | "terminal" | "startup" | "activity" | "settings";

export interface PageInfo {
  id: PageId;
  label: string;
  description: string;
  icon: typeof Gauge;
  /** Sidebar group; Settings sits apart at the bottom. */
  section: "Monitor" | "Tools" | "History" | null;
}

/** In sidebar order; Ctrl+1..9 follow this order too. */
export const PAGES: PageInfo[] = [
  { id: "dashboard", label: "Dashboard", description: "How your PC is doing right now", icon: Gauge, section: "Monitor" },
  { id: "health", label: "PC health", description: "Find out why your PC is slow, and fix it", icon: HeartPulse, section: "Monitor" },
  { id: "processes", label: "Processes", description: "See and end running apps", icon: ListTree, section: "Monitor" },
  { id: "startup", label: "Startup apps", description: "Choose what starts with Windows", icon: Power, section: "Monitor" },
  { id: "commands", label: "Quick fixes", description: "One-click fixes and your saved commands", icon: Zap, section: "Tools" },
  { id: "terminal", label: "Terminal", description: "PowerShell, Command Prompt and WSL", icon: SquareTerminal, section: "Tools" },
  { id: "activity", label: "Activity", description: "History of changes, with undo", icon: Activity, section: "History" },
  { id: "settings", label: "Settings", description: "Theme, close button and app info", icon: Settings, section: null },
];

export const SECTIONS = ["Monitor", "Tools", "History"] as const;
