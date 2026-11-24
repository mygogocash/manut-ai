// Customize › Connections' Google Sheets row for the shop's owner (google.ts, GooglePane.tsx): the canvas's app row drawn with
// react-dom/server in each state the boards draw (not connected, connected to a sheet, broken, off, waiting on Google's page), the
// questions (which month, the month that was sent before, Disconnect), the words for every answer the routes give in all four
// languages, and above all that Google's consent address goes from the runtime's answer to the browser and is in no state, no
// action and no word. The views use no hooks, so a test calls them as plain functions to read the handlers a string render leaves out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t, type Key } from "../i18n";
import { endedMonths, type GoogleBooks, type ShopGoogle } from "../runtime/google";
import {
  againText,
  GOOGLE_START,
  googleBooks,
  googleCheck,
  googleConnect,
  googleDisconnect,
  googleReduce,
  googleRow,
  monthLabel,
  monthOptions,
  optionText,
  reasonText,
  refusalText,
  rowsText,
  type GoogleAction,
  type GoogleCalls,
  type GoogleUi,
} from "./google";
import { GooglePane, type GoogleProps } from "./GooglePane";
import { LOADING } from "./load";

/** 24 November 2026, 10:00 on this computer's clock; October 2026 and before have ended. */
const NOW = new Date(2026, 10, 24, 10, 0).getTime();
const at = (month: number, day: number, hour = 9) => new Date(2026, month - 1, day, hour, 0).getTime() / 1000;
// Made up for this file: a one-use state and a PKCE challenge, which no state, action or word may hold.
const CONSENT = "https://accounts.google.test/o/oauth2/v2/auth?state=mgs1.SECRET-STATE-55&code_challenge=SECRET-CHALLENGE-77";

const SHEET = {
  title: "Manut AI books: Baan Mali",
  url: "https://docs.google.com/spreadsheets/d/sheet1/edit",
  sent: [
    { month: "2026-10", at: at(11, 3), rows: 41, outcome: "confirmed" as const },
    { month: "2026-09", at: at(10, 3), rows: 38, outcome: "unknown" as const },
  ],
};
const WORKING: ShopGoogle = { shop: "pilot:baan-mali", state: "working", connectedAt: at(9, 1), sheet: SHEET };
const NONE: ShopGoogle = { shop: "pilot:baan-mali", state: "none" };
const BROKEN: ShopGoogle = { shop: "pilot:baan-mali", state: "broken", since: at(11, 24, 8), reason: "invalid_grant", sheet: SHEET };
const OFF: ShopGoogle = { shop: "pilot:baan-mali", state: "off" };

const props = (over: Partial<GoogleProps> = {}): GoogleProps => ({
  state: { kind: "ready", value: WORKING },
  ui: GOOGLE_START,
  nowMs: NOW,
  dispatch: () => {},
  onConnect: () => {},
  onCheck: () => {},
  onSend: () => {},
  onDisconnect: () => {},
  onOpenSheet: () => {},
  onOpenNeeds: () => {},
  ...over,
});
const ui = (over: Partial<GoogleUi> = {}): GoogleUi => ({ ...GOOGLE_START, ...over });
const words = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const pane = (p: GoogleProps) => renderToString(<GooglePane p={p} />);

/** Every element a view draws, with its own components expanded. */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}
const byTestId = (node: ReactNode, id: string) => drawn(node).filter((e) => e.props["data-testid"] === id);
const press = (node: ReactNode, id: string) => (byTestId(node, id)[0]?.props.onClick as () => void)();

