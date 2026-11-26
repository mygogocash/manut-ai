// Continue with… in a coding chat's box (item 97, continueWith.ts): the agent chip opens a menu of the installed agents that chat
// and the other models of this chat's own agent. A pick reads this chat's context with no model (chat/box/threadContext.ts) and
// opens a new chat in the same lane with it above the box, unsent. The quiet lines that link the two chats both ways, and the old
// chat's Stop while it is idle, are here too.
import { useRef, useState } from "react";
import { t } from "../i18n";
import { getStore, useStore } from "../state/store";
import { Popover } from "../ui";
import { AgentMark } from "./AgentMark";
import { agentLabel, chatAgents, offeredAgents, type SessionRec } from "./agents";
import { getHost } from "./host";
import { getSessions, useSessions } from "./sessions";
import { continuePicks, type ContinuePick } from "./continueWith";
import { appReader } from "../chat/box/contextReader";
import { gatherContext, refKey, type ThreadRef } from "../chat/box/threadContext";

/** The started chat's agent in its box: a quiet button whose menu is Continue with…. */
export function AgentContinue({ rec }: { rec: SessionRec }) {
  const ss = useSessions();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const label = agentLabel(rec.agent, ss.agents);
  const picks = continuePicks(rec, chatAgents(offeredAgents(ss.agents ?? []), ss.recent), ss.models[rec.id]);
  const pick = async (p: ContinuePick) => {
    setBusy(true);
    setErr(null);
    try {
      const ref: ThreadRef = { kind: "session", id: rec.id };
      const got = await gatherContext(ref, appReader({ store: getStore(), sessions: getSessions(), host: getHost() }));
      getSessions().continueWith(rec.id, p, { title: got.title, text: got.text, ref: refKey(ref), scope: got.scope });
      setOpen(false);
    } catch (e) {
      setErr(t("cont.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="bx-w">
      <button
        ref={btn}
        type="button"
        className={`ss-pick ss-cont${open ? " on" : ""}`}
        title={t("cont.tip", { agent: label })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="session-agent-fixed"
      >
        <AgentMark agent={rec.agent} size={14} />
        <span className="ss-pick-n">{label}</span>
      </button>
      <Popover
        open={open}
        onClose={(why) => {
          setOpen(false);
          if (why === "escape") btn.current?.focus();
        }}
        side="top"
        align="left"
        width={280}
        label={t("cont.menu")}
        className="mp-pop bx-pop"
      >
        <div data-testid="continue-menu" aria-busy={busy}>
          <div className="mp-h cont-h">{t("cont.menu")}</div>
          {picks.length ? (
            picks.map((p, i) => (
              <button
                key={`${p.agent}/${p.model?.id ?? ""}`}
                type="button"
                className="mp-opt"
                autoFocus={i === 0}
                disabled={busy}
                onClick={() => void pick(p)}
                data-testid="continue-pick"
                data-agent={p.agent}
              >
                <AgentMark agent={p.agent} size={16} />
                <span className="mp-n">{p.model ? `${agentLabel(p.agent, ss.agents)} · ${p.model.label}` : agentLabel(p.agent, ss.agents)}</span>
              </button>
            ))
          ) : (
            <div className="mp-empty" data-testid="continue-none">
              {t("cont.none")}
            </div>
          )}
          {err && (
            <div className="mp-note" role="alert" data-testid="continue-error">
              {err}
            </div>
          )}
          <div className="mp-f">{t("cont.note")}</div>
        </div>
      </Popover>
    </span>
  );
}

/** The quiet lines that link a chat with the one it continued in or from, each with Open; the old chat also offers to stop its
 *  agent while it is idle (never while it works). Nothing for a chat with no such link. */
export function ContinueLines({ rec }: { rec: SessionRec }) {
  const ss = useSessions();
  const s = useStore();
  const into = rec.continuedIn ? ss.list.find((r) => r.linkId === rec.continuedIn) : undefined;
  const from = rec.continuedFrom ? ss.list.find((r) => r.linkId === rec.continuedFrom) : undefined;
  if (!into && !from) return null;
  const key = getSessions().chatKey(rec.id);
  const idle = rec.status === "running" && !(key && s.chats[key]?.turn);
  const line = (other: SessionRec, words: string, stop: boolean) => (
    <div className="ss-own ss-cont-line" role="note" data-testid="continue-line" data-to={other.id}>
      <span>{words}</span>
      <button type="button" className="lk" onClick={() => s.openSession(other.id)} data-testid="continue-open">
        {t("cont.open")}
      </button>
      {stop && (
        <button type="button" className="lk" title={t("cont.stopTip")} onClick={() => void getSessions().stopIdle(rec.id)} data-testid="continue-stop">
          {t("cont.stop", { agent: agentLabel(rec.agent, ss.agents) })}
        </button>
      )}
    </div>
  );
  return (
    <>
      {from && line(from, t("cont.from", { agent: agentLabel(from.agent, ss.agents) }), false)}
      {into && line(into, t("cont.in", { agent: agentLabel(into.agent, ss.agents) }), idle)}
    </>
  );
}

/** What the box of chat `rec` says while the chat it is linked with works in their lane, or null (continueWith.ts `busyMate`). */
export function useLaneWait(rec: SessionRec): string | null {
  useStore();
  const ss = useSessions();
  const mate = getSessions().waitsFor(rec.id);
  return mate ? t("cont.wait", { agent: agentLabel(mate.agent, ss.agents) }) : null;
}
