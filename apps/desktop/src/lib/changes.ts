// The tiny external store that dozens of modules had copied: a Set of listeners, a `subscribe` that returns its own
// undo, and an emit. Each call keeps its own Set, so a module still tells only its own readers (a React view reads it
// through `useSyncExternalStore`). Having one home means the way a notice is delivered is decided once.

export interface Changes {
  /** Add a listener; the returned function removes it again. */
  subscribe: (listener: () => void) => () => void;
  /** Tell every listener now. A listener added during the call is told too, and one removed during it is skipped. */
  emit: () => void;
  /** Tell a copy of the listeners taken first, for a listener that unsubscribes or subscribes while it is told. */
  emitSnapshot: () => void;
  /** How many listeners are waiting. */
  size: () => number;
}

export function changes(): Changes {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit() {
      for (const l of listeners) l();
    },
    emitSnapshot() {
      for (const l of [...listeners]) l();
    },
    size: () => listeners.size,
  };
}
