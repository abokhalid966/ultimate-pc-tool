import { Copy, FolderSearch, Sparkles } from "lucide-react";
import { DiskInfo } from "../api";
import { PageHeader } from "../components/PageHeader";
import { Segmented } from "../components/Segmented";
import { CleanupTab } from "./storage/CleanupTab";
import { DuplicatesTab } from "./storage/DuplicatesTab";
import { SpaceFinder } from "./storage/SpaceFinder";
import { setTab, StorageTab, useStorageState } from "./storage/state";
import "./storage/storage.css";

interface Props {
  elevated: boolean;
  onRestartAsAdmin: () => void;
  /** Live drive list from the metrics sampler. */
  disks: DiskInfo[];
}

export function Storage({ elevated, onRestartAsAdmin, disks }: Props) {
  const { tab } = useStorageState();

  return (
    <div className="page storage-page">
      <PageHeader
        title="Storage"
        subtitle={
          tab === "cleanup"
            ? "Free up space safely. You choose what goes, and your own files are never touched."
            : tab === "finder"
              ? "See which folders and files take up the most space, and move what you don't need to the Recycle Bin."
              : "Find files you have more than one copy of, and move the extra copies to the Recycle Bin."
        }
        actions={
          <Segmented<StorageTab>
            label="Storage view"
            value={tab}
            onChange={setTab}
            options={[
              {
                value: "cleanup",
                label: (
                  <>
                    <Sparkles size={15} /> Cleanup
                  </>
                ),
                title: "Remove temporary files, caches and other leftovers",
              },
              {
                value: "finder",
                label: (
                  <>
                    <FolderSearch size={15} /> Space finder
                  </>
                ),
                title: "Find the biggest folders and files on a drive",
              },
              {
                value: "duplicates",
                label: (
                  <>
                    <Copy size={15} /> Duplicates
                  </>
                ),
                title: "Find copies of the same file",
              },
            ]}
          />
        }
      />
      {tab === "cleanup" ? (
        <CleanupTab elevated={elevated} onRestartAsAdmin={onRestartAsAdmin} disks={disks} />
      ) : tab === "finder" ? (
        <SpaceFinder disks={disks} />
      ) : (
        <DuplicatesTab />
      )}
    </div>
  );
}
