// Signing the desktop in to apps/api with the sign-in the lifted backend has (/v1/auth/exchange, /refresh, /session),
// keeping the session in the keychain, refreshing it before it expires, and ending it.
import { describe, expect, it } from "vitest";
import { ApiSession, REFRESH_EARLY_MS, type StoredSession } from "./session";
import { clock, fakeApi, memoryVault, ORIGIN, tokens, type FakeApi } from "./testkit";

const IDENTITY = "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJzdWIiOiJvd25lciJ9.c2ln";
const NONCE = "client-nonce-value";

function setup(saved: StoredSession | string | null = null, onEnd?: () => unknown) {
  const api = fakeApi();
  const vault = memoryVault(saved === null ? null : typeof saved === "string" ? saved : JSON.stringify(saved));
  const c = clock();
  let devices = 0;
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, now: c.now, deviceId: () => `device-${++devices}`, onEnd });
  return { api, vault, c, session };
}

/** A session as the keychain holds it after a sign-in at `now`. */
function stored(now: number, over: Partial<StoredSession> = {}): StoredSession {
  return {
    v: 1,
    origin: ORIGIN,
    tenant: "apple:owner-1",
    deviceId: "device-1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessExpiresAt: now + 3600_000,
    signedInAt: now,
    ...over,
  };
}

const kept = (vault: { value: string | null }) => (vault.value ? (JSON.parse(vault.value) as StoredSession) : null);

/** No token is ever part of an address. */
function noTokenInUrls(api: FakeApi) {
  for (const call of api.calls) expect(call.url, call.url).not.toMatch(/access-|refresh-|eyJ/);
}

describe("loading the session", () => {
  it("is signed out with nothing in the keychain", async () => {
    const { session } = setup();
    expect(session.state).toEqual({ kind: "loading" });
    await session.load();
    expect(session.state).toEqual({ kind: "signed_out" });
  });

  it("is signed in with the keychain's session for this origin", async () => {
    const c0 = clock();
    const { session } = setup(stored(c0.now()));
    await session.load();
    expect(session.state).toEqual({ kind: "signed_in", tenant: "apple:owner-1", signedInAt: c0.now() });
  });

  it("never sends another API's session here: a session for another origin reads as signed out", async () => {
    const { session, api } = setup(stored(Date.now(), { origin: "https://staging.manut.xyz" }));
    await session.load();
    expect(session.state).toEqual({ kind: "signed_out" });
    expect(await session.read("/v1/schedules")).toEqual({ kind: "signed_out" });
    expect(api.calls).toEqual([]);
  });

  it("reads an unreadable keychain value as signed out", async () => {
    for (const raw of ["{", "null", '{"v":2}', JSON.stringify({ ...stored(0), accessToken: 5 })]) {
      const { session } = setup(raw);
      await session.load();
      expect(session.state, raw).toEqual({ kind: "signed_out" });
    }
  });

  it("says when this computer's shell has no keychain, and then signs in nowhere", async () => {
    const { session, vault, api } = setup();
    vault.missing = true;
    await session.load();
    expect(session.state).toEqual({ kind: "no_keychain" });
    expect(await session.signIn(IDENTITY, NONCE)).toEqual({ kind: "no_keychain" });
    expect(api.calls).toEqual([]);
  });
});

