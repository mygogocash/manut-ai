// Customize › Connections' Google Sheets on the connected runtime (google.ts), through the real host and session over a fake API: the
// status read with the session of the shop the switcher shows, Google being off told from an outage by the code a 503 now keeps, a
// shop the person helps at refused with nothing sent, Google's consent address handed to the page once and found nowhere else, a
// change sent to the shop its row was read for, the books asked for with exactly their month, and nothing sent while only a kept read
// of the shop is shown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { ShopCache } from "./cache";
import { BOOKS_PATH, CONNECT_PATH, decodeBooks, decodeGoogle, decodeSent, decodeSheet, DISCONNECT_PATH, GOOGLE_PATH, httpsUrl } from "./google";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import {
  fakeApi,
  iso,
  memoryCacheStore,
  memoryVault,
  ORIGIN,
  serveShop,
  serveShops,
  SHOP_A,
  SHOP_B,
  shopToken,
  storedSession,
  T0,
  type FakeAnswer,
  type FakeApi,
  type Recorded,
  type ServedShops,
} from "./testkit";

const NOW = T0 + 600_000;
const SIGNED_IN = "apple:owner-1";
const OWNER_A = shopToken(SHOP_A.id, "owner");
/** Google's consent address as the API makes it: a one-use state and a PKCE challenge in it. Made up for this file. */
const CONSENT = "https://accounts.google.test/o/oauth2/v2/auth?client_id=c&state=mgs1.SECRET-STATE-7f3a&code_challenge=SECRET-CHALLENGE-91c2";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/sheet1/edit";

const sheetJson = (over: Record<string, unknown> = {}) => ({
  id: "sheet1",
  title: "Manut AI books: Baan Mali",
  tab: "Books",
  url: SHEET_URL,
  appended: [
    { month: "2026-10", at: iso(T0 - 3_600_000), rows: 41, outcome: "confirmed" },
    { month: "2026-09", at: iso(T0 - 30 * 86_400_000), rows: 38, outcome: "unknown" },
  ],
  ...over,
});
const workingJson = (over: Record<string, unknown> = {}) => ({
  connected: true,
  connection: { id: "conn-1", connectedAt: iso(T0 - 86_400_000), state: "working", sheet: sheetJson(), ...over },
});

/** What the fake API answers for Google, by what each tenant's connection is: the routes answer by the bearer as apps/api answers
 *  them (a shop session for its own shop, a helper's refused `owner_only`, and the sign-in for the signed-in tenant). */
type Mode = { status: FakeAnswer; connect?: FakeAnswer; disconnect?: FakeAnswer; books?: FakeAnswer };

function serveGoogle(api: FakeApi, served: ServedShops | null, mode: () => Mode) {
  const asked: Recorded[] = [];
  const owned = (req: Recorded, answer: () => FakeAnswer): FakeAnswer => {
    if (req.bearer?.startsWith("access-")) return answer();
    const held = req.bearer ? served?.tokens.get(req.bearer) : undefined;
    if (!held || served?.refused.has(req.bearer!)) return { status: 401, json: { error: "unauthorized" } };
    const ended = served?.ended[held.shop];
    if (ended) return { status: 401, json: { error: ended.error, [`${ended.error}At`]: ended.at } };
    return held.role === "owner" ? answer() : { status: 403, json: { error: "owner_only" } };
  };
  api
    .on("GET", GOOGLE_PATH, (req) => owned(req, () => mode().status))
    .on("POST", CONNECT_PATH, (req) => owned(req, () => mode().connect ?? { status: 200, json: { url: CONSENT, expiresAt: iso(NOW + 600_000) } }))
    .on("POST", DISCONNECT_PATH, (req) => owned(req, () => mode().disconnect ?? { status: 200, json: { disconnected: true, revoked: true } }))
    .on("POST", BOOKS_PATH, (req) => {
      asked.push(req);
      return owned(req, () => mode().books ?? { status: 200, json: { taskId: "t1", member: "ton", outcome: "asked", requestId: "r1", kind: "command" } });
    });
  return asked;
}