/** The page's state after each action, as `useReducer` keeps it. */
const reduce = (...actions: GoogleAction[]): GoogleUi => actions.reduce(googleReduce, GOOGLE_START);

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("how the row is said", () => {
  it("names a month in the language of the app, as the calendar month it is", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
    setLang("ko");
    expect(monthLabel("2026-10")).toBe("2026년 10월");
    setLang("ja");
    expect(monthLabel("2026-10")).toBe("2026年10月");
    setLang("zh");
    expect(monthLabel("2026-10")).toBe("2026年10月");
    // Neither a time zone nor the clock moves it: December is December.
    setLang("en");
    expect(monthLabel("2026-12")).toBe("December 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(rowsText(1)).toBe("1 row");
    expect(rowsText(41)).toBe("41 rows");
  });

  it("says each state the boards draw: connected with the sheet and what was last sent, no sheet yet, not connected, broken, and off", () => {
    // The row is named for the sheet when there is one, and for Google Sheets when there is not.
    expect(googleRow(WORKING, NOW)).toEqual({
      name: "Manut AI books: Baan Mali",
      tag: { text: "Connected", tone: "ok" },
      lines: ["Last sent: October 2026, on 3 November."],
    });
    expect(googleRow({ ...WORKING, sheet: { ...SHEET, sent: [SHEET.sent[1]!] } }, NOW).lines).toEqual(["Last sent: September 2026, on 3 October. Google did not say whether it arrived."]);
    expect(googleRow({ ...WORKING, sheet: { ...SHEET, sent: [] } }, NOW).lines).toEqual(["Nothing sent yet."]);
    expect(googleRow({ ...WORKING, sheet: null }, NOW)).toEqual({
      name: "Google Sheets",
      tag: { text: "Connected", tone: "ok" },
      lines: ["Connected. Ton makes the sheet in your Google Drive the first time you send a month."],
    });
    expect(googleRow(NONE, NOW)).toEqual({
      name: "Google Sheets",
      tag: { text: "Not connected", tone: "" },
      lines: ["Not connected. Connect it and Ton can add each month's books to a sheet in your Google Drive, after you approve."],
    });
    expect(googleRow(BROKEN, NOW)).toEqual({
      name: "Manut AI books: Baan Mali",
      tag: { text: "Needs connecting again", tone: "warn" },
      lines: ["Google no longer lets Manut AI into your sheet: the access was removed or ran out."],
    });
    expect(googleRow({ ...BROKEN, reason: "refused", sheet: null }, NOW)).toMatchObject({ name: "Google Sheets", lines: ["Google refused Manut AI."] });
    expect(googleRow(OFF, NOW)).toEqual({ name: "Google Sheets", tag: { text: "Not available yet", tone: "" }, lines: ["Google Sheets isn't set up for Manut AI yet."] });
  });

  it("offers the months that have ended, newest first, with when each was sent and whether Google said it arrived", () => {
    const options = monthOptions(WORKING, NOW);
    expect(options).toHaveLength(12);
    expect(options.map((o) => o.month).slice(0, 3)).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(options.map((o) => o.month)).toEqual(endedMonths(NOW));
    expect(options.map((o) => optionText(o, NOW)).slice(0, 4)).toEqual([
      "October 2026, sent 3 November",
      "September 2026, sent 3 October, not confirmed",
      "August 2026",
      "July 2026",
    ]);
    // The month the shop is in has not ended, so it is not offered; nothing is marked sent for a shop with no sheet.
    expect(options.some((o) => o.month === "2026-11")).toBe(false);
    expect(monthOptions({ ...WORKING, sheet: null }, NOW).every((o) => o.sent === null)).toBe(true);
    expect(monthOptions(NONE, NOW).every((o) => o.sent === null)).toBe(true);
  });

  it("says, before a month that was sent is asked for again, that it went and what asking again does", () => {
    const [october, september, august] = monthOptions(WORKING, NOW);
    expect(againText(october!, NOW)).toBe("October 2026 was already sent on 3 November (41 rows). Sending it again adds the same rows a second time.");
    expect(againText(september!, NOW)).toBe(
      "September 2026 may already be in your sheet: it was sent on 3 October (38 rows), but Google did not say whether the rows arrived. Look in the sheet first. Sending it again adds the rows again.",
    );
    expect(againText(august!, NOW)).toBe("");
  });
});

