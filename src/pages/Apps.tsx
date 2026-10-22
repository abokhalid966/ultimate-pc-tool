import { useState } from "react";
import { LayoutGrid, RefreshCw, Sparkles } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { bytes } from "../format";
import { installedApps, upgradeList } from "./apps/data";
import { InstalledTab } from "./apps/InstalledTab";
import { isActive, useQueue } from "./apps/queue";
import { ToolkitTab } from "./apps/ToolkitTab";
import { UpdatesTab } from "./apps/UpdatesTab";
import "./apps/apps.css";

type Tab = "installed" | "updates" | "toolkit";

const TAB_KEY = "apps-tab";

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "updates" || v === "toolkit" ? v : "installed";
  } catch {
    return "installed";
  }
}

export function Apps({ elevated, onRestartAsAdmin }: { elevated: boolean; onRestartAsAdmin: () => void }) {
  const [tab, setTabState] = useState<Tab>(readTab);
  const installed = installedApps.use(false);
  const upgrades = upgradeList.use(false);
  const queue = useQueue();

  const setTab = (t: Tab) => {
    setTabState(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* storage unavailable */
    }
  };

  const apps = installed.data ?? [];
  const totalSize = apps.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0);
  const updated = new Set(queue.filter((j) => j.action === "upgrade" && j.status === "done").map((j) => j.pkg.id));
  const updateCount = upgrades.data?.wingetMissing ? undefined : upgrades.data?.upgrades.filter((u) => !updated.has(u.id)).length;
  const working = (action: "install" | "upgrade") => queue.some((j) => j.action === action && isActive(j));

  const count = (n: number | undefined, accent = false) =>
    n === undefined ? null : <span className={`seg-count ${accent && n > 0 ? "accent" : ""}`}>{n}</span>;

  const tabs = (
    <Segmented
      label="Apps view"
      value={tab}
      onChange={setTab}
      options={[
        { value: "installed", label: <><LayoutGrid size={14} /> Installed {count(installed.data ? apps.length : undefined)}</> },
        {
          value: "updates",
          label: (
            <>
              {working("upgrade") ? <span className="spinner seg-spinner" /> : <RefreshCw size={14} />} Updates {count(updateCount, true)}
            </>
          ),
        },
        {
          value: "toolkit",
          label: (
            <>
              {working("install") ? <span className="spinner seg-spinner" /> : <Sparkles size={14} />} Fresh-install toolkit
            </>
          ),
          title: "Install popular apps in one go",
        },
      ]}
    />
  );

  const subtitle =
    tab === "installed"
      ? installed.data
        ? `${apps.length} apps installed${totalSize ? `, using about ${bytes(totalSize)}` : ""}. Uninstall the ones you no longer need to free up space.`
        : "Everything installed on this PC, with the space each app takes."
      : tab === "updates"
        ? "Keep your apps up to date with the latest fixes and security patches."
        : "Setting up a PC? Pick your favorite apps and install them all in one go.";

  return (
    <div className="page page-fill apps-page">
      <PageHeader title="Apps" subtitle={subtitle} />
      {tab === "installed" && <InstalledTab tabs={tabs} elevated={elevated} onRestartAsAdmin={onRestartAsAdmin} />}
      {tab === "updates" && <UpdatesTab tabs={tabs} />}
      {tab === "toolkit" && <ToolkitTab tabs={tabs} elevated={elevated} />}
    </div>
  );
}
