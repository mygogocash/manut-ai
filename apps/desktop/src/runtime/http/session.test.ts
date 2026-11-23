// Signing the desktop in to apps/api with the sign-in the lifted backend has (/v1/auth/exchange, /refresh, /session),
// keeping the session in the keychain, refreshing it before it expires, and ending it.
import { describe, expect, it } from "vitest";
import { ApiSession, REFRESH_EARLY_MS, type StoredSession } from "./session";
import { clock, fakeApi, memoryVault, ORIGIN, tokens, type FakeApi } from "./testkit";

const IDENTITY = "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJzdWIiOiJvd25lciJ9.c2ln";
const NONCE = "client-nonce-value";

function setup(saved: StoredSession | string | null = null) {
  const api = fakeApi();
  const vault = memoryVault(saved === null ? null : typeof saved === "string" ? saved : JSON.stringify(saved));
  const c = clock();
  let devices = 0;
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, now: c.now, deviceId: () => `device-${++devices}` });
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
      v: 1,
      origin: ORIGIN,
      tenant: "apple:owner-1",
      deviceId: "device-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessExpiresAt: c.now() + 3600_000,
      signedInAt: c.now(),
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