describe("the questions", () => {
  it("opens the month picker, changes the month, asks about a month that was sent, and closes on cancel", () => {
    expect(reduce({ type: "send", month: "2026-10" }).ask).toEqual({ kind: "send", month: "2026-10" });
    expect(reduce({ type: "send", month: "2026-10" }, { type: "month", month: "2026-09" }).ask).toEqual({ kind: "send", month: "2026-09" });
    expect(reduce({ type: "send", month: "2026-10" }, { type: "again" }).ask).toEqual({ kind: "again", month: "2026-10" });
    expect(reduce({ type: "send", month: "2026-10" }, { type: "again" }, { type: "cancel" }).ask).toBeNull();
    // A month is chosen only in the picker, and the question about it only from the picker.
    expect(reduce({ type: "month", month: "2026-09" }).ask).toBeNull();
    expect(reduce({ type: "again" }).ask).toBeNull();
    expect(reduce({ type: "disconnect" }).ask).toEqual({ kind: "disconnect" });
  });

  it("asks one question at a time and none while a change is on its way, so the owner cannot ask twice", () => {
    const busy = reduce({ type: "send", month: "2026-10" }, { type: "begin" });
    expect(busy.busy).toBe(true);
    for (const action of [{ type: "send", month: "2026-09" }, { type: "month", month: "2026-09" }, { type: "again" }, { type: "disconnect" }, { type: "cancel" }] as GoogleAction[]) {
      expect(googleReduce(busy, action), action.type).toBe(busy);
    }
  });

  it("closes the question and says what happened when a change is done, keeps it open with the reason when it was refused", () => {
    expect(reduce({ type: "send", month: "2026-10" }, { type: "begin" }, { type: "done", notice: "ok", asked: true })).toEqual({
      ask: null, busy: false, waiting: null, error: null, notice: "ok", asked: true });
    const refused = reduce({ type: "send", month: "2026-10" }, { type: "begin" }, { type: "failed", message: "why" });
    expect(refused).toMatchObject({ ask: { kind: "send", month: "2026-10" }, busy: false, error: "why", notice: null });
    // A new question clears what the last one said.
    expect(googleReduce(refused, { type: "disconnect" })).toMatchObject({ ask: { kind: "disconnect" }, error: null, notice: null });
  });

  it("waits for the owner to come back from Google's page, holding the time its link lasts and nothing of the link", () => {
    const waiting = reduce({ type: "begin" }, { type: "waiting", until: 1_800_000_600 });
    expect(waiting).toEqual({ ask: null, busy: false, waiting: { until: 1_800_000_600 }, error: null, notice: null, asked: false });
    expect(reduce({ type: "waiting", until: 5, notice: "not yet" }).notice).toBe("not yet");
    expect(googleReduce(waiting, { type: "stopWaiting", notice: "gone" })).toMatchObject({ waiting: null, notice: "gone" });
    expect(googleReduce(waiting, { type: "done", notice: "yes" }).waiting).toBeNull();
    expect(googleReduce(waiting, { type: "reset" })).toBe(GOOGLE_START);
  });
});

/** The runtime's four calls, recorded, answering what a test says. */
function calls(over: Partial<GoogleCalls> = {}) {
  const sent: string[] = [];
  const opened: string[] = [];
  const fake: GoogleCalls = {
    status: async () => {
      sent.push("status");
      return WORKING;
    },
    connect: async (shop) => {
      sent.push(`connect ${shop}`);
      return { url: CONSENT, expiresAt: NOW / 1000 + 600 };
    },
    disconnect: async (shop) => {
      sent.push(`disconnect ${shop}`);
      return { revoked: true };
    },
    books: async (shop, month) => {
      sent.push(`books ${shop} ${month}`);
      return { outcome: "asked" } satisfies GoogleBooks;
    },
    open: async (url) => {
      opened.push(url);
    },
    ...over,
  };
  return { fake, sent, opened };
}
const refuse = (code: string, message = "the runtime's words") => Promise.reject({ code, message });

