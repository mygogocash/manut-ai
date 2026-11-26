import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import { callModel, MAX_OUTPUT_TOKENS } from "../src/model-gateway";
import { HOLD_TTL_MS, type MeterRecord } from "../src/model-meter";
import { ceilSatang, costMillisatang, MODEL_PRICES, worstCaseMillisatang } from "../src/model-price";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  anthropicProvider,
  modelProvider,
  ProviderError,
  standInProvider,
  type ChatRequest,
  type ChatResult,
} from "../src/model-provider";
import { tenantCall, tenantDelete, tenantExport } from "../src/tenant-data";

// The model gateway against the real TenantObject in workerd. Providers are the
// stand-in or small scripted doubles, and the global fetch answers every call
// with 599 for the whole file, so nothing here can reach a network: the
// Anthropic provider is driven only through a fetch it is handed.

const bindings = env as unknown as Env;
const RATE = 3_500;
const sonnet = MODEL_PRICES["claude-sonnet-5-5"]!;
/// 10:00 on 23 November 2026 in Bangkok.
const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);

let counter = 0;
const fresh = (label: string) => `model:${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const request: ChatRequest = {
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 100,
};
/// What the gateway reserves for `request` at the default rate.
const WORST = worstCaseMillisatang(sonnet, request, RATE);
const USAGE = { inputTokens: 100, outputTokens: 100 };
/// What `USAGE` costs on Sonnet 5.5: $0.0012, ฿0.042.
const COST = costMillisatang(sonnet, USAGE, RATE);

/// A provider that answers with fixed usage and counts how often it was asked.
function scripted(usage = USAGE, text = "scripted answer") {
  const provider = {
    id: "scripted",
    missing: null,
    calls: 0,
    async complete(): Promise<ChatResult> {
      provider.calls++;
      return { text, stopReason: "end_turn", usage };
    },
  };
  return provider;
}

/// A provider that fails the way `failure` says, counting its calls.
function failing(failure: unknown) {
  const provider = {
    id: "failing",
    missing: null,
    calls: 0,
    async complete(): Promise<ChatResult> {
      provider.calls++;
      throw failure;
    },
  };
  return provider;
}

/// A write to the tenant's meter, as the gateway makes it.
async function meter<T = Record<string, unknown>>(tenant: string, path: string, body: Record<string, unknown>) {
  const response = await tenantCall(bindings, tenant, path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-model": "1" },
    body: JSON.stringify({ tenant, ...body }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

type Totals = {
  month: string;
  spentMillisatang: number;
  ok: number;
  failed: number;
  unreadable: number;
  abandoned: number;
  refused: number;
  inputTokens: number;
  outputTokens: number;
};
type HoldView = { callId: string; month: string; model: string; worstMillisatang: number; at: number; expiresAt: number };
type UsageState = { capOverride: unknown; totals: Totals; holds: HoldView[]; calls: MeterRecord[] };

async function usage(tenant: string, month = "2026-11"): Promise<UsageState> {
  const response = await tenantCall(bindings, tenant, `/model/usage?tenant=${encodeURIComponent(tenant)}&month=${month}`);
  expect(response.status).toBe(200);
  return (await response.json()) as UsageState;
}

async function setCap(tenant: string, capSatang: number | null) {
  expect((await meter(tenant, "/model/cap", { capSatang, setBy: null })).status).toBe(200);
}

function reserve(tenant: string, worstMillisatang: number, nowMs = NOW) {
  return meter<{ callId: string; error?: string }>(tenant, "/model/reserve", {
    model: "claude-sonnet-5-5",
    worstMillisatang,
    defaultCapSatang: 20_000,
    nowMs,
  });
}

describe("a call through the gateway", () => {
  it("reserves, calls, settles the provider's own count and keeps metadata only", async () => {
    const tenant = fresh("ok");
    const provider = scripted(USAGE, "ราคา 290 บาทค่ะ");
    const result = await callModel(
      bindings,
      tenant,
      { ...request, messages: [{ role: "user", content: "ราคาเท่าไหร่คะ" }] },
      { provider, now: () => NOW },
    );
    expect(result).toEqual({
      ok: true,
      callId: expect.any(String),
      text: "ราคา 290 บาทค่ะ",
      stopReason: "end_turn",
      usage: USAGE,
      costMillisatang: 4_200,
      costSatang: 5,
    });
    if (!result.ok) throw new Error("unreachable");
    expect(COST).toBe(4_200);
    expect(provider.calls).toBe(1);

    const state = await usage(tenant);
    expect(state.holds).toEqual([]);
    expect(state.totals).toMatchObject({ spentMillisatang: 4_200, ok: 1, inputTokens: 100, outputTokens: 100 });
    expect(state.calls).toEqual([
      {
        id: result.callId,
        at: new Date(NOW).toISOString(),
        model: "claude-sonnet-5-5",
        inputTokens: 100,
        outputTokens: 100,
        millisatang: 4_200,
        satang: 5,
        outcome: "ok",
      },
    ]);
    // Neither the customer's question nor the answer is stored with the meter.
    expect(JSON.stringify(state)).not.toContain("ราคา");
  });

  it("answers the same way twice from the stand-in provider, which needs no settings", async () => {
    const provider = standInProvider();
    expect(provider.missing).toBeNull();
    const first = await provider.complete(request);
    expect(await provider.complete(request)).toEqual(first);
    expect(first.text).toContain("hello");
    expect(first.usage.inputTokens).toBeGreaterThan(0);

    const tenant = fresh("stand-in");
    const result = await callModel({ ...bindings, MODEL_PROVIDER: "stand-in" }, tenant, request, { now: () => NOW });
    expect(result).toMatchObject({ ok: true, text: first.text, usage: first.usage });
  });

  it("stops the stand-in's answer at the output allowance, as a real model would", async () => {
    const result = await standInProvider().complete({ ...request, maxOutputTokens: 3 });
    expect(result.usage.outputTokens).toBe(3);
    expect([...result.text]).toHaveLength(3);
    expect(result.stopReason).toBe("max_tokens");
  });

  it("chooses the provider from the environment", () => {
    expect(modelProvider({ MODEL_PROVIDER: "stand-in" }).id).toBe("stand-in");
    expect(modelProvider({ ANTHROPIC_API_KEY: "fixture-anthropic-key" })).toMatchObject({ id: "anthropic", missing: null });
    expect(modelProvider({}).missing).toBe("ANTHROPIC_API_KEY");
    expect(modelProvider({ MODEL_PROVIDER: "openai" }).missing).toBe("MODEL_PROVIDER");
  });
});

describe("the monthly cap", () => {
  it("lets a reservation reach the cap exactly and refuses one millisatang more", async () => {
    const tenant = fresh("boundary");
    await setCap(tenant, 10);
    const first = await reserve(tenant, 6_000);
    expect(first.status).toBe(200);
    expect(
      (await meter(tenant, "/model/settle", { callId: first.body.callId, inputTokens: 1, outputTokens: 1, millisatang: 6_000, nowMs: NOW })).status,
    ).toBe(200);
    // 6,000 spent and 4,000 reserved is exactly the cap of 10 satang.
    expect((await reserve(tenant, 4_000)).status).toBe(200);
    const over = await reserve(tenant, 1);
    expect(over.status).toBe(402);
    expect(over.body).toEqual({
      error: "budget_exceeded",
      month: "2026-11",
      capSatang: 10,
      spentMillisatang: 6_000,
      heldMillisatang: 4_000,
      neededMillisatang: 1,
    });

    const other = fresh("boundary-other");
    await setCap(other, 10);
    const spent = await reserve(other, 6_000);
    await meter(other, "/model/settle", { callId: spent.body.callId, inputTokens: 1, outputTokens: 1, millisatang: 6_000, nowMs: NOW });
    expect((await reserve(other, 4_001)).status).toBe(402);
    expect((await usage(other)).totals.refused).toBe(1);
  });

  it("refuses every call under a cap of zero", async () => {
    const tenant = fresh("zero");
    await setCap(tenant, 0);
    expect((await reserve(tenant, 1)).status).toBe(402);
  });

  it("refuses with 402 budget_exceeded before the provider is asked", async () => {
    const tenant = fresh("refused");
    await setCap(tenant, ceilSatang(WORST) - 1);
    const provider = scripted();
    const result = await callModel(bindings, tenant, request, { provider, now: () => NOW });
    expect(result).toEqual({
      ok: false,
      status: 402,
      error: "budget_exceeded",
      month: "2026-11",
      capSatang: ceilSatang(WORST) - 1,
      spentSatang: 0,
      heldSatang: 0,
      neededSatang: ceilSatang(WORST),
    });
    expect(provider.calls).toBe(0);
    const state = await usage(tenant);
    expect(state.totals.refused).toBe(1);
    expect(state.holds).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("lets only one of two racing reservations at the edge through", async () => {
    const tenant = fresh("race");
    await setCap(tenant, 10);
    const answers = await Promise.all([reserve(tenant, 6_000), reserve(tenant, 6_000)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 402]);
    const state = await usage(tenant);
    expect(state.holds).toHaveLength(1);
    expect(state.totals.refused).toBe(1);
  });

  it("lets only one of two racing calls reach the provider", async () => {
    const tenant = fresh("race-calls");
    // Room for one worst case, but not for a settled call and a second worst case.
    await setCap(tenant, ceilSatang(WORST));
    expect(ceilSatang(WORST) * 1_000).toBeLessThan(COST + WORST);
    const provider = scripted();
    const results = await Promise.all([
      callModel(bindings, tenant, request, { provider, now: () => NOW }),
      callModel(bindings, tenant, request, { provider, now: () => NOW }),
    ]);
    expect(results.map((result) => result.ok).sort()).toEqual([false, true]);
    expect(results.find((result) => !result.ok)).toMatchObject({ status: 402, error: "budget_exceeded" });
    expect(provider.calls).toBe(1);
    expect((await usage(tenant)).totals).toMatchObject({ ok: 1, refused: 1, spentMillisatang: COST });
  });
});

describe("a provider that fails", () => {
  it("releases the whole reservation, records the failure and frees the budget", async () => {
    const tenant = fresh("release");
    await setCap(tenant, ceilSatang(WORST));
    const provider = failing(new ProviderError({ status: 503, retryable: true, upstreamStatus: 529 }));
    const result = await callModel(bindings, tenant, request, { provider, now: () => NOW });
    expect(result).toEqual({ ok: false, status: 503, error: "provider_error", retryable: true, callId: expect.any(String) });
    expect(provider.calls).toBe(1);

    const state = await usage(tenant);
    expect(state.holds).toEqual([]);
    expect(state.totals).toMatchObject({ spentMillisatang: 0, failed: 1, ok: 0 });
    expect(state.calls).toEqual([
      expect.objectContaining({ outcome: "failed", millisatang: 0, satang: 0, inputTokens: 0, outputTokens: 0 }),
    ]);
    // The cap holds exactly one worst case, so this passes only because the
    // failed call's reservation was released.
    expect((await callModel(bindings, tenant, request, { provider: scripted(), now: () => NOW })).ok).toBe(true);
  });

  it("treats an unexpected error as a provider failure, not retryable", async () => {
    const tenant = fresh("boom");
    const result = await callModel(bindings, tenant, request, { provider: failing(new Error("boom")), now: () => NOW });
    expect(result).toMatchObject({ ok: false, status: 502, error: "provider_error", retryable: false });
    expect((await usage(tenant)).totals).toMatchObject({ spentMillisatang: 0, failed: 1 });
  });

  it("charges the worst case when the provider answered but its usage cannot be read", async () => {
    const tenant = fresh("unreadable");
    const billed = failing(new ProviderError({ status: 502, retryable: false, billed: true, upstreamStatus: 200 }));
    expect(await callModel(bindings, tenant, request, { provider: billed, now: () => NOW })).toMatchObject({
      ok: false,
      status: 502,
      error: "provider_error",
      retryable: false,
    });
    // A provider that reports impossible usage is charged the same way.
    const nonsense = scripted({ inputTokens: -5, outputTokens: 1.5 });
    expect(await callModel(bindings, tenant, request, { provider: nonsense, now: () => NOW })).toMatchObject({
      ok: false,
      status: 502,
      error: "provider_error",
    });
    const state = await usage(tenant);
    expect(state.holds).toEqual([]);
    expect(state.totals).toMatchObject({ spentMillisatang: 2 * WORST, unreadable: 2 });
    expect(state.calls.map((call) => [call.outcome, call.millisatang])).toEqual([
      ["unreadable", WORST],
      ["unreadable", WORST],
    ]);
  });
});

describe("calendar months in Bangkok", () => {
  it("starts a fresh budget at midnight in Bangkok, not in UTC", async () => {
    const tenant = fresh("rollover");
    await setCap(tenant, ceilSatang(WORST));
    /// 23:59:59.999 on 30 November in Bangkok, and the next millisecond.
    const lastMoment = Date.UTC(2026, 10, 30, 16, 59, 59, 999);
    const firstMoment = lastMoment + 1;

    expect((await callModel(bindings, tenant, request, { provider: scripted(), now: () => lastMoment })).ok).toBe(true);
    expect(await callModel(bindings, tenant, request, { provider: scripted(), now: () => lastMoment })).toMatchObject({
      status: 402,
      month: "2026-11",
    });
    expect((await callModel(bindings, tenant, request, { provider: scripted(), now: () => firstMoment })).ok).toBe(true);

    expect((await usage(tenant, "2026-11")).totals).toMatchObject({ ok: 1, refused: 1, spentMillisatang: COST });
    const december = await usage(tenant, "2026-12");
    expect(december.totals).toMatchObject({ ok: 1, refused: 0, spentMillisatang: COST });
    expect(december.calls[0]?.at).toBe(new Date(firstMoment).toISOString());
  });

  it("charges a call to the month it was reserved in, even if it finishes in the next", async () => {
    const tenant = fresh("straddle");
    const lastMoment = Date.UTC(2026, 10, 30, 16, 59, 59, 999);
    const held = await reserve(tenant, 5_000, lastMoment);
    expect(
      (await meter(tenant, "/model/settle", { callId: held.body.callId, inputTokens: 10, outputTokens: 10, millisatang: 3_000, nowMs: lastMoment + 60_000 })).status,
    ).toBe(200);
    expect((await usage(tenant, "2026-11")).totals.spentMillisatang).toBe(3_000);
    expect((await usage(tenant, "2026-12")).totals.spentMillisatang).toBe(0);
  });
});

describe("reservations that are never settled", () => {
  it("count against the cap until they expire, then are charged their worst case", async () => {
    const tenant = fresh("abandoned");
    const first = await reserve(tenant, 5_000);
    expect(first.status).toBe(200);
    const before = await usage(tenant);
    expect(before.holds.map((hold) => [hold.callId, hold.worstMillisatang, hold.expiresAt])).toEqual([
      [first.body.callId, 5_000, NOW + HOLD_TTL_MS],
    ]);
    expect(before.totals.spentMillisatang).toBe(0);

    const later = await reserve(tenant, 1_000, NOW + HOLD_TTL_MS);
    expect(later.status).toBe(200);
    const after = await usage(tenant);
    expect(after.totals).toMatchObject({ spentMillisatang: 5_000, abandoned: 1 });
    expect(after.calls).toEqual([
      expect.objectContaining({ id: first.body.callId, outcome: "abandoned", millisatang: 5_000, satang: 5, inputTokens: 0, outputTokens: 0 }),
    ]);
    expect(after.holds.map((hold) => hold.callId)).toEqual([later.body.callId]);
    // The late settle finds nothing to settle, so nothing is charged twice.
    const late = await meter(tenant, "/model/settle", {
      callId: first.body.callId,
      inputTokens: 1,
      outputTokens: 1,
      millisatang: 10,
      nowMs: NOW + HOLD_TTL_MS + 1,
    });
    expect(late).toEqual({ status: 409, body: { error: "not_reserved" } });
  });

  it("settle once: a second settle, a release after it, or an unknown call answer 409", async () => {
    const tenant = fresh("once");
    const held = await reserve(tenant, 5_000);
    const settle = { callId: held.body.callId, inputTokens: 1, outputTokens: 1, millisatang: 100, nowMs: NOW };
    expect((await meter(tenant, "/model/settle", settle)).status).toBe(200);
    expect((await meter(tenant, "/model/settle", settle)).status).toBe(409);
    expect((await meter(tenant, "/model/release", { callId: held.body.callId, nowMs: NOW })).status).toBe(409);
    expect((await meter(tenant, "/model/settle", { ...settle, callId: "call-unknown" })).status).toBe(409);
    expect((await usage(tenant)).totals).toMatchObject({ spentMillisatang: 100, ok: 1 });
  });

  it("are written only by the Worker", async () => {
    const tenant = fresh("header");
    const response = await tenantCall(bindings, tenant, "/model/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant, model: "claude-sonnet-5-5", worstMillisatang: 1, defaultCapSatang: 1, nowMs: NOW }),
    });
    expect(response.status).toBe(403);
    for (const body of [
      { model: "claude-sonnet-5-5", worstMillisatang: 0, defaultCapSatang: 1, nowMs: NOW },
      { model: "claude-sonnet-5-5", worstMillisatang: 1.5, defaultCapSatang: 1, nowMs: NOW },
      { model: "claude-sonnet-5-5", worstMillisatang: 1, defaultCapSatang: -1, nowMs: NOW },
      { model: "", worstMillisatang: 1, defaultCapSatang: 1, nowMs: NOW },
      { model: "claude-sonnet-5-5", worstMillisatang: 1, defaultCapSatang: 1 },
    ]) {
      expect((await meter(tenant, "/model/reserve", body)).status).toBe(400);
    }
    expect((await tenantCall(bindings, tenant, `/model/usage?tenant=${encodeURIComponent(tenant)}&month=2026-13`)).status).toBe(400);
  });
});

describe("a gateway without what it needs", () => {
  it("refuses with 503 not_configured and reaches no network without the key", async () => {
    expect(bindings.ANTHROPIC_API_KEY).toBeUndefined();
    const tenant = fresh("no-key");
    expect(await callModel(bindings, tenant, request, { now: () => NOW })).toEqual({
      ok: false,
      status: 503,
      error: "not_configured",
      setting: "ANTHROPIC_API_KEY",
    });
    await expect(anthropicProvider(undefined).complete(request)).rejects.toMatchObject({ status: 503, code: "not_configured" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const state = await usage(tenant);
    expect(state.holds).toEqual([]);
    expect(state.calls).toEqual([]);
    expect(state.totals.refused).toBe(0);
  });

  it("refuses with 503 not_configured when a setting cannot be read", async () => {
    const tenant = fresh("bad-setting");
    const provider = scripted();
    expect(await callModel({ ...bindings, MODEL_SATANG_PER_USD: "35.00" }, tenant, request, { provider, now: () => NOW })).toEqual({
      ok: false,
      status: 503,
      error: "not_configured",
      setting: "MODEL_SATANG_PER_USD",
    });
    expect(provider.calls).toBe(0);
    expect((await usage(tenant)).holds).toEqual([]);
  });

  it("refuses requests it cannot price or send, before reserving anything", async () => {
    const tenant = fresh("invalid");
    const provider = scripted();
    expect(await callModel(bindings, tenant, { ...request, model: "gpt-5" }, { provider })).toEqual({
      ok: false,
      status: 400,
      error: "unknown_model",
    });
    for (const bad of [
      { ...request, messages: [] },
      { ...request, messages: [{ role: "assistant", content: "hi" }] },
      { ...request, messages: [{ role: "user", content: "" }] },
      { ...request, messages: [{ role: "system", content: "hi" }] },
      { ...request, maxOutputTokens: 0 },
      { ...request, maxOutputTokens: MAX_OUTPUT_TOKENS + 1 },
      { ...request, maxOutputTokens: 1.5 },
      { ...request, system: 42 },
      { ...request, messages: [{ role: "user", content: "x".repeat(1_000_001) }] },
    ]) {
      expect(await callModel(bindings, tenant, bad as ChatRequest, { provider })).toEqual({
        ok: false,
        status: 400,
        error: "invalid_request",
      });
    }
    expect(await callModel(bindings, "", request, { provider })).toEqual({ ok: false, status: 400, error: "invalid_request" });
    expect(provider.calls).toBe(0);
    expect((await usage(tenant)).holds).toEqual([]);
  });
});

describe("tenant export and deletion", () => {
  it("export the meter with the tenant and delete it with the tenant", async () => {
    const tenant = fresh("export");
    await setCap(tenant, 12_345);
    const question = "do you deliver to Chiang Mai";
    const answer = "Yes, in two days";
    expect(
      (await callModel(bindings, tenant, { ...request, messages: [{ role: "user", content: question }] }, {
        provider: scripted(USAGE, answer),
        now: () => NOW,
      })).ok,
    ).toBe(true);
    await callModel(bindings, tenant, request, { provider: failing(new Error("down")), now: () => NOW });
    await reserve(tenant, 2_000);

    const response = await tenantExport(bindings, tenant);
    expect(response.status).toBe(200);
    const exported = (await response.json()) as {
      model: { capOverride: { capSatang: number }; months: Totals[]; calls: MeterRecord[]; holds: HoldView[] };
    };
    expect(exported.model.capOverride.capSatang).toBe(12_345);
    expect(exported.model.months).toEqual([expect.objectContaining({ month: "2026-11", ok: 1, failed: 1, spentMillisatang: COST })]);
    expect(exported.model.calls.map((call) => call.outcome)).toEqual(["ok", "failed"]);
    expect(exported.model.holds).toHaveLength(1);
    expect(JSON.stringify(exported.model)).not.toContain(question);
    expect(JSON.stringify(exported.model)).not.toContain(answer);

    expect((await tenantDelete(bindings, tenant)).status).toBe(200);
    const object = bindings.TENANT.get(bindings.TENANT.idFromName(`t:${tenant}`));
    await runInDurableObject(object, async (_instance, state) => {
      expect([...(await state.storage.list({ prefix: "model-" })).keys()]).toEqual([]);
    });
    const after = await usage(tenant);
    expect(after).toEqual({
      capOverride: null,
      totals: expect.objectContaining({ spentMillisatang: 0, ok: 0, failed: 0 }),
      holds: [],
      calls: [],
    });
  });
});

describe("the Anthropic provider", () => {
  type Sent = { url: string; init: RequestInit };

  function stub(answer: () => Response | Promise<Response>) {
    const sent: Sent[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      sent.push({ url, init: init ?? {} });
      return answer();
    };
    return { sent, fetchImpl };
  }

  const message = (overrides: Record<string, unknown> = {}) =>
    Response.json({
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      content: [{ type: "thinking", thinking: "" }, { type: "text", text: "สวัสดีค่ะ" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 21, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ...overrides,
    });

  const thai: ChatRequest = {
    model: "claude-haiku-5-5",
    system: "You are Nam, the shop's sales chat.",
    messages: [{ role: "user", content: "สวัสดี" }],
    maxOutputTokens: 300,
  };

  it("sends the Messages API request the docs describe and reads the text and usage", async () => {
    const { sent, fetchImpl } = stub(() => message());
    const result = await anthropicProvider("fixture-anthropic-key", fetchImpl).complete(thai);
    expect(result).toEqual({ text: "สวัสดีค่ะ", stopReason: "end_turn", usage: { inputTokens: 21, outputTokens: 9 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(ANTHROPIC_MESSAGES_URL).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.init.method).toBe("POST");
    const headers = new Headers(sent[0]!.init.headers);
    expect(headers.get("x-api-key")).toBe("fixture-anthropic-key");
    expect(headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
    expect(ANTHROPIC_VERSION).toBe("2026-10-21");
    expect(headers.get("content-type")).toBe("application/json");
    // No sampling settings: API version 2026-10-21 refuses temperature, top_p and top_k.
    expect(JSON.parse(String(sent[0]!.init.body))).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 300,
      system: "You are Nam, the shop's sales chat.",
      messages: [{ role: "user", content: "สวัสดี" }],
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("counts cache writes twice and cache reads once, so the meter can only overstate", async () => {
    const { fetchImpl } = stub(() =>
      message({ usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000 } }),
    );
    expect((await anthropicProvider("fixture-anthropic-key", fetchImpl).complete(thai)).usage).toEqual({
      inputTokens: 10 + 2 * 100 + 1_000,
      outputTokens: 5,
    });
  });

  it("passes a refusal through with its usage, which is billed", async () => {
    const { fetchImpl } = stub(() => message({ content: [], stop_reason: "refusal" }));
    expect(await anthropicProvider("fixture-anthropic-key", fetchImpl).complete(thai)).toEqual({
      text: "",
      stopReason: "refusal",
      usage: { inputTokens: 21, outputTokens: 9 },
    });
  });

  it("says which failures are worth retrying, and never claims a charge for an error", async () => {
    const cases: [() => Response | Promise<Response>, Record<string, unknown>][] = [
      [() => Response.json({ type: "error" }, { status: 529 }), { status: 503, retryable: true, billed: false, upstreamStatus: 529 }],
      [() => Response.json({ type: "error" }, { status: 500 }), { status: 503, retryable: true, upstreamStatus: 500 }],
      [() => Response.json({ type: "error" }, { status: 429 }), { status: 503, retryable: true, upstreamStatus: 429 }],
      [
        () => Response.json({ type: "error" }, { status: 429, headers: { "x-should-retry": "false" } }),
        { status: 502, retryable: false, upstreamStatus: 429 },
      ],
      [() => Response.json({ type: "error" }, { status: 400 }), { status: 502, retryable: false, upstreamStatus: 400 }],
      [() => Response.json({ type: "error" }, { status: 401 }), { status: 502, retryable: false, upstreamStatus: 401 }],
      [() => Promise.reject(new TypeError("network down")), { status: 503, retryable: true, billed: false, upstreamStatus: null }],
    ];
    for (const [answer, expected] of cases) {
      const { fetchImpl } = stub(answer);
      const error = await anthropicProvider("fixture-anthropic-key", fetchImpl).complete(thai).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: "provider_error", ...expected });
    }
  });

  it("treats an answer it cannot read as billed", async () => {
    for (const answer of [
      () => new Response("not json", { status: 200 }),
      () => message({ usage: { output_tokens: 9 } }),
      () => message({ usage: { input_tokens: -1, output_tokens: 9 } }),
      () => message({ content: "not a list" }),
    ]) {
      const { fetchImpl } = stub(answer);
      const error = await anthropicProvider("fixture-anthropic-key", fetchImpl).complete(thai).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "provider_error", status: 502, retryable: false, billed: true, upstreamStatus: 200 });
    }
  });
});
