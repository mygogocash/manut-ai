// What the side menu's pages share: the design canvas's screen frame (a top bar with the page's name and its actions,
// over a body that scrolls) and its empty state. A menu page is a place of its own, like the chat, so it has no back
// arrow: the menu beside it is the way on.
import type { ReactNode } from "react";
import { t } from "../i18n";
import type { MenuPage } from "../state/store";
import "./menuPages.css";

/** The pages that use the frame: the menu's own, and the two places opened from them (a job's page and the activity log,
 *  which return to where they were opened from and so carry a back arrow in `lead`). */
export type FramePage = MenuPage | "job" | "activity";

export function MenuPageFrame({
  page,
  title,
  acts,
  lead,
  middle,
  hideTitle,
  children,
}: {
  page: FramePage;
  title: string;
  acts?: ReactNode;
  /** before the title: a page opened from another carries its back arrow here */
  lead?: ReactNode;
  /** between the title and the acts: a tag, or the tabs that switch between two views of one place */
  middle?: ReactNode;
  /** the title is for screen readers only, as the activity log's is: its tabs name the place */
  hideTitle?: boolean;
  children: ReactNode;
}) {
  const heading = `page-${page}-title`;
  return (
    <section className="mpage" aria-labelledby={heading} data-testid={`page-${page}`}>
      <header className="top">
        {lead}
        <h1 id={heading} className={hideTitle ? "vh" : undefined}>
          {title}
        </h1>
        {middle}
        {acts && <div className="acts">{acts}</div>}
      </header>
      {/* The body fades in the first time the page opens in a session (lib/firstPaint.ts); the header does not move. */}
      <div className="mpage-body" data-arrive-body={page}>{children}</div>
    </section>
  );
}

/** An empty page, or an empty part of one: its row's drawing, what will be here, and why there is nothing yet. */
export function Empty({ icon, title, text, testId }: { icon: ReactNode; title: string; text: string; testId: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <span className="ico" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

/** A read that failed in a way the app did not word for people: the system-states board's "Something went wrong" (StatesSystem,
 *  item 85i). The page says it did not load and that nothing was changed, offers Try again, and keeps the runtime's own words
 *  for whoever is asked to look, under a small Details that stays shut until it is opened. */
export function LoadFailed({ details, onRetry, testId }: { details: string; onRetry: () => void; testId: string }) {
  return (
    <div className="failed" data-testid={testId}>
      <div className="banner err" role="alert">
        <span className="grow">{t("failed.text")}</span>
        <button type="button" className="btn" onClick={onRetry} data-testid={`${testId}-retry`}>
          {t("failed.retry")}
        </button>
      </div>
      <details className="failed-d">
        <summary>{t("failed.details")}</summary>
        <code data-testid={`${testId}-details`}>{details}</code>
      </details>
    </div>
  );
}