describe("how a change reaches the runtime", () => {
  it("opens Google's page once and waits, and the address is in no state, no action and no word", async () => {
    const { fake, sent, opened } = calls();
    const step = await googleConnect(fake, NONE);
    expect(sent).toEqual(["connect pilot:baan-mali"]);
    expect(opened).toEqual([CONSENT]);
    expect(step).toEqual({ data: NONE, action: { type: "waiting", until: NOW / 1000 + 600 } });
    for (const secret of ["SECRET-STATE-55", "SECRET-CHALLENGE-77", "accounts.google.test"]) {
      expect(JSON.stringify(step)).not.toContain(secret);
      expect(JSON.stringify(reduce({ type: "begin" }, step.action))).not.toContain(secret);
    }
  });

  it("connects at once where no window can open (Practice), and says so", async () => {
    const { fake, opened } = calls({ connect: async () => ({ url: null, expiresAt: NOW / 1000 + 600 }) });
    expect(await googleConnect(fake, NONE)).toEqual({ data: WORKING, action: { type: "done", notice: "Practice: no Google page opens and nothing is sent. The sample sheet is connected." } });
    expect(opened).toEqual([]);
  });

  it("says why when it could not connect, in the owner's words, whatever words the runtime used, and when the browser would not open", async () => {
    const refused = await googleConnect(calls({ connect: () => refuse("google_not_configured") }).fake, NONE);
    expect(refused.action).toEqual({ type: "failed", message: "Google Sheets isn't set up for Manut AI yet." });
    expect((await googleConnect(calls({ connect: () => refuse("owner_only") }).fake, NONE)).action).toEqual({ type: "failed", message: "Only the shop's owner sees and changes Google Sheets." });
    expect((await googleConnect(calls({ connect: () => refuse("something_new", "Words of the runtime.") }).fake, NONE)).action).toEqual({ type: "failed", message: "Words of the runtime." });
    // Any other failure says what it said, as the vault's row does.
    expect((await googleConnect(calls({ connect: () => Promise.reject(new Error("boom")) }).fake, NONE)).action).toEqual({ type: "failed", message: "boom" });
    expect((await googleConnect(calls({ open: () => refuse("failed", "not a web link") }).fake, NONE)).action).toEqual({ type: "failed", message: "not a web link" });
  });

  it("reads the status when the window is back, and a connection that is there ends the wait", async () => {
    const { fake, sent } = calls();
    expect(await googleCheck(fake, NONE, { until: NOW / 1000 + 300 }, NOW)).toEqual({ data: WORKING, action: { type: "done", notice: "Google Sheets is connected." } });
    expect(sent).toEqual(["status"]);
  });

  it("says it is not connected yet and keeps waiting while Google's page can still be used, and says it expired when it cannot", async () => {
    const { fake } = calls({ status: async () => NONE });
    expect(await googleCheck(fake, NONE, { until: NOW / 1000 + 300 }, NOW)).toEqual({
      data: NONE,
      action: { type: "waiting", until: NOW / 1000 + 300, notice: "Google Sheets is not connected yet. If you allowed it on Google's page, wait a moment and check again." },
    });
    expect(await googleCheck(fake, NONE, { until: NOW / 1000 - 1 }, NOW)).toEqual({
      data: NONE,
      action: { type: "stopWaiting", notice: "That Google page has expired. Connect again to get a new one." },
    });
    expect((await googleCheck(calls({ status: () => refuse("offline", "Offline.") }).fake, NONE, { until: NOW }, NOW)).action).toEqual({ type: "failed", message: "Offline." });
  });

  it("asks Ton for the month with the shop the row was read for, and says what came of it", async () => {
    const { fake, sent } = calls();
    expect(await googleBooks(fake, WORKING, "2026-10")).toEqual({ data: WORKING, action: { type: "done", notice: t("google.asked"), asked: true } });
    expect(sent).toEqual(["books pilot:baan-mali 2026-10"]);
    const drafted = await googleBooks(calls({ books: async () => ({ outcome: "drafted" }) }).fake, WORKING, "2026-10");
    expect(drafted.action).toEqual({ type: "done", notice: "Ton kept a draft of October 2026 and sent nothing, because Google Sheets is still in its practice days." });
    const empty = await googleBooks(calls({ books: async () => ({ outcome: "empty" }) }).fake, WORKING, "2026-10");
    expect(empty.action).toEqual({ type: "done", notice: "No payments were recorded in October 2026, so there is nothing to send." });
  });

  it("says why Ton could not ask, for every reason the API gives, and reads the connection again when it says it is gone or broken", async () => {
    const reasons: [string, string][] = [
      ["month_not_over", "That month has not ended yet. Pick a month that has ended."],
      ["month_incomplete", "Ton can read only the newest 500 payments, and they do not reach back to the start of that month, so it would be sent short. Nothing was sent."],
      ["month_too_long", "That month has too many rows to send at once. Nothing was sent."],
      ["google_broken", "Google no longer lets Manut AI into your sheet. Connect Google Sheets again first. Nothing was sent."],
      ["not_connected", "Google Sheets is not connected. Connect it first. Nothing was sent."],
      ["google_not_configured", "Google Sheets isn't set up for Manut AI yet."],
      ["google_unavailable", "Google did not answer. Nothing was sent. Try again in a moment."],
      ["sheet_in_progress", "Ton is still making the sheet. Try again in a moment."],
      ["sheet_not_made", "Google did not make the sheet. Nothing was sent. Try again in a moment."],
      ["sheet_tab_missing", "Your sheet no longer has its Books tab, so Ton cannot add to it. Nothing was sent."],
      ["budget", "This shop's AI budget is used up for now. Nothing was sent."],
      ["vault_unavailable", "Ton could not ask for that month just now. Nothing was sent. Try again in a moment."],
      ["unknown", "Ton could not ask for that month just now. Nothing was sent. Try again in a moment."],
    ];
    for (const [reason, message] of reasons) {
      expect(reasonText(reason), reason).toBe(message);
      const { fake } = calls({ books: async () => ({ outcome: "failed", reason }), status: async () => BROKEN });
      const step = await googleBooks(fake, WORKING, "2026-10");
      expect(step.action, reason).toEqual({ type: "failed", message });
      // The row moves to what the API now says only for the reasons that change it.
      expect(step.data, reason).toBe(["google_broken", "not_connected", "google_not_configured"].includes(reason) ? BROKEN : WORKING);
    }
  });

  it("says a refusal of the route in the owner's words, and one it does not know in the runtime's own", async () => {
    const cases: [string, string][] = [
      ["team_paused", "Your team is paused, so Ton starts nothing new. Resume your team, then ask again."],
      ["member_off", "Ton is turned off for this shop."],
      ["consent_required", "Ton can't do cloud work for this shop until its owner gives permission."],
      ["feature_disabled", "Cloud work is switched off for now."],
      ["invalid_month", "Pick a month that has ended."],
      ["no_shop", "No shop is linked to your account yet, so there is no Google Sheets to set up here."],
      ["unavailable", "Google Sheets did not answer. Try again in a moment."],
    ];
    for (const [code, message] of cases) {
      expect((await googleBooks(calls({ books: () => refuse(code) }).fake, WORKING, "2026-10")).action, code).toEqual({ type: "failed", message });
      expect(refusalText(code, "x"), code).toBe(message);
    }
    expect(refusalText("offline", "Offline: the Manut AI API cannot be reached.")).toBe("Offline: the Manut AI API cannot be reached.");
  });

  it("disconnects, says whether Google could be reached, reads the connection again, and takes an already disconnected shop as disconnected", async () => {
    const read: string[] = [];
    const gone = calls({ status: async () => (read.push("status"), NONE) });
    expect(await googleDisconnect(gone.fake, WORKING)).toEqual({ data: NONE, action: { type: "done", notice: "Google Sheets is disconnected." } });
    // The token is revoked first, then the row reads where the shop stands now.
    expect(gone.sent).toEqual(["disconnect pilot:baan-mali"]);
    expect(read).toEqual(["status"]);
    const loose = calls({ disconnect: async () => ({ revoked: false }), status: async () => NONE });
    expect((await googleDisconnect(loose.fake, WORKING)).action).toEqual({
      type: "done",
      notice: "Google Sheets is disconnected here, but Google could not be reached to end the access. You can remove Manut AI in your Google account's settings.",
    });
    expect((await googleDisconnect(calls({ disconnect: () => refuse("not_connected"), status: async () => NONE }).fake, WORKING)).action).toEqual({ type: "done", notice: "Google Sheets is disconnected." });
    expect((await googleDisconnect(calls({ disconnect: () => refuse("owner_only") }).fake, WORKING)).action.type).toBe("failed");
    // A status that cannot be read afterwards leaves the row as it was, and the words still say what happened.
    const blind = calls({ status: () => refuse("offline") });
    expect(await googleDisconnect(blind.fake, WORKING)).toEqual({ data: WORKING, action: { type: "done", notice: "Google Sheets is disconnected." } });
  });
});

