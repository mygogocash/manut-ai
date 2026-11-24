// Signing in by a code sent by email (docs/pilot-api.md, "Signing in by email"): `ApiSession.requestCode` asks the API for
// a code, and `signInWithCode` gives it back to `/v1/auth/exchange`. The session that comes back is Apple's in every way,
// so what is checked here beside each answer is that it is kept in the one keychain item, in the same shape, and
// refreshed, ended and given shop sessions as Apple's is; and that the code, and the address it was asked for, are
// never kept, logged, put in an address or carried in an answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiSession, normalizeEmail, REFRESH_EARLY_MS, type CodeAsk, type CodeTry, type StoredSession } from "./session";
import { clock, fakeApi, memoryVault, ORIGIN, tokens, type FakeApi } from "./testkit";

const ADDRESS = "fon@example.com";
const CODE = "482915";
/** The tenant the API makes of an address: `email:` and the SHA-256 of it in hex, so it never names the address. */
const TENANT = `email:${"ab".repeat(32)}`;
const IDENTITY = "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJzdWIiOiJvd25lciJ9.c2ln";
const NONCE = "client-nonce-value";

function setup(saved: StoredSession | null = null) {
  const api = fakeApi();
  const vault = memoryVault(saved === null ? null : JSON.stringify(saved));
  const c = clock();
  let devices = 0;
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, now: c.now, deviceId: () => `device-${++devices}` });
  return { api, vault, c, session };
}

/** An Apple session as the keychain holds it after a sign-in at `now`. */
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
const SENT = { sent: true, expiresIn: 600, resendIn: 60 };

/** Neither the code nor the address is in an address, in what the keychain holds, in an answer, or in what was logged. */
function neverKept(api: FakeApi, vault: { value: string | null }, ...answers: unknown[]) {
  for (const call of api.calls) {
    expect(call.url, call.url).not.toContain(CODE);
    expect(call.url, call.url).not.toContain(ADDRESS);
    expect(call.url, call.url).not.toContain(encodeURIComponent(ADDRESS));
    // the address and the code go in a request body only, never in a header
    expect(call.bearer ?? "").not.toContain(CODE);
  }
  if (vault.value) {
    expect(vault.value).not.toContain(CODE);
    expect(vault.value).not.toContain(ADDRESS);
  }
  for (const answer of answers) {
    expect(JSON.stringify(answer)).not.toContain(CODE);
    expect(JSON.stringify(answer)).not.toContain(ADDRESS);
  }
}

