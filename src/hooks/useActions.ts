import { useCallback, useState } from "react";
import { api, errorText, ProcessInfo } from "../api";
import { useConfirm } from "../components/Confirm";
import { useToast } from "../components/Toast";
import { bytes } from "../format";

/**
 * Ends one or all processes of an app after a confirmation (with the specific warning for
 * processes like explorer.exe). Resolves true when anything was attempted.
 */
export function useEndProcesses() {
  const confirm = useConfirm();
  const toast = useToast();

  return useCallback(
    async (list: ProcessInfo[]): Promise<boolean> => {
      if (list.length === 0) return false;
      const name = list[0].name;
      const blocked = list.find((p) => p.protected);
      if (blocked) {
        toast(blocked.protected!, "error");
        return false;
      }
      const many = list.length > 1;
      const ok = await confirm({
        title: many ? `End all ${name}?` : `End ${name}?`,
        message: many ? `All ${list.length} ${name} processes will close. Unsaved work in them will be lost.` : `PID ${list[0].pid}. Unsaved work in it will be lost.`,
        warning: list.find((p) => p.warning)?.warning,
        confirmLabel: many ? `End ${list.length} processes` : "End process",
        danger: true,
      });
      if (!ok) return false;

      try {
        const r = await api.killProcesses(name, list);
        // Child processes often exit by themselves once their parent ends: that's a success too.
        const done = r.ended + r.alreadyGone;
        if (r.failed.length === 0) {
          toast(r.ended === 0 ? `${name} had already closed.` : many ? `Ended ${name} (${done} processes)` : `Ended ${name}`, "success");
        } else if (done > 0) {
          toast(`Ended ${done} of ${list.length} ${name} processes. ${r.failed[0]}`, "error");
        } else {
          toast(r.failed[0], "error");
        }
      } catch (e) {
        toast(errorText(e), "error");
      }
      return true;
    },
    [confirm, toast],
  );
}

/** Measures the temp folder, asks, then cleans it with the safe built-in cleaner. */
export function useCleanTemp() {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const preview = await api.cleanTemp(true);
      if (preview.files === 0) {
        toast("Your temp folder is already clean. Files used in the last day are always kept.", "success");
        return;
      }
      const ok = await confirm({
        title: "Clean temp files?",
        message: `About ${bytes(preview.bytes)} in ${preview.files.toLocaleString()} files can be freed. Files used in the last 24 hours and files that are in use are kept, and nothing outside the temp folder is touched.`,
        code: preview.folder,
        confirmLabel: `Free ${bytes(preview.bytes)}`,
      });
      if (!ok) return;
      const r = await api.cleanTemp(false);
      const kept = r.skipped > 0 ? ` ${r.skipped.toLocaleString()} files were kept because they are new or in use.` : "";
      toast(`Freed ${bytes(r.bytes)} (${r.files.toLocaleString()} files).${kept}`, "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  }, [confirm, toast]);

  return { run, busy };
}
