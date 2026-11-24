// Practice's Google Sheets (google.ts), through the in-process runtime as Customize › Connections asks for it: the person's own shop
// connected to its sample sheet with two months already sent, Disconnect and Connect with the sheet and what was sent left where
// they are, asking Ton for a month answering with a draft and sending nothing, each state the sample can start in, and Ran Pa Noi,
// where the person helps, refused as a helper's session is on the connected runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n";
import { PracticeGoogle, PRACTICE_GOOGLE_KEY, readPracticeGoogleStart } from "./google";
import { MockHost, MockRuntime } from "./index";
import { HELPED_SHOP, OWN_SHOP } from "./shops";

/** 15 January 2027, 15:00 in Bangkok: the months that have ended are December 2026 and before. */
const T0 = 1_800_000_000;
const DAY = 86_400;

async function open(host = new MockHost({ now: () => T0 })) {
  const rt = new MockRuntime(host);
  await rt.connect();
  return { rt, host };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code: string }) => e.code);

beforeEach(() => setLang("en"));
afterEach(() => vi.unstubAllGlobals());

describe("Practice's Google Sheets", () => {
  it("starts connected to a sample sheet with two months sent: one confirmed, one whose answer never came", async () => {
    const { rt } = await open();
    expect(await rt.request("google.status", {})).toEqual({
      shop: OWN_SHOP,
      state: "working",
      connectedAt: T0 - 9 * DAY,
      sheet: {
        title: "Manut AI books: Baan Mali",
        url: "https://docs.google.com/spreadsheets/d/practice-sample/edit",
        sent: [
          { month: "2026-12", at: T0 - 2 * DAY, rows: 41, outcome: "confirmed" },
          { month: "2026-11", at: T0 - 33 * DAY, rows: 38, outcome: "unknown" },
        ],
      },
    });
  });

  it("disconnects, leaving the sheet and what was sent to it, and connects again at once with no window to open", async () => {
    const { rt } = await open();
    expect(await rt.request("google.disconnect", { shop: OWN_SHOP })).toEqual({ revoked: true });
    expect(await rt.request("google.status", {})).toEqual({ shop: OWN_SHOP, state: "none" });
    // Nothing to disconnect now, and no month to ask for.
    expect(await refusal(rt.request("google.disconnect", { shop: OWN_SHOP }))).toBe("not_connected");
    expect(await rt.request("google.books", { shop: OWN_SHOP, month: "2026-12" })).toEqual({ outcome: "failed", reason: "not_connected" });
    // No Google page opens in Practice, so there is no address, and the connection is made at once, as the owner's coming back is.
    expect(await rt.request("google.connect", { shop: OWN_SHOP })).toEqual({ url: null, expiresAt: T0 + 600 });
    const back = await rt.request("google.status", {});
    expect(back).toMatchObject({ state: "working", sheet: { title: "Manut AI books: Baan Mali" } });
    expect(back.state === "working" && back.sheet?.sent.map((one) => one.month)).toEqual(["2026-12", "2026-11"]);
  });

  it("answers a month that has ended with Ton's draft and sends nothing, and the others as the API's run says", async () => {
    const { rt } = await open();
    expect(await rt.request("google.books", { shop: OWN_SHOP, month: "2026-12" })).toEqual({ outcome: "drafted" });
    // What is sent to the sheet does not change: Practice sends nothing.
    expect(JSON.stringify(await rt.request("google.status", {}))).toContain('"rows":41');
    expect((await rt.request("google.status", {}) as { sheet: { sent: unknown[] } }).sheet.sent).toHaveLength(2);
    expect(await rt.request("google.books", { shop: OWN_SHOP, month: "2027-01" })).toEqual({ outcome: "failed", reason: "month_not_over" });
    expect(await rt.request("google.books", { shop: OWN_SHOP, month: "2027-02" })).toEqual({ outcome: "failed", reason: "month_not_over" });
    for (const month of ["2026-13", "Dec", "", 7 as unknown as string]) {
      expect(await refusal(rt.request("google.books", { shop: OWN_SHOP, month })), String(month)).toBe("invalid_month");
    }
  });

  it("gives a copy of the sample, which nothing the page does to it can change", async () => {
    const { rt } = await open();
    const first = await rt.request("google.status", {});
    if (first.state === "working") first.sheet?.sent.splice(0, 2, { month: "1999-01", at: 0, rows: 1, outcome: "confirmed" });
    const again = await rt.request("google.status", {});
    expect(again.state === "working" && again.sheet?.sent.map((one) => one.month)).toEqual(["2026-12", "2026-11"]);
  });

  it("is the person's own shop's alone: Ran Pa Noi, where they help, is refused as a helper is, and any other shop is not theirs", async () => {
    const { rt } = await open();
    for (const [op, params] of [
      ["google.connect", { shop: HELPED_SHOP }],
      ["google.disconnect", { shop: HELPED_SHOP }],
      ["google.books", { shop: HELPED_SHOP, month: "2026-12" }],
    ] as const) {
      expect(await refusal((rt.request as (op: string, p: unknown) => Promise<unknown>)(op, params)), op).toBe("owner_only");
    }
    expect(await refusal(rt.request("google.connect", { shop: "pilot:elsewhere" }))).toBe("not_found");
    expect(await refusal(rt.request("google.disconnect", { shop: null }))).toBe("not_found");
    await rt.request("shops.switch", { shop: HELPED_SHOP });
    expect(await refusal(rt.request("google.status", {}))).toBe("owner_only");
  });
});

