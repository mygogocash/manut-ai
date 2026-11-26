import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountHash, MAX_TRIES, REVOKE, type AccountDeletionRecord } from "../src/account-store";
import worker from "../src/index";
import type { PilotDeletionRecord } from "../src/pilot-store";
import {
  admin,
  appleIdentity,
  asSession,
  auditEntries,
  bindings,
  callWith,
  emailSignIn,
  failingWhere,
  joinHelper,
  linkedOwner,
  setFlags,
  setupShop,
  type Shop,
  type SignedIn,
} from "./people-fixtures";
import { sourceWorker } from "./source-worker";

// Deleting your own account from the app (item 124; docs/pilot-api.md, "Deleting your own account"), through the real
// Worker and objects. An owner deletes their account and their shop with it, through the same deletion record and wipe the
// operator's flow uses; a helper deletes theirs and leaves the shop, which keeps everything; nobody else can ask, and
// only for their own account; a deletion that stops part way says so and the same request finishes it; and an account
// made with Sign in with Apple has the token its sign-in kept revoked at Apple, which is stood in here at
// https://apple.test (wrangler.test.json, `TEST_APPLE_ORIGIN`). A failure there never stops the deletion: it is recorded
// and tried again. The global fetch answers Apple and LINE and everything else 599, so nothing leaves the test.

const PATH = "/v1/account/deletion";
const NONCE = "people-nonce";
/// The made-up key's public half; its private half is `TEST_APPLE_PRIVATE_KEY` in wrangler.test.json.
const SECRET_PUBLIC_JWK = { kty: "EC", crv: "P-256", x: "6XmBtgTmnHCf28NyOMesQZh9I155KBOpYMyZUWTyoZM",
  y: "89aDmsRGPv6W0F7dAyGZXvZaTqeZgjj8GSCDugz61Gk" };

type AppleCall = { url: string; form: URLSearchParams };

/// Apple's token and revoke endpoints, as the REST API's documentation describes them: a code a sign-in was given is
/// exchanged once for a refresh token whose id token names the same person; revoking answers 200 with no body, also for a
/// token already revoked. `revokeAnswer` makes the revoke fail.
class FakeApple {
  readonly calls: AppleCall[] = [];
  readonly revoked = new Set<string>();
  revokeAnswer: number | "throw" = 200;
  private readonly codes = new Map<string, { sub: string; refresh: string; used: boolean }>();

  /// A code Apple gives the app with an identity token for `sub`.
  code(sub: string): string {
    const code = `c${crypto.randomUUID().replaceAll("-", "")}.0.ab`;
    this.codes.set(code, { sub, refresh: `r${crypto.randomUUID()}`, used: false });
    return code;
  }