describe("signing in", () => {
  it("exchanges the identity for a session and keeps it in the keychain, never anywhere else", async () => {
    const { session, api, vault, c } = setup();
    api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    await session.load();
    const seen: string[] = [];
    session.subscribe((s) => seen.push(s.kind));
    expect(await session.signIn(` ${IDENTITY} `, NONCE)).toEqual({ kind: "signed_in", tenant: "apple:owner-1", signedInAt: c.now() });
    expect(seen).toEqual(["signing_in", "signed_in"]);
    expect(api.to("POST", "/v1/auth/exchange")).toEqual([
      expect.objectContaining({ bearer: null, body: { provider: "apple", identityToken: IDENTITY, nonce: NONCE, deviceId: "device-1" } }),
    ]);
    expect(kept(vault)).toEqual({
      v: 2,
      origin: ORIGIN,
      tenant: "apple:owner-1",
      deviceId: "device-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessExpiresAt: c.now() + 3600_000,
      signedInAt: c.now(),
      // a new sign-in holds no shop session yet
      shops: {},
    });
    // the csrf token is for company-console writes, which this read-only runtime never makes: it is not kept
    expect(vault.value).not.toContain("csrf");
    noTokenInUrls(api);
  });

  it("stays signed out and says why when the API refuses", async () => {
    const cases: [Parameters<FakeApi["on"]>[2], string][] = [
      [{ status: 401, json: { error: "invalid_identity" } }, "invalid_identity"],
      [{ status: 400, json: { error: "invalid_request" } }, "invalid_identity"],
      [{ status: 400, json: { error: "identity_not_configured" } }, "not_configured"],
      [{ status: 429, json: { error: "rate_limited" } }, "rate_limited"],
      [{ status: 503, json: { error: "rate_limit_unavailable" } }, "unavailable"],
      [{ status: 500, text: "<html>oops</html>" }, "unavailable"],
      [{ status: 200, json: { accessToken: "a" } }, "unavailable"],
      ["offline", "offline"],
      ["failed", "unavailable"],
    ];
    for (const [answer, failure] of cases) {
      const { session, api, vault } = setup();
      api.on("POST", "/v1/auth/exchange", answer);
      await session.load();
      expect(await session.signIn(IDENTITY, NONCE), failure).toEqual({ kind: "signed_out", failure });
      expect(vault.value).toBeNull();
    }
  });

  it("asks nothing for an empty token or nonce", async () => {
    const { session, api } = setup();
    await session.load();
    expect(await session.signIn("  ", NONCE)).toEqual({ kind: "signed_out", failure: "invalid_identity" });
    expect(await session.signIn(IDENTITY, "")).toEqual({ kind: "signed_out", failure: "invalid_identity" });
    expect(api.calls).toEqual([]);
  });

  it("ends the session already here before a second sign-in, so the first is not left live on the API", async () => {
    const { session, api, vault } = setup(stored(clock().now()));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(2, "apple:owner-2") });
    await session.load();
    expect(await session.signIn(IDENTITY, NONCE)).toMatchObject({ kind: "signed_in", tenant: "apple:owner-2" });
    expect(api.calls.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["DELETE", "/v1/auth/session", "access-1"],
      ["POST", "/v1/auth/exchange", null],
    ]);
    expect(kept(vault)).toMatchObject({ accessToken: "access-2", tenant: "apple:owner-2" });
  });

  it("ends another API's session left in the keychain on its own API before signing in here, and sends it nowhere else", async () => {
    const other = "https://staging.manut.xyz";
    const { session, api, vault } = setup(stored(clock().now(), { origin: other, accessToken: "access-other" }));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    await session.load();
    expect(session.state).toEqual({ kind: "signed_out" });
    expect((await session.signIn(IDENTITY, NONCE)).kind).toBe("signed_in");
    expect(api.calls.map((r) => [r.method, r.url, r.bearer])).toEqual([
      ["DELETE", `${other}/v1/auth/session`, "access-other"],
      ["POST", `${ORIGIN}/v1/auth/exchange`, null],
    ]);
    expect(kept(vault)).toMatchObject({ origin: ORIGIN, accessToken: "access-1" });
  });

  it("ends a new session it cannot keep, so no live token is left behind", async () => {
    const { session, api, vault } = setup();
    api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) }).on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } });
    await session.load();
    vault.refuse = true;
    expect(await session.signIn(IDENTITY, NONCE)).toEqual({ kind: "signed_out", failure: "keychain" });
    expect(api.to("DELETE", "/v1/auth/session")).toEqual([expect.objectContaining({ bearer: "access-1" })]);
  });
});

