import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

type LimitedEnv = Env & {
  AUTH_EXCHANGE_LIMITER?: RateLimit;
  AUTH_CODE_LIMITER?: RateLimit;
  AUTH_SESSION_LIMITER?: RateLimit;
  LINEAR_INBOUND_LIMITER?: RateLimit;
  OUTPOST_LIMITER?: RateLimit;
  SELF_SERVE_SHOP_LIMITER?: RateLimit;
  CHAT_LIMITER?: RateLimit;
};
const bindings = env as unknown as LimitedEnv;
const routes = [
  ["/v1/auth/exchange", "POST", "AUTH_EXCHANGE_LIMITER"],
  // Asking for a sign-in code by email sends an email, so it is limited per source IP before anything else, on its own
  // bucket keyed and configured as the exchange's (email-code.ts).
  ["/v1/auth/email/code", "POST", "AUTH_CODE_LIMITER"],
  ["/v1/auth/refresh", "POST", "AUTH_SESSION_LIMITER"],
  ["/v1/auth/session", "DELETE", "AUTH_SESSION_LIMITER"],
  ["/v1/inbound/linear", "POST", "LINEAR_INBOUND_LIMITER"],
  // The outposts' own routes (browser-control.ts) take a bearer credential, so each is limited before the credential
  // is even looked at, and all of them share one bucket per address.
  ["/v1/outposts/heartbeat", "POST", "OUTPOST_LIMITER"],
  ["/v1/outposts/redeem", "POST", "OUTPOST_LIMITER"],
  ["/v1/outposts/steps", "POST", "OUTPOST_LIMITER"],
  ["/v1/outposts/steps/report", "POST", "OUTPOST_LIMITER"],
  // Making a shop of one's own (self-serve.ts) wakes AUTH and makes a shop, so while sign-ups are open (the test config opens
  // them) every try counts before anything is read.
  ["/v1/shops/new", "POST", "SELF_SERVE_SHOP_LIMITER"],
  // Buddy's chat (chat.ts, item 143) checks the owner's session first, which wakes AUTH, so each of its four routes is limited
  // before the session is read, all of them in one bucket per address. The reads count as the message does.
  ["/v1/chat/messages", "POST", "CHAT_LIMITER"],
  ["/v1/chat/threads", "GET", "CHAT_LIMITER"],
  ["/v1/chat/threads/cht-0123456789", "GET", "CHAT_LIMITER"],
  ["/v1/chat/threads/remove", "POST", "CHAT_LIMITER"],
] as const;

