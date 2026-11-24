// Making a shop of one's own on the connected runtime (docs/pilot-api.md, "Making a shop of your own"), over a fake API: the
// request goes with the sign-in and exactly `{ name, ownerName, template }`; the owner session it answers is kept with the
// sign-in and used from the first read; the shop is then listed, shown on every page and announced; every refusal keeps the
// API's code with words for it; and what the API would refuse is refused here with nothing sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../../i18n";
import type { BridgeError, BridgeEvent } from "../../lib/protocol";
import { HttpHost } from "./host";
import { HttpRuntime } from "./index";
import { ApiSession } from "./session";
import { fakeApi, iso, memoryVault, ORIGIN, serveShop, serveShops, shopToken, storedSession, T0, type FakeAnswer, type Recorded } from "./testkit";

const NOW = T0 + 600_000;
const MADE_ID = "pilot:made-1";
const MADE_TOKEN = shopToken(MADE_ID, "owner", 9);

function setup(opts: { signedIn?: boolean; answer?: FakeAnswer } = {}) {
  const api = fakeApi();
  // In no shop: the person's list is empty, and the signed-in tenant is read as before shops.
  const served = serveShops(api, []);
  serveShop(api);
  api.on("POST", "/v1/shops/new", (req: Recorded): FakeAnswer => {
    if (opts.answer) return opts.answer;
    const body = req.body as { name: string; ownerName: string; template: string | null };
    served.list.push({ id: MADE_ID, name: body.name, ownerName: body.ownerName, role: "owner" });
    served.tokens.set(MADE_TOKEN, { shop: MADE_ID, role: "owner" });
    return { status: 201, json: { shop: { id: MADE_ID, name: body.name, ownerName: body.ownerName, template: body.template },
      role: "owner", account: { id: "owner-account-9" }, session: { accessToken: MADE_TOKEN, expiresAt: iso(NOW + 30 * 86_400_000) } } };
  });
  const vault = memoryVault(opts.signedIn === false ? null : storedSession(NOW));
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault });
  const host = new HttpHost({ session });
  const rt = new HttpRuntime(host);
  const events: BridgeEvent[] = [];
  rt.onAny((ev) => events.push(ev));
  return { api, served, vault, rt, events };
}

