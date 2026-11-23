// Needs you: every approval and question waiting on the person, in any member's chat, thread or terminal session,
// newest first. It is the sidebar's old Needs-you strip made a page, built from the strip's own pieces
// (src/sidebar/Needs.tsx): each row says what is asked, by whom, which kind, and how long ago, and opens that chat
// with the ask scrolled into view and focused, as the strip did and ⌘J still does. Nothing is approved from this
// list: an ask settles on its card in the chat, its one place.
import type { ReactNode } from "react";
import { t } from "../i18n";
import { askFrom, askText, isSessionChat, selectAsks, useStore, type Actions, type AppState, type Ask } from "../state/store";
import { useNow } from "../elsewhere/useNow";
import { AskLine, age } from "../sidebar/Needs";
import { MenuIcon } from "../sidebar/menuIcons";
import { SessionFace } from "../sessions/SessionFace";
import { Avatar } from "../ui";
import { Empty, MenuPageFrame } from "./MenuPage";

/** One ask as its row shows it. */
export interface NeedRow {
  key: string;
  /** who asks: the member's name, or a terminal session's folder and agent */
  who: string;
  kind: "approval" | "clarify";
  /** the ask in one line, `code` in backticks */
  text: string;
  /** how long it has waited ("now", "3m") */
  age: string;
  face: ReactNode;
  open: () => void;
}

/** Newest first; asks of the same moment keep their order. The store lists them oldest first, for ⌘J. */
export function newestFirst(asks: readonly Ask[]): Ask[] {
  return [...asks].sort((a, b) => b.ts - a.ts);
}

/** The rows for every open ask in the store, newest first, each opening its chat on the ask. */
export function needRows(s: AppState & Actions, nowMs: number): NeedRow[] {
  return newestFirst(selectAsks(s)).map((a) => ({
    key: `${a.bot}:${a.item.id}`,
    who: askFrom(s, a.bot),
    kind: a.item.kind,
    text: askText(a.item),
    age: age(a.ts, nowMs),
    face: isSessionChat(a.bot) ? <SessionFace chatKey={a.bot} size={32} /> : <Avatar bot={a.bot} size={32} />,
    open: () => void s.jumpToAsk(a.bot, a.item.id),
  }));
}

export function NeedsView({ rows }: { rows: NeedRow[] }) {
  return (
    <MenuPageFrame page="needs" title={t("menu.needs")}>
      <div className="col">
        {rows.length ? (
          <ul className="rows" aria-label={t("needs.list")}>
            {rows.map((r) => (
              <li key={r.key}>
                <button type="button" className="rowl" onClick={r.open} data-testid="needs-row">
                  {r.face}
                  <span className="grow">
                    <span className="l1">
                      <AskLine text={r.text} />
                    </span>
                    <span className="l2">{r.who}</span>
                  </span>
                  <span className="tag">{r.kind === "approval" ? t("needs.approve") : t("needs.question")}</span>
                  <span className="when">{r.age}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={<MenuIcon row="needs" />} title={t("needs.emptyTitle")} text={t("needs.emptyText")} testId="needs-empty" />
        )}
      </div>
    </MenuPageFrame>
  );
}

export function NeedsPage() {
  const s = useStore();
  // the ages move on while asks wait
  const now = useNow(selectAsks(s).length > 0, 5_000);
  return <NeedsView rows={needRows(s, now)} />;
}
