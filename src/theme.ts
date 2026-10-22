import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** "system" follows the Windows app-mode setting (Settings > Personalization > Colors). */
export type ThemePref = "system" | "light" | "dark";

const KEY = "theme";
const EVENT = "app:theme";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Applies a theme choice to the page and the native title bar. */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
  try {
    getCurrentWindow()
      .setTheme(pref === "system" ? null : pref)
      .catch(() => {});
  } catch {
    /* not running inside Tauri */
  }
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable: the choice lasts until the app closes */
  }
  applyTheme(pref);
  window.dispatchEvent(new Event(EVENT));
}

/** Whether the app is showing its dark theme right now. */
export function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Calls `fn` whenever the visible theme may have changed (Windows setting or in-app choice). */
export function onThemeChange(fn: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", fn);
  window.addEventListener(EVENT, fn);
  return () => {
    media.removeEventListener("change", fn);
    window.removeEventListener(EVENT, fn);
  };
}

export function useThemePref(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => onThemeChange(() => setPref(getThemePref())), []);
  const set = useCallback((p: ThemePref) => {
    setThemePref(p);
    setPref(p);
  }, []);
  return [pref, set];
}