/** The connected runtime as the app runs it, for a person in shops A (owned) and B (helped), or in none. */
async function setup(opts: { shops: boolean; mode?: Mode }) {
  const api = fakeApi();
  const served = opts.shops ? serveShops(api, [SHOP_A, SHOP_B]) : null;
  if (!opts.shops) serveShop(api).on("GET", "/v1/shops", { status: 200, json: { shops: [] } });
  const mode: { now: Mode } = { now: opts.mode ?? { status: { status: 200, json: workingJson() } } };
  const asked = serveGoogle(api, served, () => mode.now);
  const disk = memoryCacheStore();
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(storedSession(NOW)) });
  const host = new HttpHost({ session, cache: new ShopCache(disk) });
  const rt = new HttpRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((ev) => events.push(ev));
  await rt.connect();
  const ask = rt.request.bind(rt);
  return { api, served, mode, asked, disk, session, host, rt, ask, events };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => e);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reading where Google Sheets stands", () => {
  it("reads the shop the switcher shows with that shop's own owner session: the sheet, and what was sent to it, newest first", async () => {
    const { api, ask } = await setup({ shops: true });
    expect(await ask("google.status", {})).toEqual({
      shop: SHOP_A.id,
      state: "working",
      connectedAt: (T0 - 86_400_000) / 1000,
      sheet: {
        title: "Manut AI books: Baan Mali",
        url: SHEET_URL,
        sent: [
          { month: "2026-10", at: (T0 - 3_600_000) / 1000, rows: 41, outcome: "confirmed" },
          { month: "2026-09", at: (T0 - 30 * 86_400_000) / 1000, rows: 38, outcome: "unknown" },
        ],
      },
    });
    expect(api.to("GET", GOOGLE_PATH).map((c) => c.bearer)).toEqual([OWNER_A]);
  });

  it("says not connected, connected with no sheet yet, and broken with its reason", async () => {
    const { ask, mode } = await setup({ shops: true });
    mode.now = { status: { status: 200, json: { connected: false, connection: null } } };
    expect(await ask("google.status", {})).toEqual({ shop: SHOP_A.id, state: "none" });
    mode.now = { status: { status: 200, json: workingJson({ sheet: null }) } };
    expect(await ask("google.status", {})).toEqual({ shop: SHOP_A.id, state: "working", connectedAt: (T0 - 86_400_000) / 1000, sheet: null });
    mode.now = { status: { status: 200, json: workingJson({ state: "broken", broken: { at: iso(T0 + 1000), reason: "invalid_grant", words: "x" } }) } };
    expect(await ask("google.status", {})).toMatchObject({ state: "broken", since: (T0 + 1000) / 1000, reason: "invalid_grant", sheet: { title: "Manut AI books: Baan Mali" } });
  });

  it("is off, no failure, while the API says google_not_configured, and tells that 503 from an outage", async () => {
    const { ask, mode } = await setup({ shops: true });
    mode.now = { status: { status: 503, json: { error: "google_not_configured" } } };
    expect(await ask("google.status", {})).toEqual({ shop: SHOP_A.id, state: "off" });
    // Any other 5xx, with a code or with none, is no answer.
    for (const status of [{ status: 503, json: { error: "vault_unavailable" } }, { status: 502, text: "bad gateway" }] as FakeAnswer[]) {
      mode.now = { status };
      expect(await refusal(ask("google.status", {}))).toEqual({ code: "unavailable", message: t("google.err.unavailable") });
    }
  });

  it("refuses a shop the person helps at with nothing sent, and a person in no shops, and an answer it cannot read", async () => {
    const { api, ask, mode } = await setup({ shops: true });
    await ask("shops.switch", { shop: SHOP_B.id });
    expect(await refusal(ask("google.status", {}))).toEqual({ code: "owner_only", message: t("google.err.ownerOnly") });
    expect(api.to("GET", GOOGLE_PATH)).toEqual([]);
    await ask("shops.switch", { shop: SHOP_A.id });
    for (const body of [{ connected: "yes" }, { connected: true, connection: { state: "working" } }, { connected: true, connection: { connectedAt: iso(T0), state: "paused", sheet: null } },
      { connected: true, connection: { connectedAt: iso(T0), state: "working", sheet: { title: "" } } }]) {
      mode.now = { status: { status: 200, json: body } };
      expect(await refusal(ask("google.status", {})), JSON.stringify(body)).toEqual({ code: "unavailable", message: t("google.err.unreadable") });
    }
    const none = await setup({ shops: false });
    expect(await refusal(none.ask("google.status", {}))).toEqual({ code: "no_shop", message: t("google.err.noShop") });
    expect(none.api.to("GET", GOOGLE_PATH)).toEqual([]);
  });

  it("says so in the departure's words when the person's place in the shop ended", async () => {
    const { ask, served, events } = await setup({ shops: true });
    served!.ended[SHOP_A.id] = { error: "unlinked", at: iso(NOW - 60_000) };
    const out = await refusal(ask("google.status", {}));
    expect(out?.code).toBe("unlinked");
    expect(out?.message).toContain("Baan Mali");
    expect(events.some((e) => e.event === "shops.update")).toBe(true);
  });
});

