// Show older, at the top of a conversation with Buddy (item 102l-6): the API gives the newest 50 messages of a conversation and says
// when it has older ones, so the first of them is a button, and a press reads the 50 before the oldest shown and puts them above (the
// store's `threadOlder`; the runtime reads them with the owner session of the conversation's shop, and nothing read is kept on disk).
// Once the first message is shown the store holds no cursor and the button is gone. The press itself, one at a time, is the one the
// work lists use (pages/older.ts `olderPress`). A page that cannot be read says why in the runtime's own words and offers Try again,
// and what is shown has not changed.
//
// Its height is the same in every state, so the column's view, which is kept by the first row's place (chat/parts/Timeline.tsx), does
// not move when the line comes or goes.
import "./threads.css";
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { OLDER_IDLE, olderPress, type OlderUi } from "../pages/older";
import { getStore, useStore } from "../state/store";
import { threadKey } from "./types";

/** The line and the button for where a press stands: the button always, and a line while the page is read or when it was not. */
export function olderMessageWords(ui: OlderUi): { line: string | null; button: string; alert: boolean } {
  if (ui.step === "reading") return { line: t("older.messages.reading"), button: t("older.messages.show"), alert: false };
  if (ui.step === "failed") return { line: ui.message ?? t("older.messages.failed"), button: t("older.again"), alert: true };
  return { line: null, button: t("older.messages.show"), alert: false };
}

/** One conversation's press, and where it stands. The press reads the conversation named when it is made, so a screen keyed by the
 *  conversation (as `ThreadChat` keys it) never reads another's. */
function useOlderMessages(bot: string, thread: string): { ui: OlderUi; show: () => void } {
  const [ui, setUi] = useState<OlderUi>(OLDER_IDLE);
  const mounted = useRef(true);
  const press = useRef<(() => Promise<void>) | null>(null);
  press.current ??= olderPress({ ask: () => getStore().actions.threadOlder(bot, thread), set: setUi, after: () => undefined, alive: () => mounted.current });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return { ui, show: () => void press.current?.() };
}

/** The button, drawn while the conversation has older messages than it shows. */
export function ShowOlderMessages({ bot, thread }: { bot: string; thread: string }) {
  const s = useStore();
  const { ui, show } = useOlderMessages(bot, thread);
  if (!s.chats[threadKey(bot, thread)]?.older) return null;
  const words = olderMessageWords(ui);
  const reading = ui.step === "reading";
  return (
    // data-find-skip: not part of what the conversation says, so a search in it never lands here
    <div className="th-older" data-testid="chat-older" data-state={ui.step} data-find-skip>
      {words.line && (
        <p role={words.alert ? "alert" : "status"} title={words.line} data-testid="chat-older-line">
          {words.line}
        </p>
      )}
      {/* aria-disabled, not disabled, while the page is read, so the focus stays on the button the person pressed */}
      <button type="button" className="th-older-b" aria-disabled={reading || undefined} aria-busy={reading || undefined} onClick={show} data-testid="chat-older-show">
        {words.button}
      </button>
    </div>
  );
}