function fixture(limit: (key: string) => Promise<boolean> = async () => true) {
  const keys: string[] = [];
  let calls = 0;
  const limiter = { limit: async ({ key }: { key: string }) => {
    keys.push(key);
    return { success: await limit(key) };
  } } as RateLimit;
  const target: LimitedEnv = { ...bindings,
    AUTH_EXCHANGE_LIMITER: limiter, AUTH_CODE_LIMITER: limiter, AUTH_SESSION_LIMITER: limiter, LINEAR_INBOUND_LIMITER: limiter,
    OUTPOST_LIMITER: limiter, SELF_SERVE_SHOP_LIMITER: limiter, CHAT_LIMITER: limiter,
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
  const body = method === "DELETE" || method === "GET" ? undefined : new ReadableStream<Uint8Array>({
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
      headers: { "cf-connecting-ip": "192.0.2.17", "content-type": "application/json" }, body: "{}" });
    expect((await send(headerless, counter.target)).status).toBe(411);
    expect(counter.calls()).toBe(1);
  });

  it("leaves health and unrelated methods outside the limits", async () => {
    const counter = fixture(async () => { throw new Error("must_not_limit"); });
    expect((await send(new Request("https://test/v1/health"), counter.target)).status).toBe(200);
    expect((await send(new Request("https://test/v1/auth/exchange"), counter.target)).status).toBe(404);
    expect((await send(new Request("https://test/v1/auth/email/code"), counter.target)).status).toBe(404);
    expect((await send(new Request("https://test/v1/outposts/heartbeat"), counter.target)).status).toBe(404);
    expect(counter.keys).toEqual([]);
  });

  it("counts nothing for making a shop while sign-ups are closed, and wakes nothing", async () => {
    for (const closed of [undefined, "off", "1", "ON"]) {
      const counter = fixture(async () => { throw new Error("must_not_limit"); });
      const input = request("/v1/shops/new", "POST");
      const response = await send(input.request, { ...counter.target, SELF_SERVE_SHOPS: closed } as unknown as LimitedEnv);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "sign_ups_closed" });
      expect(counter.keys).toEqual([]);
      expect(input.pulls()).toBe(0);
      expect(counter.calls()).toBe(0);
    }
  });

  it.each([
    ["AUTH_EXCHANGE_LIMITER", 10], ["AUTH_CODE_LIMITER", 10], ["AUTH_SESSION_LIMITER", 60], ["LINEAR_INBOUND_LIMITER", 300],
    ["OUTPOST_LIMITER", 300], ["SELF_SERVE_SHOP_LIMITER", 10], ["CHAT_LIMITER", 60],
  ] as const)("uses the real workerd %s binding at its configured boundary", async (binding, limit) => {
    const actual = bindings[binding];
    expect(actual).toBeDefined();
    const counter = fixture();
    counter.target[binding] = actual!;
    const path = ({ AUTH_EXCHANGE_LIMITER: "/v1/auth/exchange", AUTH_CODE_LIMITER: "/v1/auth/email/code",
      AUTH_SESSION_LIMITER: "/v1/auth/refresh",
      LINEAR_INBOUND_LIMITER: "/v1/inbound/linear", OUTPOST_LIMITER: "/v1/outposts/heartbeat",
      SELF_SERVE_SHOP_LIMITER: "/v1/shops/new", CHAT_LIMITER: "/v1/chat/messages" } as const)[binding];
    // Fills one /64's real bucket to the limit, each request from another address inside it, and sends one more from
    // yet another: a whole IPv6 /64 is one source, so rotating addresses inside it gains nothing. The real limiter
    // counts in 60-second windows, so on a loaded machine the loop can cross into a new window and the extra request is
    // rightly let through. That is the window moving, not a missing limit, so the run is repeated once from a fresh /64,
    // which starts its count in a window that has only just begun; the assertions below then hold on that run.
    const fill = async () => {
      const prefix = `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 8).match(/.{4}/g)!.join(":")}`;
      for (let index = 0; index < limit; index++) {
        // Refresh and revoke deliberately consume the same real bucket.
        const revoke = binding === "AUTH_SESSION_LIMITER" && index % 2 === 1;
        const response = await send(request(revoke ? "/v1/auth/session" : path, revoke ? "DELETE" : "POST",
          `${prefix}::${(index + 1).toString(16)}`).request, counter.target);
        expect(response.status).not.toBe(429);
        expect(response.status).not.toBe(503);
      }
      const calls = counter.calls();
      const blocked = request(path, "POST", `${prefix}:ffff:ffff:ffff:ffff`);
      const response = await send(blocked.request, counter.target);
      return { prefix, calls, blocked, response };
    };
    let run = await fill();
    if (run.response.status !== 429) run = await fill();
    const { prefix, calls, blocked, response } = run;
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(blocked.pulls()).toBe(0);
    expect(counter.calls()).toBe(calls);
    // The /64 next door is another source.
    const [, , third = "0", fourth = "0"] = prefix.split(":");
    const next = `2001:db8:${third}:${(parseInt(fourth, 16) ^ 1).toString(16)}::1`;
    expect((await send(request(path, "POST", next).request, counter.target)).status).not.toBe(429);
  });

  it("keys every bucket by the source group: an IPv4 address, or an IPv6 /64 however it is written", async () => {
    const counter = fixture();
    const sources = [
      ["192.0.2.17", "192.0.2.17"],
      ["::ffff:192.0.2.17", "192.0.2.17"],
      ["2001:db8:aaaa:bbbb::1", "2001:db8:aaaa:bbbb::/64"],
      ["2001:DB8:AAAA:BBBB:0:0:0:2", "2001:db8:aaaa:bbbb::/64"],
      ["2001:0db8:aaaa:bbbb:ffff:ffff:ffff:ffff", "2001:db8:aaaa:bbbb::/64"],
      [" 2001:db8:aaaa:bbbc::1 ", "2001:db8:aaaa:bbbc::/64"],
    ] as const;
    for (const [path, method] of routes) {
      for (const [ip] of sources) await send(request(path, method, ip).request, counter.target);
      expect(counter.keys.splice(0)).toEqual(sources.map(([, key]) => key));
    }
    // An address that cannot be read is refused before anything counts or wakes, never given a bucket of its own.
    const woken = counter.calls();
    for (const ip of ["unknown", "192.0.2.256", "2001:db8::1]/x", "2001:db8:::1", "203.0.113.99, 192.0.2.17"]) {
      const input = request("/v1/auth/email/code", "POST", ip);
      const response = await send(input.request, counter.target);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "rate_limit_unavailable" });
      expect(input.pulls()).toBe(0);
    }
    expect(counter.keys).toEqual([]);
    expect(counter.calls()).toBe(woken);
  });

  it("stops one /64 asking for codes at the limit, however many of its addresses it rotates through", async () => {
    // The review's proof (24 Nov 2026): fifteen asks for codes in a minute, each from another address of one /64, all
    // went out, while one address was stopped at ten. Now the /64 is the source, so both are stopped at ten. The real
    // limiter counts in 60-second windows, so a run that crosses one is tried once more from a fresh /64.
    const ask = async (ip: string) => {
      const body = JSON.stringify({ email: `rotate-${crypto.randomUUID()}@spam.example` });
      const context = createExecutionContext();
      const response = await worker.fetch(new Request("https://api.manut.test/v1/auth/email/code", { method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length), "cf-connecting-ip": ip },
        body }), bindings, context);
      await waitOnExecutionContext(context);
      await response.body?.cancel();
      return response.status;
    };
    const run = async () => {
      const prefix = `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 8).match(/.{4}/g)!.join(":")}`;
      const statuses: number[] = [];
      for (let index = 1; index <= 15; index++) statuses.push(await ask(`${prefix}::${index.toString(16)}`));
      return statuses;
    };
    let statuses = await run();
    if (statuses.slice(10).some((status) => status !== 429)) statuses = await run();
    expect(statuses).toEqual([...Array<number>(10).fill(200), ...Array<number>(5).fill(429)]);
  });
});

