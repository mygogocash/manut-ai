// "New" in a chat means arrived while this chat was open: the rows that were there when it opened (or loaded, or was
// restored after a restart), history paged in above, a re-render and a scroll back all stay still. Only a row added
// below the last one the person already had may Rise, once (docs/motion.md, "Rise").
import { useRef } from "react";

export interface Arrival {
  /** which chat this is for: another chat starts over */
  key: string;
  /** every id seen so far */
  known: Set<string>;
  /** the ids that arrived while open; their class stays on the row, so a re-render never plays them again */
  fresh: Set<string>;
  /** false until the chat's history has loaded: what is there at that moment is not new */
  ready: boolean;
}

export const startArrival = (key: string): Arrival => ({ key, known: new Set(), fresh: new Set(), ready: false });

/** The next state for the rows now in the chat. `quiet` names a row that must not move even when new: an answer whose
 *  text was already on screen while it streamed, an error, a note. The input is never changed. */
export function arrive(prev: Arrival, key: string, ids: readonly string[], loaded: boolean, quiet: (id: string) => boolean = () => false): Arrival {
  if (prev.key !== key || !prev.ready) return { key, known: new Set(ids), fresh: new Set(), ready: loaded };
  let last = -1;
  ids.forEach((id, i) => {
    if (prev.known.has(id)) last = i;
  });
  const added = ids.filter((id, i) => !prev.known.has(id) && i > last && !quiet(id));
  if (ids.every((id) => prev.known.has(id))) return prev;
  const known = new Set(prev.known);
  for (const id of ids) known.add(id);
  return { key, known, fresh: added.length ? new Set([...prev.fresh, ...added]) : prev.fresh, ready: true };
}

/** The ids that arrived while this chat was open. Idempotent for the same input, so a strict-mode double render is safe. */
export function useArrivals(key: string, ids: readonly string[], loaded: boolean, quiet?: (id: string) => boolean): ReadonlySet<string> {
  const ref = useRef<Arrival>(startArrival(key));
  ref.current = arrive(ref.current, key, ids, loaded, quiet);
  return ref.current.fresh;
}

/** True from the render where `done` turned true after being false in this mount: a decision that landed while the
 *  person watched. A card that is already decided when it mounts never reports it. */
export function useLanded(done: boolean): boolean {
  const was = useRef(done);
  const landed = useRef(false);
  if (done && !was.current) landed.current = true;
  if (!done) landed.current = false;
  was.current = done;
  return landed.current;
}