describe("authorised reads", () => {
  it("sends the access token and reads the JSON answer", async () => {
    const { session, api, c } = setup(stored(clock().now()));
    api.on("GET", "/v1/schedules", { status: 200, json: { schedules: [] } });
    c.pass(10 * 60_000);
    expect(await session.read("/v1/schedules")).toEqual({ kind: "ok", status: 200, json: { schedules: [] } });
    expect(api.calls).toEqual([expect.objectContaining({ method: "GET", url: `${ORIGIN}/v1/schedules`, bearer: "access-1" })]);
  });

  it("refreshes before the access token expires, so an expired token is never sent", async () => {
    // The lifted API deletes the refresh grant when a request carries an expired access token (AuthObject.verify),
    // so sending one would sign the computer out.
    const start = clock().now();
    const { session, api, vault, c } = setup(stored(start));
    api.on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) }).on("GET", "/v1/schedules", { status: 200, json: { schedules: [] } });
    c.pass(3600_000 - REFRESH_EARLY_MS + 1);
    expect((await session.read("/v1/schedules")).kind).toBe("ok");
    expect(api.calls.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["POST", "/v1/auth/refresh", null],
      ["GET", "/v1/schedules", "access-2"],
    ]);
    expect(api.to("POST", "/v1/auth/refresh")[0].body).toEqual({ refreshToken: "refresh-1", deviceId: "device-1" });
    expect(kept(vault)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", accessExpiresAt: c.now() + 3600_000, signedInAt: start });
    noTokenInUrls(api);
  });

  it("on a 401 refreshes once and tries again once", async () => {
    const { session, api } = setup(stored(clock().now()));
    api
      .on("GET", "/v1/schedules", { status: 401, json: { error: "unauthorized" } }, { status: 200, json: { schedules: [{ id: "s1" }] } })
      .on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    expect(await session.read("/v1/schedules")).toEqual({ kind: "ok", status: 200, json: { schedules: [{ id: "s1" }] } });
    expect(api.calls.map((r) => [r.path, r.bearer])).toEqual([
      ["/v1/schedules", "access-1"],
      ["/v1/auth/refresh", null],
      ["/v1/schedules", "access-2"],
    ]);
  });

  it("refreshes once for requests that fail together, so one rotation does not undo the other", async () => {
    const { session, api } = setup(stored(clock().now()));
    api
      .on("GET", "/v1/schedules", (r) => (r.bearer === "access-1" ? { status: 401, json: {} } : { status: 200, json: { schedules: [] } }))
      .on("GET", "/v1/inbound/attention", (r) => (r.bearer === "access-1" ? { status: 401, json: {} } : { status: 200, json: { items: [] } }))
      .on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) }, { status: 401, json: { error: "invalid_grant" } });
    const [a, b] = await Promise.all([session.read("/v1/schedules"), session.read("/v1/inbound/attention")]);
    expect([a.kind, b.kind]).toEqual(["ok", "ok"]);
    expect(api.to("POST", "/v1/auth/refresh")).toHaveLength(1);
  });

  it("signs out when the API ends the session, and forgets the tokens", async () => {
    for (const error of ["invalid_grant", "session_expired"]) {
      const { session, api, vault } = setup(stored(clock().now()));
      api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 401, json: { error } });
      expect(await session.read("/v1/schedules"), error).toEqual({ kind: "signed_out" });
      expect(session.state).toEqual({ kind: "signed_out", ended: "expired" });
      expect(vault.value).toBeNull();
    }
  });

  it("signs out when the token is refused again right after a refresh", async () => {
    const { session, api, vault } = setup(stored(clock().now()));
    api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    expect(await session.read("/v1/schedules")).toEqual({ kind: "signed_out" });
    expect(api.to("GET", "/v1/schedules")).toHaveLength(2);
    expect(vault.value).toBeNull();
  });

  it("keeps the session when a refresh cannot reach the API, and sends nothing with the old token", async () => {
    const start = clock().now();
    const { session, api, vault, c } = setup(stored(start));
    api.on("POST", "/v1/auth/refresh", "offline").on("GET", "/v1/schedules", { status: 200, json: {} });
    c.pass(3600_000);
    expect(await session.read("/v1/schedules")).toEqual({ kind: "offline" });
    expect(api.to("GET", "/v1/schedules")).toEqual([]);
    expect(kept(vault)?.refreshToken).toBe("refresh-1");
    expect(session.state.kind).toBe("signed_in");
  });

  it("says offline, unavailable or refused for what came back", async () => {
    const { session, api } = setup(stored(clock().now()));
    api
      .on("GET", "/v1/a", "offline")
      .on("GET", "/v1/b", { status: 502, text: "bad gateway" })
      .on("GET", "/v1/c", { status: 403, json: { error: "feature_disabled", feature: "officeInbound" } })
      .on("GET", "/v1/d", { status: 200, text: "not json" })
      .on("GET", "/v1/e", "failed")
      .on("GET", "/v1/f", { status: 404, text: "" });
    expect(await session.read("/v1/a")).toEqual({ kind: "offline" });
    expect(await session.read("/v1/b")).toEqual({ kind: "unavailable", status: 502 });
    expect(await session.read("/v1/c")).toEqual({ kind: "refused", status: 403, code: "feature_disabled", json: { error: "feature_disabled", feature: "officeInbound" } });
    expect(await session.read("/v1/d")).toEqual({ kind: "unavailable", status: 200 });
    expect(await session.read("/v1/e")).toEqual({ kind: "unavailable" });
    expect(await session.read("/v1/f")).toEqual({ kind: "refused", status: 404, code: "", json: null });
  });

  it("reads nothing while signed out", async () => {
    const { session, api } = setup();
    expect(await session.read("/v1/schedules")).toEqual({ kind: "signed_out" });
    expect(api.calls).toEqual([]);
  });

  it("ends the session at once for a helper the owner removed: no refresh can bring that back", async () => {
    let ended = 0;
    const { session, api, vault } = setup(stored(clock().now()), () => (ended += 1));
    const removed = { error: "removed", removedAt: "2026-11-22T14:05:00.000Z" };
    api.on("GET", "/v1/approvals", { status: 401, json: removed });
    expect(await session.read("/v1/approvals?state=open")).toEqual({ kind: "refused", status: 401, code: "removed", json: removed });
    expect(api.to("POST", "/v1/auth/refresh")).toEqual([]);
    expect(session.state).toEqual({ kind: "signed_out", ended: "expired" });
    expect(vault.value).toBeNull();
    expect(ended).toBe(1);
  });
});