  /// The refresh token `code` was exchanged for.
  refreshOf(code: string | undefined): string {
    return this.codes.get(code ?? "")?.refresh ?? "";
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.line.me/")) return Response.json({ displayName: "Somchai" });
    if (!url.startsWith("https://apple.test/")) return Response.json({ error: "unexpected_outbound_call" }, { status: 599 });
    const form = new URLSearchParams(String(init?.body ?? ""));
    this.calls.push({ url, form });
    if (!(await this.secretIsGood(form))) return Response.json({ error: "invalid_client" }, { status: 400 });
    if (url === "https://apple.test/auth/token") {
      const kept = this.codes.get(form.get("code") ?? "");
      if (!kept || kept.used || form.get("grant_type") !== "authorization_code") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      kept.used = true;
      const idToken = `${b64(JSON.stringify({ alg: "RS256" }))}.${b64(JSON.stringify({ sub: kept.sub }))}.sig`;
      return Response.json({ access_token: "a1", token_type: "Bearer", expires_in: 3600, refresh_token: kept.refresh,
        id_token: idToken });
    }
    if (url === "https://apple.test/auth/revoke") {
      if (this.revokeAnswer === "throw") throw new Error("fixture: Apple did not answer");
      if (this.revokeAnswer !== 200) return Response.json({ error: "server_error" }, { status: this.revokeAnswer });
      this.revoked.add(form.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  /// The client secret as "Creating a client secret" asks: ES256 under the key's id, from the team, for the client.
  private async secretIsGood(form: URLSearchParams): Promise<boolean> {
    if (form.get("client_id") !== "test-client") return false;
    const [head, claims, signature] = (form.get("client_secret") ?? "").split(".");
    if (!head || !claims || !signature) return false;
    const header = JSON.parse(unb64(head)) as Record<string, unknown>;
    const body = JSON.parse(unb64(claims)) as Record<string, number | string>;
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "ES256" || header.kid !== "TESTKEY001" || body.iss !== "TESTTEAM01" || body.sub !== "test-client" ||
        body.aud !== "https://appleid.apple.com" || Number(body.exp) <= now || Number(body.exp) - Number(body.iat) > 15_777_000) {
      return false;
    }
    const key = await crypto.subtle.importKey("jwk", SECRET_PUBLIC_JWK, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes(signature),
      new TextEncoder().encode(`${head}.${claims}`));
  }
}

function b64(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(text: string): string {
  return atob(text.replace(/-/g, "+").replace(/_/g, "/"));
}
function bytes(text: string): Uint8Array {
  const raw = unb64(text);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

let apple: FakeApple;

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true })).status).toBe(200);
  apple = new FakeApple();
  vi.spyOn(globalThis, "fetch").mockImplementation(apple.fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/// Signing in with Apple through the real exchange, with the authorization code the app was given when `withCode`.
async function appleSignIn(options: { email?: string; withCode?: boolean } = {}): Promise<SignedIn & { code?: string }> {
  const sub = `apple-${crypto.randomUUID()}`;
  const identityToken = await appleIdentity({ sub, ...(options.email ? { email: options.email, email_verified: true } : {}) });
  const code = options.withCode === false ? undefined : apple.code(sub);
  const deviceId = `device-${crypto.randomUUID()}`;
  const response = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken, nonce: NONCE, deviceId, ...(code ? { authorizationCode: code } : {}) }) });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { tenant: string; accessToken: string; refreshToken: string };
  return { ...body, deviceId, headers: { authorization: `Bearer ${body.accessToken}` }, ...(code ? { code } : {}) };
}

function authStub() {
  return bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
}

async function accountRecord(subject: string): Promise<AccountDeletionRecord | null> {
  const response = await authStub().fetch(`https://auth/account-deletion?subject=${encodeURIComponent(subject)}`);
  return ((await response.json()) as { record: AccountDeletionRecord | null }).record;
}

async function pendingRevoke(subject: string): Promise<{ tries: number; nextAt: number } | undefined> {
  const hash = await accountHash(subject);
  return runInDurableObject(authStub(), (_instance, state) => state.storage.get(`${REVOKE}${hash}`));
}

function deleteAccount(person: { headers: { authorization?: string } }, owned: { shop: string; name: string }[]) {
  return asSession<Record<string, unknown>>(person.headers, "POST", PATH, { owned });
}

async function listedShops(): Promise<string[]> {
  const listed = await admin<{ shops: { tenant: string }[] }>("GET", "/v1/admin/pilot/shops");
  expect(listed.status).toBe(200);
  return listed.body.shops.map((shop) => shop.tenant);
}

async function shopDeletion(tenant: string): Promise<PilotDeletionRecord | null> {
  const response = await authStub().fetch(`https://auth/pilot-deletions?tenant=${encodeURIComponent(tenant)}`);
  return ((await response.json()) as { deletion: PilotDeletionRecord | null }).deletion;
}

/// Whether the signed-in session still works: its own list of shops answers it.
async function stillSignedIn(person: { headers: { authorization?: string } }): Promise<boolean> {
  return (await asSession(person.headers, "GET", "/v1/shops")).status === 200;
}

/// A shop with LINE, an owner signed in with Apple (keeping their token) and linked to it, and a helper.
async function ownedShop(name = "Baan Mali"): Promise<{ shop: Shop; owner: Awaited<ReturnType<typeof linkedOwner>> & {
  person: SignedIn & { code?: string } } }> {
  const shop = await setupShop(name);
  const person = await appleSignIn();
  const owner = await linkedOwner(shop, person);
  return { shop, owner: { ...owner, person } };
}

