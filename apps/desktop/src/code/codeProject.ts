// The project the Code page shows (item 167a): the one its picker names, which Kit's panel and its Lanes band are about. It was
// the panel's own state; the side menu now lists every project's lanes with this one first, so it is kept here, where both read
// it. It lasts while the app runs and is never saved: a new start shows the project of the newest session, as before.
//
// Opening a lane does not change it. The menu's groups then stay where they are while the person goes from lane to lane, by a
// row or by the previous and next lane keys, so a row is never moved out from under the pointer, and the keys step through one
// order that does not change as they step (docs/decisions/167a-lanes-in-menu.md).
import { useSyncExternalStore } from "react";
import { changes } from "../lib/changes";

let picked: string | null = null;
const listeners = changes();

/** The project the person picked on the Code page, or null while they have picked none. */
export const getCodeProject = (): string | null => picked;

export function setCodeProject(root: string | null): void {
  if (root === picked) return;
  picked = root;
  listeners.emit();
}

export const useCodeProject = (): string | null => useSyncExternalStore(listeners.subscribe, getCodeProject, getCodeProject);

/** The project the Code page shows of `projects` (its list, in its order): the one picked while it is listed, else the first. */
export const shownProject = (projects: readonly string[], chosen: string | null): string => (chosen && projects.includes(chosen) ? chosen : (projects[0] ?? ""));