describe("authorised writes", () => {
  const PATH = "/v1/approvals/action-1/decision";
  const BODY = { optionId: "approve", seenRevision: 1 };

  it("sends the body as JSON with the access token, apart from the address, and reads the JSON answer", async () => {
    const { session, api } = setup(stored(clock().now()));
    api.on("POST", PATH, { status: 200, json: { result: { ok: true }, action: "confirmed" } });
    expect(await session.write(PATH, BODY)).toEqual({ kind: "ok", status: 200, json: { result: { ok: true }, action: "confirmed" } });
    expect(api.calls).toEqual([expect.objectContaining({ method: "POST", url: `${ORIGIN}${PATH}`, bearer: "access-1", body: BODY })]);
    noTokenInUrls(api);
  });

  it("refreshes before the access token expires, so an expired token is never sent", async () => {
    const start = clock().now();
    const { session, api, c } = setup(stored(start));
    api.on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) }).on("POST", PATH, { status: 200, json: { result: { ok: true } } });
    c.pass(3600_000 - REFRESH_EARLY_MS + 1);
    expect((await session.write(PATH, BODY)).kind).toBe("ok");
    expect(api.calls.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["POST", "/v1/auth/refresh", null],
      ["POST", PATH, "access-2"],
    ]);
  });

  it("on a 401 refreshes once and sends the same body once more, never a third time", async () => {
    // A 401 is the API refusing the session before it reads the body, so nothing was decided by the first one.
    const { session, api, vault } = setup(stored(clock().now()));
    api.on("POST", PATH, { status: 401, json: { error: "unauthorized" } }).on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    expect(await session.write(PATH, BODY)).toEqual({ kind: "signed_out" });
    expect(api.calls.map((r) => [r.path, r.bearer, r.body])).toEqual([
      [PATH, "access-1", BODY],
      ["/v1/auth/refresh", null, { refreshToken: "refresh-1", deviceId: "device-1" }],
      [PATH, "access-2", BODY],
    ]);
    expect(vault.value).toBeNull();
  });

  it("ends the session at once for a removed helper, and keeps the API's answer so the card can say when", async () => {
    const { session, api, vault } = setup(stored(clock().now()));
    const removed = { error: "removed", removedAt: "2026-11-22T14:05:00.000Z" };
    api.on("POST", PATH, { status: 401, json: removed });
    expect(await session.write(PATH, BODY)).toEqual({ kind: "refused", status: 401, code: "removed", json: removed });
    expect(api.to("POST", PATH)).toHaveLength(1);
    expect(api.to("POST", "/v1/auth/refresh")).toEqual([]);
    expect(session.state).toEqual({ kind: "signed_out", ended: "expired" });
    expect(vault.value).toBeNull();
  });

  it("sends it once when no answer comes back: the API may have it, so it is never sent again on its own", async () => {
    const { session, api } = setup(stored(clock().now()));
    api.on("POST", PATH, "offline");
    expect(await session.write(PATH, BODY)).toEqual({ kind: "offline" });
    api.on("POST", PATH, { status: 503, json: { error: "approvals_unavailable" } });
    expect(await session.write(PATH, BODY)).toEqual({ kind: "unavailable", status: 503 });
    expect(api.to("POST", PATH)).toHaveLength(2);
  });

  it("writes nothing while signed out", async () => {
    const { session, api } = setup();
    expect(await session.write(PATH, BODY)).toEqual({ kind: "signed_out" });
    expect(api.calls).toEqual([]);
  });
});

