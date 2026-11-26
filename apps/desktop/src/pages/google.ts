// Customize › Connections, Google Sheets for the shop's owner, kept apart from the page so it can be tested without one: how the
// row's state is said (not connected, connected to a sheet, broken, off), which months can be asked for and which were already
// sent, how the questions move (Send a month, the month that was sent before, Disconnect), and how a change reaches the runtime.
// The design canvas's boards are "Customize: connections" (Connections.dc.html), where an app is a row with its tag and its
// button, and "Connect an app" (Connect.dc.html), where Google's page opens in the browser and the app waits for the owner to
// come back, and the question before Disconnect says what stops and what is kept. The rules are the API's: the runtime applies
// them (src/runtime/google.ts), and nothing here decides who may see or change what.
//
// Google's consent address is a credential until it is used or ends. It reaches this page once, from `calls.connect`, and goes
// straight to `calls.open`: it is put in no state, no action and no word, so there is nothing to open again, and Connect again
// asks for a new one.
import { t } from "../i18n";
import { endedMonths, monthLabel, rowsText, type BooksSheet, type GoogleBooks, type SentMonth, type ShopGoogle } from "../runtime/google";
import { unavailable } from "./load";
import { dayText } from "./memory";

// The month and row words are the runtime's (src/runtime/google.ts): a books request in Needs you says them the same way.
export { monthLabel, rowsText };

/** The latest send of `month` to the sheet; the list is newest first. */
export const sentOf = (sheet: BooksSheet | null, month: string): SentMonth | null => sheet?.sent.find((s) => s.month === month) ?? null;

// ---- how the row is said ------------------------------------------------------------------------------------------------

export interface GoogleRow {
  /** the row's name: the sheet's own name when there is one, else Google Sheets */
  name: string;
  /** the tag beside the name: what the connection is */
  tag: { text: string; tone: "ok" | "warn" | "" };
  /** the quiet lines under the name */
  lines: string[];
}

/** "Last sent: October 2026, on 3 November.", and when Google never said whether it arrived, that. */
function lastSentLine(sheet: BooksSheet, nowMs: number): string {
  const last = sheet.sent[0];
  if (!last) return t("google.neverSent");
  return t(last.outcome === "confirmed" ? "google.lastSent" : "google.lastSentUnknown", { month: monthLabel(last.month), day: dayText(last.at, nowMs) });
}

/** What the row says for each state the boards draw: connected to a sheet (its name, and what was last sent), connected with no sheet
 *  yet, not connected, broken (the plain reason, under the sheet's name), and off (Google is not set up for Manut AI yet). */
export function googleRow(g: ShopGoogle, nowMs: number): GoogleRow {
  const app = t("google.title");
  switch (g.state) {
    case "off":
      return { name: app, tag: { text: t("google.tag.off"), tone: "" }, lines: [t("google.off")] };
    case "none":
      return { name: app, tag: { text: t("google.tag.none"), tone: "" }, lines: [t("google.none")] };
    case "working":
      return {
        name: g.sheet?.title ?? app,
        tag: { text: t("google.tag.connected"), tone: "ok" },
        lines: g.sheet ? [lastSentLine(g.sheet, nowMs)] : [t("google.noSheet")],
      };
    case "broken":
      return {
        name: g.sheet?.title ?? app,
        tag: { text: t("google.tag.broken"), tone: "warn" },
        lines: [g.reason === "invalid_grant" ? t("google.brokenGrant") : t("google.brokenOther")],
      };
  }
}

// ---- which month to send ------------------------------------------------------------------------------------------------

/** A month the owner may ask Ton for, with the latest time it was sent to the sheet. */
export interface MonthOption {
  month: string;
  label: string;
  sent: SentMonth | null;
}

/** The months that have ended, newest first (a year back, the API reads the newest 500 payments), each with what the sheet's record
 *  says of it. */
export function monthOptions(g: ShopGoogle, nowMs: number): MonthOption[] {
  const sheet = g.state === "working" ? g.sheet : null;
  return endedMonths(nowMs).map((month) => ({ month, label: monthLabel(month), sent: sentOf(sheet, month) }));
}

/** An option as the picker words it: the month, and when it was sent when it was. */
export function optionText(o: MonthOption, nowMs: number): string {
  if (!o.sent) return o.label;
  return t(o.sent.outcome === "confirmed" ? "google.optionSent" : "google.optionUnknown", { month: o.label, day: dayText(o.sent.at, nowMs) });
}

/** The question asked before a month that was sent already is asked for again: that it went, and what asking again does. */
export function againText(o: MonthOption, nowMs: number): string {
  const sent = o.sent;
  if (!sent) return "";
  const vars = { month: o.label, day: dayText(sent.at, nowMs), count: rowsText(sent.rows) };
  return t(sent.outcome === "confirmed" ? "google.againConfirmed" : "google.againUnknown", vars);
}

