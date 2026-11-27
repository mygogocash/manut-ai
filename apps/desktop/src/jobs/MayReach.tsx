// The "Kit may reach" list under a coding chat's box (item 102k; `docs/several-agents.md`, "5. What an agent may do to other chats"):
// the chats the person put in front of this chat's agent, each with its number (what Kit calls it) and an ×, and an Add that opens
// item 97's Bring context picker to pick another. Only the person adds or removes; the agent is told what is listed and may ask
// about those chats only, each time on a card. With nothing listed it is one quiet button, so a chat that never reaches another
// shows nothing more than that.
//
// On the Connected runtime the same list is "Buddy may reach", under the box of Buddy's main chat and of each conversation, listing the
// shop's other conversations (item 102l-3, `BuddyMayReach`, over `buddyReach.ts`). It is offered only to the shop's owner, the one
// person who chats with Buddy there.
//
// `MayReachView` draws from props alone, so a test renders it; `MayReach` is the box's, over the sessions store.
import "./reach.css";
import { useCallback, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { revealHidden } from "../lib/secrets";
import { useStore } from "../state/store";
import { getSessions, useSessions } from "../sessions/sessions";
import type { SessionRec } from "../sessions/agents";
import { BringPicker, bringRows, type BringRow } from "../chat/box/Bring";
import { refKey, type ThreadRef } from "../chat/box/threadContext";
import type { ReachEntry } from "./reachList";
import { getBuddyReach } from "./buddyReachApp";

/** The list's words: Kit's on a coding chat, Buddy's on the Connected runtime (item 102l-3). */
const WORDS = {
  kit: { list: "reach.list", listTip: "reach.listTip", add: "reach.add", addMore: "reach.addMore", number: "reach.number" },
  buddy: { list: "reach.buddy.list", listTip: "reach.buddy.listTip", add: "reach.buddy.add", addMore: "reach.buddy.addMore", number: "reach.buddy.number" },
} as const;

export interface MayReachViewProps {
  list: readonly ReachEntry[];
  /** Buddy's list on Connected, in Buddy's words */
  buddy?: boolean;
  /** the line the last add left: why a chat was not added */
  line?: string | null;
  /** the picker is open over the box */
  picking?: boolean;
  rows?: (query: string) => BringRow[];
  onAdd?: () => void;
  onPick?: (ref: ThreadRef) => void;
  onClose?: () => void;
  onRemove?: (n: number) => void;
}

/** The list from props alone: one quiet button while it is empty, else its chips and an add. */
export function MayReachView({ list, buddy, line, picking, rows, onAdd, onPick, onClose, onRemove }: MayReachViewProps) {
  const w = WORDS[buddy ? "buddy" : "kit"];
  return (
    <div className={`rc-list${list.length ? " has" : ""}`} data-testid="reach-list">
      {list.length ? (
        <>
          <span className="rc-h" title={t(w.listTip)}>
            <Icon name="link" size={12} />
            {t(w.list)}
          </span>
          {list.map((e) => (
            <span key={e.n} className="rc-chip" data-testid="reach-chip" data-n={e.n} title={revealHidden(e.title)}>
              <span className="rc-n" aria-label={t(w.number, { n: e.n })}>
                {e.n}
              </span>
              <span className="rc-t">{revealHidden(e.title)}</span>
              <button type="button" className="rc-x" aria-label={t("reach.remove", { title: revealHidden(e.title) })} onClick={() => onRemove?.(e.n)} data-testid="reach-remove">
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <button type="button" className="rc-add icon" aria-label={t(w.addMore)} title={t(w.addMore)} onClick={onAdd} data-testid="reach-add">
            <Icon name="plus" size={12} />
          </button>
        </>
      ) : (
        <button type="button" className="rc-add" title={t(w.listTip)} onClick={onAdd} data-testid="reach-add">
          <Icon name="link" size={12} />
          {t(w.add)}
        </button>
      )}
      {line && (
        <span className="rc-msg" role="status" data-testid="reach-msg">
          {line}
        </span>
      )}
      {picking && rows && onPick && onClose && <BringPicker rows={rows} onPick={onPick} onClose={onClose} />}
    </div>
  );
}

/** Session `rec`'s list, or nothing where it is not offered (a draft, a workflow's lane, an agent in its terminal, a folder chat). */
export function MayReach({ rec, chatKey }: { rec: SessionRec; chatKey: string }) {
  useSessions(); // the list is the session's own record: it redraws when that changes
  const store = useStore();
  const [picking, setPicking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const list = rec.reach ?? [];
  // the chats Bring context from… offers, less the ones already listed
  const rows = useCallback(
    (query: string) => {
      const ss = getSessions();
      const listed = new Set((rec.reach ?? []).map((e) => refKey(e.ref)));
      return bringRows(store, { list: ss.getState().list, agents: ss.getState().agents, chatKey: ss.chatKey }, query, chatKey).filter((r) => !listed.has(refKey(r.ref)));
    },
    [store, chatKey, rec.reach],
  );
  if (!getSessions().reachOffered(rec.id)) return null;
  return (
    <MayReachView
      list={list}
      line={line}
      picking={picking}
      rows={rows}
      onAdd={() => {
        setLine(null);
        setPicking(true);
      }}
      onPick={(ref) => {
        setPicking(false);
        setLine(getSessions().addReach(rec.id, ref));
      }}
      onClose={() => setPicking(false)}
      onRemove={(n) => {
        setLine(null);
        getSessions().removeReach(rec.id, n);
      }}
    />
  );
}

const NONE: readonly ReachEntry[] = [];

/** Buddy's list under the box of Buddy's chat `chatKey` on Connected (item 102l-3): the shop's other conversations the person put in
 *  front of Buddy there. Nothing where it is not offered: another runtime, a shop the person only helps at, a task's notes. */
export function BuddyMayReach({ chatKey }: { chatKey: string }) {
  const reach = getBuddyReach();
  // the list is the cards' own, in memory; the store says which shop is shown and which conversations it has
  useStore();
  const list = useSyncExternalStore(reach.subscribe, () => (reach.offered(chatKey) ? reach.listOf(chatKey) : NONE));
  const [picking, setPicking] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const rows = useCallback((query: string) => reach.rows(chatKey, query), [reach, chatKey]);
  if (!reach.offered(chatKey)) return null;
  return (
    <MayReachView
      list={list}
      buddy
      line={line}
      picking={picking}
      rows={rows}
      onAdd={() => {
        setLine(null);
        setPicking(true);
      }}
      onPick={(ref) => {
        setPicking(false);
        setLine(reach.add(chatKey, ref));
      }}
      onClose={() => setPicking(false)}
      onRemove={(n) => {
        setLine(null);
        reach.remove(chatKey, n);
      }}
    />
  );
}
