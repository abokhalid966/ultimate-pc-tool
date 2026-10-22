import { useCallback, useEffect, useState } from "react";
import { errorText } from "../api";

/** Loads data once and exposes a `reload` for after mutations; `loaded` turns true after the first attempt. */
export function useAsync<T>(load: () => Promise<T>, initial: T) {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, setData, error, loading, loaded, reload };
}