describe("the address as the API takes it", () => {
  it("trims it and lower-cases it, as the API's own rule does", () => {
    expect(normalizeEmail("  Fon@Example.COM ")).toBe("fon@example.com");
  });

  it("refuses what the API refuses: no @, two, a space inside, nothing before or after the @, more than 254 characters", () => {
    for (const bad of ["", "   ", "fon", "fon@", "@example.com", "fon@@example.com", "a@b@c", "fon smith@example.com", "fon@exam ple.com"]) {
      expect(normalizeEmail(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(normalizeEmail(`${"a".repeat(249)}@b.co`)).toBe(`${"a".repeat(249)}@b.co`); // 249 and the five of "@b.co": exactly 254
    expect(normalizeEmail(`${"a".repeat(250)}@b.co`)).toBeNull(); // 255
  });
});

describe("asking for a code", () => {
  it("posts exactly { email } to the code route with no bearer, and reads the code's life and the wait before another", async () => {
    const { session, api, vault } = setup();
    api.on("POST", "/v1/auth/email/code", { status: 200, json: SENT });
    await session.load();
    const answer = await session.requestCode(`  ${ADDRESS.toUpperCase()} `);
    expect(answer).toEqual({ kind: "sent", expiresIn: 600, resendIn: 60 });
    // the address goes as the API reads it, and nothing else goes with it
    expect(api.calls).toEqual([expect.objectContaining({ method: "POST", url: `${ORIGIN}/v1/auth/email/code`, bearer: null, body: { email: ADDRESS } })]);
    // nobody is signed in by asking: no state moves, nothing is kept
    expect(session.state).toEqual({ kind: "signed_out" });
    expect(vault.value).toBeNull();
    neverKept(api, vault, answer);
  });

  it("reads the wait the API asks when this address has had too many codes", async () => {
    const { session, api } = setup();
    api.on("POST", "/v1/auth/email/code", { status: 429, json: { error: "too_many_codes", retryAfter: 41 } });
    expect(await session.requestCode(ADDRESS)).toEqual({ kind: "wait", retryAfter: 41 });
    // ten in a day can ask for most of a day
    const day = setup();
    day.api.on("POST", "/v1/auth/email/code", { status: 429, json: { error: "too_many_codes", retryAfter: 86_399 } });
    expect(await day.session.requestCode(ADDRESS)).toEqual({ kind: "wait", retryAfter: 86_399 });
  });

  it("says why when the API refuses, in the screen's few kinds", async () => {
    const cases: [Parameters<FakeApi["on"]>[2], CodeAsk][] = [
      [{ status: 400, json: { error: "email_not_configured" } }, { kind: "failed", failure: "not_configured" }],
      [{ status: 400, json: { error: "invalid_request" } }, { kind: "failed", failure: "invalid_request" }],
      // the route's own limit on how often one computer asks, which names no seconds
      [{ status: 429, json: { error: "rate_limited" } }, { kind: "failed", failure: "rate_limited" }],
      [{ status: 503, json: { error: "rate_limit_unavailable" } }, { kind: "failed", failure: "unavailable" }],
      [{ status: 411, json: { error: "length_required" } }, { kind: "failed", failure: "unavailable" }],
      [{ status: 413, json: { error: "body_too_large" } }, { kind: "failed", failure: "unavailable" }],
      [{ status: 500, text: "<html>oops</html>" }, { kind: "failed", failure: "unavailable" }],
      ["offline", { kind: "failed", failure: "offline" }],
      ["failed", { kind: "failed", failure: "unavailable" }],
    ];
    for (const [answer, expected] of cases) {
      const { session, api } = setup();
      api.on("POST", "/v1/auth/email/code", answer);
      expect(await session.requestCode(ADDRESS), JSON.stringify(answer)).toEqual(expected);
    }
  });

  it("reads an answer field by field: one it cannot read is a plain failure, never a guess", async () => {
    const bad: Parameters<FakeApi["on"]>[2][] = [
      { status: 200, json: {} },
      { status: 200, json: { sent: true } },
      { status: 200, json: { sent: true, expiresIn: 600 } },
      { status: 200, json: { sent: true, resendIn: 60 } },
      { status: 200, json: { sent: false, expiresIn: 600, resendIn: 60 } },
      { status: 200, json: { sent: "true", expiresIn: 600, resendIn: 60 } },
      { status: 200, json: { sent: true, expiresIn: "600", resendIn: 60 } },
      { status: 200, json: { sent: true, expiresIn: 600, resendIn: -1 } },
      { status: 200, json: { sent: true, expiresIn: 0, resendIn: 60 } },
      { status: 200, json: { sent: true, expiresIn: 600, resendIn: 86_401 } },
      { status: 200, json: { sent: true, expiresIn: null, resendIn: 60 } },
      { status: 200, json: [SENT] },
      { status: 200, text: "ok" },
      { status: 200, text: "" },
      // a refusal for too many codes without a wait it can read says nothing it can use
      { status: 429, json: { error: "too_many_codes" } },
      { status: 429, json: { error: "too_many_codes", retryAfter: "41" } },
      { status: 429, json: { error: "too_many_codes", retryAfter: 0 } },
      { status: 429, json: { error: "too_many_codes", retryAfter: 86_401 } },
      { status: 429, json: { error: "something_else" } },
      { status: 429, text: "slow down" },
      { status: 400, json: { error: "something_else" } },
      { status: 400, text: "bad" },
    ];
    for (const answer of bad) {
      const { session, api } = setup();
      api.on("POST", "/v1/auth/email/code", answer);
      expect(await session.requestCode(ADDRESS), JSON.stringify(answer)).toEqual({ kind: "failed", failure: "unavailable" });
    }
  });

  it("asks nothing for what is not an address: the API would refuse it, and it would cost a request", async () => {
    const { session, api } = setup();
    for (const bad of ["", "   ", "fon", "fon@", "a b@c.d"]) {
      expect(await session.requestCode(bad), JSON.stringify(bad)).toEqual({ kind: "failed", failure: "invalid_request" });
    }
    expect(api.calls).toEqual([]);
  });

  it("asks nothing on a computer that cannot keep a session, since a code sent there could not be used", async () => {
    const { session, api, vault } = setup();
    vault.missing = true;
    expect(await session.requestCode(ADDRESS)).toEqual({ kind: "failed", failure: "no_keychain" });
    expect(api.calls).toEqual([]);
  });

  it("can ask while a keychain that refuses to be read is still a keychain: the answer is the API's", async () => {
    const { session, api, vault } = setup();
    vault.refuse = true;
    api.on("POST", "/v1/auth/email/code", { status: 200, json: SENT });
    expect(await session.requestCode(ADDRESS)).toEqual({ kind: "sent", expiresIn: 600, resendIn: 60 });
  });
});

describe("signing in with a code", () => {
  it("posts exactly { provider, email, code, deviceId } and keeps the session in the one keychain item, in Apple's shape", async () => {
    const { session, api, vault, c } = setup();
    api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1, TENANT) });
    await session.load();
    const seen: string[] = [];
    session.subscribe((s) => seen.push(s.kind));
    const answer = await session.signInWithCode(`  ${ADDRESS.toUpperCase()} `, ` ${CODE} `);
    expect(answer).toEqual({ kind: "signed_in", tenant: TENANT, signedInAt: c.now() });
    expect(seen).toEqual(["signing_in", "signed_in"]);
    expect(session.state).toEqual({ kind: "signed_in", tenant: TENANT, signedInAt: c.now() });
    expect(api.to("POST", "/v1/auth/exchange")).toEqual([
      expect.objectContaining({ bearer: null, body: { provider: "email", email: ADDRESS, code: CODE, deviceId: "device-1" } }),
    ]);
    // exactly what an Apple sign-in writes (session.test.ts): version 2, this origin, the tenant, the pair, no shop session yet
    expect(kept(vault)).toEqual({
      v: 2,
      origin: ORIGIN,
      tenant: TENANT,
      deviceId: "device-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessExpiresAt: c.now() + 3600_000,
      signedInAt: c.now(),
      shops: {},
    });
    expect(vault.value).not.toContain("csrf");
    expect(session.signedInTenant).toBe(TENANT);
    neverKept(api, vault, answer, session.state);
  });

  it("says a wrong code is wrong, with the tries it has left, and stays signed out", async () => {
    for (const left of [4, 3, 1, 0]) {
      const { session, api, vault } = setup();
      api.on("POST", "/v1/auth/exchange", { status: 401, json: { error: "wrong_code", triesLeft: left } });
      expect(await session.signInWithCode(ADDRESS, CODE)).toEqual({ kind: "wrong_code", triesLeft: left });
      expect(session.state).toEqual({ kind: "signed_out" });
      expect(vault.value).toBeNull();
    }
  });

  it("says when the code has ended: none was asked for, it was used, ten minutes passed, or five wrong tries ended it", async () => {
    const { session, api, vault } = setup();
    api.on("POST", "/v1/auth/exchange", { status: 401, json: { error: "code_ended" } });
    expect(await session.signInWithCode(ADDRESS, CODE)).toEqual({ kind: "code_ended" });
    expect(session.state).toEqual({ kind: "signed_out" });
    expect(vault.value).toBeNull();
  });

  it("says why when the API refuses in any other way", async () => {
    const cases: [Parameters<FakeApi["on"]>[2], CodeTry][] = [
      [{ status: 400, json: { error: "email_not_configured" } }, { kind: "failed", failure: "not_configured" }],
      [{ status: 400, json: { error: "invalid_request" } }, { kind: "failed", failure: "invalid_request" }],
      [{ status: 429, json: { error: "rate_limited" } }, { kind: "failed", failure: "rate_limited" }],
      [{ status: 503, json: { error: "rate_limit_unavailable" } }, { kind: "failed", failure: "unavailable" }],
      [{ status: 500, text: "<html>oops</html>" }, { kind: "failed", failure: "unavailable" }],
      [{ status: 401, json: { error: "unauthorized" } }, { kind: "failed", failure: "unavailable" }],
      [{ status: 400, json: { error: "identity_not_configured" } }, { kind: "failed", failure: "unavailable" }],
      ["offline", { kind: "failed", failure: "offline" }],
      ["failed", { kind: "failed", failure: "unavailable" }],
    ];
    for (const [answer, expected] of cases) {
      const { session, api, vault } = setup();
      api.on("POST", "/v1/auth/exchange", answer);
      await session.load();
      expect(await session.signInWithCode(ADDRESS, CODE), JSON.stringify(answer)).toEqual(expected);
      expect(session.state).toEqual({ kind: "signed_out" });
      expect(vault.value).toBeNull();
    }
  });

  it("reads an answer field by field: one it cannot read is a plain failure, never a guess", async () => {
    const bad: Parameters<FakeApi["on"]>[2][] = [
      { status: 200, json: { accessToken: "a" } },
      { status: 200, json: { accessToken: "a", refreshToken: "r", tenant: TENANT } },
      { status: 200, json: { ...tokens(1, TENANT), expiresIn: 0 } },
      { status: 200, text: "ok" },
      // a wrong code that does not say how many tries are left is not one this build can read
      { status: 401, json: { error: "wrong_code" } },
      { status: 401, json: { error: "wrong_code", triesLeft: "4" } },
      { status: 401, json: { error: "wrong_code", triesLeft: -1 } },
      { status: 401, json: { error: "wrong_code", triesLeft: 2.5 } },
      { status: 401, json: { error: "wrong_code", triesLeft: null } },
      { status: 401, text: "no" },
    ];
    for (const answer of bad) {
      const { session, api, vault } = setup();
      api.on("POST", "/v1/auth/exchange", answer);
      expect(await session.signInWithCode(ADDRESS, CODE), JSON.stringify(answer)).toEqual({ kind: "failed", failure: "unavailable" });
      expect(vault.value).toBeNull();
      expect(session.state).toEqual({ kind: "signed_out" });
    }
  });

  it("asks nothing for an address that is not one or a code that is not six digits, which the API would not count as a try", async () => {
    const { session, api } = setup();
    await session.load();
    for (const code of ["", "12345", "1234567", "12345a", "12 345", "１２３４５６", "48-2915"]) {
      expect(await session.signInWithCode(ADDRESS, code), JSON.stringify(code)).toEqual({ kind: "failed", failure: "invalid_request" });
    }
    expect(await session.signInWithCode("fon", CODE)).toEqual({ kind: "failed", failure: "invalid_request" });
    expect(await session.signInWithCode("", CODE)).toEqual({ kind: "failed", failure: "invalid_request" });
    expect(api.calls).toEqual([]);
    expect(session.state).toEqual({ kind: "signed_out" });
  });

  it("signs in nowhere on a computer that cannot keep a session", async () => {
    const { session, api, vault } = setup();
    vault.missing = true;
    await session.load();
    expect(await session.signInWithCode(ADDRESS, CODE)).toEqual({ kind: "failed", failure: "no_keychain" });
    expect(api.calls).toEqual([]);
    expect(session.state).toEqual({ kind: "no_keychain" });
  });

  it("answers a second press of the same sign-in with the first's answer, and asks the API once", async () => {
    const { session, api } = setup();
    api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1, TENANT) }).on("DELETE", "/v1/auth/session", { status: 200, json: {} });
    await session.load();
    const first = session.signInWithCode(ADDRESS, CODE);
    const second = session.signInWithCode(ADDRESS, CODE);
    expect(await second).toEqual(await first);
    expect(api.to("POST", "/v1/auth/exchange")).toHaveLength(1);
  });

  it("lets one sign-in run at a time, whichever kind: the other is turned away while it runs", async () => {
    const codeFirst = setup();
    codeFirst.api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1, TENANT) });
    await codeFirst.session.load();
    const running = codeFirst.session.signInWithCode(ADDRESS, CODE);
    expect(await codeFirst.session.signIn(IDENTITY, NONCE)).toEqual({ kind: "signing_in" });
    expect((await running).kind).toBe("signed_in");
    expect(codeFirst.api.to("POST", "/v1/auth/exchange").map((r) => (r.body as { provider: string }).provider)).toEqual(["email"]);

    const appleFirst = setup();
    appleFirst.api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    await appleFirst.session.load();
    const apple = appleFirst.session.signIn(IDENTITY, NONCE);
    expect(await appleFirst.session.signInWithCode(ADDRESS, CODE)).toEqual({ kind: "failed", failure: "busy" });
    expect((await apple).kind).toBe("signed_in");
    expect(appleFirst.api.to("POST", "/v1/auth/exchange").map((r) => (r.body as { provider: string }).provider)).toEqual(["apple"]);
  });

  it("ends the session already here before it signs in, so the first is not left live on the API, as Apple's does", async () => {
    const { session, api, vault } = setup(stored(clock().now()));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(2, TENANT) });
    await session.load();
    expect(await session.signInWithCode(ADDRESS, CODE)).toMatchObject({ kind: "signed_in", tenant: TENANT });
    expect(api.calls.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["DELETE", "/v1/auth/session", "access-1"],
      ["POST", "/v1/auth/exchange", null],
    ]);
    expect(kept(vault)).toMatchObject({ accessToken: "access-2", tenant: TENANT });
  });

  it("ends another API's session left in the keychain on its own API first, and sends the code only here", async () => {
    const other = "https://staging.manut.xyz";
    const { session, api, vault } = setup(stored(clock().now(), { origin: other, accessToken: "access-other" }));
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1, TENANT) });
    await session.load();
    expect((await session.signInWithCode(ADDRESS, CODE)).kind).toBe("signed_in");
    expect(api.calls.map((r) => [r.method, r.url, r.bearer])).toEqual([
      ["DELETE", `${other}/v1/auth/session`, "access-other"],
      ["POST", `${ORIGIN}/v1/auth/exchange`, null],
    ]);
    expect(kept(vault)).toMatchObject({ origin: ORIGIN, tenant: TENANT, accessToken: "access-1" });
  });

  it("ends a new session it cannot keep, so no live token is left behind, and says the keychain would not keep it", async () => {
    const { session, api, vault } = setup();
    api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1, TENANT) }).on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } });
    await session.load();
    vault.refuse = true;
    expect(await session.signInWithCode(ADDRESS, CODE)).toEqual({ kind: "failed", failure: "keychain" });
    expect(api.to("DELETE", "/v1/auth/session")).toEqual([expect.objectContaining({ bearer: "access-1" })]);
    expect(session.state).toEqual({ kind: "signed_out", failure: "keychain" });
    expect(vault.value).toBeNull();
  });

  it("can try again after a wrong code, and signs in with the right one", async () => {
    const { session, api, vault } = setup();
    api.on("POST", "/v1/auth/exchange", { status: 401, json: { error: "wrong_code", triesLeft: 4 } }, { status: 200, json: tokens(1, TENANT) });
    await session.load();
    expect(await session.signInWithCode(ADDRESS, "000000")).toEqual({ kind: "wrong_code", triesLeft: 4 });
    expect((await session.signInWithCode(ADDRESS, CODE)).kind).toBe("signed_in");
    expect(api.to("POST", "/v1/auth/exchange").map((r) => (r.body as { code: string }).code)).toEqual(["000000", CODE]);
    expect(kept(vault)).toMatchObject({ tenant: TENANT });
  });
});

