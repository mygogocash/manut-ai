import { useCallback, useEffect, useRef, useState } from "react";

export type Loaded<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void };

/// Runs `load` whenever `key` changes or `reload` is called. A new key clears the old data at once, so one
/// shop's messages never show under another shop's name. `null` loads nothing.
export function useLoad<T>(load: (() => Promise<T>) | null, key: string): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean; key: string }>({
    data: null,
    error: null,
    loading: load !== null,
    key,
  });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const run = loadRef.current;
    if (!run) {
      setState({ data: null, error: null, loading: false, key });
      return;
    }
    let cancelled = false;
    setState((current) =>
      current.key === key ? { ...current, loading: true } : { data: null, error: null, loading: true, key },
    );
    run().then(
      (data) => {
        if (!cancelled) setState({ data, error: null, loading: false, key });
      },
      (error: unknown) => {
        if (!cancelled) setState((current) => ({ ...current, error, loading: false }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const current = state.key === key ? state : { data: null, error: null, loading: load !== null };
  return { data: current.data, error: current.error, loading: current.loading, reload };
}
