// Needs you: every approval and question waiting on the person, in any member's chat, thread or terminal session,
// newest first. It is the sidebar's old Needs-you strip made a page, built from the strip's own pieces
// (src/sidebar/Needs.tsx). Each ask is one card, as the design canvas's Needs you draws a decision (Approvals.dc.html):
// who asks, what they do and since when it waits, with its amber mark (the colour of waiting for a person) saying which
// kind it is; then what is asked as the kit's 17px line, with the exact action under it, whole; then Look first, which
// opens that chat with the ask scrolled into view and focused, as the strip did and ⌘J still does. So does the card
// itself. With several shops, every shop's asks are here together, and each card names its shop (docs/several-shops.md).
// Nothing is approved from this list: an ask settles on its card in the chat, its one place (Home alone offers Approve,
// for a plain command, through the same path). The board draws Approve on each card here; the app keeps the decision of
// 24 Nov 2026 (docs/decisions.md) that an owner reads the card before approving, so Look first is the card's one action.
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
import "./needs.css";

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
  /** the action is shown whole, as its card shows it: a browser write's sentence, never cut or scrolled away */
  whole?: boolean;
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
    const { title, action, whole } = askLines(a.item);
    const role = isSessionChat(a.bot) ? "" : (s.bots.find((b) => b.name === chatTarget(a.bot).bot)?.description ?? "");
    return {
      key: `${a.bot}:${a.item.id}`,
      who: askFrom(s, a.bot),
      kind: a.item.kind,
      text: askText(a.item),
      age: age(a.ts, nowMs),
      face: isSessionChat(a.bot) ? <SessionFace chatKey={a.bot} size={32} /> : <Avatar bot={a.bot} size={32} live />,
      open: () => void s.jumpToAsk(a.bot, a.item.id),
      ...(role ? { role } : {}),
      ...(a.item.kind === "approval" && a.item.shop ? { shop: shopName(s, a.item.shop) } : {}),
      title,
      action,
      ...(whole ? { whole: true } : {}),
      asked: whenText(a.ts, nowMs),
    };
  });
}

/** The one time a card shows: when it was asked ("Waiting since 09:14"), or how long ago when that is not known. */
function waited(r: NeedRow): string {
  return r.asked ? t("needs.since", { when: r.asked }) : r.age;
}

export function NeedsView({ rows }: { rows: NeedRow[] }) {
  return (
    <MenuPageFrame page="needs" title={t("menu.needs")}>
      <div className="col">
        {rows.length ? (
          <ul className="needs" aria-label={t("needs.list")} data-arrive="needs" data-arrive-rows=":scope > li">
            {rows.map((r, i) => (
              <li key={r.key} data-ask>
                <article className="need" data-testid="needs-row">
                  {/* The card opens the ask, as the row did: this button reaches over the whole card (needs.css). */}
                  <button type="button" className="need-open" onClick={r.open} aria-describedby={`needs-ask-${i}`} data-testid="needs-open">
                    <span className="need-h">
                      {r.face}
                      <span className="need-who">{[r.who, r.shop, r.role, waited(r)].filter(Boolean).join(" · ")}</span>
                      <span className="tag warn">{r.kind === "approval" ? t("needs.approve") : t("needs.question")}</span>
                    </span>
                    <span className="l1" id={`needs-ask-${i}`}>
                      <AskLine text={r.title ?? r.text} />
                    </span>
                    {r.action && <code className={r.whole ? "act whole" : "act"}>{r.action}</code>}
                  </button>
                  <div className="need-acts">
                    <button type="button" className="btn look" onClick={r.open} aria-describedby={`needs-ask-${i}`} data-testid="needs-look">
                      {t("home.look")}
                    </button>
                  </div>
                </article>
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
