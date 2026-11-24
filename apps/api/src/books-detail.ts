/// What a request to append a month of Ton's books to the owner's Google Sheet holds and names (docs/pilot-api.md,
/// "Google Sheets for Ton's books"). Pure: no network, no storage, so the task object checks and words a proposal with
/// the same code the control plane builds it with (books-sheet.ts).
///
/// The proposal's payload is the month's exact rows, as `@manut/books` makes them from the shop's confirmed payments,
/// with integer satang amounts, and the sheet they go to. What is sent is built from that payload alone by
/// `@manut/sheets-rows`, so the owner approves the very rows that are sent. The request names the sheet, the month, how
/// many rows, and the totals as text made from integer satang, and carries the rows themselves for the owner's app to
/// show.
///
/// A month's books are sales, which only the owner sees (the design canvas's People board: "See sales, the AI budget and
/// the plan": helpers no). So the request's kind is owner-only, and a helper who lists the shop's approvals sees that
/// one waits, for which month and which sheet, and none of its numbers or rows (`helperBooksDetail`).

import type { ApprovalKind } from "@manut/approval-core";
import type { BookLine } from "@manut/books";

/// The operation an append is, as the task object stores its proposal. It is not on the propose route's allowlist:
/// only a worker's ask stores one, through the job flow, with the request that alone decides it.
export const SHEETS_APPEND = "google.sheets.append";

/// The approval kind of an append, set here once and never by the worker, the way browser writes' table sets theirs
/// (browser-writes.ts, `SUBMIT_KINDS`). Writing the shop's own books into the owner's own spreadsheet moves no money and
/// shows nothing to the public: it changes the shop's own records, approval-core's `command`. It is owner-only, which a
/// month's sales need, since helpers do not see them. Ton's roster job for it (`append_books` in
/// `@manut/member-grants`) has the same kind, and a disagreement is refused rather than settled either way.
export const BOOKS_KIND: ApprovalKind = "command";
/// The member-grants job an append is.
export const BOOKS_JOB = "append_books";
/// The tab a new sheet is made with, and that each month is appended to.
export const BOOKS_TAB = "Books";
/// The most rows one append may carry. Ton reads at most the newest 500 payments, so a month is never longer.
export const MAX_BOOK_LINES = 1000;

export type BooksSheet = { id: string; title: string; tab: string };

/// An append's payload, stored on its proposal and hashed with it.
export type BooksPayload = {
  sheet: BooksSheet;
  /// `YYYY-MM`.
  month: string;
  vatRegistered: boolean;
  /// The month's rows in order, each as `@manut/books` made it.
  lines: BookLine[];
  /// How many of the month's entries Ton flagged for the owner to check. Ton raises flags and never fixes: an entry that
  /// cannot be counted is not among the rows, and one counted with a flag is.
  flags: number;
};

/// The totals of a month's rows, in integer satang.
export type BooksTotals = {
  sales: { count: number; satang: number };
  refunds: { count: number; satang: number };
  expenses: { count: number; satang: number };
  /// Sales less refunds.
  netSatang: number;
  /// For a VAT-registered shop: net sales before VAT and the VAT in them. Null for any other shop.
  vat: { beforeVatSatang: number; vatSatang: number } | null;
};

/// What an append's request names, in `record.request.detail`.
export type BooksDetail = {
  actionId: string;
  operationType: typeof SHEETS_APPEND;
  sheet: BooksSheet;
  month: string;
  /// How many rows go in after the header row.
  rows: number;
  /// The totals as text from integer satang, with their counts.
  totals: {
    sales: string;
    salesCount: number;
    refunds: string;
    refundsCount: number;
    expenses: string;
    expensesCount: number;
    net: string;
    beforeVat?: string;
    vat?: string;
  };
  flags: number;
  lines: BookLine[];
  /// The control plane's own sentence saying all of the above.
  text: string;
  payloadHash: string;
};