describe("who may ask", () => {
  it("answers no session, the operator key and a shop session 401, before the method, and deletes nothing", async () => {
    const { shop, owner } = await ownedShop();
    const helper = await joinHelper(shop);
    for (const headers of [{}, { authorization: "Bearer test-key" }, owner.headers, helper.headers,
      { authorization: "Bearer not-a-session" }]) {
      const answer = await asSession(headers, "POST", PATH, { owned: [{ shop: shop.tenant, name: shop.name }] });
      expect(answer).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect((await asSession(headers, "GET", PATH)).status).toBe(401);
    }
    expect(await listedShops()).toContain(shop.tenant);
    expect(await accountRecord(owner.person.tenant)).toBeNull();
    // Signed in, a wrong method is refused, and so is a body that names anything but the shops.
    expect((await asSession(owner.person.headers, "GET", PATH)).status).toBe(405);
    for (const body of [{}, { owned: [], account: owner.person.tenant }, { owned: [{ shop: shop.tenant }] },
      { owned: [{ shop: shop.tenant, name: shop.name, role: "owner" }] }, { owned: "all" }]) {
      expect(await asSession(owner.person.headers, "POST", PATH, body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    expect(await listedShops()).toContain(shop.tenant);
    expect(await stillSignedIn(owner.person)).toBe(true);
  });

  it("deletes only the asker's own account: another person's shop cannot be named, and nothing of theirs goes", async () => {
    const mine = await ownedShop("Khao Hom");
    const theirs = await ownedShop("Baan Mali");
    // Naming someone else's shop, with its exact name, as if it were one's own: refused, with one's own list.
    const refused = await deleteAccount(mine.owner.person, [{ shop: theirs.shop.tenant, name: theirs.shop.name }]);
    expect(refused).toEqual({ status: 409, body: { error: "owned_changed", owned: [{ id: mine.shop.tenant, name: "Khao Hom" }] } });
    // Leaving one's own shop out is refused too: nothing goes that was not shown by name.
    expect((await deleteAccount(mine.owner.person, [])).body.error).toBe("owned_changed");
    expect(await listedShops()).toEqual(expect.arrayContaining([mine.shop.tenant, theirs.shop.tenant]));
    // The other owner is untouched by the one who does delete.
    expect((await deleteAccount(mine.owner.person, [{ shop: mine.shop.tenant, name: "Khao Hom" }])).status).toBe(200);
    expect(await listedShops()).toContain(theirs.shop.tenant);
    expect(await stillSignedIn(theirs.owner.person)).toBe(true);
    expect((await asSession(theirs.owner.headers, "GET", "/v1/people")).status).toBe(200);
  });

  it("asks for the shop's own name, and a wrong one deletes nothing", async () => {
    const { shop, owner } = await ownedShop("Baan Mali");
    const wrong = await deleteAccount(owner.person, [{ shop: shop.tenant, name: "Baan Mal" }]);
    expect(wrong).toEqual({ status: 409, body: { error: "name_mismatch", shop: shop.tenant } });
    expect(await listedShops()).toContain(shop.tenant);
    expect(await accountRecord(owner.person.tenant)).toBeNull();
    // Outer spaces and how an accent was typed do not count, as for the operator's name.
    expect((await deleteAccount(owner.person, [{ shop: shop.tenant, name: "  Baan Mali " }])).status).toBe(200);
  });
});

describe("an owner", () => {
  it("deletes their account and their shop, through the operator's deletion record and wipe, and is signed out", async () => {
    const { shop, owner } = await ownedShop();
    const helper = await joinHelper(shop);
    const before = Date.now();
    const answer = await deleteAccount(owner.person, [{ shop: shop.tenant, name: shop.name }]);
    expect(answer).toEqual({ status: 200, body: { deleted: true, shops: [{ id: shop.tenant, name: shop.name }], left: [],
      apple: "revoked" } });

    // The shop is gone as the operator's deletion leaves it: off the list, its data deleted, its export says when.
    expect(await listedShops()).not.toContain(shop.tenant);
    const exported = await admin("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(exported.status).toBe(404);
    expect(exported.body.error).toBe("tenant_deleted");
    // Its deletion record says the owner asked, by their linked account's id, and the confirmation is the owner's yes.
    const record = await shopDeletion(shop.tenant);
    expect(record).toMatchObject({ tenant: shop.tenant, name: shop.name, deletedBy: null, askedBy: owner.accountId });
    expect(record?.deletedAt).toBeDefined();
    const confirmation = await authStub().fetch(`https://auth/pilot-deletions?tenant=${encodeURIComponent(shop.tenant)}`);
    const stored = (await confirmation.json()) as { confirmation: { status: string; decision: { decidedBy: string; role: string } } };
    expect(stored.confirmation.status).toBe("decided");
    expect(stored.confirmation.decision).toMatchObject({ decidedBy: owner.accountId, role: "owner" });

    // Every session ends: the sign-in, its refresh, the owner's shop session and the helper's, which the shop took with it.
    expect(await stillSignedIn(owner.person)).toBe(false);
    const refreshed = await sourceWorker.fetch("https://api.manut.test/v1/auth/refresh", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: owner.person.refreshToken, deviceId: owner.person.deviceId }) });
    expect(refreshed.status).toBe(401);
    expect((await asSession(owner.headers, "GET", "/v1/people")).status).toBe(401);
    expect((await asSession(helper.headers, "GET", "/v1/approvals?state=open")).status).toBe(401);

    // The record of the account's deletion: who asked (the account's hash, never its Apple id), when, what it covered.
    const kept = await accountRecord(owner.person.tenant);
    expect(kept).toMatchObject({ account: await accountHash(owner.person.tenant), kind: "apple",
      owned: [{ shop: shop.tenant, name: shop.name, account: owner.accountId }], helping: [], apple: "revoked" });
    expect(Date.parse(kept!.requestedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(kept?.finishedAt).toBeDefined();
    expect(kept?.runningUntil).toBeUndefined();
    expect(JSON.stringify(kept)).not.toContain(owner.person.tenant);

    // Apple was asked to revoke the very refresh token the sign-in's code was exchanged for, with a good client secret.
    expect(apple.revoked).toEqual(new Set([apple.refreshOf(owner.person.code)]));
    const revokes = apple.calls.filter((one) => one.url === "https://apple.test/auth/revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.form.get("token_type_hint")).toBe("refresh_token");
    expect(await pendingRevoke(owner.person.tenant)).toBeUndefined();
  });

  it("a second request after the deletion is answered as no session at all", async () => {
    const { shop, owner } = await ownedShop();
    expect((await deleteAccount(owner.person, [{ shop: shop.tenant, name: shop.name }])).status).toBe(200);
    expect(await deleteAccount(owner.person, [{ shop: shop.tenant, name: shop.name }]))
      .toEqual({ status: 401, body: { error: "unauthorized" } });
  });

  it("a second request while one runs is refused, and deletes nothing twice", async () => {
    const { shop, owner } = await ownedShop();
    // Another request holds the deletion, as one still running would.
    const held = await authStub().fetch("https://auth/account-deletion/begin", { method: "POST",
      headers: { "content-type": "application/json", "x-admin": "1" },
      body: JSON.stringify({ subject: owner.person.tenant, owned: [], helping: [] }) });
    expect(held.status).toBe(200);
    expect(await deleteAccount(owner.person, [{ shop: shop.tenant, name: shop.name }]))
      .toEqual({ status: 409, body: { error: "deletion_running" } });
    expect(await listedShops()).toContain(shop.tenant);
    expect(await stillSignedIn(owner.person)).toBe(true);
  });

  it("a deletion that stops part way says so, keeps the session, and the same request finishes it", async () => {
    const { shop, owner } = await ownedShop();
    // The shop's own object cannot take its wipe: the deletion stops at the shop.
    const failing = failingWhere("TENANT", (request) => new URL(request.url).pathname === "/tenant-wipe");
    const response = await callWith(failing, PATH, { method: "POST",
      headers: { ...owner.person.headers, "cf-connecting-ip": "203.0.113.77" } as { authorization: string },
      body: { owned: [{ shop: shop.tenant, name: shop.name }] } });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: "deletion_incomplete", step: "shops", failed: [shop.tenant] });
    // Nothing of the person's own went: they can press again.
    expect(await stillSignedIn(owner.person)).toBe(true);
    const kept = await accountRecord(owner.person.tenant);
    expect(kept?.finishedAt).toBeUndefined();
    expect(kept?.runningUntil).toBeUndefined();
    // The shop's data is part gone and its record may be too, so the person's list no longer shows it: the same request,
    // naming it still, finishes the same deletion.
    const finished = await deleteAccount(owner.person, [{ shop: shop.tenant, name: shop.name }]);
    expect(finished.status).toBe(200);
    expect(await listedShops()).not.toContain(shop.tenant);
    expect(await stillSignedIn(owner.person)).toBe(false);
    expect((await accountRecord(owner.person.tenant))?.requestedAt).toBe(kept?.requestedAt);
  });
});

describe("a helper", () => {
  it("deletes their account and leaves the shop, which keeps all of its data", async () => {
    const { shop, owner } = await ownedShop();
    const email = `mint-${crypto.randomUUID()}@baanmali.example`;
    const person = await appleSignIn({ email });
    const invited = await admin<{ inviteUrl: string }>("POST", "/v1/admin/people/invites",
      { tenant: shop.tenant, name: "Mint", identity: { kind: "email", address: email } });
    const joined = await asSession<{ helper: { id: string }; session: { accessToken: string } }>(person.headers, "POST",
      "/v1/people/accept", { token: invited.body.inviteUrl.split("/join/")[1] });
    expect(joined.status).toBe(200);
    const helperSession = { authorization: `Bearer ${joined.body.session.accessToken}` };
    // A helper owns no shop: naming the shop they help at is refused, and nothing goes.
    expect((await deleteAccount(person, [{ shop: shop.tenant, name: shop.name }])).body.error).toBe("owned_changed");

    const answer = await deleteAccount(person, []);
    expect(answer).toEqual({ status: 200, body: { deleted: true, shops: [], left: [{ id: shop.tenant, name: shop.name }],
      apple: "revoked" } });
    // The shop is all there, and its owner still works it.
    expect(await listedShops()).toContain(shop.tenant);
    expect(await shopDeletion(shop.tenant)).toBeNull();
    const people = await asSession<{ helpers: unknown[]; removed: { id: string; name: string }[] }>(owner.headers, "GET", "/v1/people");
    expect(people.status).toBe(200);
    expect(people.body.helpers).toEqual([]);
    expect(people.body.removed).toEqual([{ id: joined.body.helper.id, name: "Mint" }]);
    // Their place there is gone on every device, and the log says it was their own doing.
    expect((await asSession(helperSession, "GET", "/v1/approvals?state=open")).body.error).toBe("removed");
    const left = (await auditEntries(shop.tenant)).find((entry) => entry.action === "helper.left");
    expect(left).toMatchObject({ actor: { kind: "helper", id: joined.body.helper.id }, subject: { helperId: joined.body.helper.id },
      outcome: "ok" });
    expect(await stillSignedIn(person)).toBe(false);
    expect(await accountRecord(person.tenant)).toMatchObject({ owned: [],
      helping: [{ shop: shop.tenant, name: shop.name, helper: joined.body.helper.id }] });
  });

  it("signed in by email, has no Apple token to speak of", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Ice");
    // joinHelper signs in with Apple; this helper's own email sign-in is the one deleted here.
    const person = await emailSignIn(helper.email);
    // A helper is known by the address the owner invited, so this sign-in opens the shop too, and lists it from then on.
    expect((await asSession(person.headers, "POST", "/v1/people/session", { shop: shop.tenant })).status).toBe(200);
    const answer = await deleteAccount(person, []);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ deleted: true, shops: [], left: [{ id: shop.tenant, name: shop.name }] });
    expect(apple.calls).toEqual([]);
  });
});

