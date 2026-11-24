// The owner's web app's routes in the real client (docs/pilot-api.md, "The web app's session"): each sends this origin's
// cookies and the app's header, carries no token in a header, a path or a body, and builds its body field by field; an
// answer the app shows (a refusal of a decision above all) resolves, and only no answer, or one that is not JSON, rejects.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api";
import { createHttpApi } from "../src/api/client";

const ORIGIN = "https://pilot.manut.test";

type Sent = { url: string; init: RequestInit };

function client(answer: (url: string) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init: init ?? {} });
    return answer(url);
  });
  return { api: createHttpApi({ origin: ORIGIN, operatorKey: () => "operator-key", fetch }), sent };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function headersOf(sent: Sent): Record<string, string> {
  return sent.init.headers as Record<string, string>;
}

/// A request the app's page makes: cookies for this origin, the app's header, and no credential of its own.
function expectWebRequest(sent: Sent, method: string, path: string, body?: unknown) {
  expect(sent.url).toBe(`${ORIGIN}${path}`);
  expect(sent.init.method).toBe(method);
  expect(sent.init.credentials).toBe("same-origin");
  expect(headersOf(sent)["x-manut-web"]).toBe("1");
  expect(Object.keys(headersOf(sent)).map((name) => name.toLowerCase())).not.toContain("authorization");
  if (body === undefined) expect(sent.init.body).toBeUndefined();
  else expect(JSON.parse(String(sent.init.body))).toEqual(body);
}

describe("the web app's routes", () => {
  it("signs in with exactly the address and the code, and nothing the caller adds", async () => {
    const { api, sent } = client(() => json({ signedIn: true }));
    await api.webSignIn({ email: "fon@baanmali.example", code: "123456", deviceId: "mine", role: "owner" } as never);
    expectWebRequest(sent[0]!, "POST", "/v1/web/sign-in", { email: "fon@baanmali.example", code: "123456" });
  });

  it("rejects a refused code as the exchange's answer, with the tries left", async () => {
    const { api } = client(() => json({ error: "wrong_code", triesLeft: 3 }, 401));
    const refused = await api.webSignIn({ email: "fon@baanmali.example", code: "000000" }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 401, code: "wrong_code", triesLeft: 3 });
  });

  it("reads the shops field by field, signed out as a state with whether signing in is on, and anything else as an error", async () => {
    const shops = [
      { id: "pilot:a", name: "Baan Mali", ownerName: "Fon", role: "owner", you: "owner-1", ready: true, token: "mos1.x.y" },
      { id: "pilot:b", name: "Khao Soi", ownerName: "Lek", role: "helper", you: null, ready: false },
      { id: "pilot:c", name: "Odd", ownerName: "Dao", role: "manager", you: "x", ready: true },
      { id: "pilot:a", name: "Twice", ownerName: "Fon", role: "owner", you: "owner-1", ready: true },
    ];
    const listed = client(() => json({ shops }));
    expect(await listed.api.webShops()).toEqual({ signedIn: true, shops: [
      { id: "pilot:a", name: "Baan Mali", ownerName: "Fon", role: "owner", you: "owner-1", ready: true },
      { id: "pilot:b", name: "Khao Soi", ownerName: "Lek", role: "helper", you: null, ready: false },
    ] });
    expectWebRequest(listed.sent[0]!, "POST", "/v1/web/shops", {});
    expect(await client(() => json({ error: "signed_out", emailSignIn: false }, 401)).api.webShops())
      .toEqual({ signedIn: false, emailSignIn: false });
    expect(await client(() => json({ error: "signed_out", emailSignIn: true }, 401)).api.webShops())
      .toEqual({ signedIn: false, emailSignIn: true });
    await expect(client(() => json({ error: "shops_unavailable" }, 503)).api.webShops()).rejects.toMatchObject({ status: 503, code: "shops_unavailable" });
    await expect(client(() => json({ error: "csrf_required" }, 403)).api.webShops()).rejects.toMatchObject({ status: 403 });
  });

  it("reads a shop's approvals by its name in the query, and passes every answer on as it came", async () => {
    const { api, sent } = client(() => json({ error: "session_ended", shop: "pilot:a/b" }, 401));
    expect(await api.webApprovals("pilot:a/b", "recent")).toEqual({ status: 401, body: { error: "session_ended", shop: "pilot:a/b" } });
    expectWebRequest(sent[0]!, "GET", "/v1/web/approvals?shop=pilot%3Aa%2Fb&state=recent");
  });

  it("decides with exactly the shop, the option and the revision, the request in its own path segment", async () => {
    const { api, sent } = client(() => json({ error: "already_decided", result: { ok: false }, action: "confirmed" }, 409));
    const answer = await api.webDecide({ shop: "pilot:a", requestId: "req/1?x", optionId: "approve", seenRevision: 2, decidedBy: "owner" } as never);
    expect(answer).toEqual({ status: 409, body: { error: "already_decided", result: { ok: false }, action: "confirmed" } });
    expectWebRequest(sent[0]!, "POST", "/v1/web/approvals/req%2F1%3Fx/decision", { shop: "pilot:a", optionId: "approve", seenRevision: 2 });
  });

  it("rejects only no answer, or an answer that is not JSON", async () => {
    const offline = createHttpApi({ origin: ORIGIN, operatorKey: () => null, fetch: async () => Promise.reject(new TypeError("offline")) });
    await expect(offline.webDecide({ shop: "pilot:a", requestId: "r", optionId: "approve", seenRevision: 1 }))
      .rejects.toMatchObject({ status: 0, code: "network" });
    await expect(client(() => new Response("<html>", { status: 502 })).api.webApprovals("pilot:a", "open"))
      .rejects.toMatchObject({ status: 502, code: "bad_response" });
  });

  it("signs out with an empty body", async () => {
    const { api, sent } = client(() => json({ signedOut: true, shopsEnded: 2 }));
    await api.webSignOut();
    expectWebRequest(sent[0]!, "POST", "/v1/web/sign-out", {});
  });

  it("sends cookies with no other route but the operator's, and never the app's header", async () => {
    const { api, sent } = client(() => json({ sent: true, expiresIn: 600, resendIn: 60 }));
    await api.requestEmailCode("fon@baanmali.example");
    await api.getApproval("token-1").catch(() => undefined);
    for (const one of sent) {
      expect(one.init.credentials).toBe("omit");
      expect(headersOf(one)["x-manut-web"]).toBeUndefined();
    }
  });
});
