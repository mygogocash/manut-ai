import type { CSSProperties, ReactNode } from "react";
import { dayOffset, formatClock, formatDate } from "../format";

/// The pieces the owner's two pages share, the approval page and the deletion page, so both look and read the
/// same: the card, the notice for a link that cannot be used, the loading skeleton, and how an expiry is said.

export const OWNER_CARD: CSSProperties = { padding: 16, display: "flex", flexDirection: "column", gap: 12 };
/// Buttons the owner presses on a phone: at least 44px tall, sharing the row.
export const OWNER_TOUCH: CSSProperties = { minHeight: 44, flex: "1 1 0" };
/// A button that stands alone, such as the retry in a notice: the same 44px, with no share of a row to take.
export const OWNER_TAP: CSSProperties = { minHeight: 44 };
/// The column both pages sit in: a phone's reading width, and words that have nowhere to break (a customer's name made of
/// one word, an order id, a link) break at the edge of their card instead of running out of it and widening the page. The
/// message and the reply say the same for themselves, because that is where such words usually are; a name in a heading,
/// at a larger text size, is the other place, and this covers it and every other line the page writes.
export const OWNER_MAIN: CSSProperties = { maxWidth: 560, padding: "16px 16px 40px", gap: 16, overflowWrap: "anywhere" };

/// The words `whenText` needs from a page's strings table.
export type WhenWords = {
  locale: string;
  whenToday: (clock: string) => string;
  whenTomorrow: (clock: string) => string;
  whenOn: (clock: string, date: string) => string;
};

/// "14:05 today", "14:05 tomorrow", or "14:05 on 25 November", on the shop's calendar.
export function whenText(words: WhenWords, iso: string, now: number = Date.now()): string {
  const clock = formatClock(iso, words.locale);
  const offset = dayOffset(iso, now);
  if (offset === 0) return words.whenToday(clock);
  if (offset === 1) return words.whenTomorrow(clock);
  return words.whenOn(clock, formatDate(iso, words.locale));
}

export function Loading({ label }: { label: string }) {
  return (
    <div className="box" style={OWNER_CARD} role="status" aria-busy="true">
      <span className="vh">{label}</span>
      <div className="skel" style={{ width: "45%", height: 14 }} />
      <div className="skel" style={{ width: "90%", height: 20 }} />
      <div className="skel" style={{ width: "100%", height: 72 }} />
      <div className="skel" style={{ width: "100%", height: 44 }} />
    </div>
  );
}

export function Notice({ icon, title, body, children }: { icon: ReactNode; title: string; body: string; children?: ReactNode }) {
  return (
    <section className="box empty">
      <span className="ico">{icon}</span>
      <h2 style={{ margin: "4px 0 0", fontSize: 15, fontWeight: 600 }}>{title}</h2>
      <p>{body}</p>
      {children}
    </section>
  );
}

export function Pulse() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 6,
        height: 6,
        borderRadius: "var(--rad-pill)",
        background: "currentColor",
        animation: "pulse 1.6s ease-in-out infinite",
      }}
    />
  );
}
