import { useEffect, useRef } from "react";

/** Fired on F5: refreshes the current page instead of reloading the whole app. */
export const REFRESH_EVENT = "app:refresh";

export function useOnRefresh(refresh: () => void) {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    const handler = () => ref.current();
    window.addEventListener(REFRESH_EVENT, handler);
    return () => window.removeEventListener(REFRESH_EVENT, handler);
  }, []);
}
