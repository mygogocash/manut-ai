// What Customize › Connections asks of a runtime about the shop's Google Sheet for Ton's books (docs/connectors.md, 4b; the routes
// are docs/pilot-api.md, "Google Sheets for Ton's books"): whether Google is connected and the sheet Ton writes to, Google's
// consent page for the owner to open, disconnecting, and asking Ton for a month. Like the Connections and People ops
// (connections.ts, people.ts) the shapes live here, beside the runtime, and `OpMap` in lib/protocol.ts extends them, so a runtime
// that does not answer one does not compile.
//
// The rules are the API's (apps/api/src/google-connect.ts): only the shop's owner sees or changes these, and the shop is the
// session's. A runtime answers for the shop the switcher shows, and every change names the shop its row was read for, so a change
// never lands on another shop because the switcher moved meanwhile.
//
// Google's consent address is a credential until it is used or ends: it carries a one-use state and a PKCE challenge. It crosses
// the protocol once, in `google.connect`, to be opened in the system browser, and is kept nowhere else: no state, no store, no
// log. No answer holds a token of Google's. Times are seconds since the epoch, as everywhere in the protocol.

import { locale, t } from "../i18n";

/** One month the sheet was sent, as the API lists it (`AppendedMonth`): never its rows. */
export interface SentMonth {
  /** `YYYY-MM` */
  month: string;
  /** when the send began */
  at: number;
  /** rows after the header row */
  rows: number;
  /** `unknown`: Google's answer left it open whether the rows landed, or never came, so they may or may not be in the sheet */
  outcome: "confirmed" | "unknown";
}

/** The sheet Ton appends to. */
export interface BooksSheet {
  /** its name as the owner sees it in Google Drive */
  title: string;
  /** where it opens (https), or null when the API gave none */
  url: string | null;
  /** what was sent to it, newest first, at most two years' worth */
  sent: SentMonth[];
}

/** Where Google Sheets stands for a shop.
 *  - `off`: the API says `google_not_configured`, so no environment has the owner's Google client yet.
 *  - `none`: not connected.
 *  - `working`: connected; `sheet` is null until Ton first asks for a month, which makes the sheet.
 *  - `broken`: Google refused the grant (the access was removed in the owner's Google account, or ran out), so nothing is sent
 *    until the owner connects again. */
export type GoogleState =
  | { state: "off" }
  | { state: "none" }
  | { state: "working"; connectedAt: number; sheet: BooksSheet | null }
  | { state: "broken"; since: number; reason: string; sheet: BooksSheet | null };

/** What the row reads: the shop it was read for (null for the person's own signed-in tenant), and where Google Sheets stands there. */
export type ShopGoogle = { shop: string | null } & GoogleState;

/** What asking Ton for a month came to, as the API's worker run says it.
 *  - `asked`: Ton asked the owner, who decides in Needs you; nothing has been sent.
 *  - `drafted`: the shop is in its practice days with Google, so Ton kept a draft and sent nothing.
 *  - `empty`: no payments were recorded that month, so there is nothing to append.
 *  - `failed`: the API's code for why not (`month_not_over`, `google_broken`, `sheet_in_progress`, ...). */
export type GoogleBooks = { outcome: "asked" } | { outcome: "drafted" } | { outcome: "empty" } | { outcome: "failed"; reason: string };

export interface GoogleOps {
  /** Where Google Sheets stands at the shop the switcher shows. Refused `owner_only` for a helper there, and `no_shop` while the
   *  person is in no shop, which has no Google to connect. */
  "google.status": { params: Record<string, never>; result: ShopGoogle };
  /** Starts a connection for `shop` (as `google.status` named it): the address of Google's consent page to open in the system
   *  browser, good once until `expiresAt`. `url` is null where no window can open (Practice), and the connection is then made at
   *  once. Refused `google_not_configured` while Google is off. */
  "google.connect": { params: { shop: string | null }; result: { url: string | null; expiresAt: number } };
  /** Disconnects `shop`: the token is revoked at Google and forgotten here. `revoked: false` means Google could not be reached, so
   *  the owner can remove Manut AI in their Google account. Refused `not_connected` when there was nothing to disconnect. */
  "google.disconnect": { params: { shop: string | null }; result: { revoked: boolean } };
  /** Asks Ton to append `month` (`YYYY-MM`, one that has ended) of `shop`'s books to the sheet. Ton asks the owner first, in Needs
   *  you, and sends only what they approve. */
  "google.books": { params: { shop: string | null; month: string }; result: GoogleBooks };
}

/** A month as `YYYY-MM`. */
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const BANGKOK_OFFSET_MS = 7 * 3600 * 1000;

/** The calendar month in Bangkok at `ms`, `YYYY-MM`: how the API counts months (`bangkokMonth` in apps/api/src/model-price.ts), and
 *  so which months have ended (`month < bangkokMonth(now)`). Bangkok keeps no daylight saving, so a fixed offset is exact. */
export function bangkokMonth(ms: number): string {
  const shifted = new Date(ms + BANGKOK_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The month `n` months before `month`. */
export function monthsBefore(month: string, n: number): string {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const at = year * 12 + (number - 1) - n;
  return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`;
}

/** The months a shop's books can be asked for: the `count` months before this one in Bangkok, newest first. */
export function endedMonths(nowMs: number, count = 12): string[] {
  const now = bangkokMonth(nowMs);
  return Array.from({ length: count }, (_, i) => monthsBefore(now, i + 1));
}

/** A month as a person reads it, in the language of the app: "October 2026". `month` is `YYYY-MM`, read as the calendar month it
 *  names, in no time zone, so neither the clock nor the machine's zone moves it. */
export function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year ?? 0, (number ?? 1) - 1, 1)).toLocaleDateString(locale(), { month: "long", year: "numeric", timeZone: "UTC" });
}

/** "1 row", "41 rows". */
export const rowsText = (n: number): string => (n === 1 ? t("google.row1") : t("google.rows", { n }));