describe("signing out", () => {
  it("ends the session on the API, then forgets it here", async () => {
    const { session, api, vault } = setup(stored(clock().now()));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } });
    expect(await session.signOut()).toEqual({ revoked: true });
    expect(api.calls).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/auth/session", bearer: "access-1" })]);
    expect(vault.value).toBeNull();
    expect(session.state).toEqual({ kind: "signed_out" });
    expect(await session.read("/v1/schedules")).toEqual({ kind: "signed_out" });
  });

  it("forgets the session here even when the API cannot be told", async () => {
    for (const answer of ["offline", { status: 500, json: {} }, { status: 401, json: { error: "invalid_session" } }] as const) {
      const { session, api, vault } = setup(stored(clock().now()));
      api.on("DELETE", "/v1/auth/session", answer);
      expect((await session.signOut()).revoked).toBe(false);
      expect(vault.value).toBeNull();
      expect(session.state).toEqual({ kind: "signed_out" });
    }
  });

  it("asks nothing when there is no session", async () => {
    const { session, api } = setup();
    expect(await session.signOut()).toEqual({ revoked: false });
    expect(api.calls).toEqual([]);
  });
});

describe("telling what was read with a session that it is over", () => {
  /** A session whose hook records, in order with the requests it makes to the API, when it was called. */
  function hooked(saved: StoredSession | null) {
    const api = fakeApi();
    const vault = memoryVault(saved === null ? null : JSON.stringify(saved));
    const c = clock();
    const log: string[] = [];
    let devices = 0;
    const session = new ApiSession({
      origin: ORIGIN,
      vault,
      now: c.now,
      deviceId: () => `device-${++devices}`,
      fetch: (url, init) => {
        log.push(`${init.method} ${new URL(url).pathname}`);
        return api.fetch(url, init);
      },
      onEnd: () => void log.push("ended"),
    });
    return { api, vault, c, session, log };
  }

  it("is called when the person signs out, before the API is asked and whatever the API answers", async () => {
    for (const answer of [{ status: 200, json: { revoked: true } }, "offline"] as const) {
      const { session, api, log } = hooked(stored(clock().now()));
      api.on("DELETE", "/v1/auth/session", answer);
      await session.signOut();
      expect(log).toEqual(["ended", "DELETE /v1/auth/session"]);
    }
  });

  it("is called when the API ends the session, a refresh refused or a token refused twice", async () => {
    const refused = hooked(stored(clock().now()));
    refused.api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 401, json: { error: "session_expired" } });
    await refused.session.read("/v1/schedules");
    expect(refused.log.filter((x) => x === "ended")).toHaveLength(1);
    const twice = hooked(stored(clock().now()));
    twice.api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) });
    await twice.session.read("/v1/schedules");
    expect(twice.log.filter((x) => x === "ended")).toHaveLength(1);
  });

  it("is called when a new sign-in replaces this origin's session, and before the new one is made", async () => {
    const { session, api, log } = hooked(stored(clock().now()));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(2, "apple:owner-2") });
    await session.load();
    await session.signIn(IDENTITY, NONCE);
    expect(log).toEqual(["ended", "DELETE /v1/auth/session", "POST /v1/auth/exchange"]);
  });

  it("is called when a new sign-in replaces another API's session left in the keychain", async () => {
    const { session, api, log } = hooked(stored(clock().now(), { origin: "https://staging.manut.xyz" }));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    await session.load();
    await session.signIn(IDENTITY, NONCE);
    expect(log).toEqual(["ended", "DELETE /v1/auth/session", "POST /v1/auth/exchange"]);
  });

  it("is called by a sign-out with no session held, which still forgets a read an earlier session left", async () => {
    const { session, log } = hooked(null);
    await session.signOut();
    expect(log).toEqual(["ended"]);
  });

  it("is not called by a sign-in that fails, or by a read that works", async () => {
    const { session, api, log } = hooked(null);
    api.on("POST", "/v1/auth/exchange", { status: 401, json: { error: "invalid_identity" } });
    await session.load();
    await session.signIn(IDENTITY, NONCE);
    expect(log).toEqual(["POST /v1/auth/exchange"]);
    const live = hooked(stored(clock().now()));
    live.api.on("GET", "/v1/schedules", { status: 200, json: {} });
    await live.session.read("/v1/schedules");
    expect(live.log).toEqual(["GET /v1/schedules"]);
  });

  it("never lets a hook that throws, or that rejects, stop a sign-out", async () => {
    const { session, api, vault } = setup(stored(clock().now()), () => {
      throw new Error("disk");
    });
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } });
    expect(await session.signOut()).toEqual({ revoked: true });
    expect(vault.value).toBeNull();
    const rejecting = setup(stored(clock().now()), () => Promise.reject(new Error("disk")));
    rejecting.api.on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    expect((await rejecting.session.signOut()).revoked).toBe(true);
    expect(rejecting.vault.value).toBeNull();
  });
});