describe("connecting", () => {
  it("sends exactly {} with the shop's own session and hands Google's address to the page once, keeping it nowhere", async () => {
    const { api, ask, disk, events, host } = await setup({ shops: true });
    const made = await ask("google.connect", { shop: SHOP_A.id });
    expect(made).toEqual({ url: CONSENT, expiresAt: (NOW + 600_000) / 1000 });
    expect(api.to("POST", CONNECT_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, {}]]);
    // The address carries a one-use state and a PKCE challenge: the saved read of the shop, the events, the host and every other
    // request are free of both.
    for (const secret of ["SECRET-STATE-7f3a", "SECRET-CHALLENGE-91c2"]) {
      expect(JSON.stringify([...disk.files.values()])).not.toContain(secret);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(JSON.stringify(host)).not.toContain(secret);
      for (const call of api.calls) expect(JSON.stringify(call)).not.toContain(secret);
    }
  });

  it("is refused for a shop the person helps at, for no shop, and for a shop that is not theirs, with nothing sent", async () => {
    const { api, ask } = await setup({ shops: true });
    expect((await refusal(ask("google.connect", { shop: SHOP_B.id })))?.code).toBe("owner_only");
    expect((await refusal(ask("google.connect", { shop: null })))?.code).toBe("no_shop");
    expect((await refusal(ask("google.connect", { shop: "pilot:elsewhere" })))?.code).toBe("not_found");
    expect(api.to("POST", CONNECT_PATH)).toEqual([]);
  });

  it("says Google is off when the API does, and reads an address that is not https, or an expiry that is not a time, as no answer", async () => {
    const { ask, mode } = await setup({ shops: true });
    mode.now = { status: { status: 200, json: workingJson() }, connect: { status: 503, json: { error: "google_not_configured" } } };
    expect(await refusal(ask("google.connect", { shop: SHOP_A.id }))).toEqual({ code: "google_not_configured", message: t("google.off") });
    for (const json of [{ url: "http://accounts.google.test/auth", expiresAt: iso(NOW) }, { url: CONSENT, expiresAt: "soon" }, { url: "javascript:alert(1)", expiresAt: iso(NOW) },
      { url: "https://user:pw@accounts.google.test/auth", expiresAt: iso(NOW) }, { expiresAt: iso(NOW) }]) {
      mode.now = { status: { status: 200, json: workingJson() }, connect: { status: 200, json } };
      expect(await refusal(ask("google.connect", { shop: SHOP_A.id })), JSON.stringify(json)).toEqual({ code: "unavailable", message: t("google.err.unreadable") });
    }
  });

  it("says plainly that no answer came back for a change, since the API may have made it", async () => {
    const { ask, mode } = await setup({ shops: true });
    mode.now = { status: { status: 200, json: workingJson() }, connect: { status: 502, text: "bad gateway" } };
    expect(await refusal(ask("google.connect", { shop: SHOP_A.id }))).toEqual({ code: "unavailable", message: t("rt.change.noReply") });
  });
});

