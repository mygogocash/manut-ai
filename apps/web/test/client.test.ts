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
  await api.listWorkerJobs("t1", { before: "worker-task-6a7c1f00-0000-4000-8000-000000000001", limit: 5 });
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
      "GET https://api.example.test/v1/admin/workers/drafts?tenant=t1&before=worker-task-6a7c1f00-0000-4000-8000-000000000001&limit=5",
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

  it("reads a shop's worker jobs a page at a time, asking only for what it was given, and keeps the API's refusals", async () => {
    const page = {
      tenant: "pilot:1",
      jobs: [{ taskId: "worker-task-6a7c1f00-0000-4000-8000-000000000001", member: "ton", passedFrom: "nam",
        job: "daily_summary", at: "2026-11-23T02:00:00.000Z", ending: { state: "done" },
        draft: { text: "Yesterday: 3 paid orders.", at: "2026-11-23T02:00:05.000Z", about: { date: "2026-11-22" } },
        costSatang: 2 }],
      next: null,
    };
    const refusals: Record<string, [number, string]> = {
      "tenant=gone": [404, "shop_not_found"],
      "limit=99": [400, "invalid_request"],
      "tenant=slow": [503, "drafts_unavailable"],
    };
    const { api, calls } = harness("op-key-123", (url) => {
      const refused = Object.entries(refusals).find(([part]) => url.includes(part));
      return refused ? json({ error: refused[1][1] }, refused[1][0]) : json(page);
    });

    expect(await api.listWorkerJobs("pilot:1")).toEqual(page);
    expect(await api.listWorkerJobs("pilot:1", { limit: 10 })).toEqual(page);
    await expect(api.listWorkerJobs("gone")).rejects.toMatchObject({ status: 404, code: "shop_not_found" });
    await expect(api.listWorkerJobs("pilot:1", { limit: 99 })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(api.listWorkerJobs("slow")).rejects.toMatchObject({ status: 503, code: "drafts_unavailable" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.example.test/v1/admin/workers/drafts?tenant=pilot%3A1",
      "https://api.example.test/v1/admin/workers/drafts?tenant=pilot%3A1&limit=10",
      "https://api.example.test/v1/admin/workers/drafts?tenant=gone",
      "https://api.example.test/v1/admin/workers/drafts?tenant=pilot%3A1&limit=99",
      "https://api.example.test/v1/admin/workers/drafts?tenant=slow",
    ]);
    // It only reads: every call is a GET with the key and no body.
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.body).toBeUndefined();
    }
  });

  it("reads a shop's model spend for a month and sets or clears its cap, as docs/model-gateway.md answers", async () => {
    const usage = {
      tenant: "pilot:1", month: "2026-11", capSatang: 20000, capSource: "default", capOverride: null,
      spentSatang: 49, spentMillisatang: 48500, heldSatang: 0, heldMillisatang: 0, remainingSatang: 19951,
      counts: { ok: 2, failed: 0, unreadable: 0, abandoned: 0, refused: 0 }, tokens: { input: 2000, output: 1000 },
      calls: [{ id: "call-1", at: "2026-11-23T03:00:01.000Z", model: "claude-sonnet-5-5", inputTokens: 1000,
        outputTokens: 500, millisatang: 24500, satang: 25, outcome: "ok" }],
      holds: [],
    };
    const cap = { tenant: "pilot:1", capSatang: 15000, capSource: "override",
      capOverride: { capSatang: 15000, setAt: "2026-11-23T03:00:00.000Z", setBy: "ops@manut.test" } };
    const { api, calls } = harness("op-key-123", (url) => (url.includes("/model/cap") ? json(cap) : json(usage)));

    expect(await api.getModelUsage("pilot:1")).toEqual(usage);
    expect(await api.getModelUsage("pilot:1", "2026-10")).toEqual(usage);
    expect(await api.setModelCap({ tenant: "pilot:1", capSatang: 15000 })).toEqual(cap);
    await api.setModelCap({ tenant: "pilot:1", capSatang: null });
    await api.setModelCap({ tenant: "pilot:1", capSatang: 0 });

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.example.test/v1/admin/model/usage?tenant=pilot%3A1",
      "GET https://api.example.test/v1/admin/model/usage?tenant=pilot%3A1&month=2026-10",
      "PUT https://api.example.test/v1/admin/model/cap",
      "PUT https://api.example.test/v1/admin/model/cap",
      "PUT https://api.example.test/v1/admin/model/cap",
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer op-key-123");
      expect(call.credentials).toBe("include");
    }
    // `capSatang` is always in the body: the API refuses a body without it, so a request that means to clear the
    // cap says null and one that means zero says 0, and neither is ever left out.
    expect(calls[2]?.raw).toBe('{"tenant":"pilot:1","capSatang":15000}');
    expect(calls[3]?.raw).toBe('{"tenant":"pilot:1","capSatang":null}');
    expect(calls[4]?.raw).toBe('{"tenant":"pilot:1","capSatang":0}');
  });

  it("keeps the setting a 503 not_configured names, and every other answer of the model routes", async () => {
    const answers: Record<string, Response> = {
      named: json({ error: "not_configured", setting: "MODEL_DEFAULT_CAP_SATANG" }, 503),
      rate: json({ error: "not_configured", setting: "MODEL_SATANG_PER_USD" }, 503),
      odd: json({ error: "not_configured", setting: 42 }, 503),
      meter: json({ error: "meter_unavailable" }, 503),
      tenant: json({ error: "tenant_required" }, 400),
      month: json({ error: "invalid_request" }, 400),
    };
    const failing = (key: string) => {
      const { api } = harness("op-key-123", () => answers[key]!.clone());
      return api.getModelUsage("t1").catch((e: unknown) => e as ApiError);
    };

    const named = await failing("named");
    expect(named).toBeInstanceOf(ApiError);
    expect(named).toMatchObject({ status: 503, code: "not_configured", setting: "MODEL_DEFAULT_CAP_SATANG" });
    expect(await failing("rate")).toMatchObject({ status: 503, code: "not_configured", setting: "MODEL_SATANG_PER_USD" });
    // A setting that is not text is dropped, not guessed.
    expect(((await failing("odd")) as ApiError).setting).toBeUndefined();
    expect(await failing("meter")).toMatchObject({ status: 503, code: "meter_unavailable" });
    expect(await failing("tenant")).toMatchObject({ status: 400, code: "tenant_required" });
    expect(await failing("month")).toMatchObject({ status: 400, code: "invalid_request" });

    // The cap route's refusals arrive the same way, naming the setting too.
    const { api } = harness("op-key-123", () => answers.rate!.clone());
    await expect(api.setModelCap({ tenant: "t1", capSatang: 100 })).rejects.toMatchObject({ status: 503,
      code: "not_configured", setting: "MODEL_SATANG_PER_USD" });
  });

  it("refuses the model routes with no key and sends nothing", async () => {
    const { api, fetch } = harness(null);
    await expect(api.getModelUsage("t1")).rejects.toMatchObject({ code: "operator_key_missing" });
    await expect(api.setModelCap({ tenant: "t1", capSatang: null })).rejects.toMatchObject({ code: "operator_key_missing" });
    expect(fetch).not.toHaveBeenCalled();
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

// The owner's people (docs/pilot-api.md, "Helpers", "Operator routes"): six routes under the admin gate. Each change sends
// the tenant and exactly what its route takes, and answers what the API answers.
describe("the API client, for the owner's helpers", () => {
  const line = { kind: "line", id: "beam.baanmali" } as const;
  const email = { kind: "email", address: "mint@baanmali.example" } as const;
  const invite = { id: "inv-1", name: "Beam", identity: line, status: "pending", createdAt: "2026-11-23T01:00:00.000Z",
    expiresAt: "2026-11-30T01:00:00.000Z", inviteUrl: "https://web.test/join/tok" };
  const people = {
    tenant: "pilot:1",
    owner: { name: "Fon" },
    helpers: [{ id: "helper-1", name: "Mint", identity: email, joinedAt: "2026-11-13T03:05:00.000Z", devices: 2 }],
    invites: [invite],
    away: { helperId: "helper-1", name: "Mint", until: "2026-11-27T16:59:59.000Z", inForce: true },
    passedOn: [{ requestId: "req_1", kind: "money", by: "helper-1", name: "Mint", note: "It looks right to me.",
      at: "2026-11-23T00:00:00.000Z" }],
    removed: [{ id: "helper-0", name: "Kai" }],
  };
  const answers: Record<string, unknown> = {
    "/v1/admin/people": people,
    "/v1/admin/people/invites": { invite: { ...invite, inviteUrl: undefined }, inviteUrl: "https://web.test/join/tok" },
    "/v1/admin/people/invites/revoke": { invite: { ...invite, status: "revoked", inviteUrl: undefined } },
    "/v1/admin/people/remove": { removed: "helper-1", sessionsEnded: 2, invitesRevoked: ["inv-9"], coverEnded: true },
    "/v1/admin/people/away": { away: people.away },
    "/v1/admin/people/away/clear": { away: null },
  };
  const answering = (url: string) => json(answers[new URL(url).pathname] ?? {});

  async function everyPeopleRoute(api: PilotApi) {
    await api.getPeople("pilot:1");
    await api.createInvite({ tenant: "pilot:1", name: "Beam", identity: line });
    await api.createInvite({ tenant: "pilot:1", name: "Mint", identity: email });
    await api.revokeInvite({ tenant: "pilot:1", inviteId: "inv-1" });
    await api.removeHelper({ tenant: "pilot:1", helperId: "helper-1" });
    await api.setAway({ tenant: "pilot:1", helperId: "helper-1", until: "2026-11-27T16:59:59.000Z" });
    await api.clearAway({ tenant: "pilot:1" });
  }

  it("sends the operator key to the contract's six paths, with the tenant and exactly what each route takes", async () => {
    const { api, calls } = harness("op-key-123", answering);
    await everyPeopleRoute(api);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.example.test/v1/admin/people?tenant=pilot%3A1",
      "POST https://api.example.test/v1/admin/people/invites",
      "POST https://api.example.test/v1/admin/people/invites",
      "POST https://api.example.test/v1/admin/people/invites/revoke",
      "POST https://api.example.test/v1/admin/people/remove",
      "POST https://api.example.test/v1/admin/people/away",
      "POST https://api.example.test/v1/admin/people/away/clear",
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe("Bearer op-key-123");
      expect(call.credentials).toBe("include");
    }
    expect(calls[1]?.body).toEqual({ tenant: "pilot:1", name: "Beam", identity: { kind: "line", id: "beam.baanmali" } });
    expect(calls[2]?.body).toEqual({ tenant: "pilot:1", name: "Mint",
      identity: { kind: "email", address: "mint@baanmali.example" } });
    expect(calls[3]?.body).toEqual({ tenant: "pilot:1", inviteId: "inv-1" });
    expect(calls[4]?.body).toEqual({ tenant: "pilot:1", helperId: "helper-1" });
    expect(calls[5]?.body).toEqual({ tenant: "pilot:1", helperId: "helper-1", until: "2026-11-27T16:59:59.000Z" });
    expect(calls[6]?.body).toEqual({ tenant: "pilot:1" });
  });

  it("never sends a field its route does not take, a role above all", async () => {
    const { api, calls } = harness("op-key-123", answering);
    const extra = { role: "owner", decidedBy: "owner-session" };
    await api.createInvite({ tenant: "t1", name: "Beam", identity: { ...line, ...extra }, ...extra } as never);
    await api.revokeInvite({ tenant: "t1", inviteId: "inv-1", ...extra } as never);
    await api.removeHelper({ tenant: "t1", helperId: "helper-1", ...extra } as never);
    await api.setAway({ tenant: "t1", helperId: "helper-1", until: "2026-11-27T16:59:59.000Z", ...extra } as never);
    await api.clearAway({ tenant: "t1", ...extra } as never);

    expect(calls.map((c) => c.raw)).toEqual([
      '{"tenant":"t1","name":"Beam","identity":{"kind":"line","id":"beam.baanmali"}}',
      '{"tenant":"t1","inviteId":"inv-1"}',
      '{"tenant":"t1","helperId":"helper-1"}',
      '{"tenant":"t1","helperId":"helper-1","until":"2026-11-27T16:59:59.000Z"}',
      '{"tenant":"t1"}',
    ]);
  });

  it("answers what the API answers: the people, the invite with its link, the removal's counts, the cover", async () => {
    const { api } = harness("op-key-123", answering);
    expect(await api.getPeople("pilot:1")).toEqual(people);
    expect(await api.createInvite({ tenant: "pilot:1", name: "Beam", identity: line })).toEqual({
      invite: { ...invite, inviteUrl: undefined }, inviteUrl: "https://web.test/join/tok" });
    expect(await api.revokeInvite({ tenant: "pilot:1", inviteId: "inv-1" })).toMatchObject({ invite: { status: "revoked" } });
    expect(await api.removeHelper({ tenant: "pilot:1", helperId: "helper-1" })).toEqual({ removed: "helper-1",
      sessionsEnded: 2, invitesRevoked: ["inv-9"], coverEnded: true });
    expect(await api.setAway({ tenant: "pilot:1", helperId: "helper-1", until: "2026-11-27T16:59:59.000Z" }))
      .toEqual({ away: people.away });
    expect(await api.clearAway({ tenant: "pilot:1" })).toEqual({ away: null });
  });

  it("turns every refusal of the people routes into an ApiError with the API's status and code", async () => {
    const calls: [string, (api: PilotApi) => Promise<unknown>, number, string][] = [
      ["read", (api) => api.getPeople("t1"), 400, "tenant_required"],
      ["read", (api) => api.getPeople("t1"), 404, "shop_not_found"],
      ["read", (api) => api.getPeople("t1"), 503, "people_unavailable"],
      ["invite", (api) => api.createInvite({ tenant: "t1", name: "", identity: line }), 400, "invalid_request"],
      ["invite", (api) => api.createInvite({ tenant: "t1", name: "Beam", identity: { kind: "line", id: "" } }), 400, "bad_identity"],
      ["invite", (api) => api.createInvite({ tenant: "t1", name: "Beam", identity: line }), 409, "already_invited"],
      ["invite", (api) => api.createInvite({ tenant: "t1", name: "Mint", identity: email }), 409, "already_helper"],
      ["revoke", (api) => api.revokeInvite({ tenant: "t1", inviteId: "inv-9" }), 404, "unknown_invite"],
      ["revoke", (api) => api.revokeInvite({ tenant: "t1", inviteId: "inv-1" }), 409, "not_pending"],
      ["remove", (api) => api.removeHelper({ tenant: "t1", helperId: "helper-9" }), 404, "not_a_helper"],
      ["away", (api) => api.setAway({ tenant: "t1", helperId: "helper-1", until: "yesterday" }), 400, "bad_date"],
      ["away", (api) => api.setAway({ tenant: "t1", helperId: "helper-9", until: "2026-11-27T16:59:59.000Z" }), 404, "not_a_helper"],
      ["clear", (api) => api.clearAway({ tenant: "t1" }), 503, "people_unavailable"],
    ];
    for (const [, call, status, code] of calls) {
      const { api } = harness("op-key-123", () => json({ error: code }, status));
      const failed = await call(api).catch((e: unknown) => e);
      expect(failed).toBeInstanceOf(ApiError);
      expect(failed).toMatchObject({ status, code });
    }
  });

  it("keeps the setting a 503 not_configured names when an invite's link cannot be made", async () => {
    for (const setting of ["WEB_ORIGIN", "APPROVAL_LINK_SECRET"]) {
      const { api } = harness("op-key-123", () => json({ error: "not_configured", setting }, 503));
      await expect(api.createInvite({ tenant: "t1", name: "Beam", identity: line })).rejects.toMatchObject({ status: 503,
        code: "not_configured", setting });
    }
  });

  it("refuses every people route with no key and sends nothing", async () => {
    const { api, fetch } = harness(null);
    await expect(everyPeopleRoute(api)).rejects.toMatchObject({ code: "operator_key_missing" });
    for (const call of [
      () => api.getPeople("t1"),
      () => api.createInvite({ tenant: "t1", name: "Beam", identity: line }),
      () => api.revokeInvite({ tenant: "t1", inviteId: "inv-1" }),
      () => api.removeHelper({ tenant: "t1", helperId: "helper-1" }),
      () => api.setAway({ tenant: "t1", helperId: "helper-1", until: "2026-11-27T16:59:59.000Z" }),
      () => api.clearAway({ tenant: "t1" }),
    ]) await expect(call()).rejects.toMatchObject({ code: "operator_key_missing" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
