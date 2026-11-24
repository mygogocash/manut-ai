import { describe, expect, it, vi } from "vitest";
// The API's people routes, read as text, so the answers this client knows are held to the API as it stands.
import peopleSource from "../../api/src/people.ts?raw";
import { createHttpApi } from "../src/api/client";
import { ApiError, type JoinAnswer } from "../src/api/types";

type Call = { url: string; method: string; headers: Headers; raw: unknown; credentials: RequestCredentials | undefined };

const INVITE_TOKEN = "inv1.cGlsb3Q6YmFhbi1tYWxp.0123456789abcdef";
const ACCESS = "access-token-of-mint";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/// A client whose every request is recorded and answered by `answer`. The operator key is set, so a test can see that
/// none of the join page's routes ever sends it.
function harness(answer: (url: string, init?: RequestInit) => Response | Promise<Response> = () => json({})) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      raw: init?.body,
      credentials: init?.credentials,
    });
    return answer(String(input), init);
  });
  const api = createHttpApi({ origin: "https://pilot.manut.test/", operatorKey: () => "op-key-123", fetch });
  return { api, calls };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected the call to be refused");
}

const JOINED = {
  answer: "joined",
  shop: { id: "pilot:baan-mali", name: "Baan Mali", ownerName: "Fon" },
  helper: { id: "helper-1", name: "Mint" },
  session: { accessToken: "mhs1.cGlsb3Q.abc", expiresAt: "2026-12-24T10:00:00.000Z" },
};

