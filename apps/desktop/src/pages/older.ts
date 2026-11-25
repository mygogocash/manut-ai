// Show older on a page that lists the shop's work (History, the activity log): what the page says for each state, and the one
// press that reads the next page. The connected runtime lists the newest 50 tasks of a shop and says `more` when it has older ones
// (`jobs.list` and `activity.list`, runtime/mission.ts); `jobs.older` reads the next page of them, after which the page reads its list
// again. Everything else (which page, which list, how it reads again) is the page's. The words are the dictionaries'.
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { OlderState } from "../runtime/mission";
import { getStore } from "../state/store";
import { load } from "./load";

/** Where a press stands: waiting to be pressed, reading the page, or the page could not be read (with the runtime's own words). */
export interface OlderUi {
  step: "idle" | "reading" | "failed";
  /** why the last page was not read, in the runtime's words (offline: Show older needs a connection); null otherwise */
  message: string | null;
}

export const OLDER_IDLE: OlderUi = { step: "idle", message: null };

/** What a page needs to draw Show older: what its list says (`more` or `end`; a list that says nothing draws none), where the press
 *  stands, and the press. */
export interface OlderView {
  state: OlderState;
  ui: OlderUi;
  onShow: () => void;
}

/** The line a page says and the button it offers, for a state of the list and of the press. Once everything is shown there is no
 *  button. A page that could not be read says why in the runtime's words and offers Try again, and what is shown has not changed. */
export function olderWords(state: OlderState, ui: OlderUi): { line: string; button: string | null; alert: boolean } {
  if (state === "end") return { line: t("older.end"), button: null, alert: false };
  if (ui.step === "reading") return { line: t("older.reading"), button: t("older.show"), alert: false };
  if (ui.step === "failed") return { line: ui.message ?? t("older.failed"), button: t("older.again"), alert: true };
  return { line: t("older.more"), button: t("older.show"), alert: false };
}

/** What a press needs, handed in so it can be run without a page: `ask` reads the next page (the store's `missionOlder`), `set` says
 *  where the press stands, `after` has the page read its list again, and `alive` says whether the page is still there. */
export interface OlderPress {
  ask: () => Promise<unknown>;
  set: (ui: OlderUi) => void;
  after: () => void;
  alive: () => boolean;
}

/** A page's press of Show older, one at a time: a press while one is on its way does nothing. It asks the runtime for the next page
 *  and, once the page is read, has the page read its list again. A page that cannot be read leaves the list as it is and says why, in
 *  the runtime's own words. Nothing happens to a page that has gone by the time the answer comes. */
export function olderPress(o: OlderPress): () => Promise<void> {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      o.set({ step: "reading", message: null });
      const r = await load(o.ask);
      if (!o.alive()) return;
      if (r.kind === "ready") {
        o.set(OLDER_IDLE);
        o.after();
      } else o.set({ step: "failed", message: r.kind === "unavailable" ? r.message : null });
    } finally {
      busy = false;
    }
  };
}

/** A page's Show older: where the press stands, and the press (`olderPress`), which has the page read its list again by `after`. */
export function useShowOlder(after: () => void): { ui: OlderUi; show: () => void } {
  const [ui, setUi] = useState<OlderUi>(OLDER_IDLE);
  const mounted = useRef(true);
  const again = useRef(after);
  again.current = after;
  const press = useRef<(() => Promise<void>) | null>(null);
  press.current ??= olderPress({ ask: () => getStore().actions.missionOlder(), set: setUi, after: () => again.current(), alive: () => mounted.current });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return { ui, show: () => void press.current?.() };
}