describe("the row", () => {
  it("is the canvas's app row for a connected shop: its sheet, what was last sent, and Send, Open the sheet and Disconnect", () => {
    const html = pane(props());
    expect(words(html)).toBe(
      "Google Sheets Ton can keep each month's books in a Google Sheet in your Google Drive. Ton asks you first, every time. " +
        "G Manut AI books: Baan Mali Last sent: October 2026, on 3 November. Connected Send a month's books Open the sheet Disconnect",
    );
    expect(byTestId(GooglePane({ p: props() }), "google-tag").map((e) => e.props.className)).toEqual(["tag ok"]);
    expect(byTestId(GooglePane({ p: props() }), "google-row")[0]?.props["data-state"]).toBe("working");
    expect(byTestId(GooglePane({ p: props() }), "google-name")[0]?.props.children).toBe("Manut AI books: Baan Mali");
    expect(byTestId(GooglePane({ p: props() }), "google-connect")).toHaveLength(0);
  });

  it("offers Connect to a shop that is not connected, and Connect again, with Disconnect, to one that broke", () => {
    const none = props({ state: { kind: "ready", value: NONE } });
    expect(words(pane(none))).toContain("Not connected Connect");
    expect(byTestId(GooglePane({ p: none }), "google-connect").map((e) => e.props.className)).toEqual(["btn dark"]);
    expect(byTestId(GooglePane({ p: none }), "google-send")).toHaveLength(0);
    const broken = props({ state: { kind: "ready", value: BROKEN } });
    expect(words(pane(broken))).toContain("Google no longer lets Manut AI into your sheet: the access was removed or ran out.");
    expect(byTestId(GooglePane({ p: broken }), "google-tag").map((e) => e.props.className)).toEqual(["tag warn"]);
    expect(byTestId(GooglePane({ p: broken }), "google-connect")[0]?.props.children).toBe("Connect again");
    expect(byTestId(GooglePane({ p: broken }), "google-disconnect")).toHaveLength(1);
    expect(byTestId(GooglePane({ p: broken }), "google-send")).toHaveLength(0);
    expect(pane(broken)).toContain("tr google-row broken");
  });

  it("says Google Sheets isn't set up for Manut AI yet while the API says so, and offers nothing", () => {
    const off = props({ state: { kind: "ready", value: OFF } });
    expect(words(pane(off))).toContain("Not available yet");
    expect(words(pane(off))).toContain("Google Sheets isn't set up for Manut AI yet.");
    for (const id of ["google-connect", "google-send", "google-disconnect", "google-sheet"]) expect(byTestId(GooglePane({ p: off }), id), id).toHaveLength(0);
  });

  it("says it is reading, or why it could not, and stays out of a shop the person only helps at", () => {
    expect(words(pane(props({ state: LOADING })))).toContain("Reading Google Sheets…");
    expect(words(pane(props({ state: { kind: "unavailable", code: "offline", message: "Offline: the Manut AI API cannot be reached." } })))).toContain("Offline: the Manut AI API cannot be reached.");
    expect(words(pane(props({ state: { kind: "unavailable", code: "no_shop", message: "x" } })))).toContain("No shop is linked to your account yet");
    // The Vault box says it is the owner's; this one says nothing.
    expect(pane(props({ state: { kind: "unavailable", code: "owner_only", message: "Only Noi sees it." } }))).toBe("");
  });

  it("hands each button to the page: Connect, Send for the newest ended month, Open the sheet, and Disconnect's question", () => {
    const dispatched: GoogleAction[] = [];
    let connected = 0;
    let opened = 0;
    const p = props({ dispatch: (a) => dispatched.push(a), onConnect: () => connected++, onOpenSheet: () => opened++ });
    press(GooglePane({ p }), "google-send");
    press(GooglePane({ p }), "google-disconnect");
    press(GooglePane({ p }), "google-sheet");
    expect(dispatched).toEqual([{ type: "send", month: "2026-10" }, { type: "disconnect" }]);
    expect(opened).toBe(1);
    press(GooglePane({ p: { ...p, state: { kind: "ready", value: NONE } } }), "google-connect");
    expect(connected).toBe(1);
  });

  it("offers nothing while a change is on its way, a question is open or Google's page is open", () => {
    for (const locked of [ui({ busy: true }), ui({ ask: { kind: "send", month: "2026-10" } }), ui({ waiting: { until: 1 } })]) {
      const p = props({ ui: locked });
      for (const id of ["google-send", "google-disconnect"]) expect(byTestId(GooglePane({ p }), id)[0]?.props.disabled, `${id} ${JSON.stringify(locked)}`).toBe(true);
      const none = props({ ui: locked, state: { kind: "ready", value: NONE } });
      expect(byTestId(GooglePane({ p: none }), "google-connect")[0]?.props.disabled).toBe(true);
    }
  });
});

