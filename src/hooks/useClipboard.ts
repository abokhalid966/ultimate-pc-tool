import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, ClipboardSettings, ClipItem } from "../api";

/** Clipboard history, kept up to date as new text is copied. */
export function useClipboard() {
  const [items, setItems] = useState<ClipItem[] | null>(null);
  const [settings, setSettings] = useState<ClipboardSettings | null>(null);
  const load = useCallback(() => {
    api
      .clipboard()
      .then((r) => {
        setItems(r.items);
        setSettings(r.settings);
      })
      .catch(() => setItems([]));
  }, []);
  useEffect(() => {
    load();
    const unlisten = listen("clipboard://changed", load);
    return () => {
      unlisten.then((f) => f());
    };
  }, [load]);
  return { items, settings, setSettings, load };
}

/** Pinned first, then newest; a search matches anywhere in the text, ignoring case. */
export function filterClips(items: ClipItem[], query: string): ClipItem[] {
  const q = query.trim().toLowerCase();
  const found = q ? items.filter((i) => i.text.toLowerCase().includes(q)) : items;
  return [...found.filter((i) => i.pinned), ...found.filter((i) => !i.pinned)];
}
