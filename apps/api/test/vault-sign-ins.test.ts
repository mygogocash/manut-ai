import { adminFetch } from "./authenticated-fixtures";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../src/audit-log";
import { openSecret, type SealedSecret } from "../src/cred-crypto";
import type { Env } from "../src/index";
import { tenantCall } from "../src/tenant-data";

// The operator's side of the vault's site sign-ins (docs/browser-control.md): kept sealed, answered without the
// password, replaced, and removed, each written to the shop's audit log with ids only.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
// Committed test-only vault key, matching wrangler.test.json (cred-vault.test.ts reads it the same way).
const VAULT_KEY = "48b0c940489d799edf8202d721c46affd57351019df8ccc01579fbb82d2b2569";
// Made up for each run and never a real password, so a search for it finds only what this file stored.
const PASSWORD = `pw-${crypto.randomUUID()}`;
const NEW_PASSWORD = `pw-new-${crypto.randomUUID()}`;
const API = "https://api.manut.test";

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

type SignIn = {
  id: string;
  site: string;
  origins: string[];
  username: string;
  members: string[];
  state: "working" | "broken";
  passwordSet: boolean;
  passwordSetAt: string;
  brokenAt: string | null;
  brokenBy: string | null;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  createdAt: string;
};

function create(tenant: string, overrides: Record<string, unknown> = {}) {
  return adminFetch(`${API}/v1/admin/vault/sign-ins`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, site: "Shopee Seller Centre", origins: ["https://seller.shopee.co.th"],
      username: "baan.mali@example.com", password: PASSWORD, members: ["nam", "ton"], ...overrides }) });
}

async function created(tenant: string, overrides: Record<string, unknown> = {}): Promise<SignIn> {
  const response = await create(tenant, overrides);
  expect(response.status).toBe(200);
  return ((await response.json()) as { signIn: SignIn }).signIn;
}

function list(tenant: string) {
  return adminFetch(`${API}/v1/admin/vault/sign-ins?tenant=${encodeURIComponent(tenant)}`, { headers: OPERATOR });
}

function replace(tenant: string, signInId: string, password = NEW_PASSWORD) {
  return adminFetch(`${API}/v1/admin/vault/sign-ins/password`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, signInId, password }) });
}

function remove(tenant: string, signInId: string) {
  return adminFetch(`${API}/v1/admin/vault/sign-ins/remove`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, signInId }) });
}

/// Everything the shop's vault object holds under the sign-in prefix, as stored.
function vaultRecords(tenant: string) {
  const vault = bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
  return runInDurableObject(vault, async (_instance, state) =>
    [...(await state.storage.list<Record<string, unknown>>({ prefix: "signin:" })).values()]);
}

async function audit(tenant: string) {
  const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as { entries: AuditEntry[] };
  return entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
}

