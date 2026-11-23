// A session opened in a collapsed folder opens the folder (folders.ts `revealFolder`), so its row is there when the person
// looks at the Code page. This ran in the list's own effect, and the list is drawn only on the Code page: a session
// opened from Recent, from Needs you's Look first, with ⌘⇧] or as a new terminal starts has its terminal in view and no
// list drawn, so its folder stayed shut. It is watched here instead, from the two stores the open session and its row
// live in, and started once with the shared sessions store (sessions.ts `getSessions`).
import type { Store } from "../state/store";
import { revealFolder } from "./folders";
import type { SessionsStore } from "./sessions";

/** Open the folder of the session in view whenever it is a different one, or the same one in a different folder, and
 *  again when it comes back into view after another page. Nothing else reveals: a person who shuts the folder of the
 *  open session keeps it shut until another session (or the same one, back from another page) comes into view. Returns
 *  the function that stops watching. */
export function watchOpenFolder(
  store: Pick<Store, "getState" | "subscribe">,
  sessions: Pick<SessionsStore, "getState" | "subscribe">,
  reveal: (cwd: string) => void = revealFolder,
): () => void {
  // what was revealed last: the session and its folder, or null while no listed session is in view
  let last: string | null = null;
  const check = () => {
    const ui = store.getState().ui;
    const open = ui.view === "session" ? ui.session : null;
    // a session opens as it starts, which can be a moment before it is listed: the sessions store's own change finds it
    const cwd = open ? sessions.getState().list.find((r) => r.id === open)?.cwd : undefined;
    const key = open && cwd !== undefined ? `${open}\n${cwd}` : null;
    if (key === last) return;
    last = key;
    if (cwd !== undefined && key !== null) reveal(cwd);
  };
  const stops = [store.subscribe(check), sessions.subscribe(check)];
  check();
  return () => {
    for (const stop of stops) stop();
  };
}
