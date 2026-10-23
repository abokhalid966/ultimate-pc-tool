import { Activity, CalendarClock, CircuitBoard, ClipboardList, EyeOff, Gauge, HardDrive, HeartPulse, Info, LayoutGrid, ListTree, Power, Rocket, ServerCog, Settings, SquareTerminal, Wifi, Zap } from "lucide-react";

export type PageId = "dashboard" | "health" | "processes" | "sysinfo" | "network" | "drivers" | "boost" | "privacy" | "clipboard" | "commands" | "automations" | "terminal" | "startup" | "apps" | "services" | "storage" | "activity" | "settings";

export type SectionId = "start" | "speed" | "clean" | "pc" | "tools" | "advanced";

export interface PageInfo {
  id: PageId;
  label: string;
  description: string;
  icon: typeof Gauge;
  /** Sidebar group; Settings sits apart at the bottom. */
  section: SectionId | null;
}

/** In sidebar order; Ctrl+1..9 follow this order too. */
export const PAGES: PageInfo[] = [
  { id: "dashboard", label: "Home", description: "How your PC is doing right now, and quick actions", icon: Gauge, section: "start" },
  { id: "health", label: "PC health", description: "Find out why your PC is slow, and fix it", icon: HeartPulse, section: "start" },
  { id: "boost", label: "Boost", description: "One-click game mode: more power, fewer background apps", icon: Rocket, section: "speed" },
  { id: "startup", label: "Startup apps", description: "Choose what starts with Windows", icon: Power, section: "speed" },
  { id: "processes", label: "Processes", description: "See and end running apps", icon: ListTree, section: "speed" },
  { id: "storage", label: "Storage", description: "Free up space, find big files and duplicates", icon: HardDrive, section: "clean" },
  { id: "apps", label: "Apps", description: "Uninstall, update and install apps", icon: LayoutGrid, section: "clean" },
  { id: "privacy", label: "Privacy", description: "Turn off ads and tracking, remove preinstalled apps", icon: EyeOff, section: "clean" },
  { id: "sysinfo", label: "System info", description: "What's inside your PC: processor, memory, graphics, drives", icon: Info, section: "pc" },
  { id: "drivers", label: "Drivers", description: "Find old drivers and devices that aren't working", icon: CircuitBoard, section: "pc" },
  { id: "network", label: "Network", description: "Internet speed test, DNS and apps that are online", icon: Wifi, section: "pc" },
  { id: "clipboard", label: "Clipboard", description: "Everything you copied, ready to paste again", icon: ClipboardList, section: "tools" },
  { id: "commands", label: "Quick fixes", description: "One-click fixes and your saved commands", icon: Zap, section: "tools" },
  { id: "automations", label: "Automations", description: "Run cleanups, update checks and fixes on a schedule", icon: CalendarClock, section: "tools" },
  { id: "services", label: "Services", description: "Background programs for Windows and your apps", icon: ServerCog, section: "advanced" },
  { id: "terminal", label: "Terminal", description: "PowerShell, Command Prompt and WSL", icon: SquareTerminal, section: "advanced" },
  { id: "activity", label: "Activity", description: "History of changes, with undo", icon: Activity, section: "advanced" },
  { id: "settings", label: "Settings", description: "Theme, start with Windows, alerts and overlay", icon: Settings, section: null },
];

/** Sidebar groups. A group without a label shows no heading; Advanced can be folded away. */
export const SECTIONS: { id: SectionId; label: string | null; color: string; collapsible?: boolean }[] = [
  { id: "start", label: null, color: "var(--accent-text)" },
  { id: "speed", label: "Speed up", color: "var(--cat-repair)" },
  { id: "clean", label: "Clean up", color: "var(--cat-cleanup)" },
  { id: "pc", label: "Your PC", color: "var(--cat-system)" },
  { id: "tools", label: "Tools", color: "var(--cat-network)" },
  { id: "advanced", label: "Advanced", color: "var(--cat-apps)", collapsible: true },
];
