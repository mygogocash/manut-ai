import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../src/audit-log";
import { keyTag, openSecret, sealSecret, type SealedSecret } from "../src/cred-crypto";
import { connectionResealStore } from "../src/cred-object";
import type { Env } from "../src/index";
import { resealStore } from "../src/reseal";
import { signInResealStore } from "../src/sign-in-vault";
import { tenantCall } from "../src/tenant-data";

// Re-sealing a shop's vault after a rotation of its key (reseal.ts, vault-reseal.ts): the shop's connection secrets and
// site sign-ins are sealed again under the new key, so the previous key can be retired. The routes seal everything here
// under the committed test key, which these tests treat as the key before a rotation; the key after it is made up for
// each run. Neither is ever a real key, and no secret here is a real one.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const API = "https://api.manut.test";
// Committed test-only vault key, matching wrangler.test.json (vault-sign-ins.test.ts reads it the same way).
const OLD_KEY = "48b0c940489d799edf8202d721c46affd57351019df8ccc01579fbb82d2b2569";
const NEW_KEY = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const LOST_KEY = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const ROTATED = { CRED_KEY: NEW_KEY, CRED_KEY_PREVIOUS: OLD_KEY };
const PASSWORD = `pw-${crypto.randomUUID()}`;
const REFRESH = `refresh-${crypto.randomUUID()}`;

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

type Stored = { id: string; sealed: SealedSecret; removedAt?: string | null; revokedAt?: string | null };

function vault(tenant: string) {
  return bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
}

async function signIn(tenant: string, password = PASSWORD): Promise<string> {
  const response = await adminFetch(`${API}/v1/admin/vault/sign-ins`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, site: "Shopee Seller Centre", origins: ["https://seller.shopee.co.th"],
      username: "baan.mali@example.com", password, members: ["nam"] }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { signIn: { id: string } }).signIn.id;
}