describe("the session an email sign-in made, kept as Apple's is", () => {
  async function signedInByCode() {
    const s = setup();
    s.api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1, TENANT) });
    await s.session.load();
    await s.session.signInWithCode(ADDRESS, CODE);
    return s;
  }

  it("refreshes before the access token expires, with the same grant and device, and keeps the new pair in the one item", async () => {
    const { session, api, vault, c } = await signedInByCode();
    const start = c.now();
    api.on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2, TENANT) }).on("GET", "/v1/schedules", { status: 200, json: { schedules: [] } });
    c.pass(3600_000 - REFRESH_EARLY_MS + 1);
    expect((await session.read("/v1/schedules")).kind).toBe("ok");
    expect(api.calls.map((r) => [r.method, r.path, r.bearer])).toEqual([
      ["POST", "/v1/auth/exchange", null],
      ["POST", "/v1/auth/refresh", null],
      ["GET", "/v1/schedules", "access-2"],
    ]);
    expect(api.to("POST", "/v1/auth/refresh")[0].body).toEqual({ refreshToken: "refresh-1", deviceId: "device-1" });
    expect(kept(vault)).toMatchObject({ v: 2, tenant: TENANT, accessToken: "access-2", refreshToken: "refresh-2", accessExpiresAt: c.now() + 3600_000, signedInAt: start });
    // the address and the code are as absent after a refresh as before it
    neverKept(api, vault);
  });

  it("refreshes once and tries again after a 401, and signs out when the API ends the chain, as for Apple's", async () => {
    const first = await signedInByCode();
    first.api.on("GET", "/v1/schedules", { status: 401, json: { error: "unauthorized" } }, { status: 200, json: { schedules: [] } }).on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2, TENANT) });
    expect((await first.session.read("/v1/schedules")).kind).toBe("ok");
    expect(first.api.to("POST", "/v1/auth/refresh")).toHaveLength(1);

    const ended = await signedInByCode();
    ended.api.on("GET", "/v1/schedules", { status: 401, json: {} }).on("POST", "/v1/auth/refresh", { status: 401, json: { error: "session_expired" } });
    expect(await ended.session.read("/v1/schedules")).toEqual({ kind: "signed_out" });
    expect(ended.vault.value).toBeNull();
    expect(ended.session.state).toEqual({ kind: "signed_out", ended: "expired" });
  });

  it("is read back from the keychain at the next start as a sign-in, tenant and all", async () => {
    const { vault } = await signedInByCode();
    const again = new ApiSession({ origin: ORIGIN, fetch: fakeApi().fetch, vault, now: clock().now });
    await again.load();
    expect(again.state).toMatchObject({ kind: "signed_in", tenant: TENANT });
  });

  it("holds shop sessions with it in the same item, and they survive a refresh and end with a sign-out", async () => {
    const { session, api, vault, c } = await signedInByCode();
    const now = c.now();
    const OWNER = "mos1.fake-shop-a.not-a-real-secret";
    const HELPER = "mhs1.fake-shop-b.not-a-real-secret";
    const shops = {
      "pilot:shop-a": { role: "owner" as const, accessToken: OWNER, expiresAt: now + 30 * 86_400_000 },
      "pilot:shop-b": { role: "helper" as const, accessToken: HELPER, expiresAt: now + 30 * 86_400_000 },
    };
    expect(await session.keepShopSession("pilot:shop-a", shops["pilot:shop-a"], session.signInChain)).toBe(true);
    expect(await session.keepShopSession("pilot:shop-b", shops["pilot:shop-b"], session.signInChain)).toBe(true);
    expect(kept(vault)).toMatchObject({ v: 2, tenant: TENANT, shops });
    expect(session.heldShops()).toEqual(["pilot:shop-a", "pilot:shop-b"]);

    api.on("POST", "/v1/auth/refresh", { status: 200, json: tokens(2, TENANT) }).on("GET", "/v1/schedules", { status: 200, json: {} });
    c.pass(3600_000 - REFRESH_EARLY_MS + 1);
    expect((await session.read("/v1/schedules")).kind).toBe("ok");
    expect(kept(vault)).toMatchObject({ accessToken: "access-2", shops });

    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } }).on("POST", "/v1/shops/session/end", { status: 200, json: { ended: {} } });
    expect(await session.signOut()).toEqual({ revoked: true });
    expect(api.to("POST", "/v1/shops/session/end").map((r) => [r.bearer, r.body])).toEqual([[OWNER, {}], [HELPER, {}]]);
    expect(vault.value).toBeNull();
    expect(session.heldShops()).toEqual([]);
  });

  it("ends on the API when the person signs out, with the session's own bearer", async () => {
    const { session, api, vault } = await signedInByCode();
    api.on("DELETE", "/v1/auth/session", { status: 200, json: { revoked: true } });
    expect(await session.signOut()).toEqual({ revoked: true });
    expect(api.to("DELETE", "/v1/auth/session")).toEqual([expect.objectContaining({ bearer: "access-1" })]);
    expect(vault.value).toBeNull();
    expect(session.state).toEqual({ kind: "signed_out" });
  });
});