// Buddy's chat (item 143, L5 of the sixth security read): every call under /v1/chat/ checked the owner's session first, which
// wakes AUTH, with no limit of its own at the door. The generic tests above walk its four routes; these are the chat's own: which
// paths and methods count, that the paths beside it do not, and that a call below the limit goes on to the session's own check.
describe("Buddy's chat ingress limit", () => {
  /// Every method and every path under /v1/chat/ counts, the unknown ones and the bare /v1/chat too: the chat route answers each
  /// of them, and each is answered before the session is read, so each is counted first.
  const everyCall = [
    ["POST", "/v1/chat/messages"], ["PUT", "/v1/chat/messages"], ["GET", "/v1/chat/threads"], ["POST", "/v1/chat/threads"],
    ["GET", "/v1/chat/threads/cht-0123456789"], ["DELETE", "/v1/chat/threads/cht-0123456789"],
    ["POST", "/v1/chat/threads/remove"], ["GET", "/v1/chat/nothing-here"], ["GET", "/v1/chat/"], ["GET", "/v1/chat"],
  ] as const;

  it.each(everyCall)("counts %s %s, and past the limit answers 429 before the session is checked or anything is read",
    async (method, path) => {
      const counter = fixture(async () => false);
      const input = request(path, method);
      const response = await send(input.request, counter.target);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toEqual({ error: "rate_limited" });
      expect(counter.keys).toEqual(["192.0.2.17"]);
      expect(counter.calls()).toBe(0);
      expect(input.pulls()).toBe(0);
    });

  it("lets a call below the limit through to the chat's own checks, counted once", async () => {
    const counter = fixture();
    // The fixture's AUTH knows no session, so the route's own first check refuses it: the call got past the gate and woke AUTH once.
    const refused = await send(request("/v1/chat/threads", "GET").request, counter.target);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "unauthorized" });
    expect(counter.keys).toEqual(["192.0.2.17"]);
    expect(counter.calls()).toBe(1);
    // A path under /v1/chat/ that is no route of the chat is counted too, and answered 404 without reading any session.
    const unknown = await send(request("/v1/chat/nothing-here", "GET").request, counter.target);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not_found" });
    expect(counter.keys).toEqual(["192.0.2.17", "192.0.2.17"]);
    expect(counter.calls()).toBe(1);
  });

  it("leaves the paths beside the chat's outside the limit", async () => {
    const counter = fixture(async () => { throw new Error("must_not_limit"); });
    for (const path of ["/v1/chatter", "/v1/chats", "/v1/chat-history", "/v1/memory/chat", "/v1/shops/chat"]) {
      const response = await send(request(path, "GET").request, counter.target);
      // A limiter that was asked would have failed this request closed (503) after recording its key.
      expect(response.status, path).not.toBe(503);
      await response.body?.cancel();
    }
    expect(counter.keys).toEqual([]);
  });

  it("counts the chat in a bucket of its own, not the auth routes' or the deletion's", async () => {
    // One limiter per binding, so a source that has used up the chat's cannot lock the same source out of signing in, and the
    // other way round: each route asks only its own binding.
    const asked: string[] = [];
    const named = (name: string) => ({ limit: async () => { asked.push(name); return { success: true }; } }) as RateLimit;
    const counter = fixture();
    const target: LimitedEnv = { ...counter.target, AUTH_EXCHANGE_LIMITER: named("exchange"), AUTH_SESSION_LIMITER: named("session"),
      TENANT_DELETE_LIMITER: named("deletion"), SELF_SERVE_SHOP_LIMITER: named("self-serve"), CHAT_LIMITER: named("chat") } as LimitedEnv;
    await (await send(request("/v1/chat/messages", "POST").request, target)).body?.cancel();
    expect(asked).toEqual(["chat"]);
    await (await send(request("/v1/auth/refresh", "POST").request, target)).body?.cancel();
    expect(asked).toEqual(["chat", "session"]);
  });
});
