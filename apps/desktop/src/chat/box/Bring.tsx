// "Bring context from…" (item 97): the keyboard's way to what a drag of a row onto the box does. The + menu's row opens a list
// over the box with a search field: the chats the palette's switcher finds (History's own rows, its search), then the coding
// chats; arrows move, Enter brings the chat's context in as one chip (threadContext.ts), Esc closes. Nothing is sent.
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { composing } from "../../lib/ime";
import { historyDays } from "../../pages/HistoryPage";
import { getStore, type Actions, type AppState } from "../../state/store";
import { getSessions } from "../../sessions/sessions";
import { getHost } from "../../sessions/host";
import { agentLabel, folderName, type AgentInfo, type SessionRec } from "../../sessions/agents";
import { pickTitle } from "../../sessions/titles";
import { Icon } from "../../ui/icons";
import { carry, type Scope } from "./carry";
import { appReader } from "./contextReader";
import { bringContext, refKey, type ThreadRef } from "./threadContext";
import { threadKey } from "../../threads/types";
import "../parts/skills.css";

export interface BringRow {
  ref: ThreadRef;
  title: string;
  who: string;
}

/** The most rows the list shows; the search narrows the rest. */
const ROWS_MAX = 30;

/** The chats that can be brought into chat `self`'s box for `query`: the member threads the palette's switcher and History find
 *  (jobs have no chat to bring), newest first, then the coding chats that have started, newest first. */
export function bringRows(s: AppState & Actions, sessions: { list: readonly SessionRec[]; agents: AgentInfo[] | null; chatKey: (id: string) => string | null }, query: string, self: string, now = Date.now()): BringRow[] {
  const threads = historyDays(s, query, now)
    .flatMap((d) => d.rows)
    .flatMap((r): BringRow[] => (r.rowKey && r.kind !== "job" ? [{ ref: { kind: "thread", bot: r.bot, thread: r.key.slice(r.bot.length + 1) }, title: r.title, who: r.who }] : []));
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const coding = [...sessions.list]
    .filter((r) => r.status !== "draft" && !!sessions.chatKey(r.id))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((r): BringRow => ({ ref: { kind: "session", id: r.id }, title: pickTitle(r, folderName(r.cwd)).title, who: agentLabel(r.agent, sessions.agents) }))
    .filter((r) => words.every((w) => `${r.title} ${r.who}`.toLowerCase().includes(w)));
  const selfRef = (r: BringRow) => (r.ref.kind === "session" ? sessions.chatKey(r.ref.id) === self : threadKey(r.ref.bot, r.ref.thread) === self);
  return [...threads, ...coding].filter((r) => !selfRef(r)).slice(0, ROWS_MAX);
}

/** Bring `ref`'s context into chat `key`'s box, read through the app's own store, sessions and shell. Null when the chip was
 *  added, else the line the box shows. */
export const bringInto = (key: string, scope: Scope, ref: ThreadRef): Promise<string | null> =>
  bringContext(ref, { key, scope }, appReader({ store: getStore(), sessions: getSessions(), host: getHost() }), carry);

/** The list over the box. `rows` reads the chats for what is typed. */
export function BringPicker({ rows, onPick, onClose }: { rows: (query: string) => BringRow[]; onPick: (ref: ThreadRef) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useMemo(() => rows(query), [rows, query]);
  const at = Math.min(active, Math.max(0, list.length - 1));
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    pop.current?.querySelector(".sk-row.on")?.scrollIntoView({ block: "nearest" });
  }, [at]);
  return (
    <div className="sk-pop bring-pop" ref={pop} data-testid="bring-pop">
      <label className="bring-q">
        <Icon name="search" />
        <input
          autoFocus
          value={query}
          placeholder={t("carry.bringSearch")}
          aria-label={t("carry.bringSearch")}
          aria-controls="bring-list"
          aria-activedescendant={list.length ? `bring-${at}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={(e) => {
            // a click on a row keeps the list (the row takes it); leaving it anywhere else closes it
            if (!pop.current?.contains(e.relatedTarget as Node | null)) onClose();
          }}
          onKeyDown={(e) => {
            if (composing(e)) return;
            if ((e.key === "ArrowDown" || e.key === "ArrowUp") && list.length) {
              e.preventDefault();
              setActive((at + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (list[at]) onPick(list[at].ref);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          data-testid="bring-search"
        />
      </label>
      <div role="listbox" id="bring-list" aria-label={t("carry.bring")} className="bring-list">
        {list.length ? (
          list.map((r, i) => (
            <div
              key={refKey(r.ref)}
              id={`bring-${i}`}
              role="option"
              aria-selected={i === at}
              className={`sk-row${i === at ? " on" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== at && setActive(i)}
              onClick={() => onPick(r.ref)}
              data-testid="bring-option"
              data-ref={refKey(r.ref)}
            >
              <span className="sk-name">{r.title}</span>
              <span className="sk-d">{r.who}</span>
            </div>
          ))
        ) : (
          <div className="sk-none">{t("carry.bringNone")}</div>
        )}
      </div>
    </div>
  );
}
