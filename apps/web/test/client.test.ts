import { describe, expect, it, vi } from "vitest";
import { createHttpApi } from "../src/api/client";
import { ApiError, type PilotApi } from "../src/api/types";

type Call = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  raw: unknown;
  credentials: RequestCredentials | undefined;
};

function harness(key: string | null, answer: (url: string) => Response = () => json({})) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body,
      raw: init?.body,
      credentials: init?.credentials,
    });
    return answer(url);
  });
  const api = createHttpApi({ origin: "https://api.example.test/", operatorKey: () => key, fetch });
  return { api, calls, fetch };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const listAnswers = (url: string): Response => {
  if (url.includes("/shops")) return json({ shops: [] });
  if (url.includes("/messages")) return json({ messages: [] });
  if (url.includes("/actions")) return json({ actions: [] });
  if (url.includes("/payments")) return json({ payments: [] });
  if (url.includes("/subscription-payments")) return json({ payments: [] });
  return json({});
};

async function everyAdminRoute(api: PilotApi) {
  await api.createShop({ name: "Baan Mali", ownerName: "Fon" });
  await api.listShops();
  await api.createLineConnection({
    tenant: "t1",
    channelId: "c1",
    botUserId: "U1",
    channelSecret: "secret",
    channelAccessToken: "token",
  });
  await api.listMessages("t1");
  await api.proposeReply({ tenant: "t1", messageId: "m1", text: "Hello" });
  await api.listActions("t1");
  await api.recordPayment({ tenant: "t1", orderRef: "SP-2301", amountSatang: 129000, promptPayId: "0812345678" });
  await api.listPayments("t1");
  await api.exportShop("t1");
  await api.deleteShop({ tenant: "t1", confirmName: "Baan Mali" });
  await api.recordSubscriptionPayment({ tenant: "t1", amountSatang: 49900, slipRef: "KB-1", slipNote: "KBank 10:02" });
  await api.listSubscriptionPayments("t1");
  await api.getGate();
  await api.listAudit("t1", { before: "aud-mi8x2k4c0-000-0a1b2c3d", limit: 20 });
  await api.getMemory("t1");
  await api.rememberFact({ tenant: "t1", text: "We close on Mondays" });
  await api.confirmFact({ tenant: "t1", id: "f2" });
  await api.correctFact({ tenant: "t1", id: "f2", text: "We close on Tuesdays" });
  await api.forgetFact({ tenant: "t1", id: "f2" });
}