describe("vault sign-ins", () => {
  it("keeps a sign-in sealed and answers it without the password", async () => {
    const tenant = fresh("vault:shop");
    const response = await create(tenant);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(PASSWORD);
    const { signIn } = JSON.parse(text) as { signIn: SignIn };
    expect(signIn).toEqual({ id: expect.any(String), site: "Shopee Seller Centre",
      origins: ["https://seller.shopee.co.th"], username: "baan.mali@example.com", members: ["nam", "ton"],
      state: "working", passwordSet: true, passwordSetAt: expect.any(String), brokenAt: null, brokenBy: null,
      lastUsedAt: null, lastUsedBy: null, createdAt: expect.any(String) });

    const listed = await list(tenant);
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(PASSWORD);
    expect(JSON.parse(listedText)).toEqual({ tenant, signIns: [signIn] });

    // At rest it is the vault's own seal: the same keys and crypto as every connection, and no plaintext.
    const [stored] = await vaultRecords(tenant);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(await openSecret(stored?.sealed as SealedSecret, VAULT_KEY)).toBe(PASSWORD);

    expect(await audit(tenant)).toEqual([{ actor: { kind: "operator", email: null }, action: "signin.created",
      subject: { signInId: signIn.id }, outcome: "ok" }]);
  });

  it("keeps several origins for a site whose sign-in page lives on another host", async () => {
    const tenant = fresh("vault:shop");
    const signIn = await created(tenant, {
      origins: ["https://seller.shopee.co.th", "https://accounts.shopee.co.th"] });
    expect(signIn.origins).toEqual(["https://seller.shopee.co.th", "https://accounts.shopee.co.th"]);
  });

  it.each([
    [{ tenant: "" }, "tenant_required"],
    [{ site: "   " }, "invalid_site"],
    [{ site: "x".repeat(81) }, "invalid_site"],
    [{ origins: [] }, "invalid_origins"],
    [{ origins: "https://seller.shopee.co.th" }, "invalid_origins"],
    [{ origins: ["http://seller.shopee.co.th"] }, "invalid_origins"],
    [{ origins: ["https://seller.shopee.co.th/login"] }, "invalid_origins"],
    [{ origins: ["https://fon:secret@seller.shopee.co.th"] }, "invalid_origins"],
    [{ origins: ["https://seller.shopee.co.th", "https://seller.shopee.co.th"] }, "invalid_origins"],
    [{ origins: ["https://a.th", "https://b.th", "https://c.th", "https://d.th", "https://e.th", "https://f.th"] },
      "invalid_origins"],
    [{ username: "" }, "invalid_username"],
    [{ username: "fon\nbaan" }, "invalid_username"],
    [{ password: "" }, "invalid_password"],
    [{ password: 1234 }, "invalid_password"],
    [{ members: [] }, "invalid_members"],
    [{ members: ["buddy"] }, "invalid_members"],
    [{ members: ["zed"] }, "invalid_members"],
    [{ members: ["nam", "nam"] }, "invalid_members"],
  ])("refuses %j with %s and keeps nothing", async (overrides, error) => {
    const tenant = fresh("vault:shop");
    const response = await create(tenant, overrides);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    if (error !== "tenant_required") expect(await vaultRecords(tenant)).toEqual([]);
  });

  it("replaces a password with a new seal, and the answer still holds neither", async () => {
    const tenant = fresh("vault:shop");
    const signIn = await created(tenant);
    const response = await replace(tenant, signIn.id);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(NEW_PASSWORD);
    const replaced = (JSON.parse(text) as { signIn: SignIn }).signIn;
    expect(replaced).toEqual({ ...signIn, passwordSetAt: expect.any(String) });
    expect(Date.parse(replaced.passwordSetAt)).toBeGreaterThanOrEqual(Date.parse(signIn.passwordSetAt));

    const [stored] = await vaultRecords(tenant);
    expect(await openSecret(stored?.sealed as SealedSecret, VAULT_KEY)).toBe(NEW_PASSWORD);
    expect((await audit(tenant)).map((entry) => entry.action)).toEqual(["signin.created", "signin.password_replaced"]);
    expect((await audit(tenant))[1]).toEqual({ actor: { kind: "operator", email: null },
      action: "signin.password_replaced", subject: { signInId: signIn.id }, outcome: "ok" });

    expect((await replace(tenant, signIn.id, "")).status).toBe(400);
    const unknown = await replace(tenant, crypto.randomUUID());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "sign_in_not_found" });
  });

  it("removes a sign-in and keeps nothing that could be typed", async () => {
    const tenant = fresh("vault:shop");
    const signIn = await created(tenant);
    const response = await remove(tenant, signIn.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true, signInId: signIn.id });
    expect(await (await list(tenant)).json()).toEqual({ tenant, signIns: [] });

    // Like a revoked connection, a removed sign-in leaves a tombstone with no secret and no account in it, so a
    // restored backup cannot bring back a password the owner took away.
    const [stored] = await vaultRecords(tenant);
    expect(stored).toMatchObject({ id: signIn.id, username: "", sealed: { keyTag: "", iv: "", data: "" },
      removedAt: expect.any(String) });
    expect(JSON.stringify(stored)).not.toContain("baan.mali@example.com");

    expect((await audit(tenant)).at(-1)).toEqual({ actor: { kind: "operator", email: null },
      action: "signin.removed", subject: { signInId: signIn.id }, outcome: "ok" });
    expect((await remove(tenant, signIn.id)).status).toBe(404);
    expect((await replace(tenant, signIn.id)).status).toBe(404);
  });

  it("keeps each shop's sign-ins to itself", async () => {
    const tenantA = fresh("vault:shop-a");
    const tenantB = fresh("vault:shop-b");
    const signIn = await created(tenantA);
    expect(await (await list(tenantB)).json()).toEqual({ tenant: tenantB, signIns: [] });
    expect((await replace(tenantB, signIn.id)).status).toBe(404);
    expect((await remove(tenantB, signIn.id)).status).toBe(404);
    expect((await (await list(tenantA)).json() as { signIns: SignIn[] }).signIns.map((s) => s.id)).toEqual([signIn.id]);
  });

  it("is reached only through the exact operator routes behind the admin gate", async () => {
    const tenant = fresh("vault:shop");
    for (const [method, path] of [["PUT", "/v1/admin/vault/sign-ins"], ["DELETE", "/v1/admin/vault/sign-ins"],
      ["GET", "/v1/admin/vault/sign-ins/password"], ["POST", "/v1/admin/vault/sign-ins/broken"],
      ["GET", "/v1/admin/vault"]] as const) {
      const response = await adminFetch(`${API}${path}?tenant=${encodeURIComponent(tenant)}`, { method,
        headers: OPERATOR, ...(method === "GET" ? {} : { body: "{}" }) });
      expect(response.status).toBe(404);
    }
    // Without Cloudflare Access the operator key alone opens nothing.
    expect((await SELF.fetch(`${API}/v1/admin/vault/sign-ins?tenant=${encodeURIComponent(tenant)}`,
      { headers: OPERATOR })).status).toBe(403);
  });
});