describe("the Apple token", () => {
  it("is kept sealed from a sign-in that carried its code, and never in the clear", async () => {
    const person = await appleSignIn();
    const refresh = apple.refreshOf(person.code);
    expect(refresh).not.toBe("");
    const hash = await accountHash(person.tenant);
    const kept = await runInDurableObject(authStub(), (_instance, state) => state.storage.get(`apple-grant:${hash}`));
    expect(kept).toMatchObject({ sealed: { keyTag: expect.any(String), iv: expect.any(String), data: expect.any(String) } });
    const exchanged = apple.calls.find((one) => one.url === "https://apple.test/auth/token");
    expect(exchanged?.form.get("code")).toBe(person.code);
    expect(exchanged?.form.has("redirect_uri")).toBe(false);
    const raw = await runInDurableObject(authStub(), async (_instance, state) => JSON.stringify([...(await state.storage.list()).entries()]));
    expect(raw).not.toContain(refresh);
  });

  it("a code that is not one is refused, and one Apple refuses still signs the person in, with nothing kept", async () => {
    const identityToken = await appleIdentity({});
    const refused = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "apple", identityToken, nonce: NONCE, deviceId: "d1", authorizationCode: "not a code" }) });
    expect(refused.status).toBe(400);
    const sub = `apple-${crypto.randomUUID()}`;
    const signed = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "apple", identityToken: await appleIdentity({ sub }), nonce: NONCE, deviceId: "d2",
        authorizationCode: "never.given.out" }) });
    expect(signed.status).toBe(200);
    const hash = await accountHash(`apple:${sub}`);
    expect(await runInDurableObject(authStub(), (_instance, state) => state.storage.get(`apple-grant:${hash}`))).toBeUndefined();
  });

  it("never kept (signed in without a code): the deletion finishes and says Apple's link was not ended by us", async () => {
    const shop = await setupShop();
    const person = await appleSignIn({ withCode: false });
    const owner = await linkedOwner(shop, person);
    expect(owner.accountId).toMatch(/^owner-/);
    const answer = await deleteAccount(person, [{ shop: shop.tenant, name: shop.name }]);
    expect(answer.status).toBe(200);
    expect(answer.body.apple).toBe("no_token");
    expect(apple.calls.filter((one) => one.url.endsWith("/auth/revoke"))).toEqual([]);
    expect((await accountRecord(person.tenant))?.apple).toBe("no_token");
  });

  it("Apple failing never stops the deletion: the failure is recorded and tried again until it is revoked", async () => {
    const { shop, owner } = await ownedShop();
    apple.revokeAnswer = 503;
    const answer = await deleteAccount(owner.person, [{ shop: shop.tenant, name: shop.name }]);
    expect(answer.status).toBe(200);
    expect(answer.body.apple).toBe("retrying");
    expect(await listedShops()).not.toContain(shop.tenant);
    expect(await stillSignedIn(owner.person)).toBe(false);
    const pending = await pendingRevoke(owner.person.tenant);
    expect(pending?.tries).toBe(1);
    expect(pending!.nextAt).toBeGreaterThan(Date.now());
    expect((await accountRecord(owner.person.tenant))?.apple).toBe("retrying");

    // Apple answers again; the alarm's next try, once due, revokes it and forgets the token.
    apple.revokeAnswer = 200;
    const hash = await accountHash(owner.person.tenant);
    await runInDurableObject(authStub(), async (_instance, state) => {
      const row = await state.storage.get<{ nextAt: number }>(`${REVOKE}${hash}`);
      await state.storage.put(`${REVOKE}${hash}`, { ...row, nextAt: Date.now() - 1 });
    });
    expect(await runDurableObjectAlarm(authStub())).toBe(true);
    expect(await pendingRevoke(owner.person.tenant)).toBeUndefined();
    expect((await accountRecord(owner.person.tenant))?.apple).toBe("revoked");
    expect(apple.revoked.size).toBe(1);
  });

  it("gives up after the last try, forgets the token, and the record says so", async () => {
    const { shop, owner } = await ownedShop();
    apple.revokeAnswer = "throw";
    expect((await deleteAccount(owner.person, [{ shop: shop.tenant, name: shop.name }])).body.apple).toBe("retrying");
    const hash = await accountHash(owner.person.tenant);
    for (let tried = 1; tried < MAX_TRIES; tried++) {
      await runInDurableObject(authStub(), async (_instance, state) => {
        const row = await state.storage.get<{ nextAt: number }>(`${REVOKE}${hash}`);
        await state.storage.put(`${REVOKE}${hash}`, { ...row, nextAt: Date.now() - 1 });
      });
      await runDurableObjectAlarm(authStub());
    }
    expect(await pendingRevoke(owner.person.tenant)).toBeUndefined();
    expect((await accountRecord(owner.person.tenant))?.apple).toBe("gave_up");
  });
});

describe("limits", () => {
  it("counts every try against the address's limit on deleting one's own data", async () => {
    const person = await appleSignIn({ withCode: false });
    const ip = "203.0.113.200";
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const context = createExecutionContext();
      const response = await worker.fetch(new Request(`https://api.manut.test${PATH}`, { method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...person.headers },
        body: JSON.stringify({ owned: [{ shop: "pilot:none", name: "x" }] }) }), bindings, context);
      await waitOnExecutionContext(context);
      if (response.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