/// What a helper is shown of an append's request instead: that it waits for the owner, its month and its sheet's title.
export type HelperBooksDetail = {
  actionId: string;
  operationType: typeof SHEETS_APPEND;
  month: string;
  sheet: { title: string };
  ownerOnly: true;
  text: string;
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SPREADSHEET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const KINDS: ReadonlySet<string> = new Set(["sale", "refund", "expense"]);
const LINE_KEYS = ["date", "ref", "kind", "channelOrCategory", "amountSatang", "beforeVatSatang", "vatSatang"] as const;
const PAYLOAD_KEYS = ["sheet", "month", "vatRegistered", "lines", "flags"] as const;
const SHEET_KEYS = ["id", "title", "tab"] as const;
/// No amount a real shop records comes near this, and twice it is still a safe integer, so any sum of a month is exact.
const MAX_SATANG = 1_000_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysAre(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function plain(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && [...value].length <= max && !CONTROL.test(value);
}

function satang(value: unknown, positive: boolean): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0) &&
    value <= MAX_SATANG;
}

export function isBooksMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH.test(value);
}

/// The sheet a payload names, checked, or null.
export function booksSheetOf(value: unknown): BooksSheet | null {
  if (!isRecord(value) || !keysAre(value, SHEET_KEYS) || typeof value.id !== "string" || !SPREADSHEET_ID.test(value.id) ||
      !plain(value.title, 200) || !plain(value.tab, 100)) {
    return null;
  }
  return { id: value.id, title: value.title, tab: value.tab };
}

function lineOf(value: unknown, month: string, vatRegistered: boolean): BookLine | null {
  if (!isRecord(value) || !keysAre(value, LINE_KEYS)) return null;
  const { date, ref, kind, channelOrCategory, amountSatang, beforeVatSatang, vatSatang } = value;
  // A ref and a channel or category are taken as the shop recorded them (an order's ref is up to 128 characters, of any
  // kind, pilot-store.ts): the sheet stores them as text, never as a formula, since the append is RAW.
  if (typeof date !== "string" || !DAY.test(date) || !date.startsWith(`${month}-`) || typeof ref !== "string" ||
      ref.length === 0 || ref.length > 128 || typeof kind !== "string" || !KINDS.has(kind) ||
      typeof channelOrCategory !== "string" || channelOrCategory.length > 128 || !satang(amountSatang, true)) {
    return null;
  }
  // Only a VAT-registered shop's sales and refunds carry VAT figures, and then both of them, summing to the amount.
  const vatLine = vatRegistered && kind !== "expense";
  if (vatLine) {
    if (!satang(beforeVatSatang, false) || !satang(vatSatang, false) || beforeVatSatang + vatSatang !== amountSatang) {
      return null;
    }
  } else if (beforeVatSatang !== null || vatSatang !== null) {
    return null;
  }
  return { date, ref, kind: kind as BookLine["kind"], channelOrCategory, amountSatang,
    beforeVatSatang: vatLine ? beforeVatSatang as number : null, vatSatang: vatLine ? vatSatang as number : null };
}

/// An append's payload, checked field by field, or null. Exactly the fields it has, a field more or less refused, so
/// nothing rides along that the owner was not shown; one to `MAX_BOOK_LINES` rows, each dated in the month, with
/// positive integer satang.
export function booksPayloadOf(value: unknown): BooksPayload | null {
  if (!isRecord(value) || !keysAre(value, PAYLOAD_KEYS) || !isBooksMonth(value.month) ||
      typeof value.vatRegistered !== "boolean" || !Array.isArray(value.lines) || value.lines.length === 0 ||
      value.lines.length > MAX_BOOK_LINES || typeof value.flags !== "number" || !Number.isSafeInteger(value.flags) ||
      value.flags < 0 || value.flags > 100_000) {
    return null;
  }
  const sheet = booksSheetOf(value.sheet);
  if (!sheet) return null;
  const month = value.month;
  const vatRegistered = value.vatRegistered;
  const lines: BookLine[] = [];
  for (const entry of value.lines as unknown[]) {
    const line = lineOf(entry, month, vatRegistered);
    if (!line) return null;
    lines.push(line);
  }
  return { sheet, month, vatRegistered, lines, flags: value.flags };
}

/// The totals of the rows, added in integer satang.
export function booksTotals(lines: readonly BookLine[], vatRegistered: boolean): BooksTotals {
  const totals: BooksTotals = {
    sales: { count: 0, satang: 0 },
    refunds: { count: 0, satang: 0 },
    expenses: { count: 0, satang: 0 },
    netSatang: 0,
    vat: null,
  };
  let beforeVat = 0;
  let vat = 0;
  for (const line of lines) {
    const bucket = line.kind === "sale" ? totals.sales : line.kind === "refund" ? totals.refunds : totals.expenses;
    bucket.count += 1;
    bucket.satang += line.amountSatang;
    const sign = line.kind === "sale" ? 1 : line.kind === "refund" ? -1 : 0;
    beforeVat += sign * (line.beforeVatSatang ?? 0);
    vat += sign * (line.vatSatang ?? 0);
  }
  totals.netSatang = totals.sales.satang - totals.refunds.satang;
  if (vatRegistered) totals.vat = { beforeVatSatang: beforeVat, vatSatang: vat };
  return totals;
}

