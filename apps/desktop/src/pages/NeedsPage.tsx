// Needs you: every approval and question waiting on the person, in any member's chat, thread or terminal session,
// newest first. It is the sidebar's old Needs-you strip made a page, built from the strip's own pieces
// (src/sidebar/Needs.tsx). Each row is the design canvas's ask (Approvals.dc.html): who asks and what they do, what is
// asked in its card's words with the exact action under it, which kind it is, and since when it waits, with Look first,
// which opens that chat with the ask scrolled into view and focused, as the strip did and ⌘J still does. So does the row
// itself. With several shops, every shop's asks are here together, and each row names its shop (docs/several-shops.md). Nothing is approved from this list: an ask settles on its card in the chat, its one place (Home alone offers
// Approve, for a plain command, through the same path).
import type { ReactNode } from "react";
import { t } from "../i18n";
import { askFrom, askText, chatTarget, isSessionChat, selectAsks, shopName, useStore, type Actions, type AppState, type Ask } from "../state/store";
import { useNow } from "../elsewhere/useNow";
import { AskLine, age } from "../sidebar/Needs";
import { MenuIcon } from "../sidebar/menuIcons";
import { SessionFace } from "../sessions/SessionFace";
import { Avatar } from "../ui";
import { askLines } from "./home";
import { whenText } from "./job";
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
  /** what the member who asks does ("Sales chat"); none for a terminal session */
  role?: string;
  /** the shop the ask comes from, when the runtime shows several */
  shop?: string;
  /** the ask in its card's words (an approval's title, or the question) */
  title?: string;
  /** the exact action an approval names, as its card shows it */
  action?: string | null;
  /** when it was asked ("09:14", "Yesterday 18:40"), beside how long ago */
  asked?: string;
}

/** Newest first; asks of the same moment keep their order. The store lists them oldest first, for ⌘J. */
export function newestFirst(asks: readonly Ask[]): Ask[] {
  return [...asks].sort((a, b) => b.ts - a.ts);
}

/** The rows for every open ask in the store, newest first, each opening its chat on the ask. */
export function needRows(s: AppState & Actions, nowMs: number): NeedRow[] {
  return newestFirst(selectAsks(s)).map((a) => {
    const { title, action } = askLines(a.item);
    const role = isSessionChat(a.bot) ? "" : (s.bots.find((b) => b.name === chatTarget(a.bot).bot)?.description ?? "");
    return {
      key: `${a.bot}:${a.item.id}`,
      who: askFrom(s, a.bot),
      kind: a.item.kind,
      text: askText(a.item),
      age: age(a.ts, nowMs),
      face: isSessionChat(a.bot) ? <SessionFace chatKey={a.bot} size={32} /> : <Avatar bot={a.bot} size={32} />,
      open: () => void s.jumpToAsk(a.bot, a.item.id),
      ...(role ? { role } : {}),
      ...(a.item.kind === "approval" && a.item.shop ? { shop: shopName(s, a.item.shop) } : {}),
      title,
      action,
      asked: whenText(a.ts, nowMs),
    };
  });
}

export function NeedsView({ rows }: { rows: NeedRow[] }) {
  return (
    <MenuPageFrame page="needs" title={t("menu.needs")}>
      <div className="col">
        {rows.length ? (
          <ul className="rows" aria-label={t("needs.list")}>
            {rows.map((r, i) => (
              <li key={r.key} className="tli">
                <div className="rowl trow need" data-testid="needs-row">
                  <button type="button" className="rowmain" onClick={r.open} aria-describedby={`needs-ask-${i}`} data-testid="needs-open">
                    {r.face}
                    <span className="grow">
                      <span className="l1" id={`needs-ask-${i}`}>
                        <AskLine text={r.title ?? r.text} />
                      </span>
                      {r.action && <code className="act">{r.action}</code>}
                      <span className="l2">
                        {[r.who, r.shop, r.role].filter(Boolean).join(" · ")}
                        {r.asked && ` · ${t("needs.since", { when: r.asked })}`}
                      </span>
                    </span>
                    <span className="tag">{r.kind === "approval" ? t("needs.approve") : t("needs.question")}</span>
                    <span className="when">{r.age}</span>
                  </button>
                  <button type="button" className="btn look" onClick={r.open} aria-describedby={`needs-ask-${i}`} data-testid="needs-look">
                    {t("home.look")}
                  </button>
                </div>
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
  // The ages move on while asks wait.
  const now = useNow(selectAsks(s).length > 0, 5_000);
  return <NeedsView rows={needRows(s, now)} />;
}
