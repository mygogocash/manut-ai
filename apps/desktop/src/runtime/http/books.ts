// Ton's request to append a month of the books to the owner's Google Sheet, as the card, Home and Needs you read it
// (docs/pilot-api.md, "Asking for a month, and sending it"). The API's request is of the kind `command`, which only the owner may
// decide, and names its operation `google.sheets.append`. What its detail holds, for the owner: the sheet, the month, how many rows,
// the totals as text from integer satang, the flags, and `earlier` when the month went to the sheet before. For a helper, who may
// pass it on but not decide it, the detail holds only the month and the sheet's title, and says it is the owner's.
//
// Rules this module keeps:
// - The owner approves what is shown, so the whole text is shown: the sheet, the month, how many rows, every total, the flags and,
//   first, a month that was sent before. It is shown whole on every surface, as a browser write's sentence is (view.ts `wholeOf`),
//   and a request whose detail this build cannot read whole is not answerable here (`unreadable`): it says to update the app.
// - Amounts are the API's own words from integer satang ("฿1,290.33"). They are shown as they came and never turned into a number,
//   since a number here would be a float.
// - Nothing else of the detail stays: not the rows themselves, which the detail carries for the owner's app to show and this app
//   does not (the request says how many), and not the payload's hash. What is kept is what the words use, in the API's own shape,
//   so reading it again, after the offline cache has kept it, reads the same.
import { t } from "../../i18n";
import { dayText } from "../../app/time";
import { monthLabel, MONTH, rowsText } from "../google";

/** The operation of Ton's append (`SHEETS_APPEND` in apps/api/src/books-detail.ts). */
export const SHEETS_APPEND = "google.sheets.append";

/** The totals, as text from integer satang with their counts (`BooksDetail.totals`). VAT is a VAT-registered shop's only. */
export interface BooksTotals {
  sales: string;
  salesCount: number;
  refunds: string;
  refundsCount: number;
  expenses: string;
  expensesCount: number;
  net: string;
  beforeVat?: string;
  vat?: string;
}

/** An earlier send of the month to the same sheet: how many times, and for the latest when, how many rows and how it ended. */
export interface BooksEarlier {
  count: number;
  /** an ISO time */
  at: string;
  rows: number;
  /** `unknown`: Google's answer left it open whether the rows landed, or never came */
  outcome: "confirmed" | "unknown";
}

/** What an owner's request holds, as far as the words use it. */
export interface OwnerBooks {
  operationType: typeof SHEETS_APPEND;
  ownerOnly?: undefined;
  month: string;
  sheet: { title: string; tab: string };
  rows: number;
  totals: BooksTotals;
  flags: number;
  earlier: BooksEarlier | null;
}

/** What a helper's request holds: that it waits for the owner, for which month and which sheet's title. */
export interface HelperBooks {
  operationType: typeof SHEETS_APPEND;
  ownerOnly: true;
  month: string;
  sheet: { title: string };
}

export type BooksDetail = OwnerBooks | HelperBooks;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** A line of text the API wrote: not empty, not long, with no control character in it (the API's own rule for what it names). */
const plain = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v);
const count = (v: unknown, max = 1_000_000): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** An amount as the API words it from integer satang: `฿1,290.33`, `฿500`, `-฿20.05`. Short, one line, nothing else is read. */
const amount = (v: unknown): v is string => typeof v === "string" && /^-?฿[0-9][0-9,]*(\.[0-9]{2})?$/.test(v) && v.length <= 32;

function totalsOf(v: unknown): BooksTotals | null {
  if (!isObj(v)) return null;
  const { sales, salesCount, refunds, refundsCount, expenses, expensesCount, net, beforeVat, vat } = v;
  if (!amount(sales) || !count(salesCount) || !amount(refunds) || !count(refundsCount) || !amount(expenses) || !count(expensesCount) || !amount(net)) return null;
  // A VAT-registered shop's request names both figures; one without the other is not read.
  if ((beforeVat === undefined) !== (vat === undefined)) return null;
  if (beforeVat !== undefined && (!amount(beforeVat) || !amount(vat))) return null;
  return { sales, salesCount, refunds, refundsCount, expenses, expensesCount, net, ...(beforeVat !== undefined && amount(beforeVat) && amount(vat) ? { beforeVat, vat } : {}) };
}

