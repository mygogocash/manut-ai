// The "Kit may reach" list under a coding chat's box (item 102k; `docs/several-agents.md`, "5. What an agent may do to other chats"):
// the chats the person put in front of this chat's agent, each with its number (what Kit calls it) and an ×, and an Add that opens
// item 97's Bring context picker to pick another. Only the person adds or removes; the agent is told what is listed and may ask
// about those chats only, each time on a card. With nothing listed it is one quiet button, so a chat that never reaches another
// shows nothing more than that.
//
// `MayReachView` draws from props alone, so a test renders it; `MayReach` is the box's, over the sessions store.
import "./reach.css";
import { useCallback, useState } from "react";
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { revealHidden } from "../lib/secrets";
import { useStore } from "../state/store";
import { getSessions, useSessions } from "../sessions/sessions";
import type { SessionRec } from "../sessions/agents";
import { BringPicker, bringRows, type BringRow } from "../chat/box/Bring";
import { refKey, type ThreadRef } from "../chat/box/threadContext";
import type { ReachEntry } from "./reachList";

export interface MayReachViewProps {
  list: readonly ReachEntry[];
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
export function MayReachView({ list, line, picking, rows, onAdd, onPick, onClose, onRemove }: MayReachViewProps) {
  return (
    <div className={`rc-list${list.length ? " has" : ""}`} data-testid="reach-list">
      {list.length ? (
        <>
          <span className="rc-h" title={t("reach.listTip")}>
            <Icon name="link" size={12} />
            {t("reach.list")}
          </span>
          {list.map((e) => (
            <span key={e.n} className="rc-chip" data-testid="reach-chip" data-n={e.n} title={revealHidden(e.title)}>
              <span className="rc-n" aria-label={t("reach.number", { n: e.n })}>
                {e.n}
              </span>
              <span className="rc-t">{revealHidden(e.title)}</span>
              <button type="button" className="rc-x" aria-label={t("reach.remove", { title: revealHidden(e.title) })} onClick={() => onRemove?.(e.n)} data-testid="reach-remove">
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <button type="button" className="rc-add icon" aria-label={t("reach.addMore")} title={t("reach.addMore")} onClick={onAdd} data-testid="reach-add">
            <Icon name="plus" size={12} />
          </button>
        </>
      ) : (
        <button type="button" className="rc-add" title={t("reach.listTip")} onClick={onAdd} data-testid="reach-add">
          <Icon name="link" size={12} />
          {t("reach.add")}
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