describe("the code and the address are never logged, whatever the answer", () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  afterEach(() => spies.forEach((s) => s.mockClear()));

  it("writes nothing to the console through a whole sign-in, a wrong code, a refusal and an unreadable answer", async () => {
    const asks: Parameters<FakeApi["on"]>[2][] = [
      { status: 200, json: SENT },
      { status: 429, json: { error: "too_many_codes", retryAfter: 30 } },
      { status: 400, json: { error: "email_not_configured" } },
      { status: 200, text: `garbled ${ADDRESS}` },
      "offline",
    ];
    for (const answer of asks) {
      const { session, api, vault } = setup();
      api.on("POST", "/v1/auth/email/code", answer);
      neverKept(api, vault, await session.requestCode(ADDRESS));
    }
    const tries: Parameters<FakeApi["on"]>[2][] = [
      { status: 200, json: tokens(1, TENANT) },
      { status: 401, json: { error: "wrong_code", triesLeft: 2 } },
      { status: 401, json: { error: "code_ended" } },
      { status: 400, json: { error: "invalid_request" } },
      { status: 200, text: `garbled ${CODE} ${ADDRESS}` },
      { status: 500, text: `${CODE}` },
      "failed",
    ];
    for (const answer of tries) {
      const { session, api, vault } = setup();
      api.on("POST", "/v1/auth/exchange", answer);
      neverKept(api, vault, await session.signInWithCode(ADDRESS, CODE), session.state);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
