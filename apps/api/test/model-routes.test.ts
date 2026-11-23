import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { callModel } from "../src/model-gateway";
import { bangkokMonth, costMillisatang, MAX_CAP_SATANG, MODEL_PRICES } from "../src/model-price";
import type { ChatResult } from "../src/model-provider";

// The model gateway's two operator routes through the real Worker: the admin
// gate in front of them, and what each answers. The global fetch answers 599
// for the whole file, so nothing here can reach a network.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const NOW = Date.UTC(2026, 10, 23, 3, 0, 0);
const sonnet = MODEL_PRICES["claude-sonnet-5-5"]!;

let counter = 0;
const fresh = (label: string) => `model-routes:${label}-${Date.now()}-${counter++}`;

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ error: "unexpected_outbound_call" }, { status: 599 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// An operator call through the admin gate, against `target`, with the Access identity `email` when given.
async function admin<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  options: { target?: Env; email?: string } = {},
) {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", {
    value: { aud: bindings.ADMIN_ACCESS_AUD, getIdentity: async () => (options.email ? { email: options.email } : undefined) },
    configurable: true,
  });
  const response = await worker.fetch(
    new Request(`https://api.manut.test${path}`, {
      method,
      headers: OPERATOR,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    options.target ?? bindings,
    context,
  );
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as T };
}

const usagePath = (tenant: string, month?: string) =>
  `/v1/admin/model/usage?tenant=${encodeURIComponent(tenant)}${month ? `&month=${month}` : ""}`;

function scripted(usage = { inputTokens: 1_000, outputTokens: 500 }) {
  return {
    id: "scripted",
    missing: null,
    async complete(): Promise<ChatResult> {
      return { text: "answer", stopReason: "end_turn", usage };
    },
  };
}

describe("the model operator routes behind the admin gate", () => {
  const routes = [
    ["GET", "/v1/admin/model/usage"],
    ["PUT", "/v1/admin/model/cap"],
  ] as const;

  /// A request whose body counts how often it is read, so a test can show the gate answered first.
  function send(method: string, path: string, options: { audience?: string; bearer?: string }) {
    let pulls = 0;
    const body =
      method === "PUT"
        ? new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                pulls++;
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          )
        : undefined;
    const context = createExecutionContext();
    if (options.audience !== undefined) {
      Object.defineProperty(context, "access", {
        value: { aud: options.audience, getIdentity: async () => undefined },
        configurable: true,
      });
    }
    const request = new Request(`https://api.manut.test${path}`, {
      method,
      headers: { authorization: `Bearer ${options.bearer ?? "test-key"}`, "content-type": "application/json" },
      ...(body ? { body } : {}),
    });
    return {
      status: worker.fetch(request, bindings, context).then(async (response) => {
        await waitOnExecutionContext(context);
        return response.status;
      }),
      pulls: () => pulls,
    };
  }

  it.each(routes)("refuses %s %s without the admin gate's two credentials, before reading anything", async (method, path) => {
    for (const options of [{}, { audience: "another-application" }, { audience: bindings.ADMIN_ACCESS_AUD!, bearer: "a-session-token" }]) {
      const attempt = send(method, path, options);
      expect(await attempt.status).toBe(403);
      expect(attempt.pulls()).toBe(0);
    }
    // Through the gate, each is an exact ADMIN_METHODS entry, never the gate's
    // 404 for an unlisted method.
    expect(await send(method, path, { audience: bindings.ADMIN_ACCESS_AUD! }).status).not.toBe(404);
  });

  it("refuses model admin methods that are not listed", async () => {
    for (const [method, path] of [
      ["POST", "/v1/admin/model/usage"],
      ["GET", "/v1/admin/model/cap"],
      ["DELETE", "/v1/admin/model/cap"],
      ["GET", "/v1/admin/model/usage/extra"],
      ["POST", "/v1/admin/model/calls"],
    ] as const) {
      expect(await send(method, path, { audience: bindings.ADMIN_ACCESS_AUD! }).status).toBe(404);
    }
  });
});