describe("the month picker", () => {
  const open = (month = "2026-10", over: Partial<GoogleUi> = {}) => props({ ui: ui({ ask: { kind: "send", month }, ...over }) });

  it("lists the months that have ended, marks the ones sent, and says Ton asks first", () => {
    const html = pane(open());
    expect(words(html)).toContain("Which month's books?");
    expect(words(html)).toContain("October 2026, sent 3 November September 2026, sent 3 October, not confirmed August 2026");
    expect(words(html)).toContain("Ton asks you first. Nothing goes to your sheet until you approve it in Needs you.");
    expect(byTestId(GooglePane({ p: open("2026-09") }), "google-month")[0]?.props.value).toBe("2026-09");
    expect(byTestId(GooglePane({ p: open() }), "google-ask")[0]?.props.children).toBe("Ask Ton");
    expect(byTestId(GooglePane({ p: open() }), "google-month")[0]?.props.autoFocus).toBe(true);
  });

  it("changes the month, asks on submit, and closes on Escape and Cancel", () => {
    const dispatched: GoogleAction[] = [];
    let sent = 0;
    const p = { ...open(), dispatch: (a: GoogleAction) => dispatched.push(a), onSend: () => sent++ };
    (byTestId(GooglePane({ p }), "google-month")[0]?.props.onChange as (e: unknown) => void)({ target: { value: "2026-08" } });
    (byTestId(GooglePane({ p }), "google-pick")[0]?.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
    (byTestId(GooglePane({ p }), "google-pick")[0]?.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault() {}, nativeEvent: { isComposing: false } });
    press(GooglePane({ p }), "google-pick-cancel");
    expect(dispatched).toEqual([{ type: "month", month: "2026-08" }, { type: "cancel" }, { type: "cancel" }]);
    expect(sent).toBe(1);
  });

  it("asks nothing while the owner is composing a word, and while a change is on its way", () => {
    const dispatched: GoogleAction[] = [];
    let sent = 0;
    const busy = { ...open("2026-10", { busy: true }), dispatch: (a: GoogleAction) => dispatched.push(a), onSend: () => sent++ };
    (byTestId(GooglePane({ p: busy }), "google-pick")[0]?.props.onSubmit as (e: unknown) => void)({ preventDefault() {} });
    expect(sent).toBe(0);
    expect(byTestId(GooglePane({ p: busy }), "google-ask")[0]?.props.disabled).toBe(true);
    expect(byTestId(GooglePane({ p: busy }), "google-ask")[0]?.props.children).toBe("Asking Ton…");
    (byTestId(GooglePane({ p: busy }), "google-pick")[0]?.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault() {}, nativeEvent: { isComposing: true } });
    expect(dispatched).toEqual([]);
  });
});