describe("where the sample can start", () => {
  const start = (state: "off" | "none" | "working" | "broken") => new PracticeGoogle(T0, state);

  it("off: Google is not set up, which the row says, and every change is refused as the API's is", () => {
    const g = start("off");
    expect(g.status(OWN_SHOP, T0)).toEqual({ shop: OWN_SHOP, state: "off" });
    for (const done of [g.connect(T0), g.disconnect(), g.books("2026-12", T0 * 1000)]) {
      expect(done).toMatchObject({ ok: false, code: "google_not_configured" });
    }
  });

  it("none: not connected and no sheet made yet, and connecting makes a connection with no sheet until Ton first asks", () => {
    const g = start("none");
    expect(g.status(OWN_SHOP, T0)).toEqual({ shop: OWN_SHOP, state: "none" });
    expect(g.connect(T0)).toEqual({ ok: true, value: { url: null, expiresAt: T0 + 600 } });
    expect(g.status(OWN_SHOP, T0)).toMatchObject({ state: "working", sheet: null });
    expect(g.books("2026-12", T0 * 1000)).toEqual({ ok: true, value: { outcome: "drafted" } });
    expect(g.status(OWN_SHOP, T0)).toMatchObject({ sheet: null });
  });

  it("broken: Google refused the grant, nothing is asked, and connecting again mends it", () => {
    const g = start("broken");
    expect(g.status(OWN_SHOP, T0)).toMatchObject({ state: "broken", reason: "invalid_grant", since: T0 - 3 * 3600, sheet: { title: "Manut AI books: Baan Mali" } });
    expect(g.books("2026-12", T0 * 1000)).toEqual({ ok: true, value: { outcome: "failed", reason: "google_broken" } });
    expect(g.connect(T0).ok).toBe(true);
    expect(g.status(OWN_SHOP, T0)).toMatchObject({ state: "working" });
  });

  it("is chosen by a saved setting read once, and any other value, or no storage, is the working sample", () => {
    const store = (value: string | null) => ({ getItem: (key: string) => (key === PRACTICE_GOOGLE_KEY ? value : null) });
    for (const value of ["off", "none", "working", "broken"] as const) expect(readPracticeGoogleStart(store(value))).toBe(value);
    for (const value of ["", "on", "BROKEN", null]) expect(readPracticeGoogleStart(store(value))).toBe("working");
    expect(readPracticeGoogleStart(undefined)).toBe("working");
    expect(readPracticeGoogleStart({ getItem: () => { throw new Error("blocked"); } })).toBe("working");
  });

  it("is read when the page starts: a host built with the setting saved starts in that state", async () => {
    vi.stubGlobal("localStorage", { getItem: (key: string) => (key === PRACTICE_GOOGLE_KEY ? "off" : null) });
    const { rt } = await open(new MockHost({ now: () => T0 }));
    expect(await rt.request("google.status", {})).toEqual({ shop: OWN_SHOP, state: "off" });
    expect(await refusal(rt.request("google.connect", { shop: OWN_SHOP }))).toBe("google_not_configured");
  });
});
