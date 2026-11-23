import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

type LimitedEnv = Env & {
  AUTH_EXCHANGE_LIMITER?: RateLimit;
  AUTH_SESSION_LIMITER?: RateLimit;
  LINEAR_INBOUND_LIMITER?: RateLimit;
  OUTPOST_LIMITER?: RateLimit;
};
const bindings = env as unknown as LimitedEnv;
const routes = [
  ["/v1/auth/exchange", "POST", "AUTH_EXCHANGE_LIMITER"],
  ["/v1/auth/refresh", "POST", "AUTH_SESSION_LIMITER"],
  ["/v1/auth/session", "DELETE", "AUTH_SESSION_LIMITER"],
  ["/v1/inbound/linear", "POST", "LINEAR_INBOUND_LIMITER"],
  // The outposts' own routes (browser-control.ts) take a bearer credential, so each is limited before the credential
  // is even looked at, and all of them share one bucket per address.
  ["/v1/outposts/heartbeat", "POST", "OUTPOST_LIMITER"],
  ["/v1/outposts/redeem", "POST", "OUTPOST_LIMITER"],
] as const;

function fixture(limit: (key: string) => Promise<boolean> = async () => true) {
  const keys: string[] = [];
  let calls = 0;
  const limiter = { limit: async ({ key }: { key: string }) => {
    keys.push(key);
    return { success: await limit(key) };
  } } as RateLimit;
  const target: LimitedEnv = { ...bindings,
    AUTH_EXCHANGE_LIMITER: limiter, AUTH_SESSION_LIMITER: limiter, LINEAR_INBOUND_LIMITER: limiter,
    OUTPOST_LIMITER: limiter,
    AUTH: { idFromName: (name: string) => bindings.AUTH.idFromName(name),
      get: () => ({ fetch: async () => { calls++; return Response.json({ fixture: true }); } }),
    } as unknown as DurableObjectNamespace,
  };
  return { target, keys, calls: () => calls };
}

function request(path: string, method: string, ip: string | null = "192.0.2.17") {
  let pulls = 0;
  const headers = new Headers({ "content-type": "application/json", "content-length": "2",
    authorization: "Bearer fixture-token", "x-forwarded-for": "203.0.113.99" });
  if (ip !== null) headers.set("cf-connecting-ip", ip);
  const body = method === "DELETE" ? undefined : new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); },
  }, { highWaterMark: 0 });
  return { request: new Request(`https://test${path}`, { method, headers, ...(body ? { body } : {}) }),
    pulls: () => pulls };
}

async function send(request: Request, target: LimitedEnv) {
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

describe("public ingress rate limits", () => {
  it.each(routes)("throttles %s before body reads and AUTH", async (path, method) => {
    const counter = fixture(async () => false);
    const input = request(path, method);
    const response = await send(input.request, counter.target);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(input.pulls()).toBe(0);
    expect(counter.calls()).toBe(0);
    expect(counter.keys).toEqual(["192.0.2.17"]);
  });

  it.each(routes)("fails closed when the %s binding is missing or throws", async (path, method, binding) => {
    for (const missing of [true, false]) {
      const counter = fixture(async () => { throw new Error("fixture_unavailable"); });
      if (missing) delete counter.target[binding];
      const input = request(path, method);
      const response = await send(input.request, counter.target);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "rate_limit_unavailable" });
      expect(input.pulls()).toBe(0);
      expect(counter.calls()).toBe(0);
    }
  });

  it.each([null, "", "   "])("refuses an absent trusted source IP (%s), ignoring forwarded IP claims", async (ip) => {
    const counter = fixture();
    const input = request("/v1/auth/exchange", "POST", ip);
    expect((await send(input.request, counter.target)).status).toBe(503);
    expect(counter.keys).toEqual([]);
    expect(input.pulls()).toBe(0);
    expect(counter.calls()).toBe(0);
  });

  it("forwards an allowed opaque refresh and keeps the existing body boundary", async () => {
    const counter = fixture();
    const response = await send(request("/v1/auth/refresh", "POST").request, counter.target);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fixture: true });
    expect(counter.keys).toEqual(["192.0.2.17"]);
    expect(counter.calls()).toBe(1);
    const headerless = new Request("https://test/v1/auth/exchange", { method: "POST",
      headers: { "cf-connecting-ip": "192.0.2.17" }, body: "{}" });
    expect((await send(headerless, counter.target)).status).toBe(411);
    expect(counter.calls()).toBe(1);
  });

  it("leaves health and unrelated methods outside the limits", async () => {
    const counter = fixture(async () => { throw new Error("must_not_limit"); });
    expect((await send(new Request("https://test/v1/health"), counter.target)).status).toBe(200);
    expect((await send(new Request("https://test/v1/auth/exchange"), counter.target)).status).toBe(404);
    expect((await send(new Request("https://test/v1/outposts/heartbeat"), counter.target)).status).toBe(404);
    expect(counter.keys).toEqual([]);
  });

  it.each([
    ["AUTH_EXCHANGE_LIMITER", 10], ["AUTH_SESSION_LIMITER", 60], ["LINEAR_INBOUND_LIMITER", 300],
    ["OUTPOST_LIMITER", 300],
  ] as const)("uses the real workerd %s binding at its configured boundary", async (binding, limit) => {
    const actual = bindings[binding];
    expect(actual).toBeDefined();
    const counter = fixture();
    counter.target[binding] = actual!;
    const path = ({ AUTH_EXCHANGE_LIMITER: "/v1/auth/exchange", AUTH_SESSION_LIMITER: "/v1/auth/refresh",
      LINEAR_INBOUND_LIMITER: "/v1/inbound/linear", OUTPOST_LIMITER: "/v1/outposts/heartbeat" } as const)[binding];
    // Fills one address's real bucket to the limit and sends one more. The real limiter counts in 60-second windows,
    // so on a loaded machine the loop can cross into a new window and the extra request is rightly let through.
    // That is the window moving, not a missing limit, so the run is repeated once from a fresh address, which starts
    // its count in a window that has only just begun; the assertions below then hold on that run.
    const fill = async () => {
      const ip = `2001:db8::${crypto.randomUUID().replaceAll("-", "").slice(0, 4)}`;
      for (let index = 0; index < limit; index++) {
        // Refresh and revoke deliberately consume the same real bucket.
        const revoke = binding === "AUTH_SESSION_LIMITER" && index % 2 === 1;
        const response = await send(request(revoke ? "/v1/auth/session" : path, revoke ? "DELETE" : "POST", ip).request,
          counter.target);
        expect(response.status).not.toBe(429);
        expect(response.status).not.toBe(503);
      }
      const calls = counter.calls();
      const blocked = request(path, "POST", ip);
      const response = await send(blocked.request, counter.target);
      return { ip, calls, blocked, response };
    };
    let run = await fill();
    if (run.response.status !== 429) run = await fill();
    const { ip, calls, blocked, response } = run;
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(blocked.pulls()).toBe(0);
    expect(counter.calls()).toBe(calls);
    expect((await send(request(path, "POST", `${ip}:1`).request, counter.target)).status).not.toBe(429);
  });
});