describe("reading a shop's month", () => {
  it("answers an untouched shop with the default cap and nothing spent", async () => {
    const tenant = fresh("empty");
    const read = await admin("GET", usagePath(tenant));
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      tenant,
      month: bangkokMonth(Date.now()),
      capSatang: 20_000,
      capSource: "default",
      capOverride: null,
      spentSatang: 0,
      spentMillisatang: 0,
      heldSatang: 0,
      heldMillisatang: 0,
      remainingSatang: 20_000,
      counts: { ok: 0, failed: 0, unreadable: 0, abandoned: 0, refused: 0 },
      tokens: { input: 0, output: 0 },
      calls: [],
      holds: [],
    });
  });

  it("shows month-to-date spend rounded up, what is left rounded down, and the calls newest first", async () => {
    const tenant = fresh("spent");
    const request = { model: "claude-sonnet-5-5", messages: [{ role: "user" as const, content: "hi" }], maxOutputTokens: 600 };
    const first = await callModel(bindings, tenant, request, { provider: scripted(), now: () => NOW });
    const second = await callModel(bindings, tenant, request, { provider: scripted(), now: () => NOW + 1_000 });
    if (!first.ok || !second.ok) throw new Error("calls_failed");
    // Each call costs ฿0.245: 1,000 input and 500 output tokens at $2 and $10 a million, at ฿35.
    expect(costMillisatang(sonnet, { inputTokens: 1_000, outputTokens: 500 }, 3_500)).toBe(24_500);

    const read = await admin<Record<string, unknown>>("GET", usagePath(tenant, "2026-11"));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      month: "2026-11",
      capSatang: 20_000,
      spentMillisatang: 49_000,
      spentSatang: 49,
      remainingSatang: 19_951,
      counts: { ok: 2, failed: 0, unreadable: 0, abandoned: 0, refused: 0 },
      tokens: { input: 2_000, output: 1_000 },
    });
    expect((read.body.calls as { id: string }[]).map((call) => call.id)).toEqual([second.callId, first.callId]);
    expect(read.body.calls).toEqual([
      expect.objectContaining({ model: "claude-sonnet-5-5", inputTokens: 1_000, outputTokens: 500, millisatang: 24_500, satang: 25, outcome: "ok" }),
      expect.objectContaining({ at: new Date(NOW).toISOString() }),
    ]);
    // Another month of the same shop is its own budget.
    expect((await admin("GET", usagePath(tenant, "2026-10"))).body).toMatchObject({ month: "2026-10", spentSatang: 0, calls: [] });
  });

  it("counts open reservations against what is left, and shows when each expires", async () => {
    const tenant = fresh("held");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const asked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // The gateway asks the provider only once the reservation is held, so
    // waiting for the provider to be asked is waiting for the hold.
    const slow = {
      id: "slow",
      missing: null,
      async complete(): Promise<ChatResult> {
        entered();
        await gate;
        return { text: "late", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const request = { model: "claude-sonnet-5-5", messages: [{ role: "user" as const, content: "hi" }], maxOutputTokens: 1_000 };
    const pending = callModel(bindings, tenant, request, { provider: slow, now: () => NOW });
    await asked;
    const read = await admin<{ holds: { expiresAt: string; worstMillisatang: number }[]; heldMillisatang: number; remainingSatang: number }>(
      "GET",
      usagePath(tenant, "2026-11"),
    );
    expect(read.body.holds).toHaveLength(1);
    expect(read.body.holds[0]!.expiresAt).toBe(new Date(NOW + 15 * 60 * 1000).toISOString());
    expect(read.body.heldMillisatang).toBe(read.body.holds[0]!.worstMillisatang);
    expect(read.body.remainingSatang).toBe(Math.floor((20_000_000 - read.body.heldMillisatang) / 1_000));
    release();
    expect((await pending).ok).toBe(true);
    expect((await admin<{ holds: unknown[] }>("GET", usagePath(tenant, "2026-11"))).body.holds).toEqual([]);
  });

  it("takes the default cap from MODEL_DEFAULT_CAP_SATANG", async () => {
    const tenant = fresh("default");
    const read = await admin("GET", usagePath(tenant), undefined, { target: { ...bindings, MODEL_DEFAULT_CAP_SATANG: "5000" } });
    expect(read.body).toMatchObject({ capSatang: 5_000, capSource: "default", remainingSatang: 5_000 });
  });

  it("refuses a missing tenant, a month that is not one, and settings it cannot read", async () => {
    expect(await admin("GET", "/v1/admin/model/usage")).toEqual({ status: 400, body: { error: "tenant_required" } });
    expect(await admin("GET", usagePath(fresh("bad"), "2026-13"))).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(await admin("GET", usagePath(fresh("bad"), "November"))).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect(
      await admin("GET", usagePath(fresh("bad")), undefined, { target: { ...bindings, MODEL_DEFAULT_CAP_SATANG: "two hundred" } }),
    ).toEqual({ status: 503, body: { error: "not_configured", setting: "MODEL_DEFAULT_CAP_SATANG" } });
  });
});

describe("setting a shop's cap", () => {
  it("sets an override that the next read and the next call use, and records who set it", async () => {
    const tenant = fresh("override");
    const set = await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: 1 }, { email: "operator@manut.test" });
    expect(set).toEqual({
      status: 200,
      body: {
        tenant,
        capSatang: 1,
        capSource: "override",
        capOverride: { capSatang: 1, setAt: expect.any(String), setBy: "operator@manut.test" },
      },
    });
    expect((await admin("GET", usagePath(tenant))).body).toMatchObject({ capSatang: 1, capSource: "override", remainingSatang: 1 });
    // One satang is too little for any call's worst case.
    const request = { model: "claude-sonnet-5-5", messages: [{ role: "user" as const, content: "hi" }], maxOutputTokens: 100 };
    expect(await callModel(bindings, tenant, request, { provider: scripted() })).toMatchObject({ status: 402, capSatang: 1 });
  });

  it("clears the override with null, returning the shop to the default", async () => {
    const tenant = fresh("clear");
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: 0 })).body).toMatchObject({ capSatang: 0, capSource: "override" });
    expect((await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang: null })).body).toEqual({
      tenant,
      capSatang: 20_000,
      capSource: "default",
      capOverride: null,
    });
    expect((await admin("GET", usagePath(tenant))).body).toMatchObject({ capSatang: 20_000, capSource: "default", capOverride: null });
  });

  it("refuses a cap that is not a whole, non-negative number of satang, and a missing tenant", async () => {
    const tenant = fresh("invalid");
    for (const capSatang of [-1, 1.5, "100", MAX_CAP_SATANG + 1, undefined, true]) {
      expect(await admin("PUT", "/v1/admin/model/cap", { tenant, capSatang })).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await admin("PUT", "/v1/admin/model/cap", { capSatang: 100 })).toEqual({ status: 400, body: { error: "tenant_required" } });
    expect(await admin("PUT", "/v1/admin/model/cap", [1, 2])).toEqual({ status: 400, body: { error: "invalid_request" } });
    expect((await admin("GET", usagePath(tenant))).body).toMatchObject({ capSource: "default", capOverride: null });
  });
});
