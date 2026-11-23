// What the side menu's pages share: the design canvas's screen frame (a top bar with the page's name and its actions,
// over a body that scrolls) and its empty state. A menu page is a place of its own, like the chat, so it has no back
// arrow: the menu beside it is the way on.
import type { ReactNode } from "react";
import type { MenuPage } from "../state/store";
import "./menuPages.css";

export function MenuPageFrame({ page, title, acts, children }: { page: MenuPage; title: string; acts?: ReactNode; children: ReactNode }) {
  const heading = `page-${page}-title`;
  return (
    <section className="mpage" aria-labelledby={heading} data-testid={`page-${page}`}>
      <header className="top">
        <h1 id={heading}>{title}</h1>
        {acts && <div className="acts">{acts}</div>}
      </header>
      <div className="mpage-body">{children}</div>
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