// ---- the questions ------------------------------------------------------------------------------------------------------

/** The one question open in the row. Nothing is changed until the owner answers it. */
export type GoogleAsk =
  /** the month picker, with the month chosen */
  | { kind: "send"; month: string }
  /** the chosen month was sent before: asking again adds its rows again, so the owner is asked first */
  | { kind: "again"; month: string }
  /** Disconnect: what stops and what is kept */
  | { kind: "disconnect" }
  | null;

export interface GoogleUi {
  ask: GoogleAsk;
  /** a change is on its way: nothing else can be asked */
  busy: boolean;
  /** Google's page was opened and the owner has not come back with a connection: until when its link lasts, in seconds. The address
   *  itself is not here. */
  waiting: { until: number } | null;
  /** why the last change did not happen, in the page's words */
  error: string | null;
  /** what the last change did */
  notice: string | null;
  /** the notice is Ton's ask, which offers Needs you */
  asked: boolean;
}

export const GOOGLE_START: GoogleUi = { ask: null, busy: false, waiting: null, error: null, notice: null, asked: false };

export type GoogleAction =
  | { type: "send"; month: string }
  | { type: "month"; month: string }
  | { type: "again" }
  | { type: "disconnect" }
  | { type: "cancel" }
  | { type: "begin" }
  | { type: "done"; notice: string; asked?: boolean }
  | { type: "waiting"; until: number; notice?: string }
  | { type: "stopWaiting"; notice?: string }
  | { type: "failed"; message: string }
  | { type: "reset" };

/** Moves the row between asking, waiting on the runtime and done. One question at a time, and none while a change is on its way,
 *  so the owner cannot ask twice. */
export function googleReduce(s: GoogleUi, a: GoogleAction): GoogleUi {
  switch (a.type) {
    case "send":
      return s.busy ? s : { ...s, ask: { kind: "send", month: a.month }, error: null, notice: null, asked: false };
    case "month":
      return !s.busy && s.ask?.kind === "send" ? { ...s, ask: { kind: "send", month: a.month } } : s;
    case "again":
      return !s.busy && s.ask?.kind === "send" ? { ...s, ask: { kind: "again", month: s.ask.month } } : s;
    case "disconnect":
      return s.busy ? s : { ...s, ask: { kind: "disconnect" }, error: null, notice: null, asked: false };
    case "cancel":
      return s.busy ? s : { ...s, ask: null, error: null };
    case "begin":
      return { ...s, busy: true, error: null, notice: null, asked: false };
    case "done":
      return { ...s, ask: null, busy: false, waiting: null, error: null, notice: a.notice, asked: a.asked === true };
    // Google's page is open: the row waits for the owner to come back, and says what it found when it looked ("not connected yet").
    case "waiting":
      return { ...s, ask: null, busy: false, waiting: { until: a.until }, error: null, notice: a.notice ?? null, asked: false };
    case "stopWaiting":
      return { ...s, busy: false, waiting: null, notice: a.notice ?? null };
    // A refusal keeps the question open, so the owner can read why and try again.
    case "failed":
      return { ...s, busy: false, error: a.message, notice: null, asked: false };
    case "reset":
      return GOOGLE_START;
  }
}

// ---- what a refusal says --------------------------------------------------------------------------------------------------

/** What the row says to the runtime's refusals, by code, in the owner's language. Any other refusal is said in the runtime's own words. */
const REFUSALS = new Map<string, () => string>([
  ["owner_only", () => t("google.err.ownerOnly")],
  ["no_shop", () => t("google.err.noShop")],
  ["not_found", () => t("google.err.notFound")],
  ["google_not_configured", () => t("google.off")],
  ["not_connected", () => t("google.err.notConnected")],
  ["invalid_month", () => t("google.err.month")],
  ["team_paused", () => t("google.err.paused")],
  ["member_off", () => t("google.err.memberOff")],
  ["consent_required", () => t("google.err.consent")],
  ["feature_disabled", () => t("google.err.switchedOff")],
  ["unavailable", () => t("google.err.unavailable")],
  // a shop made in Practice has no sample Google Sheet (runtime/mock/host.ts)
  ["not_yet", () => t("google.err.practiceShop")],
]);

export function refusalText(code: string, message: string): string {
  return REFUSALS.get(code)?.() ?? message;
}

/** Why Ton could not ask for a month, by the API's code for it. A code this app does not know says only that nothing was sent. */
const REASONS = new Map<string, () => string>([
  ["month_not_over", () => t("google.fail.monthNotOver")],
  ["month_incomplete", () => t("google.fail.monthIncomplete")],
  ["month_too_long", () => t("google.fail.monthTooLong")],
  ["google_broken", () => t("google.fail.broken")],
  ["not_connected", () => t("google.fail.notConnected")],
  ["google_not_configured", () => t("google.off")],
  ["google_unavailable", () => t("google.fail.googleDown")],
  ["sheet_in_progress", () => t("google.fail.sheetBusy")],
  ["sheet_not_made", () => t("google.fail.sheetNotMade")],
  ["sheet_tab_missing", () => t("google.fail.tabMissing")],
  ["budget", () => t("google.fail.budget")],
]);