describe("the month that was sent before", () => {
  const again = (month: string) => props({ ui: ui({ ask: { kind: "again", month } }) });

  it("says it went, on which day, how many rows, and what asking again does, with Cancel holding the focus", () => {
    const confirmed = GooglePane({ p: again("2026-10") });
    expect(byTestId(confirmed, "google-again-text")[0]?.props.children).toBe("October 2026 was already sent on 3 November (41 rows). Sending it again adds the same rows a second time.");
    expect(byTestId(confirmed, "google-again-keep")[0]?.props.autoFocus).toBe(true);
    expect(byTestId(confirmed, "google-again-yes")[0]?.props.autoFocus).toBeUndefined();
    expect(byTestId(confirmed, "google-again-yes")[0]?.props.children).toBe("Ask Ton anyway");
    const unknown = GooglePane({ p: again("2026-09") });
    expect(words(renderToString(<GooglePane p={again("2026-09")} />))).toContain("may already be in your sheet");
    expect(byTestId(unknown, "google-again-text")[0]?.props.children).toContain("Look in the sheet first.");
    // The picker is gone while the question is open.
    expect(byTestId(confirmed, "google-pick")).toHaveLength(0);
  });

  it("asks only when the owner says so, and closes on Cancel and Escape", () => {
    const dispatched: GoogleAction[] = [];
    let sent = 0;
    const p = { ...again("2026-10"), dispatch: (a: GoogleAction) => dispatched.push(a), onSend: () => sent++ };
    press(GooglePane({ p }), "google-again-yes");
    expect(sent).toBe(1);
    press(GooglePane({ p }), "google-again-keep");
    (byTestId(GooglePane({ p }), "google-again")[0]?.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault() {}, nativeEvent: { isComposing: false } });
    expect(dispatched).toEqual([{ type: "cancel" }, { type: "cancel" }]);
  });
});

describe("Disconnect's question", () => {
  const asking = props({ ui: ui({ ask: { kind: "disconnect" } }) });

  it("says what stops and what is kept, with the safe answer holding the focus, and disconnects only when told", () => {
    const view = GooglePane({ p: asking });
    expect(byTestId(view, "google-disconnect-question")[0]?.props.children).toBe(
      "Disconnect Google Sheets? Ton stops adding the books. Your sheet and what is in it stay in your Google Drive.",
    );
    expect(byTestId(view, "google-disconnect-yes")[0]?.props.className).toBe("btn danger solid");
    expect(byTestId(view, "google-disconnect-keep")[0]?.props.autoFocus).toBe(true);
    expect(byTestId(view, "google-disconnect-yes")[0]?.props.autoFocus).toBeUndefined();
    expect(byTestId(view, "google-disconnect-keep")[0]?.props.children).toBe("Keep it connected");
    const dispatched: GoogleAction[] = [];
    let disconnected = 0;
    const p = { ...asking, dispatch: (a: GoogleAction) => dispatched.push(a), onDisconnect: () => disconnected++ };
    press(GooglePane({ p }), "google-disconnect-yes");
    press(GooglePane({ p }), "google-disconnect-keep");
    expect([disconnected, dispatched]).toEqual([1, [{ type: "cancel" }]]);
  });
});

