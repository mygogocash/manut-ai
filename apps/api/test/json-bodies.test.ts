import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { testOutbox } from "../src/email-sender";
import worker, { type Env } from "../src/index";

// A body the API reads must say it is JSON (index.ts, `jsonBodyRefusal`; docs/pilot-api.md, "Security rules"). A page on
// another site can make a visitor's browser send a POST without a CORS preflight only as `text/plain`, a form or a
// multipart upload, so those, and a body that names no type at all, are refused before anything is counted, read or
// woken. The security review of 24 Nov 2026 showed such a request making the browser ask for a code to any address.

const bindings = env as unknown as Env;
const API = "https://api.manut.test";

const LIMITERS = ["AUTH_EXCHANGE_LIMITER", "AUTH_CODE_LIMITER", "AUTH_SESSION_LIMITER", "LINEAR_INBOUND_LIMITER",
  "LINE_INBOUND_LIMITER", "PILOT_APPROVAL_LIMITER", "OUTPOST_LIMITER", "GOOGLE_CALLBACK_LIMITER",
  "SELF_SERVE_SHOP_LIMITER"] as const;

/// The test config with every limiter and every object counted, each limiter letting everything through, and AUTH,
/// TENANT and TASK answering a fixture instead of waking.
function counting() {
  const keys: string[] = [];
  let woken = 0;
  const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: true }; } } as RateLimit;
  const sleeping = (namespace: DurableObjectNamespace) => ({ idFromName: (name: string) => namespace.idFromName(name),
    get: () => ({ fetch: async () => { woken++; return Response.json({ fixture: true }); } }) }) as unknown as
    DurableObjectNamespace;
  const target = { ...bindings, AUTH: sleeping(bindings.AUTH), TENANT: sleeping(bindings.TENANT),
    TASK: sleeping(bindings.TASK) } as Record<string, unknown>;
  for (const name of LIMITERS) target[name] = limiter;
  return { env: target as unknown as Env, keys, woken: () => woken };
}