describe("the API client", () => {
  it("sends the operator key as a bearer token on every admin route, to the contract's paths", async () => {
    const { api, calls } = harness("op-key-123", listAnswers);
    await everyAdminRoute(api);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.example.test/v1/admin/pilot/shops",
      "GET https://api.example.test/v1/admin/pilot/shops",
      "POST https://api.example.test/v1/admin/pilot/line-connections",
      "GET https://api.example.test/v1/admin/pilot/messages?tenant=t1",
      "POST https://api.example.test/v1/admin/pilot/replies",
      "GET https://api.example.test/v1/admin/pilot/actions?tenant=t1",
      "POST https://api.example.test/v1/admin/pilot/payments",
      "GET https://api.example.test/v1/admin/pilot/payments?tenant=t1",
      "GET https://api.example.test/v1/admin/pilot/export?tenant=t1",
      "POST https://api.example.test/v1/admin/pilot/deletions",
      "POST https://api.example.test/v1/admin/pilot/subscription-payments",
      "GET https://api.example.test/v1/admin/pilot/subscription-payments?tenant=t1",
      "GET https://api.example.test/v1/admin/pilot/gate",
      "GET https://api.example.test/v1/admin/audit?tenant=t1&before=aud-mi8x2k4c0-000-0a1b2c3d&limit=20",
      "GET https://api.example.test/v1/admin/memory?tenant=t1",
      "POST https://api.example.test/v1/admin/memory/remember",
      "POST https://api.example.test/v1/admin/memory/confirm",
      "POST https://api.example.test/v1/admin/memory/correct",
      "POST https://api.example.test/v1/admin/memory/forget",
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer op-key-123");
      expect(call.credentials).toBe("include");
    }
    expect(calls[10]?.body).toEqual({ tenant: "t1", amountSatang: 49900, slipRef: "KB-1", slipNote: "KBank 10:02" });
    expect(calls[4]?.body).toEqual({ tenant: "t1", messageId: "m1", text: "Hello" });
    expect(calls[6]?.body).toEqual({
      tenant: "t1",
      orderRef: "SP-2301",
      amountSatang: 129000,
      promptPayId: "0812345678",
    });
    expect(calls[9]?.body).toEqual({ tenant: "t1", confirmName: "Baan Mali" });
    // Memory: the tenant and exactly what the route takes, nothing else.
    expect(calls[15]?.body).toEqual({ tenant: "t1", text: "We close on Mondays" });
    expect(calls[16]?.body).toEqual({ tenant: "t1", id: "f2" });
    expect(calls[17]?.body).toEqual({ tenant: "t1", id: "f2", text: "We close on Tuesdays" });
    expect(calls[18]?.body).toEqual({ tenant: "t1", id: "f2" });
  });

  it("reads what the team knows about a shop, and turns the memory routes' refusals into ApiError", async () => {
    const fact = { id: "f1", text: "We close on Mondays", status: "confirmed", createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000, source: { kind: "owner" } };
    const memory = { tenant: "pilot:1", facts: [fact], forgottenCount: 2 };
    const refusals: Record<string, [number, string]> = {
      "/v1/admin/memory/remember": [409, "already_known"],
      "/v1/admin/memory/confirm": [404, "not_found"],
      "/v1/admin/memory/correct": [400, "invalid_text"],
      "/v1/admin/memory/forget": [409, "full"],
    };
    const { api, calls } = harness("op-key-123", (url) => {
      const { pathname } = new URL(url);
      const refusal = refusals[pathname];
      return refusal ? json({ error: refusal[1] }, refusal[0]) : json(memory);
    });

    expect(await api.getMemory("pilot:1")).toEqual(memory);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/admin/memory?tenant=pilot%3A1");
    await expect(api.rememberFact({ tenant: "pilot:1", text: "x" })).rejects.toMatchObject({ status: 409, code: "already_known" });
    await expect(api.confirmFact({ tenant: "pilot:1", id: "f9" })).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(api.correctFact({ tenant: "pilot:1", id: "f1", text: "" })).rejects.toMatchObject({ status: 400, code: "invalid_text" });
    await expect(api.forgetFact({ tenant: "pilot:1", id: "f1" })).rejects.toMatchObject({ status: 409, code: "full" });
  });

  it("answers the fact on success and the id for Forget, as the memory routes do", async () => {
    const fact = { id: "f1", text: "We close on Mondays", status: "confirmed", createdAt: 1, updatedAt: 1, source: { kind: "owner" } };
    const { api } = harness("op-key-123", (url) => (url.endsWith("/forget") ? json({ id: "f1" }) : json(fact)));
    expect(await api.rememberFact({ tenant: "t1", text: "We close on Mondays" })).toEqual(fact);
    expect(await api.confirmFact({ tenant: "t1", id: "f1" })).toEqual(fact);
    expect(await api.correctFact({ tenant: "t1", id: "f1", text: "We close on Mondays" })).toEqual(fact);
    expect(await api.forgetFact({ tenant: "t1", id: "f1" })).toEqual({ id: "f1" });
  });

  it("never sends the key, or cookies, on the owner's routes or the LINE webhook", async () => {
    const view = { state: "proposed", replyText: "x", shopName: "Baan Mali" };
    const { api, calls } = harness("op-key-123", (url) =>
      url.includes("/inbound/") ? new Response(null, { status: 200 }) : json(view),
    );

    await api.getApproval("tok/en");
    await api.giveConsent("tok/en");
    await api.decide("tok/en", true);
    await api.decide("tok/en", false);
    await api.deliverLineWebhook("line_1", '{"events":[]}', "c2ln");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.example.test/v1/pilot/approvals/tok%2Fen",
      "POST https://api.example.test/v1/pilot/approvals/tok%2Fen/consent",
      "POST https://api.example.test/v1/pilot/approvals/tok%2Fen/decision",
      "POST https://api.example.test/v1/pilot/approvals/tok%2Fen/decision",
      "POST https://api.example.test/v1/inbound/line/line_1",
    ]);
    for (const call of calls) {
      expect(call.headers.has("authorization")).toBe(false);
      expect(call.credentials).toBe("omit");
    }
    expect(calls[1]?.body).toEqual({ cloudWork: true });
    expect(calls[2]?.body).toEqual({ approve: true });
    expect(calls[3]?.body).toEqual({ approve: false });
    expect(calls[4]?.headers.get("x-line-signature")).toBe("c2ln");
    expect(calls[4]?.raw).toBe('{"events":[]}');
  });

  it("reads the gate and a shop's subscription payments as the contract answers them", async () => {
    const gate = {
      asOf: "2026-12-21T03:00:00.000Z",
      rules: { trialDays: 14, priceSatang: 49900, activeWindowDays: 7 },
      shops: [{ tenant: "t1", name: "Baan Mali", trialStartedAt: "2026-12-07T03:00:00.000Z", day: 15,
        trialEnded: true, paid: false, paidSatang: 0, activeOnDay14: "yes" }],
      cohort: { counted: 1, paid: { count: 0, percent: 0, thresholdPercent: 25, met: false },
        active: { count: 1, percent: 100, thresholdPercent: 50, met: true }, status: "below_line" },
    };
    const payment = { id: "sub-1", tenant: "t1", amountSatang: 49900, slipRef: "KB-1",
      confirmedAt: "2026-12-21T03:00:00.000Z" };
    const { api } = harness("op-key-123", (url) => {
      if (url.includes("/gate")) return json(gate);
      if (new URL(url).searchParams.get("tenant")) return json({ payments: [payment] });
      return json({ error: "slip_already_recorded" }, 409);
    });

    expect(await api.getGate()).toEqual(gate);
    expect(await api.listSubscriptionPayments("t1")).toEqual([payment]);
    await expect(api.recordSubscriptionPayment({ tenant: "t1", amountSatang: 49900, slipRef: "KB-1" })).rejects
      .toMatchObject({ status: 409, code: "slip_already_recorded" });
  });

  it("reads a shop's audit log a page at a time, asking only for what it was given", async () => {
    const page = {
      tenant: "pilot:1",
      entries: [{ id: "aud-mi8x2k4c0-000-0a1b2c3d", at: "2026-11-23T03:00:00.000Z",
        actor: { kind: "operator", email: "ops@manut.test" }, action: "shop.created", subject: {}, outcome: "ok" }],
      next: null,
      missed: { count: 1, lastAt: "2026-11-23T03:05:00.000Z", lastAction: "dispatch.settled" },
    };
    const { api, calls } = harness("op-key-123", (url) =>
      url.includes("before=bad") ? json({ error: "invalid_request" }, 400) : json(page));

    expect(await api.listAudit("pilot:1")).toEqual(page);
    await expect(api.listAudit("pilot:1", { before: "bad" })).rejects.toMatchObject({ status: 400,
      code: "invalid_request" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example.test/v1/admin/audit?tenant=pilot%3A1",
      "https://api.example.test/v1/admin/audit?tenant=pilot%3A1&before=bad",
    ]);
  });

  it("refuses an admin call with no key and sends nothing", async () => {
    const { api, fetch } = harness(null);
    await expect(api.listShops()).rejects.toMatchObject({ code: "operator_key_missing" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns the contract's errors into ApiError, keeping the view on a second decision", async () => {
    const decided = { state: "confirmed", replyText: "x", shopName: "Baan Mali" };
    const answers: Record<string, Response> = {
      "/v1/pilot/approvals/gone": json({ error: "link_expired" }, 410),
      "/v1/pilot/approvals/bad": json({ error: "link_invalid" }, 404),
      "/v1/pilot/approvals/twice/decision": json({ error: "already_decided", view: decided }, 409),
      "/v1/pilot/approvals/noconsent/decision": json({ error: "consent_required" }, 403),
      "/v1/pilot/approvals/broken": new Response("oops", { status: 502 }),
    };
    const { api } = harness(null, (url) => answers[new URL(url).pathname] ?? json({}));

    await expect(api.getApproval("gone")).rejects.toMatchObject({ status: 410, code: "link_expired" });
    await expect(api.getApproval("bad")).rejects.toMatchObject({ status: 404, code: "link_invalid" });
    await expect(api.decide("noconsent", true)).rejects.toMatchObject({ status: 403, code: "consent_required" });
    await expect(api.getApproval("broken")).rejects.toMatchObject({ status: 502, code: "http_502" });
    const second = await api.decide("twice", true).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ApiError);
    expect((second as ApiError).code).toBe("already_decided");
    expect((second as ApiError).view).toEqual(decided);
  });

  it("answers a live shop's deletion with the link for its owner, and reads and answers that link keyless", async () => {
    const asked = { status: "awaiting_owner", confirmUrl: "https://web.test/delete/tok", expiresAt: "2026-11-24T03:00:00Z" };
    const view = { shopName: "Baan Mali", goes: { messages: 7, replies: 6, payments: 2, lineConnected: true },
      state: "awaiting_owner", expiresAt: "2026-11-24T03:00:00Z" };
    const { api, calls } = harness("op-key-123", (url) =>
      url.includes("/admin/") ? json(asked, 202) : json(view),
    );

    expect(await api.deleteShop({ tenant: "t1", confirmName: "Baan Mali" })).toEqual(asked);
    expect(await api.getDeletion("tok/en")).toEqual(view);
    expect(await api.decideDeletion("tok/en", true)).toEqual(view);
    expect(await api.decideDeletion("tok/en", false)).toEqual(view);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://api.example.test/v1/admin/pilot/deletions",
      "GET https://api.example.test/v1/pilot/deletions/tok%2Fen",
      "POST https://api.example.test/v1/pilot/deletions/tok%2Fen/decision",
      "POST https://api.example.test/v1/pilot/deletions/tok%2Fen/decision",
    ]);
    for (const call of calls.slice(1)) {
      expect(call.headers.has("authorization")).toBe(false);
      expect(call.credentials).toBe("omit");
    }
    expect(calls[2]?.body).toEqual({ approve: true });
    expect(calls[3]?.body).toEqual({ approve: false });
  });

  it("keeps what a deletion's error answers carry: what failed, when and by whom, and the settled page", async () => {
    const settled = { shopName: "Baan Mali", goes: { messages: 7, replies: 6, payments: 2, lineConnected: true },
      state: "declined", expiresAt: "2026-11-24T03:00:00Z", decidedAt: "2026-11-23T05:00:00Z" };
    const answers: Record<string, Response> = {
      partial: json({ error: "wipe_incomplete", tasksWiped: 0, failed: ["task-1", "connections"] }, 500),
      gone: json({ error: "tenant_deleted", deletedAt: "2026-11-23T04:00:00Z", deletedBy: "ops@manut.test" }, 404),
      token: json({ error: "tenant_deleted", deletedAt: "2026-11-23T04:00:00Z", deletedBy: null }, 404),
    };
    const { api } = harness("op-key-123", (url) =>
      url.includes("/decision") ? json({ error: "already_decided", view: settled }, 409) : json({}),
    );
    const failing = (key: string) => {
      const { api: each } = harness("op-key-123", () => answers[key]!);
      return each.deleteShop({ tenant: "t1", confirmName: "Baan Mali" }).catch((e: unknown) => e as ApiError);
    };

    expect(await failing("partial")).toMatchObject({ status: 500, code: "wipe_incomplete",
      failed: ["task-1", "connections"] });
    expect(await failing("gone")).toMatchObject({ status: 404, code: "tenant_deleted",
      deletedAt: "2026-11-23T04:00:00Z", deletedBy: "ops@manut.test" });
    const byToken = await failing("token");
    expect(byToken).toMatchObject({ code: "tenant_deleted", deletedAt: "2026-11-23T04:00:00Z" });
    expect((byToken as ApiError).deletedBy).toBeNull();

    const twice = (await api.decideDeletion("tok", true).catch((e: unknown) => e)) as ApiError;
    expect(twice).toMatchObject({ status: 409, code: "already_decided" });
    expect(twice.deletionView).toEqual(settled);
    expect(twice.view).toBeUndefined();
  });

  it("reports a request that never got an answer as status 0", async () => {
    const api = createHttpApi({
      origin: "https://api.example.test",
      operatorKey: () => null,
      fetch: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    await expect(api.getApproval("t")).rejects.toMatchObject({ status: 0, code: "network" });
  });
});