describe("disconnecting and asking Ton for a month", () => {
  it("disconnects the shop its row was read for, and says whether Google could be reached", async () => {
    const { api, ask, mode } = await setup({ shops: true });
    expect(await ask("google.disconnect", { shop: SHOP_A.id })).toEqual({ revoked: true });
    mode.now = { status: { status: 200, json: workingJson() }, disconnect: { status: 200, json: { disconnected: true, revoked: false } } };
    expect(await ask("google.disconnect", { shop: SHOP_A.id })).toEqual({ revoked: false });
    expect(api.to("POST", DISCONNECT_PATH).map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, {}], [OWNER_A, {}]]);
    mode.now = { status: { status: 200, json: workingJson() }, disconnect: { status: 404, json: { error: "not_connected" } } };
    expect(await refusal(ask("google.disconnect", { shop: SHOP_A.id }))).toEqual({ code: "not_connected", message: t("google.err.notConnected") });
    mode.now = { status: { status: 200, json: workingJson() }, disconnect: { status: 200, json: { disconnected: false } } };
    expect((await refusal(ask("google.disconnect", { shop: SHOP_A.id })))?.code).toBe("unavailable");
    expect((await refusal(ask("google.disconnect", { shop: SHOP_B.id })))?.code).toBe("owner_only");
  });

  it("sends exactly the month, with the shop's own session, and reads what the worker run came to", async () => {
    const { ask, asked, mode, api } = await setup({ shops: true });
    expect(await ask("google.books", { shop: SHOP_A.id, month: "2026-10" })).toEqual({ outcome: "asked" });
    expect(asked.map((c) => [c.bearer, c.body])).toEqual([[OWNER_A, { month: "2026-10" }]]);
    const runs: [FakeAnswer, unknown][] = [
      [{ status: 200, json: { outcome: "done", member: "ton", draft: { send: { answer: "draft_only", kind: "command" }, text: "x" } } }, { outcome: "drafted" }],
      [{ status: 200, json: { outcome: "done", member: "ton", draft: { text: "No payments were recorded in 2026-10, so there is nothing to append." } } }, { outcome: "empty" }],
      [{ status: 200, json: { outcome: "failed", reason: "month_incomplete" } }, { outcome: "failed", reason: "month_incomplete" }],
      [{ status: 200, json: { outcome: "failed", reason: "Not A Code!" } }, { outcome: "failed", reason: "unknown" }],
      [{ status: 200, json: { outcome: "failed" } }, { outcome: "failed", reason: "unknown" }],
    ];
    for (const [answer, expected] of runs) {
      mode.now = { status: { status: 200, json: workingJson() }, books: answer };
      expect(await ask("google.books", { shop: SHOP_A.id, month: "2026-10" })).toEqual(expected);
    }
    for (const bad of [{ outcome: "paused" }, { outcome: "done" }, "text"]) {
      mode.now = { status: { status: 200, json: workingJson() }, books: { status: 200, json: bad } };
      expect((await refusal(ask("google.books", { shop: SHOP_A.id, month: "2026-10" })))?.code, JSON.stringify(bad)).toBe("unavailable");
    }
    expect(api.to("POST", BOOKS_PATH).length).toBeGreaterThan(5);
  });

  it("reads the shop again once Ton has asked, so the ask shows in Needs you at once, and only then", async () => {
    const { api, ask, mode } = await setup({ shops: true });
    const reads = () => api.to("GET", "/v1/approvals").length;
    const before = reads();
    await ask("google.books", { shop: SHOP_A.id, month: "2026-10" });
    expect(reads()).toBeGreaterThan(before);
    mode.now = { status: { status: 200, json: workingJson() }, books: { status: 200, json: { outcome: "failed", reason: "month_not_over" } } };
    const after = reads();
    await ask("google.books", { shop: SHOP_A.id, month: "2026-10" });
    expect(reads()).toBe(after);
  });

  it("answers each refusal of the route in plain words, and sends no month it would refuse itself", async () => {
    const { api, ask, mode } = await setup({ shops: true });
    const cases: [number, string, string][] = [
      [409, "team_paused", t("google.err.paused")],
      [409, "member_off", t("google.err.memberOff")],
      [403, "consent_required", t("google.err.consent")],
      [403, "feature_disabled", t("google.err.switchedOff")],
      [404, "shop_not_found", t("google.err.notFound")],
      [400, "invalid_month", t("google.err.month")],
      [409, "something_new", t("google.err.failed")],
    ];
    for (const [status, error, words] of cases) {
      mode.now = { status: { status: 200, json: workingJson() }, books: { status, json: { error } } };
      expect(await refusal(ask("google.books", { shop: SHOP_A.id, month: "2026-10" })), error).toEqual({ code: error, message: words });
    }
    mode.now = { status: { status: 200, json: workingJson() }, books: { status: 503, json: { error: "google_not_configured" } } };
    expect((await refusal(ask("google.books", { shop: SHOP_A.id, month: "2026-10" })))?.code).toBe("google_not_configured");
    const sent = api.to("POST", BOOKS_PATH).length;
    for (const month of ["2026-13", "2026-1", "October", "", 7 as unknown as string]) {
      expect((await refusal(ask("google.books", { shop: SHOP_A.id, month })))?.code, String(month)).toBe("invalid_month");
    }
    expect((await refusal(ask("google.books", { shop: SHOP_B.id, month: "2026-10" })))?.code).toBe("owner_only");
    expect(api.to("POST", BOOKS_PATH).length).toBe(sent);
  });

  it("sends nothing while only a kept read of the shop is shown", async () => {
    const { api, ask, host } = await setup({ shops: true });
    host.cache = { kind: "showing", at: NOW - 60_000 };
    const before = api.calls.length;
    for (const [op, params] of [
      ["google.status", {}],
      ["google.connect", { shop: SHOP_A.id }],
      ["google.disconnect", { shop: SHOP_A.id }],
      ["google.books", { shop: SHOP_A.id, month: "2026-10" }],
    ] as const) {
      expect(await refusal((ask as (op: string, p: unknown) => Promise<unknown>)(op, params)), op).toEqual({ code: "offline", message: t("rt.offline") });
    }
    expect(api.calls.length).toBe(before);
  });
});