/// Integer satang written in baht by `@manut/format`'s rule (`formatMoney`): `฿1,250.50`, `฿500` for whole baht, and a
/// minus sign before the baht sign. In integer arithmetic only: the baht are the satang less their remainder, divided
/// exactly, so no float ever touches the amount.
export function bahtText(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const whole = Math.abs(amount);
  const rest = whole % 100;
  const grouped = String((whole - rest) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}฿${grouped}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/// What the owner reads: the month, the sheet by its title (quoted as JSON, so quotes in it show as they are) and its
/// tab, how many rows after the header, the totals with their counts, VAT for a VAT-registered shop, and the flags. It
/// names the sheet by title and tab only, so a practice draft can say it before the sheet exists.
export function booksText(payload: Omit<BooksPayload, "sheet"> & { sheet: Pick<BooksSheet, "title" | "tab"> }): string {
  const totals = booksTotals(payload.lines, payload.vatRegistered);
  const parts = [
    `Append the books for ${payload.month} to the Google Sheet ${JSON.stringify(payload.sheet.title)}, tab ` +
      `${JSON.stringify(payload.sheet.tab)}: a header row, then ${counted(payload.lines.length, "row", "rows")}.`,
    `Sales ${bahtText(totals.sales.satang)} (${counted(totals.sales.count, "entry", "entries")}), refunds ` +
      `${bahtText(totals.refunds.satang)} (${totals.refunds.count}), expenses ${bahtText(totals.expenses.satang)} ` +
      `(${totals.expenses.count}), net sales ${bahtText(totals.netSatang)}.`,
  ];
  if (totals.vat) {
    parts.push(`Net sales before VAT ${bahtText(totals.vat.beforeVatSatang)}, VAT ${bahtText(totals.vat.vatSatang)}.`);
  }
  if (payload.flags > 0) parts.push(`Ton flagged ${counted(payload.flags, "entry", "entries")} for you to check.`);
  return parts.join(" ");
}

/// The request's detail for a stored append, built from its payload alone.
export function booksDetail(actionId: string, payload: BooksPayload, payloadHash: string): BooksDetail {
  const totals = booksTotals(payload.lines, payload.vatRegistered);
  return {
    actionId,
    operationType: SHEETS_APPEND,
    sheet: payload.sheet,
    month: payload.month,
    rows: payload.lines.length,
    totals: {
      sales: bahtText(totals.sales.satang),
      salesCount: totals.sales.count,
      refunds: bahtText(totals.refunds.satang),
      refundsCount: totals.refunds.count,
      expenses: bahtText(totals.expenses.satang),
      expensesCount: totals.expenses.count,
      net: bahtText(totals.netSatang),
      ...(totals.vat ? { beforeVat: bahtText(totals.vat.beforeVatSatang), vat: bahtText(totals.vat.vatSatang) } : {}),
    },
    flags: payload.flags,
    lines: payload.lines,
    text: booksText(payload),
    payloadHash,
  };
}

/// Whether a request's detail is an append's.
export function isBooksDetail(detail: unknown): detail is { operationType: typeof SHEETS_APPEND } {
  return isRecord(detail) && detail.operationType === SHEETS_APPEND;
}

/// What a helper sees of an append's request: none of its numbers or rows.
export function helperBooksDetail(detail: Record<string, unknown>): HelperBooksDetail {
  const month = typeof detail.month === "string" ? detail.month : "";
  const sheet = isRecord(detail.sheet) && typeof detail.sheet.title === "string" ? detail.sheet.title : "";
  return {
    actionId: typeof detail.actionId === "string" ? detail.actionId : "",
    operationType: SHEETS_APPEND,
    month,
    sheet: { title: sheet },
    ownerOnly: true,
    text: `Ton asks to append the books for ${month} to the owner's Google Sheet. Only the owner sees the books and ` +
      "can approve it.",
  };
}