async function send(request: Request, target: Env = bindings): Promise<Response> {
  if (!request.headers.has("cf-connecting-ip")) {
    const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
    request.headers.set("cf-connecting-ip", `2001:db8:${groups.join(":")}`);
  }
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

/// A POST with `body` as `type`, as `fetch(url, { method: "POST", mode: "no-cors", body })` on another site sends it.
function crossSite(path: string, body: string, type: string | null = "text/plain;charset=UTF-8",
  headers: Record<string, string> = {}): Request {
  const request = new Request(`${API}${path}`, { method: "POST", body, headers: { origin: "https://evil.example",
    "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "content-length": String(body.length), ...headers } });
  if (type === null) request.headers.delete("content-type");
  else request.headers.set("content-type", type);
  return request;
}

const address = (name: string) => `${name}-${crypto.randomUUID()}@example.org`;

function code(email: string): string {
  const sent = testOutbox().filter((one) => one.to === email);
  const found = /sign-in code is (\d{6})\./.exec(sent.at(-1)?.text ?? "")?.[1];
  if (!found) throw new Error("no code in the outbox for that address");
  return found;
}

describe("a body the API reads", () => {
  it("is never one another site can make a visitor's browser send: no code is asked for", async () => {
    // The review's proof: this request sent the victim a code.
    const victim = address("victim");
    const response = await send(crossSite("/v1/auth/email/code", JSON.stringify({ email: victim })));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "json_required" });
    expect(testOutbox().some((one) => one.to === victim)).toBe(false);
    // Nothing counted it against the visitor's source, and nothing woke.
    const counted = counting();
    expect((await send(crossSite("/v1/auth/email/code", JSON.stringify({ email: victim })), counted.env)).status)
      .toBe(415);
    expect(counted.keys).toEqual([]);
    expect(counted.woken()).toBe(0);
  });

  it("nor spends the tries of a code its owner asked for", async () => {
    const owner = address("owner");
    const asked = await send(new Request(`${API}/v1/auth/email/code`, { method: "POST", body: JSON.stringify({ email: owner }),
      headers: { "content-type": "application/json", "content-length": String(JSON.stringify({ email: owner }).length) } }));
    expect(asked.status).toBe(200);
    const right = code(owner);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    for (let i = 0; i < 5; i++) {
      const tried = await send(crossSite("/v1/auth/exchange",
        JSON.stringify({ provider: "email", email: owner, code: wrong, deviceId: "evil-device" })));
      expect(tried.status).toBe(415);
    }
    const body = JSON.stringify({ provider: "email", email: owner, code: right, deviceId: "owner-device" });
    const signedIn = await send(new Request(`${API}/v1/auth/exchange`, { method: "POST", body,
      headers: { "content-type": "application/json", "content-length": String(body.length) } }));
    expect(signedIn.status).toBe(200);
  });

  it("is refused as any type a page can send without asking, or none, on every route that reads one", async () => {
    const routes: [string, string][] = [
      ["POST", "/v1/auth/email/code"], ["POST", "/v1/auth/exchange"], ["POST", "/v1/auth/refresh"],
      ["POST", "/v1/web/sign-in"], ["POST", "/v1/web/shops"], ["POST", "/v1/web/sign-out"], ["POST", "/v1/shops/new"],
      ["POST", "/v1/shops/session"], ["POST", "/v1/shops/owner-code"], ["POST", "/v1/people/accept"],
      ["POST", "/v1/routines"], ["POST", "/v1/approvals/req-1/decision"], ["POST", "/v1/outposts/register"],
      ["POST", "/v1/outposts/heartbeat"], ["POST", "/v1/pilot/approvals/token/decision"], ["POST", "/v1/google/connect"],
      ["POST", "/v1/admin/pilot/shops"], ["PUT", "/v1/admin/flags"], ["PUT", "/v1/consent/cloud"],
      ["POST", "/v1/tasks"], ["PUT", "/v1/tasks/task-1"], ["PATCH", "/v1/companies/company-1"],
      ["POST", "/v1/no-such-route"],
    ];
    const types = ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x", "text/json", "application/jsonp", "application/json-patch+json", "", null];
    const counted = counting();
    for (const [method, path] of routes) {
      for (const type of types) {
        const request = new Request(`${API}${path}`, { method, body: "{}",
          headers: { authorization: "Bearer test-key", "x-manut-web": "1", origin: API, "content-length": "2" } });
        if (type === null) request.headers.delete("content-type");
        else request.headers.set("content-type", type);
        const response = await send(request, counted.env);
        expect([method, path, type, response.status]).toEqual([method, path, type, 415]);
        expect(await response.json()).toEqual({ error: "json_required" });
      }
    }
    expect(counted.keys).toEqual([]);
    expect(counted.woken()).toBe(0);
  });

  it("is taken as JSON however the type is written", async () => {
    for (const type of ["application/json", "application/json; charset=utf-8", "Application/JSON",
      " application/json ; charset=UTF-8"]) {
      const email = address("written");
      const body = JSON.stringify({ email });
      const response = await send(new Request(`${API}/v1/auth/email/code`, { method: "POST", body,
        headers: { "content-type": type, "content-length": String(body.length) } }));
      expect([type, response.status]).toEqual([type, 200]);
      expect(testOutbox().some((one) => one.to === email)).toBe(true);
    }
  });

  it("is not needed when there is none, and GET and DELETE are left as they were", async () => {
    const counted = counting();
    // No body at all, and an empty one with a length of 0: nothing to read, so the route answers as before.
    const empty = await send(new Request(`${API}/v1/shops/owner-code`, { method: "POST" }), counted.env);
    expect(empty.status).toBe(401);
    const zero = await send(new Request(`${API}/v1/shops/owner-code`, { method: "POST",
      headers: { "content-type": "text/plain", "content-length": "0" } }), counted.env);
    expect(zero.status).toBe(401);
    expect((await send(new Request(`${API}/v1/health`), counted.env)).status).toBe(200);
    const signOut = await send(new Request(`${API}/v1/auth/session`, { method: "DELETE",
      headers: { "content-type": "text/plain" } }), counted.env);
    expect(signOut.status).toBe(401);
  });

  it("leaves the webhooks to their senders, who sign the exact body", async () => {
    const counted = counting();
    for (const path of ["/v1/inbound/linear", "/v1/inbound/line/connection-1"]) {
      const response = await send(crossSite(path, "{}", "text/plain"), counted.env);
      expect(response.status).not.toBe(415);
    }
    // Each still counted against its own limit, as before.
    expect(counted.keys).toHaveLength(2);
  });
});