describe("the answers, read field by field", () => {
  it("takes a sent month only whole, and a sheet's name only as text", () => {
    const sent = { month: "2026-10", at: iso(T0), rows: 3, outcome: "confirmed" };
    expect(decodeSent(sent)).toEqual({ month: "2026-10", at: T0 / 1000, rows: 3, outcome: "confirmed" });
    for (const bad of [{ ...sent, month: "2026-13" }, { ...sent, at: "yesterday" }, { ...sent, rows: -1 }, { ...sent, rows: 1.5 }, { ...sent, outcome: "sending" }, null, "x"]) {
      expect(decodeSent(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(decodeSheet({ title: "Books", appended: [sent, { month: "x" }] })).toEqual({ title: "Books", url: null, sent: [decodeSent(sent)] });
    expect(decodeSheet({ title: "Books" })).toEqual({ title: "Books", url: null, sent: [] });
    expect(decodeSheet({ title: "Books", url: "http://insecure.example/x" })?.url).toBeNull();
    expect(decodeSheet({ title: "  " })).toBeNull();
    expect(decodeSheet({ title: "x".repeat(513) })).toBeNull();
    expect(decodeSheet({ title: 7 })).toBeNull();
  });

  it("opens only an https address with no name or password in it", () => {
    expect(httpsUrl("https://docs.google.com/spreadsheets/d/x/edit")).toBe(true);
    for (const bad of ["http://docs.google.com/", "https://u:p@docs.google.com/", "https://user@docs.google.com/", "javascript:alert(1)", "file:///etc/passwd", "docs.google.com", "", 7, null, `https://x.test/${"a".repeat(5000)}`]) {
      expect(httpsUrl(bad), String(bad).slice(0, 40)).toBe(false);
    }
  });

  it("reads the status and the run as they are, and nothing else", () => {
    expect(decodeGoogle({ connected: false, connection: null })).toEqual({ state: "none" });
    expect(decodeGoogle({ connected: false })).toEqual({ state: "none" });
    expect(decodeGoogle({ connected: false, connection: { id: "c" } })).toBeNull();
    expect(decodeBooks({ outcome: "asked", requestId: "r" })).toEqual({ outcome: "asked" });
    expect(decodeBooks({ outcome: "done" })).toBeNull();
    expect(decodeBooks(null)).toBeNull();
  });
});
