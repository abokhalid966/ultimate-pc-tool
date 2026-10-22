import { Brush, LucideIcon, Monitor, Package, User, Wifi, Wrench, Zap } from "lucide-react";

/** Icon and tint per command category, so fixes can be scanned at a glance. */
const CATEGORY_LOOK: Record<string, { icon: LucideIcon; color: string }> = {
  network: { icon: Wifi, color: "var(--cat-network)" },
  system: { icon: Monitor, color: "var(--cat-system)" },
  repair: { icon: Wrench, color: "var(--cat-repair)" },
  apps: { icon: Package, color: "var(--cat-apps)" },
  cleanup: { icon: Brush, color: "var(--cat-cleanup)" },
  "my commands": { icon: User, color: "var(--cat-mine)" },
};

export const categoryLook = (category: string) => CATEGORY_LOOK[category.trim().toLowerCase()] ?? { icon: Zap, color: "var(--cat-mine)" };
