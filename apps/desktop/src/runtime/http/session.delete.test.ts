// Deleting the signed-in account from the desktop (item 124; docs/pilot-api.md, "Deleting your own account"): what is sent,
// how each answer is read, that a deletion forgets the session here without calling the API back, and that anything else
// leaves the session so the person can press again. Also the Sign in with Apple authorization code the exchange now
// carries, so the API can keep the token a deletion revokes.
import { describe, expect, it } from "vitest";
import { ApiSession, readAccountDeletion, type StoredSession } from "./session";
import { clock, fakeApi, memoryVault, ORIGIN, tokens } from "./testkit";

const IDENTITY = "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3Qta2V5LTEifQ.eyJzdWIiOiJvd25lciJ9.c2ln";
const NONCE = "client-nonce-value";

function signedIn(now: number): StoredSession {
  return { v: 2, origin: ORIGIN, tenant: "apple:owner-1", deviceId: "device-1", accessToken: "access-1",
    refreshToken: "refresh-1", accessExpiresAt: now + 3600_000, signedInAt: now,
    shops: { "pilot:a": { role: "owner", accessToken: "mos1.shop-a", expiresAt: now + 86_400_000 } } };
}

function setup() {
  const api = fakeApi();
  const c = clock();
  const vault = memoryVault(JSON.stringify(signedIn(c.now())));
  let ended = 0;
  const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, now: c.now, deviceId: () => "device-2", onEnd: () => ended++ });
  return { api, vault, session, ended: () => ended };
}

const OWNED = [{ shop: "pilot:a", name: "Baan Mali" }];

describe("deleting the account", () => {
  it("sends exactly { owned } with the sign-in's own token, and once it is done forgets the session without calling back", async () => {
    const { api, vault, session, ended } = setup();
    api.on("POST", "/v1/account/deletion", { status: 200, json: { deleted: true, shops: [{ id: "pilot:a", name: "Baan Mali" }], left: [],
      apple: "revoked" } });
    await session.load();
    const result = await session.deleteAccount(OWNED);
    expect(result).toEqual({ kind: "deleted", shops: [{ id: "pilot:a", name: "Baan Mali" }], left: [], apple: "revoked" });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ method: "POST", path: "/v1/account/deletion", bearer: "access-1", body: { owned: OWNED } });
    // The API ended every session: nothing is sent to end them again, and nothing of them is kept here.
    expect(api.to("DELETE", "/v1/auth/session")).toEqual([]);
    expect(api.to("POST", "/v1/shops/session/end")).toEqual([]);
    expect(vault.value).toBeNull();
    expect(session.state).toEqual({ kind: "signed_out" });
    expect(session.heldShops()).toEqual([]);
    expect(ended()).toBe(1);
  });

  it("a helper sends an empty list, and an email account's answer has no Apple line", async () => {
    const { api, session } = setup();
    api.on("POST", "/v1/account/deletion", { status: 200, json: { deleted: true, shops: [], left: [{ id: "pilot:b", name: "Khao Hom" }] } });
    expect(await session.deleteAccount([])).toEqual({ kind: "deleted", shops: [], left: [{ id: "pilot:b", name: "Khao Hom" }] });
    expect(api.calls[0]!.body).toEqual({ owned: [] });
  });

  it("keeps the session for every answer that is not a deletion, so the person can press again", async () => {
    const answers = [
      [{ status: 409, json: { error: "owned_changed", owned: [{ id: "pilot:c", name: "New" }] } }, { kind: "owned_changed", owned: [{ id: "pilot:c", name: "New" }] }],
      [{ status: 409, json: { error: "name_mismatch", shop: "pilot:a" } }, { kind: "name_mismatch", shop: "pilot:a" }],
      [{ status: 409, json: { error: "deletion_running" } }, { kind: "running" }],
      [{ status: 500, json: { error: "deletion_incomplete", step: "shops", failed: ["pilot:a"] } }, { kind: "incomplete" }],
      [{ status: 503, json: { error: "audit_unavailable" } }, { kind: "failed" }],
      [{ status: 429, json: { error: "rate_limited" } }, { kind: "failed" }],
      // An answer the API did not word may have come after a deletion started: it reads as no answer.
      [{ status: 502, text: "<html>" }, { kind: "offline" }],
      ["offline", { kind: "offline" }],
    ] as const;
    for (const [answer, read] of answers) {
      const { api, vault, session } = setup();
      api.on("POST", "/v1/account/deletion", answer as never);
      expect(await session.deleteAccount(OWNED), JSON.stringify(answer)).toEqual(read);
      expect(session.state.kind).toBe("signed_in");
      expect(vault.value).not.toBeNull();
    }
  });

  it("refreshes once after a 401 and sends again, as an ask's answer is; a sign-in that ended reads as signed out", async () => {
    const { api, session } = setup();
    api.on("POST", "/v1/account/deletion", { status: 401, json: { error: "unauthorized" } });
    api.on("POST", "/v1/auth/refresh", { status: 401, json: { error: "invalid_grant" } });
    expect(await session.deleteAccount(OWNED)).toEqual({ kind: "signed_out" });
    expect(api.to("POST", "/v1/account/deletion")).toHaveLength(1);
  });

  it("reads only a 200 that says deleted as a deletion", () => {
    expect(readAccountDeletion({ kind: "ok", status: 200, json: { deleted: false } })).toEqual({ kind: "offline" });
    expect(readAccountDeletion({ kind: "ok", status: 200, json: { deleted: true, shops: "x", apple: "maybe" } }))
      .toEqual({ kind: "deleted", shops: [], left: [] });
  });
});

describe("the Sign in with Apple authorization code", () => {
  it("goes once, in the exchange's body, when the sign-in has one, and is not kept", async () => {
    const api = fakeApi();
    const vault = memoryVault(null);
    const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault, now: clock().now, deviceId: () => "device-9" });
    api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    await session.load();
    expect((await session.signIn(IDENTITY, NONCE, " c1a2.0.code ")).kind).toBe("signed_in");
    expect(api.calls[0]!.body).toEqual({ provider: "apple", identityToken: IDENTITY, nonce: NONCE, deviceId: "device-9",
      authorizationCode: "c1a2.0.code" });
    expect(vault.value).not.toContain("c1a2");
  });

  it("is left out when there is none, and one that cannot be a code is refused before anything is sent", async () => {
    const api = fakeApi();
    const session = new ApiSession({ origin: ORIGIN, fetch: api.fetch, vault: memoryVault(null), now: clock().now, deviceId: () => "d" });
    api.on("POST", "/v1/auth/exchange", { status: 200, json: tokens(1) });
    await session.load();
    expect((await session.signIn(IDENTITY, NONCE, "not a code")).kind).toBe("signed_out");
    expect(api.calls).toEqual([]);
    await session.signIn(IDENTITY, NONCE);
    expect(api.calls[0]!.body).not.toHaveProperty("authorizationCode");
  });
});
