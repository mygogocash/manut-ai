import { adminFetch } from "./authenticated-fixtures";
import { sourceWorker } from "./source-worker";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../src/audit-log";
import { sha256Hex } from "../src/auth";
import type { Env } from "../src/index";
import { tenantCall } from "../src/tenant-data";

// Outposts, the machines the team's browser runs on (docs/browser-control.md): registered by an operator with a
// credential of their own, given once; online while they beat, asleep once they stop.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const API = "https://api.manut.test";
const CREDENTIAL = /^mo1_[A-Za-z0-9_-]{43}$/;

let counter = 0;
const fresh = (label: string) => `${label}-${Date.now()}-${counter++}`;

type Outpost = {
  id: string;
  name: string;
  kind: "this_mac" | "cloud";
  status: "online" | "asleep";
  lastHeartbeatAt: string | null;
  createdAt: string;
};

function register(tenant: string, overrides: Record<string, unknown> = {}) {
  return adminFetch(`${API}/v1/admin/outposts`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, name: "This Mac", kind: "this_mac", ...overrides }) });
}

async function registered(tenant: string, overrides: Record<string, unknown> = {}) {
  const response = await register(tenant, overrides);
  expect(response.status).toBe(200);
  return (await response.json()) as { outpost: Outpost; credential: string };
}

async function list(tenant: string) {
  const response = await adminFetch(`${API}/v1/admin/outposts?tenant=${encodeURIComponent(tenant)}`,
    { headers: OPERATOR });
  expect(response.status).toBe(200);
  return (await response.json()) as { tenant: string; outposts: Outpost[] };
}

function remove(tenant: string, outpostId: unknown) {
  return adminFetch(`${API}/v1/admin/outposts/remove`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, outpostId }) });
}

function rotate(tenant: string, outpostId: unknown) {
  return adminFetch(`${API}/v1/admin/outposts/credential`, { method: "POST", headers: OPERATOR,
    body: JSON.stringify({ tenant, outpostId }) });
}

function heartbeat(tenant: string, outpostId: unknown, credential?: string) {
  return sourceWorker.fetch(`${API}/v1/outposts/heartbeat`, { method: "POST", headers: {
    "content-type": "application/json", ...(credential !== undefined ? { authorization: `Bearer ${credential}` } : {}),
  }, body: JSON.stringify({ tenant, outpostId }) });
}

function vault(tenant: string) {
  return bindings.CRED.get(bindings.CRED.idFromName(`t:${tenant}`));
}

/// Moves the outpost's last heartbeat `seconds` into the past, as if it had stopped beating then.
async function lastBeatAgo(tenant: string, outpostId: string, seconds: number) {
  await runInDurableObject(vault(tenant), async (_instance, state) => {
    const record = await state.storage.get<Record<string, unknown>>(`outpost:${outpostId}`);
    await state.storage.put(`outpost:${outpostId}`,
      { ...record, lastHeartbeatAt: new Date(Date.now() - seconds * 1000).toISOString() });
  });
}

async function audit(tenant: string) {
  const response = await tenantCall(bindings, tenant, `/audit?tenant=${encodeURIComponent(tenant)}&limit=200`);
  expect(response.status).toBe(200);
  const { entries } = (await response.json()) as { entries: AuditEntry[] };
  return entries.reverse().map(({ id: _id, at: _at, ...said }) => said);
}

