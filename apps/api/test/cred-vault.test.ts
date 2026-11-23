import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readConnectionSecret } from "../src/cred-broker";
import { keyTag, openSecret, sealSecret } from "../src/cred-crypto";

const OPERATOR = { authorization: "Bearer test-key" };
const TENANT_A = "apple:tenant-a";
const TENANT_B = "apple:tenant-b";
// Committed test-only vault key, matching wrangler.test.json. Production
// uses a real secret and never sees this value.
const VAULT_KEY = "48b0c940489d799edf8202d721c46affd57351019df8ccc01579fbb82d2b2569";
const OTHER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

type Stub = { fetch(request: Request): Promise<Response> };
type Namespace = { idFromName(id: string): unknown; get(id: unknown): Stub };

function cred(): Namespace {
  return (env as unknown as { CRED: Namespace }).CRED;
}

function stub(tenant: string = TENANT_A): Stub {
  const ns = cred();
  return ns.get(ns.idFromName(`t:${tenant || "operator"}`));
}

async function storeConnection(tenant: string, overrides: Record<string, unknown> = {}) {
  return adminFetch("https://test/v1/admin/connections", {
    method: "POST",
    headers: { "content-type": "application/json", ...OPERATOR },
    body: JSON.stringify({
      tenantId: tenant,
      provider: "gmail",
      accountId: "user@example.com",
      scopes: ["gmail.readonly"],
      refreshToken: "refresh-secret-value",
      ...overrides,
    }),
  });
}

async function listConnections(tenant: string) {
  return SELF.fetch(`https://test/v1/connections?tenant=${encodeURIComponent(tenant)}`, {
    headers: await tenantSession(tenant, false),
  });
}

describe("credential crypto", () => {
  it("round-trips through the current key", async () => {
    const sealed = await sealSecret("s3cret", VAULT_KEY);
    expect(await openSecret(sealed, VAULT_KEY)).toBe("s3cret");
    expect(sealed.keyTag).toBe(await keyTag(VAULT_KEY));
  });

  it("falls back to the previous key after rotation", async () => {
    const sealed = await sealSecret("s3cret", OTHER_KEY);
    expect(await openSecret(sealed, VAULT_KEY, OTHER_KEY)).toBe("s3cret");
  });

  it("fails closed on unknown tags, wrong keys, and bad key material", async () => {
    const sealed = await sealSecret("s3cret", VAULT_KEY);
    await expect(openSecret({ ...sealed, keyTag: "deadbeefcafe" }, VAULT_KEY, OTHER_KEY)).rejects.toThrow();
    await expect(openSecret(sealed, OTHER_KEY)).rejects.toThrow();
    await expect(sealSecret("x", "short")).rejects.toThrow();
  });
});

describe("credential vault", () => {
  it("stores secrets and lists metadata without secret material", async () => {
    const stored = await storeConnection(TENANT_A);
    expect(stored.status).toBe(200);
    const { id } = (await stored.json()) as { id: string };
    expect(typeof id).toBe("string");

    const listed = await listConnections(TENANT_A);
    expect(listed.status).toBe(200);
    const { connections } = (await listed.json()) as { connections: Record<string, unknown>[] };
    const entry = connections.find((connection) => connection.id === id);
    expect(entry).toMatchObject({ id, provider: "gmail", accountId: "user@example.com" });
    expect(entry).not.toHaveProperty("sealed");
    expect(entry).not.toHaveProperty("refreshToken");

    // The broker path unseals for connector code with the right tenant.
    expect(await readConnectionSecret({ CRED: cred() } as never, id, TENANT_A)).toBe("refresh-secret-value");
  });

  it("rejects unknown providers and missing tenants", async () => {
    const badProvider = await storeConnection(TENANT_A, { provider: "universe" });
    expect(badProvider.status).toBe(400);
    const noTenant = await adminFetch("https://test/v1/admin/connections", {
      method: "POST",
      headers: { "content-type": "application/json", ...OPERATOR },
      body: JSON.stringify({ provider: "gmail", accountId: "u@e.com", scopes: [], refreshToken: "x" }),
    });
    expect(noTenant.status).toBe(400);
  });

  it("isolates tenants without leaking existence", async () => {
    const stored = await storeConnection(TENANT_A);
    const { id } = (await stored.json()) as { id: string };
    // Another tenant's listing succeeds but reveals nothing of this record:
    // no existence oracle, no contents.
    const foreign = await listConnections(TENANT_B);
    expect(foreign.status).toBe(200);
    const { connections } = (await foreign.json()) as { connections: { id?: string }[] };
    expect(connections.some((connection) => connection.id === id)).toBe(false);
    expect(
      (
        await SELF.fetch(`https://test/v1/connections/${id}?tenant=${encodeURIComponent(TENANT_B)}`, {
          method: "DELETE",
          headers: await tenantSession(TENANT_B, false),
        })
      ).status,
    ).toBe(404);
    await expect(readConnectionSecret({ CRED: cred() } as never, id, TENANT_B)).rejects.toThrow();
  });

  it("serializes refresh leases per connection", async () => {
    const { id } = (await (await storeConnection(TENANT_A)).json()) as { id: string };
    const lease = (body: object) =>
      stub().fetch(
        new Request("https://cred/lease", {
          method: "POST",
          headers: { "content-type": "application/json", "x-tenant": TENANT_A },
          body: JSON.stringify(body),
        }),
      );
    expect((await (await lease({ id })).json()) as { lease?: boolean }).toEqual({ lease: true });
    expect((await lease({ id })).status).toBe(409);
    const release = await stub().fetch(
      new Request("https://cred/release", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant": TENANT_A },
        body: JSON.stringify({ id }),
      }),
    );
    expect(release.status).toBe(200);
    expect((await (await lease({ id })).json()) as { lease?: boolean }).toEqual({ lease: true });
  });

  it("revokes into a tombstone that stays dead", async () => {
    const { id } = (await (await storeConnection(TENANT_A)).json()) as { id: string };
    const revoked = await SELF.fetch(`https://test/v1/connections/${id}?tenant=${encodeURIComponent(TENANT_A)}`, {
      method: "DELETE",
      headers: await tenantSession(TENANT_A, false),
    });
    expect(revoked.status).toBe(200);
    const { connections } = (await (await listConnections(TENANT_A)).json()) as {
      connections: { id?: string }[];
    };
    expect(connections.some((connection) => connection.id === id)).toBe(false);
    await expect(readConnectionSecret({ CRED: cred() } as never, id, TENANT_A)).rejects.toThrow();
  });

  it("rekeys under the current key", async () => {
    const { id } = (await (await storeConnection(TENANT_A)).json()) as { id: string };
    const rekeyed = await stub().fetch(
      new Request("https://cred/rekey", {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant": TENANT_A },
        body: JSON.stringify({ id }),
      }),
    );
    expect(rekeyed.status).toBe(200);
    expect(((await rekeyed.json()) as { keyTag?: string }).keyTag).toBe(await keyTag(VAULT_KEY));
    expect(await readConnectionSecret({ CRED: cred() } as never, id, TENANT_A)).toBe("refresh-secret-value");
  });
});