const make = (rt: HttpRuntime, params: { name: string; ownerName: string; template: string | null }) =>
  (rt.request as unknown as (op: string, p: unknown) => Promise<unknown>)("shops.make", params);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: BridgeError) => ({ code: e.code, message: e.message }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  setLang("en");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("making a shop on the connected runtime", () => {
  it("asks with the sign-in and exactly the shop, keeps its owner session, and shows it on every page", async () => {
    const { api, served, vault, rt, events } = setup();
    await rt.connect();
    expect(await rt.request("shops.list", {})).toMatchObject({ shops: [], current: null });

    const answer = await make(rt, { name: "  Khao Hom ", ownerName: "Dao", template: "food" });
    expect(answer).toEqual({ shop: { id: MADE_ID, name: "Khao Hom", owner: "Dao", role: "owner" } });
    const sent = api.to("POST", "/v1/shops/new");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.bearer).toBe("access-1");
    expect(sent[0]!.body).toEqual({ name: "Khao Hom", ownerName: "Dao", template: "food" });
    // The owner session the API answered is kept with the sign-in, and nothing opened the shop again.
    const kept = JSON.parse(vault.value ?? "{}") as { shops?: Record<string, { role: string; accessToken: string }> };
    expect(kept.shops?.[MADE_ID]).toMatchObject({ role: "owner", accessToken: MADE_TOKEN });
    expect(served.opened[MADE_ID]).toBeUndefined();
    // By the time it answers, the shop is listed, shown, and read with its own session.
    expect(await rt.request("shops.list", {})).toEqual({ shops: [{ id: MADE_ID, name: "Khao Hom", owner: "Dao", role: "owner" }],
      current: MADE_ID, left: [] });
    expect(events.some((ev) => ev.event === "shops.update")).toBe(true);
    expect(api.calls.filter((c) => c.bearer === MADE_TOKEN).map((c) => c.path)).toEqual(expect.arrayContaining(["/v1/approvals",
      "/v1/routines", "/v1/tenant/export"]));
  });

  it("says that the shop's team waits for Manut AI when the API's answer does", async () => {
    const answer: FakeAnswer = { status: 201, json: { shop: { id: MADE_ID, name: "Khao Hom", ownerName: "Dao", template: "food" },
      role: "owner", account: { id: "owner-account-9" }, session: { accessToken: MADE_TOKEN, expiresAt: iso(NOW + 30 * 86_400_000) },
      teamWaits: "not_counted_in" } };
    const { rt } = setup({ answer });
    await rt.connect();
    expect(await make(rt, { name: "Khao Hom", ownerName: "Dao", template: "food" })).toEqual({
      shop: { id: MADE_ID, name: "Khao Hom", owner: "Dao", role: "owner" }, teamWaits: true });
  });

  it("makes a shop of none of the kinds as no template", async () => {
    const { api, rt } = setup();
    await rt.connect();
    await make(rt, { name: "Ran Pa Noi", ownerName: "Noi", template: null });
    expect(api.to("POST", "/v1/shops/new")[0]!.body).toEqual({ name: "Ran Pa Noi", ownerName: "Noi", template: null });
  });

  it("keeps each refusal's code, with plain words for it, and lists nothing", async () => {
    const cases: [FakeAnswer, { code: string; message: string }][] = [
      [{ status: 403, json: { error: "sign_ups_closed" } }, { code: "sign_ups_closed", message: t("make.fail.sign_ups_closed") }],
      [{ status: 409, json: { error: "too_many_shops", limit: 3 } }, { code: "too_many_shops", message: t("make.fail.too_many_shops", { limit: 3 }) }],
      [{ status: 400, json: { error: "invalid_name" } }, { code: "invalid_name", message: t("make.fail.invalid_name") }],
      [{ status: 400, json: { error: "unknown_template" } }, { code: "unknown_template", message: t("make.fail.unknown_template") }],
      [{ status: 429, json: { error: "rate_limited" } }, { code: "rate_limited", message: t("make.fail.rate_limited") }],
      // The day's sign-ups being full is a 429 too, with its own code and words.
      [{ status: 429, json: { error: "sign_ups_full", retryAfter: 3600 } }, { code: "sign_ups_full", message: t("make.fail.sign_ups_full") }],
      [{ status: 400, json: { error: "invalid_request" } }, { code: "unavailable", message: t("make.fail.unavailable") }],
      [{ status: 503, json: { error: "shop_unavailable" } }, { code: "unavailable", message: t("rt.unavailable") }],
      ["offline", { code: "offline", message: t("rt.offline") }],
    ];
    for (const [answer, refused] of cases) {
      const { api, rt, vault } = setup({ answer });
      await rt.connect();
      expect(await refusal(make(rt, { name: "Khao Hom", ownerName: "Dao", template: "food" })), JSON.stringify(answer)).toEqual(refused);
      // Sent once and never again from here, even with no answer: the API may have made it.
      expect(api.to("POST", "/v1/shops/new")).toHaveLength(1);
      expect(await rt.request("shops.list", {})).toMatchObject({ shops: [], current: null });
      expect((JSON.parse(vault.value ?? "{}") as { shops?: object }).shops ?? {}).toEqual({});
    }
  });

  it("refuses what the API would refuse, with nothing sent", async () => {
    const { api, rt } = setup();
    await rt.connect();
    for (const [params, code] of [
      [{ name: "   ", ownerName: "Dao", template: "food" }, "invalid_name"],
      [{ name: "Khao Hom", ownerName: "x".repeat(81), template: "food" }, "invalid_owner_name"],
      [{ name: "Khao Hom", ownerName: "Dao", template: "bakery" }, "unknown_template"],
    ] as const) {
      expect((await refusal(make(rt, params)))?.code).toBe(code);
    }
    expect(api.to("POST", "/v1/shops/new")).toEqual([]);
  });

  it("refuses with nobody signed in, sending nothing", async () => {
    const { api, rt } = setup({ signedIn: false });
    // Nobody signed in: the runtime does not open, and answers from what it holds.
    void rt.connect().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(await refusal(make(rt, { name: "Khao Hom", ownerName: "Dao", template: null }))).toEqual({ code: "signed_out",
      message: t("rt.signedOut") });
    expect(api.to("POST", "/v1/shops/new")).toEqual([]);
  });
});