function earlierOf(v: unknown): BooksEarlier | null | undefined {
  // An API that does not name an earlier send (one before the record of what was sent) says none.
  if (v === null || v === undefined) return null;
  if (!isObj(v)) return undefined;
  const { at, rows, outcome } = v;
  if (!count(v.count, 1000) || v.count < 1 || typeof at !== "string" || !ISO_TIME.test(at) || Number.isNaN(Date.parse(at)) || !count(rows, 1000) || rows < 1) return undefined;
  if (outcome !== "confirmed" && outcome !== "unknown") return undefined;
  return { count: v.count, at, rows, outcome };
}

/** The detail of a books request, read whole, or null when `detail` is not one or this build cannot read it whole. Reads both
 *  shapes: the API's own, and the one `narrowDetail` (approvals.ts) keeps, which is the same. */
export function decodeBooksDetail(detail: unknown): BooksDetail | null {
  if (!isObj(detail) || detail.operationType !== SHEETS_APPEND || typeof detail.month !== "string" || !MONTH.test(detail.month)) return null;
  const sheet = isObj(detail.sheet) ? detail.sheet : null;
  if (!sheet || !plain(sheet.title, 512)) return null;
  if (detail.ownerOnly === true) return { operationType: SHEETS_APPEND, ownerOnly: true, month: detail.month, sheet: { title: sheet.title } };
  const totals = totalsOf(detail.totals);
  const earlier = earlierOf(detail.earlier);
  if (!totals || earlier === undefined || !plain(sheet.tab, 256) || !count(detail.rows, 1000) || !count(detail.flags, 100_000)) return null;
  return { operationType: SHEETS_APPEND, month: detail.month, sheet: { title: sheet.title, tab: sheet.tab }, rows: detail.rows, totals, flags: detail.flags, earlier };
}

/** What a send before says first: that the month went to the sheet, on which day, how many rows, whether Google said it arrived, and
 *  what approving does. */
export function earlierWords(earlier: BooksEarlier, nowMs: number): string {
  const day = dayText(Date.parse(earlier.at) / 1000, nowMs);
  return t(earlier.outcome === "confirmed" ? "rt.books.earlierConfirmed" : "rt.books.earlierUnknown", {
    when: earlier.count === 1 ? t("rt.books.when1", { day }) : t("rt.books.whenN", { n: earlier.count, day }),
    count: rowsText(earlier.rows),
    again: earlier.count === 1 ? t("rt.books.second") : t("rt.books.again"),
  });
}

/** The whole text an owner reads before approving: a month sent before first, then the sheet and the month, how many rows, every
 *  total as the API worded it, VAT for a VAT-registered shop, and the flags. One line each. */
export function booksText(books: BooksDetail, nowMs: number = Date.now()): string {
  const month = monthLabel(books.month);
  if (books.ownerOnly) return t("rt.books.helper", { month });
  const { totals } = books;
  return [
    ...(books.earlier ? [earlierWords(books.earlier, nowMs), ""] : []),
    t("rt.books.add", { month, sheet: books.sheet.title, tab: books.sheet.tab }),
    books.rows === 1 ? t("rt.books.row1") : t("rt.books.rows", { n: books.rows }),
    t("rt.books.sales", { amount: totals.sales, count: totals.salesCount }),
    t("rt.books.refunds", { amount: totals.refunds, count: totals.refundsCount }),
    t("rt.books.expenses", { amount: totals.expenses, count: totals.expensesCount }),
    t("rt.books.net", { amount: totals.net }),
    ...(totals.beforeVat !== undefined && totals.vat !== undefined ? [t("rt.books.vat", { before: totals.beforeVat, vat: totals.vat })] : []),
    ...(books.flags > 0 ? [books.flags === 1 ? t("rt.books.flag1") : t("rt.books.flags", { n: books.flags })] : []),
  ].join("\n");
}

/** The request in one line, as its card is titled and a notification says it: that Ton asks to add the month's books to Google
 *  Sheets. The same for a helper, whose card says in its text that the books are the owner's. */
export function booksTitle(books: BooksDetail): string {
  return t("rt.books.title", { month: monthLabel(books.month) });
}
