// The person's shops and their shop sessions (shops.ts): the list read with the sign-in; one session per shop, opened with
// exactly `{ shop }` and kept only in the keychain item; every request for a shop sent with that shop's own session and no
// other; a session that ended opened again once; and a removal or an unlinking ending the person's place in the shop at
// once, with when.
import { describe, expect, it } from "vitest";
import { ApiSession } from "./session";
import { decodeShops, listShops, SHOP_EARLY_MS, ShopSessions } from "./shops";
import { approvalJson, clock, fakeApi, memoryVault, ORIGIN, serveShops, SHOP_A, SHOP_B, shopToken, storedSession, tokens } from "./testkit";

function setup() {
  const c = clock();
  const api = fakeApi();
  const served = serveShops(api, [SHOP_A, SHOP_B], { [SHOP_A.id]: [approvalJson({ id: "req-a" })], [SHOP_B.id]: [approvalJson({ id: "req-b", kind: "money" })] }, c.now);
  const vault = memoryVault(storedSession(c.now()));
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, now: c.now });
  const shops = new ShopSessions(session, c.now);
  const kept = () => JSON.parse(vault.value ?? "null") as { shops?: Record<string, { accessToken: string; role: string; expiresAt: number }> } | null;
  return { c, api, served, vault, session, shops, kept };
}

const ids = (json: unknown) => ((json as { approvals: { record: { request: { id: string } } }[] }).approvals ?? []).map((a) => a.record.request.id);

describe("the list of shops", () => {
  it("reads the shops with the sign-in, the ones the person owns first, each one whole and once", async () => {
    const { api, session } = setup();
    api.on("GET", "/v1/shops", {
      status: 200,
      json: {
        shops: [
          SHOP_B,
          SHOP_A,
          { ...SHOP_A, name: "Again" },
          { id: "pilot:c", name: "Co-owned", ownerName: "Fon", role: "co-owner" },
          { id: "", name: "No id", ownerName: "", role: "owner" },
          { id: "pilot:d", name: 5, ownerName: "Fon", role: "owner" },
          "nonsense",
        ],
      },
    });
    expect(await listShops(session)).toEqual({
      ok: true,
      shops: [
        { id: SHOP_A.id, name: "Baan Mali", owner: "Fon", role: "owner" },
        { id: SHOP_B.id, name: "Ran Pa Noi", owner: "Noi", role: "helper" },
      ],
    });
    expect(api.to("GET", "/v1/shops")).toEqual([expect.objectContaining({ bearer: "access-1" })]);
  });

  it("reads an API from before shops (404) as no shops, and fails a read the API could not answer", async () => {
    const cases = [
      [{ status: 404, json: { error: "not_found" } }, { ok: true, shops: [] }],
      [{ status: 503, json: { error: "shops_unavailable" } }, { ok: false, failure: "unavailable" }],
      [{ status: 400, json: { error: "invalid_request" } }, { ok: false, failure: "unavailable" }],
      ["offline", { ok: false, failure: "offline" }],
    ] as const;
    for (const [answer, read] of cases) {
      const { api, session } = setup();
      api.on("GET", "/v1/shops", answer);
      expect(await listShops(session)).toEqual(read);
    }
    expect(decodeShops(null)).toEqual([]);
  });
});

