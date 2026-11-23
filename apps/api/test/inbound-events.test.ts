import { adminFetch, tenantSession } from "./authenticated-fixtures";
import { sourceWorker as SELF } from "./source-worker";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { INBOUND_TIMESTAMP_TOLERANCE_MS, linearEventType, verifyLinearSignature } from "../src/inbound";

// ofc22-inbound-events-cloud: signed Linear webhooks behind officeInbound
// become at most one attention item per delivery, and nothing else.
//
// Every delivery here is synthetic: the body is built in the test and signed
// with the committed test-only secret in wrangler.test.json. No request
// reaches Linear, and the inbound route makes no outbound call of its own, so
// nothing needs stubbing. A real delivery counts only as the owner's
// H-OFC22-webhook check, per docs/office-connections.md section 7.

const OPERATOR = { authorization: "Bearer test-key" };
const SECRET = "test-linear-webhook-secret";
const PROJECT = "project-allowed";
const TITLE = "Quarterly numbers leaked in title";
const DESCRIPTION = "Private description text that must never be stored";

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

async function setInbound(enabled: boolean) {
  const response = await adminFetch("https://test/v1/admin/flags", {
    method: "PUT",
    headers: { "content-type": "application/json", ...OPERATOR },
    body: JSON.stringify({ officeInbound: enabled }),
  });
  expect(response.status).toBe(200);
}