async function connection(tenant: string): Promise<string> {
  const response = await adminFetch(`${API}/v1/admin/connections`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenantId: tenant, provider: "gmail", accountId: "shop@example.com",
      scopes: ["gmail.readonly"], refreshToken: REFRESH }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

function stored(tenant: string, key: string) {
  return runInDurableObject(vault(tenant), async (_instance, state) => state.storage.get<Stored>(key));
}

function reseal(tenant: string, body: unknown = { tenant }, headers: Record<string, string> = OPERATOR) {
  return adminFetch(`${API}/v1/admin/vault/reseal`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function audit(tenant: string) {
  const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as { entries: AuditEntry[] };
  return entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
}

describe("re-sealing a shop's vault after a key rotation", () => {
  it("seals every sign-in and connection again under the new key, after which the old key opens none of them", async () => {
    const tenant = fresh("vault:shop");
    const signInId = await signIn(tenant);
    const connectionId = await connection(tenant);

    const counts = await runInDurableObject(vault(tenant), async (_instance, state) => ({
      signIns: await resealStore(signInResealStore(state.storage, tenant), ROTATED),
      connections: await resealStore(connectionResealStore(state.storage, tenant), ROTATED),
    }));
    expect(counts).toEqual({ signIns: { resealed: 1, current: 0, unreadable: [], remaining: 0 },
      connections: { resealed: 1, current: 0, unreadable: [], remaining: 0 } });

    // Each now opens under the new key alone, with what it held before, and is no longer sealed under the old one.
    const newTag = await keyTag(NEW_KEY);
    const sealedSignIn = (await stored(tenant, `signin:${signInId}`))!.sealed;
    const sealedConnection = (await stored(tenant, `conn:${connectionId}`))!.sealed;
    expect([sealedSignIn.keyTag, sealedConnection.keyTag]).toEqual([newTag, newTag]);
    expect(await openSecret(sealedSignIn, NEW_KEY)).toBe(PASSWORD);
    expect(await openSecret(sealedConnection, NEW_KEY)).toBe(REFRESH);
    await expect(openSecret(sealedSignIn, OLD_KEY)).rejects.toThrow();

    // A second run finds nothing more to do.
    const again = await runInDurableObject(vault(tenant), async (_instance, state) =>
      resealStore(signInResealStore(state.storage, tenant), ROTATED));
    expect(again).toEqual({ resealed: 0, current: 1, unreadable: [], remaining: 0 });
  });

  it("names a seal that neither configured key opens, and leaves it as it is", async () => {
    const tenant = fresh("vault:shop");
    const signInId = await signIn(tenant);
    const lost = await sealSecret("a password nobody can open now", LOST_KEY);
    await runInDurableObject(vault(tenant), async (_instance, state) => {
      const record = (await state.storage.get<Stored>(`signin:${signInId}`))!;
      await state.storage.put(`signin:${signInId}`, { ...record, sealed: lost });
    });
    const count = await runInDurableObject(vault(tenant), async (_instance, state) =>
      resealStore(signInResealStore(state.storage, tenant), ROTATED));
    expect(count).toEqual({ resealed: 0, current: 0, unreadable: [signInId], remaining: 1 });
    expect((await stored(tenant, `signin:${signInId}`))!.sealed).toEqual(lost);
  });

  it("never brings back a sign-in removed, or a password replaced, while its seal was being made", async () => {
    const tenant = fresh("vault:shop");
    const removedId = await signIn(tenant);
    const replacedId = await signIn(tenant);
    const replacement = await sealSecret(`pw-replaced-${crypto.randomUUID()}`, NEW_KEY);
    // The sealing step lets other requests in; here they land in the middle of it, as a real removal and a real
    // replacement could.
    const count = await runInDurableObject(vault(tenant), async (_instance, state) =>
      resealStore(signInResealStore(state.storage, tenant), ROTATED, async (plaintext, hex) => {
        const removed = (await state.storage.get<Stored>(`signin:${removedId}`))!;
        if (!removed.removedAt) {
          await state.storage.put(`signin:${removedId}`, { ...removed, removedAt: new Date().toISOString(),
            sealed: { keyTag: "", iv: "", data: "" } });
        }
        const replaced = (await state.storage.get<Stored>(`signin:${replacedId}`))!;
        if (replaced.sealed.keyTag !== replacement.keyTag || replaced.sealed.data !== replacement.data) {
          await state.storage.put(`signin:${replacedId}`, { ...replaced, sealed: replacement });
        }
        return sealSecret(plaintext, hex);
      }));
    expect(count.resealed).toBe(0);
    expect(count.remaining).toBe(0);
    const removed = (await stored(tenant, `signin:${removedId}`))!;
    expect(removed.removedAt).not.toBeNull();
    expect(removed.sealed).toEqual({ keyTag: "", iv: "", data: "" });
    expect((await stored(tenant, `signin:${replacedId}`))!.sealed).toEqual(replacement);
  });

  it("leaves a revoked connection's tombstone without a secret", async () => {
    const tenant = fresh("vault:shop");
    const connectionId = await connection(tenant);
    const revoked = await vault(tenant).fetch(new Request(`https://cred/connections/${connectionId}`, {
      method: "DELETE", headers: { "x-tenant": tenant } }));
    expect(revoked.status).toBe(200);
    const count = await runInDurableObject(vault(tenant), async (_instance, state) =>
      resealStore(connectionResealStore(state.storage, tenant), ROTATED));
    expect(count).toEqual({ resealed: 0, current: 0, unreadable: [], remaining: 0 });
    expect((await stored(tenant, `conn:${connectionId}`))!.sealed).toEqual({ keyTag: "", iv: "", data: "" });
  });

  it("touches no other shop's records", async () => {
    const tenant = fresh("vault:shop");
    const other = fresh("vault:other");
    await signIn(tenant);
    const theirs = await signIn(other);
    const before = (await stored(other, `signin:${theirs}`))!.sealed;
    await runInDurableObject(vault(tenant), async (_instance, state) =>
      resealStore(signInResealStore(state.storage, tenant), ROTATED));
    expect((await stored(other, `signin:${theirs}`))!.sealed).toEqual(before);
  });
});

describe("POST /v1/admin/vault/reseal", () => {
  it("answers both stores' counts and writes vault.resealed, by the operator, with no ids", async () => {
    const tenant = fresh("vault:shop");
    await signIn(tenant);
    await connection(tenant);
    const response = await reseal(tenant);
    expect(response.status).toBe(200);
    // Everything the routes sealed is already under the configured key, so nothing needs sealing again.
    expect(await response.json()).toEqual({ connections: { resealed: 0, current: 1, unreadable: [], remaining: 0 },
      signIns: { resealed: 0, current: 1, unreadable: [], remaining: 0 } });
    const entries = await audit(tenant);
    expect(entries.at(-1)).toEqual({ actor: { kind: "operator", email: null }, action: "vault.resealed", subject: {},
      outcome: "ok" });
    // Nothing secret is in what the operator sees, or in the log.
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
    expect(JSON.stringify(entries)).not.toContain(REFRESH);
  });

  it("takes exactly a tenant, and nothing else", async () => {
    const tenant = fresh("vault:shop");
    expect((await reseal(tenant, { tenant, signInId: "x" })).status).toBe(400);
    expect((await reseal(tenant, {})).status).toBe(400);
    expect((await reseal(tenant, { tenant: "" })).status).toBe(400);
    expect((await reseal(tenant, [tenant])).status).toBe(400);
  });

  it("is the operator's only: no operator key, or a shop's own session, is refused", async () => {
    const tenant = fresh("vault:shop");
    const noKey = await reseal(tenant, { tenant }, { "content-type": "application/json" });
    expect([401, 403]).toContain(noKey.status);
    const session = await tenantSession(tenant);
    const asShop = await SELF.fetch(`${API}/v1/admin/vault/reseal`, { method: "POST",
      headers: { ...session, "content-type": "application/json" }, body: JSON.stringify({ tenant }) });
    expect([401, 403]).toContain(asShop.status);
  });
});
