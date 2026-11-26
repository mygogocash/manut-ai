// Send when the limit resets (item 95; the rules are later.ts's): the watcher that sends a waiting message once its
// account is usable again, the row a chat shows while one waits, and the question a message long past its reset asks, in
// its chat and on Home. Only coding chats (SESSIONS) know which account they run on, so only they offer to wait.
import { useEffect } from "react";
import "../chat.css";
import "../cards/cards.css";
import { t } from "../../i18n";
import { getStore } from "../../state/store";
import { getSessions, ACCOUNT_CLI } from "../../sessions/sessions";
import type { SessionRec } from "../../sessions/agents";
import { getDraft, setDraft } from "../../app/drafts";
import { joinDraft } from "../../app/stash";
import { accountGroups, reloadAccounts, useAccounts } from "../../settings/accounts/useAccounts";
import { clock } from "../../sidebar/usageFormat";
import { allWaiting, cancelWait, limitOf, look, sendWaiting, useWaiting, waitFor, WATCH_MS, type Limit, type Waiting } from "./later";

/** The account session `rec` runs on, when it is at its limit with a reset ahead (what Accounts reads as Limited until). */
export function sessionLimit(groups: Parameters<typeof limitOf>[0], rec: Pick<SessionRec, "agent" | "account">, nowS: number): Limit | null {
  return limitOf(groups, ACCOUNT_CLI[rec.agent], rec.account ?? "default", nowS);
}

/** Send a waiting message to the chat it was written in. Only a running coding chat takes one; anything else throws,
 *  and the message stays, asking the person. */
export async function sendToChat(key: string, text: string): Promise<void> {
  if (!key.startsWith("agent:")) throw new Error("not a coding chat");
  const id = key.slice(6);
  const rec = getSessions().getState().list.find((r) => r.id === id);
  if (!rec || rec.status !== "running") throw new Error("not running");
  if (!(await getSessions().send(id, text))) throw new Error("not sent");
}

/** Cancel the message waiting in `key`: its words go back to that chat's box, after what the box holds. */
export function cancelInto(key: string): void {
  const text = cancelWait(key);
  if (text === null) return;
  const next = joinDraft(getDraft(key), text);
  setDraft(key, next);
  getStore().dispatch({ type: "ui.draft", bot: key, text: next });
}

/** For a coding chat's box: when its account is at its limit, until when, and the button's way to keep the words. */
export function useLimitOffer(key: string, rec: Pick<SessionRec, "agent" | "account">): { until: string; onWait: (text: string) => boolean } | null {
  const { groups } = useAccounts();
  const now = Date.now();
  const limit = sessionLimit(groups, rec, now / 1000);
  if (!limit) return null;
  return { until: clock(limit.until, now / 1000), onWait: (text) => waitFor(key, text, limit) };
}

/** The question a message long past its reset asks (in its chat, and on Home with Open). */
function LateQuestion({ w, where, onOpen }: { w: Waiting; where?: string; onOpen?: () => void }) {
  const since = clock(w.since / 1000, Date.now() / 1000);
  return (
    <>
      <span className="later-words">{where ? t("later.lateOf", { name: where, since }) : t("later.late", { since })}</span>
      <span className="later-acts">
        <button type="button" className="card-btn primary" onClick={() => void sendWaiting(w.key, sendToChat).catch(() => undefined)} data-testid="later-send-now">
          {t("later.sendNow")}
        </button>
        {onOpen && (
          <button type="button" className="card-btn" onClick={onOpen} data-testid="later-open">
            {t("later.open")}
          </button>
        )}
        <button type="button" className="card-btn" onClick={() => cancelInto(w.key)} data-testid="later-cancel">
          {t("later.cancel")}
        </button>
      </span>
    </>
  );
}

/** Above a chat's box while a message waits in it: what waits and until when, with Cancel; past the hour, the question. */
export function WaitingRow({ chatKey }: { chatKey: string }) {
  const w = useWaiting(chatKey);
  if (!w) return null;
  const now = Date.now();
  const due = now >= w.at * 1000;
  return (
    <div className="later-row" role="status" data-testid="later-row" data-late={w.late ? "true" : "false"}>
      {w.late ? (
        <LateQuestion w={w} />
      ) : (
        <>
          <span className="later-words">
            {due ? t("later.waitingReady") : t("later.waiting", { when: clock(w.at, now / 1000) })}
            <span className="later-text"> {w.text.replace(/\s+/g, " ").trim()}</span>
          </span>
          <span className="later-acts">
            <button type="button" className="card-btn" onClick={() => cancelInto(chatKey)} data-testid="later-cancel">
              {t("later.cancel")}
            </button>
          </span>
        </>
      )}
    </div>
  );
}

/** On Home: each message long past its reset, asking before it goes. */
export function LateOnHome({ items }: { items: { w: Waiting; name: string; open: () => void }[] }) {
  if (!items.length) return null;
  return (
    <div className="wide later-home" role="region" aria-label={t("later.title")} data-testid="home-later">
      {items.map(({ w, name, open }) => (
        <div key={w.key} className="later-row" role="status" data-testid="later-row" data-late="true">
          <LateQuestion w={w} where={name} onOpen={open} />
        </div>
      ))}
    </div>
  );
}

/** Mounted once beside the accounts watcher: looks at every waiting message every half minute and whenever the accounts
 *  are read again, and sends those that are due. Renders nothing. */
export function LaterWatcher() {
  const { groups } = useAccounts();
  useEffect(() => {
    void look(groups, Date.now(), sendToChat);
  }, [groups]);
  useEffect(() => {
    const h = setInterval(() => {
      const now = Date.now();
      const waiting = allWaiting();
      if (!waiting.length) return;
      // a reset has passed: read the accounts again (they ask each CLI, so only then), so a lifted limit is seen now
      // rather than at the accounts' next minute
      const due = waiting.some((w) => !w.late && now >= w.at * 1000);
      void (due ? reloadAccounts() : Promise.resolve()).then(() => look(accountGroups(), Date.now(), sendToChat));
    }, WATCH_MS);
    return () => clearInterval(h);
  }, []);
  return null;
}