describe("a shop's own session", () => {
  it("opens the shop with exactly { shop } and the sign-in, keeps the token only in the keychain item, and sends each shop's requests with its own", async () => {
    const { api, shops, kept, c } = setup();
    const a = await shops.read(SHOP_A.id, "/v1/approvals?state=open");
    const b = await shops.read(SHOP_B.id, "/v1/approvals?state=open");
    expect(a.kind === "ok" && ids(a.json)).toEqual(["req-a"]);
    expect(b.kind === "ok" && ids(b.json)).toEqual(["req-b"]);
    expect(api.to("POST", "/v1/shops/session").map((r) => [r.bearer, r.body])).toEqual([
      ["access-1", { shop: SHOP_A.id }],
      ["access-1", { shop: SHOP_B.id }],
    ]);
    expect(api.to("GET", "/v1/approvals").map((r) => r.bearer)).toEqual([shopToken(SHOP_A.id, "owner"), shopToken(SHOP_B.id, "helper")]);
    expect(kept()?.shops).toEqual({
      [SHOP_A.id]: { role: "owner", accessToken: shopToken(SHOP_A.id, "owner"), expiresAt: c.now() + 30 * 86_400_000 },
      [SHOP_B.id]: { role: "helper", accessToken: shopToken(SHOP_B.id, "helper"), expiresAt: c.now() + 30 * 86_400_000 },
    });
    // held now: the next read opens nothing
    await shops.read(SHOP_A.id, "/v1/approvals?state=open");
    expect(api.to("POST", "/v1/shops/session")).toHaveLength(2);
    for (const call of api.calls) expect(call.url, call.url).not.toMatch(/mos1|mhs1|access-/);
  });

  it("says the role the held session has, which is what the API decides with", async () => {
    const { shops, served } = setup();
    const row = { id: SHOP_B.id, name: SHOP_B.name, owner: SHOP_B.ownerName, role: "owner" as const };
    expect(shops.roleAt(row)).toBe("owner");
    served.list = [SHOP_A, SHOP_B];
    await shops.read(SHOP_B.id, "/v1/approvals?state=open");
    expect(shops.roleAt(row)).toBe("helper");
  });

  it("opens a shop again before its 30 days end, so an ended session is never sent", async () => {
    const { api, shops, c } = setup();
    // the sign-in's hour is long over by then, so opening the shop again refreshes it first
    api.on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    await shops.read(SHOP_A.id, "/v1/approvals?state=open");
    c.pass(30 * 86_400_000 - SHOP_EARLY_MS + 1);
    await shops.read(SHOP_A.id, "/v1/approvals?state=open");
    expect(api.to("GET", "/v1/approvals").map((r) => r.bearer)).toEqual([shopToken(SHOP_A.id, "owner", 1), shopToken(SHOP_A.id, "owner", 2)]);
  });

  it("opens the shop again once on a 401, and sends the same request once more; a second 401 is not opened again", async () => {
    const { api, shops, served } = setup();
    await shops.read(SHOP_A.id, "/v1/approvals?state=open");
    served.refused.add(shopToken(SHOP_A.id, "owner", 1));
    api.on("POST", "/v1/approvals/req-a/decision", (r) => (served.refused.has(r.bearer!) ? { status: 401, json: { error: "unauthorized" } } : { status: 200, json: { result: { ok: true } } }));
    const decided = await shops.write(SHOP_A.id, "/v1/approvals/req-a/decision", { optionId: "approve", seenRevision: 1 });
    expect(decided.kind).toBe("ok");
    expect(api.to("POST", "/v1/approvals/req-a/decision").map((r) => [r.bearer, r.body])).toEqual([
      [shopToken(SHOP_A.id, "owner", 1), { optionId: "approve", seenRevision: 1 }],
      [shopToken(SHOP_A.id, "owner", 2), { optionId: "approve", seenRevision: 1 }],
    ]);
    // a session the shop refuses right after it was opened is not opened a third time
    api.on("GET", "/v1/approvals", { status: 401, json: { error: "unauthorized" } });
    const refused = await shops.read(SHOP_A.id, "/v1/approvals?state=open");
    expect(refused).toMatchObject({ kind: "refused", status: 401 });
    expect(served.opened[SHOP_A.id]).toBe(3);
  });

  it("opens a shop once for requests that find its session ended together", async () => {
    const { shops, served } = setup();
    await Promise.all([shops.read(SHOP_A.id, "/v1/approvals?state=open"), shops.read(SHOP_A.id, "/v1/approvals?state=open")]);
    expect(served.opened[SHOP_A.id]).toBe(1);
  });

  it("ends the person's place in a shop on 401 removed or unlinked: says when, drops the session at once, and opens nothing", async () => {
    for (const [error, shop, role] of [["removed", SHOP_B, "helper"], ["unlinked", SHOP_A, "owner"]] as const) {
      const { shops, served, kept, api } = setup();
      await shops.read(shop.id, "/v1/approvals?state=open");
      served.ended[shop.id] = { error, at: "2026-11-22T03:00:00.000Z" };
      expect(await shops.read(shop.id, "/v1/approvals?state=open"), error).toEqual({ kind: "left", departure: { why: error, at: Date.parse("2026-11-22T03:00:00.000Z") } });
      expect(kept()?.shops?.[shop.id], error).toBeUndefined();
      expect(served.opened[shop.id]).toBe(1);
      expect(api.to("GET", "/v1/approvals").every((r) => r.bearer === shopToken(shop.id, role))).toBe(true);
    }
  });

  it("reads a shop the sign-in can no longer open as gone, and a sign-in that is over as signed out", async () => {
    const { shops, served } = setup();
    served.list = [SHOP_A];
    expect(await shops.read(SHOP_B.id, "/v1/approvals?state=open")).toEqual({ kind: "left", departure: { why: "gone", at: null } });
    const out = setup();
    await out.session.load();
    out.api.on("POST", "/v1/shops/session", { status: 401, json: { error: "unauthorized" } }).on("POST", "/v1/auth/refresh", { status: 401, json: { error: "invalid_grant" } });
    expect(await out.shops.read(SHOP_A.id, "/v1/approvals?state=open")).toEqual({ kind: "signed_out" });
    const offline = setup();
    offline.api.on("POST", "/v1/shops/session", "offline");
    expect(await offline.shops.read(SHOP_A.id, "/v1/approvals?state=open")).toEqual({ kind: "offline" });
  });

  it("drops a shop's session here without asking the API", async () => {
    const { shops, kept, api } = setup();
    await shops.read(SHOP_A.id, "/v1/approvals?state=open");
    await shops.drop([SHOP_A.id]);
    expect(kept()?.shops).toEqual({});
    expect(api.to("POST", "/v1/shops/session/end")).toEqual([]);
  });
});