describe("the API client, for the join page", () => {
  it("sends each route to the contract's path with exactly its body, and never the operator key or a cookie", async () => {
    const { api, calls } = harness((url) =>
      url.endsWith("/email/code") ? json({ sent: true, expiresIn: 600, resendIn: 60 })
        : url.endsWith("/exchange") ? json({ accessToken: ACCESS, refreshToken: "r", csrf: "c", expiresIn: 3600, tenant: "email:ab" })
        : url.endsWith("/accept") ? json(JOINED)
        : url.endsWith("/session/end") ? json({ ended: { shop: "pilot:baan-mali", role: "helper" } })
        : json({ revoked: true }));

    expect(await api.requestEmailCode("mint@baanmali.example")).toEqual({ sent: true, expiresIn: 600, resendIn: 60 });
    expect(await api.exchangeEmailCode({ email: "mint@baanmali.example", code: "246810", deviceId: "web-1" }))
      .toEqual({ accessToken: ACCESS, refreshToken: "r", csrf: "c", expiresIn: 3600, tenant: "email:ab" });
    expect(await api.acceptInvite({ accessToken: ACCESS, inviteToken: INVITE_TOKEN })).toEqual(JOINED);
    await api.endShopSession("mhs1.cGlsb3Q.abc");
    await api.signOut(ACCESS);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://pilot.manut.test/v1/auth/email/code",
      "POST https://pilot.manut.test/v1/auth/exchange",
      "POST https://pilot.manut.test/v1/people/accept",
      "POST https://pilot.manut.test/v1/shops/session/end",
      "DELETE https://pilot.manut.test/v1/auth/session",
    ]);
    expect(calls.map((call) => call.raw)).toEqual([
      JSON.stringify({ email: "mint@baanmali.example" }),
      JSON.stringify({ provider: "email", email: "mint@baanmali.example", code: "246810", deviceId: "web-1" }),
      JSON.stringify({ token: INVITE_TOKEN }),
      JSON.stringify({}),
      undefined,
    ]);
    expect(calls.map((call) => call.headers.get("authorization"))).toEqual(
      [null, null, `Bearer ${ACCESS}`, "Bearer mhs1.cGlsb3Q.abc", `Bearer ${ACCESS}`]);
    for (const call of calls) {
      expect(call.credentials, call.url).toBe("omit");
      expect(call.headers.get("authorization") ?? "", call.url).not.toContain("op-key-123");
    }
  });

  it("puts the invite token in the accept's body only: never in a path, a query or a header", async () => {
    const { api, calls } = harness(() => json(JOINED));
    await api.acceptInvite({ accessToken: ACCESS, inviteToken: INVITE_TOKEN });
    const [call] = calls;
    expect(call?.url).toBe("https://pilot.manut.test/v1/people/accept");
    expect([...(call?.headers.entries() ?? [])].some(([, value]) => value.includes(INVITE_TOKEN))).toBe(false);
    expect(JSON.parse(String(call?.raw))).toEqual({ token: INVITE_TOKEN });
  });

  it("resolves every answer of the accept, whatever its status, keeping only what each answer carries", async () => {
    const cases: [number, unknown, JoinAnswer][] = [
      [200, JOINED, JOINED as JoinAnswer],
      [403, { answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" }, invitedOn: "line" },
        { answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" }, invitedOn: "line" }],
      // A field the contract does not give a wrong account, an invited address above all, never reaches the page.
      [403, { answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon", address: "beam@x.test" }, invitedOn: "email",
        invited: "beam@x.test" },
        { answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" }, invitedOn: "email" }],
      [409, { answer: "already_used" }, { answer: "already_used" }],
      [410, { answer: "expired" }, { answer: "expired" }],
      [410, { answer: "revoked" }, { answer: "revoked" }],
      [404, { answer: "unknown" }, { answer: "unknown" }],
      // Nothing about the shop rides on the answers that name none.
      [410, { answer: "expired", shop: { name: "Baan Mali" } }, { answer: "expired" }],
    ];
    for (const [status, body, expected] of cases) {
      const { api } = harness(() => json(body, status));
      expect(await api.acceptInvite({ accessToken: ACCESS, inviteToken: INVITE_TOKEN }), JSON.stringify(body)).toEqual(expected);
    }
  });

  it("refuses with an ApiError only what is not an answer", async () => {
    const cases: [() => Response | Promise<Response>, number, string][] = [
      [() => json({ error: "unauthorized" }, 401), 401, "unauthorized"],
      [() => json({ error: "invalid_request" }, 400), 400, "invalid_request"],
      [() => json({ error: "people_unavailable" }, 503), 503, "people_unavailable"],
      [() => new Response("<html>Bad gateway</html>", { status: 502 }), 502, "http_502"],
      [() => Promise.reject(new TypeError("Failed to fetch")), 0, "network"],
      // An answer that is not the contract's is never shown as one.
      [() => json({ ok: true }), 200, "bad_response"],
      [() => json({ answer: "joined", shop: { name: "Baan Mali" } }), 200, "bad_response"],
      [() => json({ answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" }, invitedOn: "phone" }, 403), 403,
        "bad_response"],
      [() => json({ answer: "welcome" }, 200), 200, "bad_response"],
    ];
    for (const [answer, status, code] of cases) {
      const { api } = harness(answer);
      const err = await rejection(api.acceptInvite({ accessToken: ACCESS, inviteToken: INVITE_TOKEN }));
      expect([err.status, err.code], code).toEqual([status, code]);
    }
  });

  it("keeps the wait and the tries left that the sign-in refusals carry, and drops a value of the wrong type", async () => {
    const tooMany = await rejection(harness(() => json({ error: "too_many_codes", retryAfter: 42 }, 429, { "retry-after": "42" }))
      .api.requestEmailCode("mint@baanmali.example"));
    expect([tooMany.status, tooMany.code, tooMany.retryAfter]).toEqual([429, "too_many_codes", 42]);

    // The limit per network says its wait only in the header.
    const limited = await rejection(harness(() => json({ error: "rate_limited" }, 429, { "retry-after": "60" }))
      .api.requestEmailCode("mint@baanmali.example"));
    expect([limited.code, limited.retryAfter]).toEqual(["rate_limited", 60]);

    const off = await rejection(harness(() => json({ error: "email_not_configured" }, 400)).api.requestEmailCode("a@b.test"));
    expect([off.status, off.code, off.retryAfter]).toEqual([400, "email_not_configured", undefined]);

    const exchange = (body: unknown, status: number) =>
      rejection(harness(() => json(body, status)).api.exchangeEmailCode({ email: "a@b.test", code: "111111", deviceId: "web-1" }));
    const wrong = await exchange({ error: "wrong_code", triesLeft: 3 }, 401);
    expect([wrong.code, wrong.triesLeft]).toEqual(["wrong_code", 3]);
    const last = await exchange({ error: "wrong_code", triesLeft: 0 }, 401);
    expect([last.code, last.triesLeft]).toEqual(["wrong_code", 0]);
    const ended = await exchange({ error: "code_ended" }, 401);
    expect([ended.code, ended.triesLeft]).toEqual(["code_ended", undefined]);
    const garbled = await exchange({ error: "wrong_code", triesLeft: "three", retryAfter: -1 }, 401);
    expect([garbled.triesLeft, garbled.retryAfter]).toEqual([undefined, undefined]);
  });

  it("knows exactly the answers the API's accept gives", () => {
    const start = peopleSource.indexOf("const ANSWER_STATUS");
    const end = peopleSource.indexOf(";", start);
    expect(start, "apps/api/src/people.ts no longer has ANSWER_STATUS: teach this test where the answers went")
      .toBeGreaterThan(-1);
    const refusals = Object.fromEntries([...peopleSource.slice(start, end).matchAll(/(\w+): (\d{3})/g)]
      .map((match) => [match[1], Number(match[2])]));
    expect(refusals).toEqual({ expired: 410, revoked: 410, already_used: 409, unknown: 404 });
    expect(peopleSource).toContain('json({ answer: "joined", shop: { id: shop.tenant, name: shop.name, ownerName: shop.ownerName }');
    expect(peopleSource).toContain('return json({ answer: "wrong_account", shop: { name: shop.name, ownerName: shop.ownerName }');
  });
});