describe("outposts", () => {
  it("registers an outpost and gives its credential once, keeping only its digest", async () => {
    const tenant = fresh("outpost:shop");
    const response = await register(tenant);
    expect(response.status).toBe(200);
    const { outpost, credential } = (await response.json()) as { outpost: Outpost; credential: string };
    expect(credential).toMatch(CREDENTIAL);
    // Asleep until its first beat.
    expect(outpost).toEqual({ id: expect.any(String), name: "This Mac", kind: "this_mac", status: "asleep",
      lastHeartbeatAt: null, createdAt: expect.any(String) });

    const listed = await adminFetch(`${API}/v1/admin/outposts?tenant=${encodeURIComponent(tenant)}`,
      { headers: OPERATOR });
    const text = await listed.text();
    expect(JSON.parse(text)).toEqual({ tenant, outposts: [outpost] });
    expect(text).not.toContain(credential);
    expect(text).not.toContain(await sha256Hex(credential));

    const stored = await runInDurableObject(vault(tenant), (_instance, state) =>
      state.storage.get<Record<string, unknown>>(`outpost:${outpost.id}`));
    expect(stored?.credentialHash).toBe(await sha256Hex(credential));
    expect(JSON.stringify(stored)).not.toContain(credential);

    expect(await audit(tenant)).toEqual([{ actor: { kind: "operator", email: null }, action: "outpost.registered",
      subject: { outpostId: outpost.id }, outcome: "ok" }]);
  });

  it("registers a cloud outpost, with a credential of its own", async () => {
    const tenant = fresh("outpost:shop");
    const mac = await registered(tenant);
    const cloud = await registered(tenant, { name: "Cloud outpost", kind: "cloud" });
    expect(cloud.outpost).toMatchObject({ name: "Cloud outpost", kind: "cloud", status: "asleep" });
    expect(cloud.credential).not.toBe(mac.credential);
    expect((await list(tenant)).outposts.map((outpost) => outpost.id)).toEqual([mac.outpost.id, cloud.outpost.id]);
  });

  it.each([
    [{ tenant: "" }, "tenant_required"],
    [{ name: "   " }, "invalid_name"],
    [{ name: "x".repeat(81) }, "invalid_name"],
    [{ kind: "phone" }, "invalid_kind"],
    [{ kind: undefined }, "invalid_kind"],
  ])("refuses %j with %s and registers nothing", async (overrides, error) => {
    const tenant = fresh("outpost:shop");
    const response = await register(tenant, overrides);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    if (error !== "tenant_required") expect((await list(tenant)).outposts).toEqual([]);
  });

  it("is online after a heartbeat, and asleep once its beats stop for 90 seconds", async () => {
    const tenant = fresh("outpost:shop");
    const { outpost, credential } = await registered(tenant);
    const beat = await heartbeat(tenant, outpost.id, credential);
    expect(beat.status).toBe(200);
    const { outpost: beating } = (await beat.json()) as { outpost: Outpost };
    expect(beating).toEqual({ ...outpost, status: "online", lastHeartbeatAt: expect.any(String) });
    expect((await list(tenant)).outposts).toEqual([beating]);

    await lastBeatAgo(tenant, outpost.id, 89);
    expect((await list(tenant)).outposts[0]?.status).toBe("online");
    await lastBeatAgo(tenant, outpost.id, 91);
    expect((await list(tenant)).outposts[0]?.status).toBe("asleep");

    expect((await heartbeat(tenant, outpost.id, credential)).status).toBe(200);
    expect((await list(tenant)).outposts[0]?.status).toBe("online");
    // A heartbeat changes only the time, and the log is not written for it.
    expect((await audit(tenant)).map((entry) => entry.action)).toEqual(["outpost.registered"]);
  });

  it("refuses a heartbeat without the outpost's own credential, and records no beat", async () => {
    const tenant = fresh("outpost:shop");
    const other = fresh("outpost:other-shop");
    const { outpost, credential } = await registered(tenant);
    const sibling = await registered(tenant, { name: "Cloud outpost", kind: "cloud" });
    const foreign = await registered(other);
    for (const refused of [
      heartbeat(tenant, outpost.id),
      heartbeat(tenant, outpost.id, `mo1_${"A".repeat(43)}`),
      heartbeat(tenant, outpost.id, sibling.credential),
      heartbeat(tenant, outpost.id, "test-key"),
      heartbeat(tenant, foreign.outpost.id, foreign.credential),
      heartbeat(other, outpost.id, credential),
      heartbeat(tenant, crypto.randomUUID(), credential),
      heartbeat(tenant, 42, credential),
    ]) {
      const response = await refused;
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect((await list(tenant)).outposts.map((entry) => [entry.id, entry.status])).toEqual([
      [outpost.id, "asleep"], [sibling.outpost.id, "asleep"]]);
  });

  it("keeps each shop's outposts to itself", async () => {
    const tenant = fresh("outpost:shop");
    await registered(tenant);
    expect((await list(fresh("outpost:other-shop"))).outposts).toEqual([]);
  });

  it("rotates an outpost's credential: the new one is shown once, and the old one stops at once", async () => {
    const tenant = fresh("outpost:shop");
    const { outpost, credential: old } = await registered(tenant);
    expect((await heartbeat(tenant, outpost.id, old)).status).toBe(200);

    const response = await rotate(tenant, outpost.id);
    expect(response.status).toBe(200);
    const { outpost: rotated, credential } = (await response.json()) as { outpost: Outpost; credential: string };
    expect(credential).toMatch(CREDENTIAL);
    expect(credential).not.toBe(old);
    // Asleep until the holder of the new credential beats: the old holder's beats no longer count.
    expect(rotated).toEqual({ ...outpost, status: "asleep", lastHeartbeatAt: null });
    expect((await list(tenant)).outposts).toEqual([rotated]);

    expect((await heartbeat(tenant, outpost.id, old)).status).toBe(401);
    expect((await heartbeat(tenant, outpost.id, credential)).status).toBe(200);
    const stored = await runInDurableObject(vault(tenant), (_instance, state) =>
      state.storage.get<Record<string, unknown>>(`outpost:${outpost.id}`));
    expect(stored?.credentialHash).toBe(await sha256Hex(credential));
    expect(JSON.stringify(stored)).not.toContain(credential);
    const listed = await (await adminFetch(`${API}/v1/admin/outposts?tenant=${encodeURIComponent(tenant)}`,
      { headers: OPERATOR })).text();
    expect(listed).not.toContain(credential);
    expect(listed).not.toContain(await sha256Hex(credential));

    expect(await audit(tenant)).toEqual([
      { actor: { kind: "operator", email: null }, action: "outpost.registered", subject: { outpostId: outpost.id },
        outcome: "ok" },
      { actor: { kind: "operator", email: null }, action: "outpost.credential_rotated",
        subject: { outpostId: outpost.id }, outcome: "ok" },
    ]);
  });

  it("removes an outpost: it leaves the list, and its credential stops working", async () => {
    const tenant = fresh("outpost:shop");
    const { outpost, credential } = await registered(tenant);
    const sibling = await registered(tenant, { name: "Cloud outpost", kind: "cloud" });
    expect((await heartbeat(tenant, outpost.id, credential)).status).toBe(200);

    const response = await remove(tenant, outpost.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true, outpostId: outpost.id, grantsRefused: 0 });
    expect((await list(tenant)).outposts.map((entry) => entry.id)).toEqual([sibling.outpost.id]);
    expect((await heartbeat(tenant, outpost.id, credential)).status).toBe(401);
    expect(await runInDurableObject(vault(tenant), (_instance, state) => state.storage.get(`outpost:${outpost.id}`)))
      .toBeUndefined();
    expect((await audit(tenant)).at(-1)).toEqual({ actor: { kind: "operator", email: null }, action: "outpost.removed",
      subject: { outpostId: outpost.id }, outcome: "ok" });

    // Removed is gone: a second removal and a rotation find nothing, and write nothing to the log.
    for (const again of [await remove(tenant, outpost.id), await rotate(tenant, outpost.id)]) {
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual({ error: "outpost_not_found" });
    }
    expect((await audit(tenant)).map((entry) => entry.action)).toEqual(["outpost.registered", "outpost.registered",
      "outpost.removed"]);
  });

  it.each(["remove", "rotate"] as const)("refuses to %s an outpost it cannot find, or another shop's", async (how) => {
    const tenant = fresh("outpost:shop");
    const other = fresh("outpost:other-shop");
    const foreign = await registered(other);
    const call = how === "remove" ? remove : rotate;
    for (const outpostId of [crypto.randomUUID(), "not-an-outpost", 42, foreign.outpost.id]) {
      const response = await call(tenant, outpostId);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "outpost_not_found" });
    }
    const response = await call("", foreign.outpost.id);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "tenant_required" });
    // The other shop's outpost is untouched.
    expect((await heartbeat(other, foreign.outpost.id, foreign.credential)).status).toBe(200);
    expect(await audit(tenant)).toEqual([]);
  });

  it("is reached only through exact routes", async () => {
    const tenant = fresh("outpost:shop");
    for (const [method, path] of [["PUT", "/v1/admin/outposts"], ["GET", "/v1/admin/outposts/remove"],
      ["GET", "/v1/admin/outposts/credential"], ["DELETE", "/v1/admin/outposts"], ["POST", "/v1/admin/outposts/x"]] as const) {
      expect((await adminFetch(`${API}${path}`, { method, headers: OPERATOR,
        ...(method === "GET" ? {} : { body: JSON.stringify({ tenant }) }) })).status).toBe(404);
    }
    for (const path of ["/v1/admin/outposts/remove", "/v1/admin/outposts/credential"]) {
      expect((await SELF.fetch(`${API}${path}`, { method: "POST", headers: OPERATOR,
        body: JSON.stringify({ tenant, outpostId: crypto.randomUUID() }) })).status).toBe(403);
    }
    expect((await SELF.fetch(`${API}/v1/outposts/heartbeat`)).status).toBe(404);
    expect((await SELF.fetch(`${API}/v1/outposts`, { method: "POST", body: "{}" })).status).toBe(404);
    // Without Cloudflare Access the operator key alone registers nothing.
    expect((await SELF.fetch(`${API}/v1/admin/outposts`, { method: "POST", headers: OPERATOR,
      body: JSON.stringify({ tenant, name: "This Mac", kind: "this_mac" }) })).status).toBe(403);
  });
});