describe("the shop sessions kept with the sign-in (docs/several-shops.md)", () => {
  /** Plainly fake shop tokens: a real one is `mos1.` or `mhs1.`, the shop in base64url, and 64 hex digits. */
  const OWNER_TOKEN = "mos1.fake-shop-a.not-a-real-secret";
  const HELPER_TOKEN = "mhs1.fake-shop-b.not-a-real-secret";
  const held = (now: number) => ({
    "pilot:shop-a": { role: "owner" as const, accessToken: OWNER_TOKEN, expiresAt: now + 30 * 86_400_000 },
    "pilot:shop-b": { role: "helper" as const, accessToken: HELPER_TOKEN, expiresAt: now + 30 * 86_400_000 },
  });
  const withShops = (now: number) => stored(now, { v: 2, shops: held(now) });

  it("reads today's value, which keeps none, as a sign-in with no shop session, and writes nothing for it", async () => {
    const { session, vault } = setup(stored(clock().now()));
    const before = vault.value;
    await session.load();
    expect(session.state.kind).toBe("signed_in");
    expect(session.heldShops()).toEqual([]);
    expect(vault.value).toBe(before);
  });

  it("reads each shop session the value keeps, and leaves out one that is not whole rather than signing out", async () => {
    const now = clock().now();
    const broken = { ...held(now), "pilot:shop-c": { role: "boss", accessToken: "x", expiresAt: 1 }, "pilot:shop-d": { role: "owner", accessToken: 5, expiresAt: 1 } };
    const { session } = setup(stored(now, { v: 2, shops: broken as never }));
    await session.load();
    expect(session.state.kind).toBe("signed_in");
    expect(session.heldShops()).toEqual(["pilot:shop-a", "pilot:shop-b"]);
    expect(session.shopSession("pilot:shop-b")).toEqual(held(now)["pilot:shop-b"]);
    expect(session.shopSession("pilot:shop-c")).toBeNull();
  });

  it("keeps a shop session in the one keychain item, beside the sign-in, and drops it again", async () => {
    const now = clock().now();
    const { session, vault } = setup(stored(now));
    await session.load();
    expect(await session.keepShopSession("pilot:shop-a", held(now)["pilot:shop-a"], session.signInChain)).toBe(true);
    expect(kept(vault)).toEqual({ ...stored(now), v: 2, shops: { "pilot:shop-a": held(now)["pilot:shop-a"] } });
    await session.dropShopSessions(["pilot:shop-a", "pilot:not-held"]);
    expect(kept(vault)).toEqual({ ...stored(now), v: 2, shops: {} });
  });

  it("writes the item one change at a time, and a refresh keeps the shop session kept while it was on its way", async () => {
    const now = clock().now();
    const { session, vault, api, c } = setup(stored(now));
    // A keychain that takes a moment per write, and notes how many writes ran at once.
    let running = 0;
    let most = 0;
    const write = vault.write.bind(vault);
    vault.write = async (v: string) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      await write(v);
      running -= 1;
    };
    let answer!: () => void;
    const held_ = new Promise<void>((r) => (answer = r));
    api.on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2) }).on("GET", "/v1/schedules", { status: 200, json: {} });
    const fetch = api.fetch;
    // the refresh's answer waits until the shop session has been kept
    (session as unknown as { fetch: typeof fetch }).fetch = async (url, init) => {
      if (url.endsWith("/v1/auth/refresh")) await held_;
      return fetch(url, init);
    };
    await session.load();
    c.pass(3600_000);
    const read = session.read("/v1/schedules");
    await session.keepShopSession("pilot:shop-a", held(now)["pilot:shop-a"], session.signInChain);
    answer();
    expect((await read).kind).toBe("ok");
    await session.keepShopSession("pilot:shop-b", held(now)["pilot:shop-b"], session.signInChain);
    expect(most).toBe(1);
    expect(kept(vault)).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", shops: held(now) });
  });

  it("does not keep a shop session opened under a sign-in that ended meanwhile: it is ended on the API instead", async () => {
    const now = clock().now();
    const { session, vault, api } = setup(stored(now));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: {} }).on("POST", "/v1/shops/session/end", { status: 200, json: { ended: {} } });
    await session.load();
    const chain = session.signInChain;
    await session.signOut();
    expect(await session.keepShopSession("pilot:shop-a", held(now)["pilot:shop-a"], chain)).toBe(false);
    await Promise.resolve();
    expect(vault.value).toBeNull();
    expect(api.to("POST", "/v1/shops/session/end")).toEqual([expect.objectContaining({ bearer: OWNER_TOKEN, body: {} })]);
  });

  it("signing out ends every shop session with itself as the bearer and exactly {}, then forgets them all", async () => {
    const now = clock().now();
    const { session, vault, api } = setup(withShops(now));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/shops/session/end", { status: 200, json: { ended: {} } });
    expect(await session.signOut()).toEqual({ revoked: true });
    expect(api.calls.map((r) => [r.method, r.path, r.bearer, r.body])).toEqual([
      ["DELETE", "/v1/auth/session", "access-1", undefined],
      ["POST", "/v1/shops/session/end", OWNER_TOKEN, {}],
      ["POST", "/v1/shops/session/end", HELPER_TOKEN, {}],
    ]);
    expect(vault.value).toBeNull();
    expect(session.heldShops()).toEqual([]);
    expect(session.shopSession("pilot:shop-a")).toBeNull();
    for (const call of api.calls) expect(call.url, call.url).not.toMatch(/mos1|mhs1|access-/);
  });

  it("a sign-out that cannot reach the API still clears this computer, and says the API was not told", async () => {
    const now = clock().now();
    for (const [del, end] of [["offline", "offline"], [{ status: 200, json: {} }, "offline"], [{ status: 200, json: {} }, { status: 503, json: { error: "people_unavailable" } }]] as const) {
      const { session, vault, api } = setup(withShops(now));
      api.on("DELETE", "/v1/auth/session", del).on("POST", "/v1/shops/session/end", end);
      expect(await session.signOut()).toEqual({ revoked: false });
      expect(vault.value).toBeNull();
      expect(session.heldShops()).toEqual([]);
    }
    // A session the API already ended (a removal, an unlinking) is over there: it counts as told.
    const { session, api } = setup(withShops(now));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: {} }).on("POST", "/v1/shops/session/end", { status: 401, json: { error: "removed", removedAt: "2026-11-22T10:00:00.000Z" } });
    expect(await session.signOut()).toEqual({ revoked: true });
  });

  it("ends the shop sessions too when the API ends the sign-in, and before a new sign-in", async () => {
    const now = clock().now();
    const ended = setup(withShops(now));
    ended.api
      .on("GET", "/v1/schedules", { status: 401, json: {} })
      .on("POST", "/v1/auth/refresh", { status: 401, json: { error: "session_expired" } })
      .on("POST", "/v1/shops/session/end", { status: 200, json: {} });
    expect(await ended.session.read("/v1/schedules")).toEqual({ kind: "signed_out" });
    await Promise.resolve();
    expect(ended.api.to("POST", "/v1/shops/session/end").map((r) => r.bearer)).toEqual([OWNER_TOKEN, HELPER_TOKEN]);
    expect(ended.vault.value).toBeNull();

    const again = setup(withShops(now));
    again.api
      .on("DELETE", "/v1/auth/session", { status: 200, json: {} })
      .on("POST", "/v1/shops/session/end", { status: 200, json: {} })
      .on("POST", "/v1/auth/exchange", { status: 200, json: tokens(2, "apple:owner-2") });
    await again.session.load();
    await again.session.signIn(IDENTITY, NONCE);
    expect(again.api.calls.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["DELETE", "/v1/auth/session", "access-1"],
      ["POST", "/v1/shops/session/end", OWNER_TOKEN],
      ["POST", "/v1/shops/session/end", HELPER_TOKEN],
      ["POST", "/v1/auth/exchange", null],
    ]);
    expect(kept(again.vault)).toMatchObject({ accessToken: "access-2", shops: {} });
  });

  it("ends another API's shop sessions on that API before a sign-in here", async () => {
    const other = "https://staging.manut.xyz";
    const { session, api } = setup(stored(clock().now(), { origin: other, accessToken: "access-other", v: 2, shops: held(clock().now()) }));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: {} }).on("POST", "/v1/shops/session/end", { status: 200, json: {} }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    await session.load();
    expect(session.heldShops()).toEqual([]);
    await session.signIn(IDENTITY, NONCE);
    expect(api.calls.map((r) => [r.method, r.url, r.bearer])).toEqual([
      ["DELETE", `${other}/v1/auth/session`, "access-other"],
      ["POST", `${other}/v1/shops/session/end`, OWNER_TOKEN],
      ["POST", `${other}/v1/shops/session/end`, HELPER_TOKEN],
      ["POST", `${ORIGIN}/v1/auth/exchange`, null],
    ]);
  });

  it("sends a shop session's token only as the bearer, to its own origin, and reads its 401 as the API said it", async () => {
    const { session, api } = setup(withShops(clock().now()));
    api.on("GET", "/v1/approvals", { status: 401, json: { error: "unlinked", unlinkedAt: "2026-11-22T10:00:00.000Z" } });
    await session.load();
    expect(await session.sendAs(OWNER_TOKEN, "GET", "/v1/approvals?state=open")).toEqual({
      kind: "refused",
      status: 401,
      code: "unlinked",
      json: { error: "unlinked", unlinkedAt: "2026-11-22T10:00:00.000Z" },
    });
    expect(api.calls).toEqual([expect.objectContaining({ url: `${ORIGIN}/v1/approvals?state=open`, bearer: OWNER_TOKEN })]);
    // nothing about the sign-in moved: a shop session's 401 is not the sign-in's
    expect(session.state.kind).toBe("signed_in");
    expect(api.to("POST", "/v1/auth/refresh")).toEqual([]);
  });
});
