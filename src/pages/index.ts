import { Activity, Gauge, ListTree, Power, SquareTerminal, Zap } from "lucide-react";

export type PageId = "dashboard" | "processes" | "commands" | "terminal" | "startup" | "activity";

export const PAGES: { id: PageId; label: string; description: string; icon: typeof Gauge }[] = [
  { id: "dashboard", label: "Dashboard", description: "Live CPU, memory, network and disk", icon: Gauge },
  { id: "processes", label: "Processes", description: "See and end running apps", icon: ListTree },
  { id: "commands", label: "Commands", description: "Saved commands and one-click fixes", icon: Zap },
  { id: "terminal", label: "Terminal", description: "PowerShell, Command Prompt and WSL", icon: SquareTerminal },
  { id: "startup", label: "Startup apps", description: "Choose what starts with Windows", icon: Power },
  { id: "activity", label: "Activity", description: "History of changes, with undo", icon: Activity },
];