describe("waiting on Google's page, and what the last change said", () => {
  it("draws the canvas's waiting box with Check now and Not now, in place of Connect, and no address to open again", () => {
    const p = props({ state: { kind: "ready", value: NONE }, ui: ui({ waiting: { until: NOW / 1000 + 600 } }) });
    const html = pane(p);
    expect(words(html)).toContain("Google's page is open in your browser Allow Manut AI there, then come back to this window. It checks again when you do. Check now Not now");
    expect(html).toContain('class="spin"');
    expect(byTestId(GooglePane({ p }), "google-waiting")).toHaveLength(1);
    const dispatched: GoogleAction[] = [];
    let checked = 0;
    const q = { ...p, dispatch: (a: GoogleAction) => dispatched.push(a), onCheck: () => checked++ };
    press(GooglePane({ p: q }), "google-check");
    press(GooglePane({ p: q }), "google-not-now");
    expect([checked, dispatched]).toEqual([1, [{ type: "stopWaiting" }]]);
    expect(html).not.toContain("accounts.google");
  });

  it("says what a change did, or why it did not, and offers Needs you from Ton's ask", () => {
    const done = pane(props({ ui: ui({ notice: "Google Sheets is connected." }) }));
    expect(done).toContain('class="msg ok"');
    expect(words(done)).toContain("Google Sheets is connected.");
    // While waiting, "not connected yet" is no success.
    expect(pane(props({ state: { kind: "ready", value: NONE }, ui: ui({ waiting: { until: 1 }, notice: "not yet" }) }))).toContain('class="msg"');
    expect(pane(props({ ui: ui({ error: "That did not work." }) }))).toContain('role="alert"');
    let opened = 0;
    const asked = props({ ui: ui({ notice: t("google.asked"), asked: true }), onOpenNeeds: () => opened++ });
    expect(words(pane(asked))).toContain("Ton asked you. Open Needs you to read it and approve it. Nothing goes to your sheet until you do. Open Needs you");
    press(GooglePane({ p: asked }), "google-open-needs");
    expect(opened).toBe(1);
    expect(byTestId(GooglePane({ p: props({ ui: ui({ notice: "x" }) }) }), "google-open-needs")).toHaveLength(0);
  });
});

describe("in every language", () => {
  it("has the row's words in all four languages and draws without a key left over, and no English in the others", () => {
    const row: Key[] = ["google.title", "google.hint", "google.off", "google.none", "google.noSheet", "google.connect", "google.send", "google.disconnect", "google.disconnectAsk", "google.pick", "google.asked"];
    for (const lang of LANGS) {
      setLang(lang);
      for (const key of row) {
        const text = t(key);
        expect(text, `${lang} ${key}`).not.toBe(key);
        if (lang !== "en") expect(text, `${lang} ${key}`).not.toBe(t(key, undefined, "en"));
      }
      // The row draws in each language without a hook or a key left over.
      const html = pane(props());
      expect(words(html), lang).not.toMatch(/google\.[a-z]/);
      expect(words(pane(props({ state: { kind: "ready", value: OFF } }))), lang).toContain(t("google.off"));
    }
  });

  it("names months and counts rows as each language does, and words a month sent before in each", () => {
    setLang("ko");
    expect(againText(monthOptions(WORKING, NOW)[0]!, NOW)).toContain("2026년 10월");
    expect(rowsText(41)).toBe("41행");
    setLang("ja");
    expect(againText(monthOptions(WORKING, NOW)[1]!, NOW)).toContain("2026年9月");
    setLang("zh");
    expect(optionText(monthOptions(WORKING, NOW)[0]!, NOW)).toContain("2026年10月");
  });

  it("never lets a stubbed clock decide a month: the labels come from the month alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2031, 5, 1));
    expect(monthLabel("2026-10")).toBe("October 2026");
    vi.useRealTimers();
  });
});