async function storeConnection(tenant: string, organizationId: string, resourceIds = [PROJECT]) {
  const response = await adminFetch("https://test/v1/admin/connections", {
    method: "POST",
    headers: { "content-type": "application/json", ...OPERATOR },
    body: JSON.stringify({
      tenantId: tenant,
      provider: "linear",
      accountId: organizationId,
      scopes: ["read"],
      refreshToken: "linear-test-credential",
      resourceIds,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
}

function issueEvent(organizationId: string, overrides: Record<string, unknown> = {}) {
  return {
    action: "update",
    type: "Issue",
    actor: { id: "user-1", name: "Ann", type: "user" },
    createdAt: new Date().toISOString(),
    url: "https://linear.app/sandbox/issue/GO-1",
    organizationId,
    webhookId: "webhook-1",
    webhookTimestamp: Date.now(),
    data: {
      id: "issue-1",
      identifier: "GO-1",
      title: TITLE,
      description: DESCRIPTION,
      projectId: PROJECT,
      teamId: "team-1",
    },
    ...overrides,
  };
}

async function sign(raw: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type DeliveryOptions = { deliveryId?: string | null; signature?: string | null; signedRaw?: string };

/// Posts a delivery the way Linear does. By default the signature covers the
/// exact bytes sent; `signedRaw` signs other bytes to model tampering, and a
/// null signature or delivery id leaves that header out.
async function deliver(payload: unknown, options: DeliveryOptions = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "linear-event": "Issue" };
  const signature = options.signature === undefined ? await sign(options.signedRaw ?? raw) : options.signature;
  if (signature !== null) headers["linear-signature"] = signature;
  const deliveryId = options.deliveryId === undefined ? crypto.randomUUID() : options.deliveryId;
  if (deliveryId !== null) headers["linear-delivery"] = deliveryId;
  return SELF.fetch("https://test/v1/inbound/linear", { method: "POST", headers, body: raw });
}

/// The route index rows for a workspace, read straight from AuthObject: no
/// Worker route exposes them.
async function routesFor(organizationId: string): Promise<unknown[]> {
  const auth = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
  const response = await auth
    .get(auth.idFromName("auth"))
    .fetch(`https://auth/inbound-routes?provider=linear&account=${encodeURIComponent(organizationId)}`);
  return ((await response.json()) as { routes: unknown[] }).routes;
}

type Item = { id: string; connectionId: string; eventType: string; issueId: string; receivedAt: string };

async function attention(tenant: string): Promise<Item[]> {
  const response = await SELF.fetch(
    `https://test/v1/inbound/attention?tenant=${encodeURIComponent(tenant)}`,
    { headers: await tenantSession(tenant, false) },
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: Item[] }).items;
}

// Compact identity minter, as in consent.test.ts: a session is only a means
// to a tenant here. Full rejection coverage lives in auth.test.ts.
const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};
const NONCE = "inbound-nonce";

function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function derEncode(r: Uint8Array, s: Uint8Array): Uint8Array {
  const strip = (part: Uint8Array) => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const cut = part.slice(i);
    return cut[0]! >= 128 ? new Uint8Array([0, ...cut]) : cut;
  };
  const rEnc = strip(r);
  const sEnc = strip(s);
  const out = new Uint8Array(2 + 2 + rEnc.length + 2 + sEnc.length);
  out[0] = 0x30;
  out[1] = out.length - 2;
  out[2] = 0x02;
  out[3] = rEnc.length;
  out.set(rEnc, 4);
  out[4 + rEnc.length] = 0x02;
  out[5 + rEnc.length] = sEnc.length;
  out.set(sEnc, 6 + rEnc.length);
  return out;
}

async function sessionFor(sub: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    TEST_PRIVATE_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(NONCE));
  const nonce = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: "test-key-1", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({ iss: "https://appleid.apple.com", aud: "test-client", sub, iat: now - 60, exp: now + 600, nonce }),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`)),
  );
  const half = signature.length / 2;
  const token = `${header}.${payload}.${base64Url(derEncode(signature.slice(0, half), signature.slice(half)))}`;
  const response = await SELF.fetch("https://test/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken: token, nonce: NONCE, deviceId: `device-${sub}` }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

describe("inbound signature and event checks", () => {
  it("verifies the hex HMAC of the exact bytes and fails closed", async () => {
    const raw = new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer;
    const good = await sign('{"a":1}');
    expect(await verifyLinearSignature(SECRET, raw, good)).toBe(true);
    expect(await verifyLinearSignature(SECRET, raw, good.toUpperCase())).toBe(true);
    expect(await verifyLinearSignature(SECRET, raw, await sign('{"a":2}'))).toBe(false);
    expect(await verifyLinearSignature("other-secret", raw, good)).toBe(false);
    expect(await verifyLinearSignature(undefined, raw, good)).toBe(false);
    expect(await verifyLinearSignature(SECRET, raw, null)).toBe(false);
    expect(await verifyLinearSignature(SECRET, raw, "not-hex")).toBe(false);
  });

  it("takes issue changes only", () => {
    expect(linearEventType("Issue", "create")).toBe("linear.issue.create");
    expect(linearEventType("Issue", "update")).toBe("linear.issue.update");
    expect(linearEventType("Issue", "remove")).toBe("linear.issue.remove");
    expect(linearEventType("Comment", "create")).toBeNull();
    expect(linearEventType("Issue", "archive")).toBeNull();
    expect(linearEventType(undefined, undefined)).toBeNull();
  });
});

describe("inbound Linear webhooks", () => {
  it("is not there while officeInbound is off, and stores nothing", async () => {
    await setInbound(false);
    const tenant = fresh("inbound-off");
    const organization = fresh("org-off");
    await storeConnection(tenant, organization);

    const refused = await deliver(issueEvent(organization));
    const missing = await SELF.fetch("https://test/v1/inbound/no-such-route", { method: "POST", body: "{}" });
    // Byte for byte what a path that does not exist answers.
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(await missing.text());

    const read = await SELF.fetch(`https://test/v1/inbound/attention?tenant=${tenant}`, { headers: await tenantSession(tenant, false) });
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: "feature_disabled", feature: "officeInbound" });

    await setInbound(true);
    expect(await attention(tenant)).toEqual([]);
  });

  it("refuses unsigned, mis-signed, tampered and stale deliveries with no body", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-unsigned");
    const organization = fresh("org-unsigned");
    await storeConnection(tenant, organization);
    const event = issueEvent(organization);

    const refusals = [
      await deliver(event, { signature: null }),
      await deliver(event, { signature: "" }),
      await deliver(event, { signature: "abc123" }),
      await deliver(event, { signature: await sign(JSON.stringify(event), "wrong-secret") }),
      await deliver(event, { signedRaw: JSON.stringify({ ...event, organizationId: "someone-else" }) }),
      await deliver(issueEvent(organization, { webhookTimestamp: Date.now() - INBOUND_TIMESTAMP_TOLERANCE_MS - 5000 })),
      await deliver(issueEvent(organization, { webhookTimestamp: Date.now() + INBOUND_TIMESTAMP_TOLERANCE_MS + 5000 })),
      await deliver(issueEvent(organization, { webhookTimestamp: "now" })),
    ];
    for (const response of refusals) {
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    }
    expect(await attention(tenant)).toEqual([]);
  });

  it("refuses a signed delivery it cannot deduplicate or parse", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-malformed");
    const organization = fresh("org-malformed");
    await storeConnection(tenant, organization);

    const noDelivery = await deliver(issueEvent(organization), { deliveryId: null });
    expect(noDelivery.status).toBe(400);
    expect(await noDelivery.text()).toBe("");

    const raw = "not json";
    const garbled = await SELF.fetch("https://test/v1/inbound/linear", {
      method: "POST",
      headers: { "linear-signature": await sign(raw), "linear-delivery": crypto.randomUUID() },
      body: raw,
    });
    expect(garbled.status).toBe(400);
    expect(await garbled.text()).toBe("");
    expect(await attention(tenant)).toEqual([]);
  });

  it("stores one item for a delivery however often it repeats", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-replay");
    const organization = fresh("org-replay");
    const connectionId = await storeConnection(tenant, organization);
    const event = issueEvent(organization);
    const deliveryId = crypto.randomUUID();

    const first = await deliver(event, { deliveryId });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("");
    const again = await deliver(event, { deliveryId });
    // A duplicate answers exactly like the first delivery.
    expect(again.status).toBe(200);
    expect(await again.text()).toBe("");
    // Copies racing each other still land once.
    const racing = await Promise.all([1, 2, 3].map(() => deliver(event, { deliveryId })));
    for (const response of racing) expect(response.status).toBe(200);

    const items = await attention(tenant);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ connectionId, eventType: "linear.issue.update", issueId: "issue-1" });

    // A separate delivery is a separate event, even about the same issue.
    expect((await deliver(issueEvent(organization, { action: "remove" }))).status).toBe(200);
    const after = await attention(tenant);
    expect(after.map((item) => item.eventType)).toEqual(["linear.issue.remove", "linear.issue.update"]);
  });

  it("answers an unknown workspace, a denied project or a revoked connection like a duplicate", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-unknown");
    const organization = fresh("org-unknown");
    const connectionId = await storeConnection(tenant, organization);

    const stored = await deliver(issueEvent(organization));
    const storedText = await stored.text();
    expect(stored.status).toBe(200);

    const quiet = [
      // A workspace no connection names.
      await deliver(issueEvent(fresh("org-nobody"))),
      // A project outside the grant, and an issue with no project at all.
      await deliver(issueEvent(organization, { data: { id: "issue-2", title: TITLE, projectId: "project-denied" } })),
      await deliver(issueEvent(organization, { data: { id: "issue-3", title: TITLE } })),
      // A kind of event that cannot be shown to fall inside the grant.
      await deliver(issueEvent(organization, { type: "Comment", data: { id: "comment-1", issueId: "issue-1" } })),
    ];
    for (const response of quiet) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe(storedText);
      expect(text).not.toContain(tenant);
      expect(text).not.toContain(connectionId);
    }
    expect(await attention(tenant)).toHaveLength(1);

    // After disconnect the vault no longer vouches for the connection.
    const revoked = await SELF.fetch(
      `https://test/v1/connections/${connectionId}?tenant=${encodeURIComponent(tenant)}`,
      { method: "DELETE", headers: await tenantSession(tenant, false) },
    );
    expect(revoked.status).toBe(200);
    const afterRevoke = await deliver(issueEvent(organization));
    expect(afterRevoke.status).toBe(200);
    expect(await afterRevoke.text()).toBe(storedText);
    expect(await attention(tenant)).toHaveLength(1);
  });

  it("checks the grant of each connection on a shared workspace and stores one item", async () => {
    await setInbound(true);
    const organization = fresh("org-shared");
    const older = fresh("inbound-older");
    const newer = fresh("inbound-newer");
    const olderId = await storeConnection(older, organization, ["project-older"]);
    const newerId = await storeConnection(newer, organization, ["project-newer"]);

    // Only the older connection was granted this project: the newer one,
    // asked first, must not swallow the event.
    const olderEvent = issueEvent(organization, { data: { id: "issue-older", projectId: "project-older" } });
    expect((await deliver(olderEvent)).status).toBe(200);
    // Granted to the newer connection only.
    const newerEvent = issueEvent(organization, { data: { id: "issue-newer", projectId: "project-newer" } });
    expect((await deliver(newerEvent)).status).toBe(200);

    expect((await attention(older)).map((item) => [item.connectionId, item.issueId])).toEqual([
      [olderId, "issue-older"],
    ]);
    expect((await attention(newer)).map((item) => [item.connectionId, item.issueId])).toEqual([
      [newerId, "issue-newer"],
    ]);
  });

  it("keeps ids only, never the issue's title or description", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-ids");
    const organization = fresh("org-ids");
    await storeConnection(tenant, organization);
    expect((await deliver(issueEvent(organization, { action: "create" }))).status).toBe(200);

    const items = await attention(tenant);
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]!).sort()).toEqual(["connectionId", "eventType", "id", "issueId", "receivedAt"]);
    const exported = await SELF.fetch(`https://test/v1/tenant/export?tenant=${encodeURIComponent(tenant)}`, {
      headers: await tenantSession(tenant, false),
    });
    expect(exported.status).toBe(200);
    const text = await exported.text();
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(DESCRIPTION);
    expect(text).not.toContain("GO-1");
  });

  it("starts no task, proposal or run", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-nowork");
    const organization = fresh("org-nowork");
    await storeConnection(tenant, organization);
    for (const action of ["create", "update", "remove"]) {
      expect((await deliver(issueEvent(organization, { action }))).status).toBe(200);
    }
    const exported = await SELF.fetch(`https://test/v1/tenant/export?tenant=${encodeURIComponent(tenant)}`, {
      headers: await tenantSession(tenant, false),
    });
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as { tasks: unknown[]; schedules: unknown[]; attention: unknown[] };
    // The tenant's task index is what every task, proposal and attempt hangs
    // off; it stays empty, and so do schedules. Only the items exist.
    expect(body.tasks).toEqual([]);
    expect(body.schedules).toEqual([]);
    expect(body.attention).toHaveLength(3);
  });

  it("shows a session only its own tenant's items", async () => {
    await setInbound(true);
    const sub = fresh("inbound-sub");
    const organization = fresh("org-session");
    await storeConnection(`apple:${sub}`, organization);
    expect((await deliver(issueEvent(organization))).status).toBe(200);

    const own = await sessionFor(sub);
    const other = await sessionFor(fresh("inbound-other"));
    const mine = await SELF.fetch("https://test/v1/inbound/attention", { headers: { authorization: `Bearer ${own}` } });
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { items: Item[] }).items).toHaveLength(1);
    // The tenant comes from the session; a tenant in the query is ignored.
    const theirs = await SELF.fetch(
      `https://test/v1/inbound/attention?tenant=${encodeURIComponent(`apple:${sub}`)}`,
      { headers: { authorization: `Bearer ${other}` } },
    );
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as { items: Item[] }).items).toEqual([]);
    expect((await SELF.fetch("https://test/v1/inbound/attention")).status).toBe(401);
  });

  it("never routes a workspace's events to a session that names it", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-owner");
    const organization = fresh("org-claimed");
    await storeConnection(tenant, organization);

    // A session may store its own Linear connection, but the account id is
    // only its word: it gets no inbound route, so the operator-provisioned
    // connection keeps the workspace's events.
    const sub = fresh("inbound-claimant");
    const claimant = await sessionFor(sub);
    const claimed = await SELF.fetch("https://test/v1/connections", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${claimant}` },
      body: JSON.stringify({
        provider: "linear",
        accountId: organization,
        scopes: ["read"],
        refreshToken: "claimed-credential",
        resourceIds: [PROJECT],
      }),
    });
    expect(claimed.status).toBe(200);
    expect(await routesFor(organization)).toHaveLength(1);

    expect((await deliver(issueEvent(organization))).status).toBe(200);
    expect(await attention(tenant)).toHaveLength(1);
    expect(await attention(`apple:${sub}`)).toEqual([]);
  });

  it("forgets items and routes when the tenant is deleted", async () => {
    await setInbound(true);
    const tenant = fresh("inbound-wipe");
    const organization = fresh("org-wipe");
    await storeConnection(tenant, organization);
    expect((await deliver(issueEvent(organization))).status).toBe(200);
    expect(await attention(tenant)).toHaveLength(1);
    expect(await routesFor(organization)).toHaveLength(1);

    const wiped = await SELF.fetch(`https://test/v1/tenant/data?tenant=${encodeURIComponent(tenant)}`, {
      method: "DELETE",
      headers: await tenantSession(tenant, false),
    });
    expect(wiped.status).toBe(200);
    expect(await attention(tenant)).toEqual([]);
    expect(await routesFor(organization)).toEqual([]);
    expect((await deliver(issueEvent(organization))).status).toBe(200);
    expect(await attention(tenant)).toEqual([]);
  });
});