export const reasonText = (reason: string): string => REASONS.get(reason)?.() ?? t("google.fail.generic");

// ---- how a change reaches the runtime -------------------------------------------------------------------------------------

/** The four things the row asks of the runtime, through the tab's own client, and opening Google's page in the system browser. */
export interface GoogleCalls {
  status(): Promise<ShopGoogle>;
  connect(shop: string | null): Promise<{ url: string | null; expiresAt: number }>;
  disconnect(shop: string | null): Promise<{ revoked: boolean }>;
  books(shop: string | null, month: string): Promise<GoogleBooks>;
  /** Opens an address in the system browser. */
  open(url: string): Promise<void>;
}

/** What the row is now and how it moves on. */
export interface GoogleStep {
  data: ShopGoogle;
  action: GoogleAction;
}

const failed = (data: ShopGoogle, e: unknown): GoogleStep => {
  const why = unavailable(e);
  const message = why.kind === "unavailable" ? refusalText(why.code, why.message) : t("google.err.failed");
  return { data, action: { type: "failed", message } };
};

/** The status read again after a change, or the one the row already had when it cannot be read: the change's own words still say
 *  what happened. */
async function fresh(calls: GoogleCalls, data: ShopGoogle): Promise<ShopGoogle> {
  try {
    return await calls.status();
  } catch {
    return data;
  }
}

/** Connect: Google's consent page opens in the system browser, and the row waits for the owner to come back. Where no window can open
 *  (Practice) the connection is made at once. The address is opened and dropped here. */
export async function googleConnect(calls: GoogleCalls, data: ShopGoogle): Promise<GoogleStep> {
  try {
    const { url, expiresAt } = await calls.connect(data.shop);
    if (url === null) return { data: await fresh(calls, data), action: { type: "done", notice: t("google.connectedPractice") } };
    await calls.open(url);
    return { data, action: { type: "waiting", until: expiresAt } };
  } catch (e) {
    return failed(data, e);
  }
}

/** The window is in front again: the status is read, and a connection that is there ends the wait. One that is not yet there says so
 *  and keeps waiting, unless Google's page has expired, which says that and stops. */
export async function googleCheck(calls: GoogleCalls, data: ShopGoogle, waiting: { until: number }, nowMs: number): Promise<GoogleStep> {
  try {
    const next = await calls.status();
    if (next.state === "working") return { data: next, action: { type: "done", notice: t("google.connected") } };
    if (nowMs / 1000 > waiting.until) return { data: next, action: { type: "stopWaiting", notice: t("google.expired") } };
    return { data: next, action: { type: "waiting", until: waiting.until, notice: t("google.stillNone") } };
  } catch (e) {
    return failed(data, e);
  }
}

/** Ask Ton for a month: what came of it is said in words, and a connection the answer says is gone or broken is read again. */
export async function googleBooks(calls: GoogleCalls, data: ShopGoogle, month: string): Promise<GoogleStep> {
  try {
    const answer = await calls.books(data.shop, month);
    const label = monthLabel(month);
    switch (answer.outcome) {
      case "asked":
        return { data, action: { type: "done", notice: t("google.asked"), asked: true } };
      case "drafted":
        return { data, action: { type: "done", notice: t("google.drafted", { month: label }) } };
      case "empty":
        return { data, action: { type: "done", notice: t("google.empty", { month: label }) } };
      case "failed": {
        const moved = answer.reason === "google_broken" || answer.reason === "not_connected" || answer.reason === "google_not_configured";
        return { data: moved ? await fresh(calls, data) : data, action: { type: "failed", message: reasonText(answer.reason) } };
      }
    }
  } catch (e) {
    return failed(data, e);
  }
}

/** Disconnect, after its question: the token is revoked at Google and forgotten here. When Google could not be reached the words say
 *  the owner can remove Manut AI in their Google account. Already disconnected reads as disconnected. */
export async function googleDisconnect(calls: GoogleCalls, data: ShopGoogle): Promise<GoogleStep> {
  try {
    const { revoked } = await calls.disconnect(data.shop);
    return { data: await fresh(calls, data), action: { type: "done", notice: revoked ? t("google.disconnected") : t("google.disconnectedLoose") } };
  } catch (e) {
    const why = unavailable(e);
    if (why.kind === "unavailable" && why.code === "not_connected") return { data: await fresh(calls, data), action: { type: "done", notice: t("google.disconnected") } };
    return failed(data, e);
  }
}
