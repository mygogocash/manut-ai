import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth";
import { tenantSession } from "./authenticated-fixtures";
import {
  admin,
  asSession,
  auditEntries,
  bindings,
  call,
  joinHelper,
  setupShop,
  signIn,
  type Shop,
  type SignedIn,
} from "./people-fixtures";

// This Mac registering itself as one of the shop's outposts (docs/browser-control.md, "The outpost in the desktop
// shell"; docs/pilot-api.md, `POST /v1/outposts/register`). The desktop does it with the owner's session, never the
// operator's key: an owner session of a linked account, or the shop's own signed-in session. A helper's session is
// refused. The credential is answered once and the vault keeps only its SHA-256, as for the operator's route.

const CREDENTIAL = /^mo1_[A-Za-z0-9_-]{43}$/;
const MAC = { name: "This Mac", kind: "this_mac" };

type Outpost = { id: string; name: string; kind: string; status: string; lastHeartbeatAt: string | null;
  createdAt: string };
type Registered = { tenant: string; outpost: Outpost; credential: string; error?: string };

/// `person`'s account linked as `shop`'s owner by the operator, with a code from the person's own session, and an owner
/// session for the shop opened from it: the account's id and the session's headers.
async function ownerOf(shop: Shop, person: SignedIn): Promise<{ accountId: string; headers: { authorization: string } }> {
  const code = await asSession<{ code: string }>(person.headers, "POST", "/v1/shops/owner-code");
  expect(code.status).toBe(200);
  const linked = await admin<{ ownerAccount: { id: string } }>("POST", "/v1/admin/shops/owner",
    { tenant: shop.tenant, code: code.body.code });
  expect(linked.status).toBe(200);
  const opened = await asSession<{ role: string; session: { accessToken: string } }>(person.headers, "POST",
    "/v1/shops/session", { shop: shop.tenant });
  expect(opened.status).toBe(200);
  expect(opened.body.role).toBe("owner");
  return { accountId: linked.body.ownerAccount.id,
    headers: { authorization: `Bearer ${opened.body.session.accessToken}` } };
}

function register(headers: { authorization?: string }, body: unknown = MAC) {
  return call("/v1/outposts/register", { method: "POST",
    headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function outposts(tenant: string): Promise<Outpost[]> {
  const listed = await admin<{ outposts: Outpost[] }>("GET", `/v1/admin/outposts?tenant=${encodeURIComponent(tenant)}`);
  expect(listed.status).toBe(200);
  return listed.body.outposts;
}

function heartbeat(tenant: string, outpostId: string, credential: string) {
  return call("/v1/outposts/heartbeat", { method: "POST", headers: { authorization: `Bearer ${credential}`,
    "content-type": "application/json" }, body: JSON.stringify({ tenant, outpostId }) });
}

describe("this Mac registering itself through the owner's session", () => {
  it("registers with an owner session, answers the credential once and keeps only its digest", async () => {
    const shop = await setupShop();
    const fon = await ownerOf(shop, await signIn());
    const response = await register(fon.headers);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const { tenant, outpost, credential } = JSON.parse(text) as Registered;
    expect(tenant).toBe(shop.tenant);
    expect(credential).toMatch(CREDENTIAL);
    expect(outpost).toEqual({ id: expect.any(String), name: "This Mac", kind: "this_mac", status: "asleep",
      lastHeartbeatAt: null, createdAt: expect.any(String) });

    // The operator sees it like one they registered, without the credential or its digest.
    expect(await outposts(shop.tenant)).toEqual([outpost]);
    // The vault holds the digest, and the credential works for the outpost's own routes.
    const stored = await runInDurableObject(bindings.CRED.get(bindings.CRED.idFromName(`t:${shop.tenant}`)),
      (_instance, state) => state.storage.get<Record<string, unknown>>(`outpost:${outpost.id}`));
    expect(stored?.credentialHash).toBe(await sha256Hex(credential));
    expect(JSON.stringify(stored)).not.toContain(credential);
    const beat = await heartbeat(shop.tenant, outpost.id, credential);
    expect(beat.status).toBe(200);
    expect(((await beat.json()) as { outpost: Outpost }).outpost.status).toBe("online");

    // The log names the owner's linked account and the outpost, by id only.
    const entries = await auditEntries(shop.tenant);
    const registered = entries.filter((entry) => entry.action === "outpost.registered");
    expect(registered).toEqual([expect.objectContaining({ actor: { kind: "owner", id: fon.accountId },
      subject: { outpostId: outpost.id }, outcome: "ok" })]);
    expect(JSON.stringify(entries)).not.toContain(credential);
  });

  it("registers with the shop's own signed-in session, logged as the shop's own session", async () => {
    const tenant = `apple:outpost-owner-${crypto.randomUUID()}`;
    const response = await register(await tenantSession(tenant, false));
    expect(response.status).toBe(200);
    const { tenant: answered, outpost } = (await response.json()) as Registered;
    expect(answered).toBe(tenant);
    expect(await outposts(tenant)).toEqual([outpost]);
    expect((await auditEntries(tenant)).filter((entry) => entry.action === "outpost.registered"))
      .toEqual([expect.objectContaining({ actor: { kind: "owner", id: "owner-session" },
        subject: { outpostId: outpost.id } })]);
  });

  it("refuses a helper's session, and registers nothing", async () => {
    const shop = await setupShop();
    const mint = await joinHelper(shop);
    const response = await register(mint.headers);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "owner_only" });
    expect(await outposts(shop.tenant)).toEqual([]);
    expect((await auditEntries(shop.tenant)).some((entry) => entry.action.startsWith("outpost."))).toBe(false);
  });

  it("refuses no session, the operator's key, and an outpost's own credential", async () => {
    const shop = await setupShop();
    const fon = await ownerOf(shop, await signIn());
    const { credential } = (await (await register(fon.headers)).json()) as Registered;
    for (const headers of [{}, { authorization: "Bearer test-key" }, { authorization: `Bearer ${credential}` },
      { authorization: "Bearer mos1.not-a-session" }]) {
      const response = await register(headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(await outposts(shop.tenant)).toHaveLength(1);
  });

  it("refuses an owner session whose account the operator unlinked", async () => {
    const shop = await setupShop();
    const fon = await ownerOf(shop, await signIn());
    expect((await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    const response = await register(fon.headers);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("unlinked");
    expect(await outposts(shop.tenant)).toEqual([]);
  });

  it.each([
    [{ ...MAC, tenant: "pilot:another-shop" }, "invalid_request"],
    [{ ...MAC, kind: "cloud" }, "invalid_kind"],
    [{ name: "This Mac" }, "invalid_kind"],
    [{ ...MAC, name: "  " }, "invalid_name"],
    [{ ...MAC, name: "x".repeat(81) }, "invalid_name"],
    [{ ...MAC, name: "Mac\u0007" }, "invalid_name"],
    [["This Mac"], "invalid_request"],
  ])("refuses %j with %s and registers nothing", async (body, error) => {
    const shop = await setupShop();
    const fon = await ownerOf(shop, await signIn());
    const response = await register(fon.headers, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(await outposts(shop.tenant)).toEqual([]);
  });

  it("stops at the shop's twenty outposts", async () => {
    const tenant = `apple:outpost-many-${crypto.randomUUID()}`;
    const headers = await tenantSession(tenant, false);
    for (let i = 0; i < 20; i++) expect((await register(headers, { ...MAC, name: `Mac ${i}` })).status).toBe(200);
    const response = await register(headers);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "too_many_outposts" });
    expect(await outposts(tenant)).toHaveLength(20);
  });
});
