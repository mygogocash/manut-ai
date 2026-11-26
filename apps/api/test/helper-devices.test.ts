import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { HELPER_SESSION_TTL_MS } from "../src/people";
import type { PeopleRecord } from "../src/people-store";
import { tenantStub } from "../src/tenant-data";
import { tenantSession } from "./authenticated-fixtures";
import {
  admin,
  asSession,
  auditEntries,
  bindings,
  call,
  callWith,
  failingWhere,
  joinHelper,
  linkedOwner,
  setFlags,
  setupShop,
  signIn,
  stubLine,
  type Helper,
  type Shop,
} from "./people-fixtures";

// Telling the owner about a helper's new device (docs/people.md, "A helper's new device"; docs/pilot-api.md, "The owner's
// own routes"), through the real Worker and objects. `GET /v1/people/devices` lists each sign-in a helper made, whether the
// device is still signed in or not, and says only who, when and an id the desktop uses to tell it has already said so.
// Only the shop's owner reads it, the shop and the role come from the session alone, and nothing it answers could open a
// session or name a person outside the shop. The global fetch counts LINE pushes and answers everything else 599, so
// nothing leaves the test, and the route sends nothing.

const DAY = 24 * 60 * 60 * 1000;
let line: ReturnType<typeof stubLine>;

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
  line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Device = { id: string; helperId: string; name: string; openedAt: string };
type Headers = { authorization?: string };

/// The devices helpers signed in on, as a session of the shop reads them.
function devicesAt(headers: Headers, query = "") {
  return asSession<{ devices: Device[]; error?: string }>(headers, "GET", `/v1/people/devices${query}`);
}

/// The helper signs in on another device: a new helper session of the shop, and the headers that carry it.
async function newDevice(helper: Helper, shop: Shop): Promise<{ authorization: string }> {
  const opened = await asSession<{ session: { accessToken: string } }>(helper.person.headers, "POST", "/v1/people/session",
    { shop: shop.tenant });
  expect(opened.status).toBe(200);
  return { authorization: `Bearer ${opened.body.session.accessToken}` };
}

/// The shop's people record, as its object holds it.
async function recordOf(shop: Shop): Promise<PeopleRecord> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), async (_instance, state) =>
    (await state.storage.get<PeopleRecord>(`people:${encodeURIComponent(shop.tenant)}`))!);
}

/// Changes the shop's people record as an older build, or a clock that moved on, would have left it.
async function rewriteRecord(shop: Shop, change: (record: PeopleRecord) => PeopleRecord): Promise<void> {
  await runInDurableObject(tenantStub(bindings, shop.tenant), async (_instance, state) => {
    const key = `people:${encodeURIComponent(shop.tenant)}`;
    await state.storage.put(key, change((await state.storage.get<PeopleRecord>(key))!));
  });
}

const bearerOf = (headers: { authorization: string }) => headers.authorization.slice("Bearer ".length);

describe("what the owner is told about a helper's devices", () => {
  it("lists each sign-in newest first: the helper's id and name, when, and an id for it, nothing more", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    expect(await devicesAt(owner.headers)).toEqual({ status: 200, body: { devices: [] } });

    // Mint joins on her phone (her first device) and opens the shop on her laptop; Beam joins on his.
    const before = Date.now() - 5000;
    const mint = await joinHelper(shop, "Mint");
    const laptop = await newDevice(mint, shop);
    const beam = await joinHelper(shop, "Beam");
    const after = Date.now() + 5000;

    const listed = await devicesAt(owner.headers);
    expect(listed.status).toBe(200);
    const { devices } = listed.body;
    expect(devices.map((device) => [device.helperId, device.name])).toEqual([[beam.id, "Beam"], [mint.id, "Mint"],
      [mint.id, "Mint"]]);
    for (const device of devices) {
      expect(Object.keys(device).sort()).toEqual(["helperId", "id", "name", "openedAt"]);
      expect(new Date(device.openedAt).toISOString()).toBe(device.openedAt);
      expect(Date.parse(device.openedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(device.openedAt)).toBeLessThanOrEqual(after);
    }
    expect(Date.parse(devices[0]!.openedAt)).toBeGreaterThanOrEqual(Date.parse(devices[1]!.openedAt));
    expect(Date.parse(devices[1]!.openedAt)).toBeGreaterThanOrEqual(Date.parse(devices[2]!.openedAt));
    expect(new Set(devices.map((device) => device.id)).size).toBe(3);

    // The id is the session's own id in the shop's record, so it is the same however often it is read, and it opens nothing.
    const record = await recordOf(shop);
    const held = record.state.helpers.flatMap((helper) => helper.sessions);
    expect(devices.map((device) => device.id).sort()).toEqual([...held].sort());

    // Nothing in the answer could open a session or name a person: no token, no hash, no email, no Apple subject.
    const secrets = [bearerOf(mint.headers), bearerOf(laptop), bearerOf(beam.headers), bearerOf(owner.headers)];
    const hashes = await Promise.all(secrets.map((token) => sha256Hex(token)));
    const text = JSON.stringify(listed.body);
    for (const kept of [...secrets, ...secrets.map((token) => token.split(".")[2]!), ...hashes, mint.email, beam.email,
      mint.person.tenant, beam.person.tenant, owner.person.tenant, "mhs1", "mos1"]) {
      expect(text).not.toContain(kept);
    }
    // The id opens nothing: sent as a bearer, it is no session.
    for (const device of devices) {
      expect(await asSession({ authorization: `Bearer ${device.id}` }, "GET", "/v1/approvals?state=open")).toEqual({
        status: 401, body: { error: "unauthorized" } });
    }
    expect(line.pushes()).toBe(0);
  });

  it("says the same about the same sign-in every time, whatever else changes in the shop", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    const first = (await devicesAt(owner.headers)).body.devices;
    expect(first).toHaveLength(1);
    expect((await devicesAt(owner.headers)).body.devices).toEqual(first);
    // Other changes to the shop's people, and another sign-in, leave the first one's id and time as they were.
    expect((await asSession(owner.headers, "POST", "/v1/people/invites", { name: "Pim",
      identity: { kind: "line", id: "Upim" } })).status).toBe(200);
    await newDevice(mint, shop);
    const later = (await devicesAt(owner.headers)).body.devices;
    expect(later).toHaveLength(2);
    expect(later[1]).toEqual(first[0]);
  });

  it("keeps a sign-in that is already over: signing out does not take it back, and the session itself no longer works", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    const laptop = await newDevice(mint, shop);
    expect((await asSession(laptop, "POST", "/v1/shops/session/end", {})).status).toBe(200);
    expect(await asSession(laptop, "GET", "/v1/approvals?state=open")).toEqual({ status: 401,
      body: { error: "unauthorized" } });
    // The owner's app was closed meanwhile: it still hears that someone signed in as Mint on a second device.
    expect((await devicesAt(owner.headers)).body.devices.map((device) => device.name)).toEqual(["Mint", "Mint"]);
  });

  it("leaves out a helper once the owner removes them, and the other helpers' sign-ins stay", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    const beam = await joinHelper(shop, "Beam");
    await newDevice(mint, shop);
    expect((await devicesAt(owner.headers)).body.devices.map((device) => device.name)).toEqual(["Mint", "Beam", "Mint"]);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: mint.id })).status).toBe(200);
    expect((await devicesAt(owner.headers)).body.devices).toMatchObject([{ helperId: beam.id, name: "Beam" }]);
  });

  it("is read the same from the shop's own session, and writes nothing to the shop's log", async () => {
    const shop = await setupShop();
    const mint = await joinHelper(shop, "Mint");
    const own = await tenantSession(shop.tenant);
    const logged = (await auditEntries(shop.tenant)).length;
    const listed = await devicesAt(own);
    expect(listed).toMatchObject({ status: 200, body: { devices: [{ helperId: mint.id, name: "Mint" }] } });
    expect((await auditEntries(shop.tenant)).length).toBe(logged);
  });

  it("leaves the people list as it was: the devices are not part of it", async () => {
    const shop = await setupShop();
    await linkedOwner(shop);
    await joinHelper(shop, "Mint");
    const people = await admin<Record<string, unknown>>("GET", `/v1/admin/people?tenant=${encodeURIComponent(shop.tenant)}`);
    expect(people.status).toBe(200);
    expect(Object.keys(people.body).sort()).toEqual(["away", "helpers", "invites", "owner", "passedOn", "removed", "tenant"]);
    expect(JSON.stringify(people.body)).not.toContain("signIns");
  });
});

describe("who reads a shop's helper devices", () => {
  it("is the owner's: a helper's session is refused, and so is every credential that is not the shop's owner", async () => {
    const shop = await setupShop();
    await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    // A helper is told the route is the owner's rather than that their session ended, as on the other owner routes, and
    // that comes before the method.
    expect(await devicesAt(mint.headers)).toEqual({ status: 403, body: { error: "owner_only" } });
    expect(await asSession(mint.headers, "POST", "/v1/people/devices", {})).toEqual({ status: 403, body: { error: "owner_only" } });
    // A person's own sign-in acts for their own tenant, which is no pilot shop and has no helpers.
    const person = await signIn();
    expect(await devicesAt(person.headers)).toEqual({ status: 404, body: { error: "not_found" } });
    // No credential, the operator key and a token nobody holds are no session; a caller with none learns nothing else.
    for (const headers of [{}, { authorization: "Bearer test-key" }, { authorization: "Bearer nonsense" }]) {
      expect(await devicesAt(headers)).toEqual({ status: 401, body: { error: "unauthorized" } });
      expect(await asSession(headers, "POST", "/v1/people/devices", {})).toEqual({ status: 401, body: { error: "unauthorized" } });
    }
  });

  it("has one method, and takes no shop, tenant or role from the request", async () => {
    const shop = await setupShop();
    const other = await setupShop("Khao Hom");
    const owner = await linkedOwner(shop);
    await joinHelper(other, "Beam");
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(await asSession(owner.headers, method, "/v1/people/devices", {})).toEqual({ status: 405,
        body: { error: "method_not_allowed" } });
    }
    for (const query of [`tenant=${encodeURIComponent(other.tenant)}`, `shop=${encodeURIComponent(other.tenant)}`, "role=owner"]) {
      expect(await devicesAt(owner.headers, `?${query}`)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    // A header naming another shop is not read either: this shop has no helper, and Khao Hom's Beam is not listed in it.
    const viaHeader = await call("/v1/people/devices", { headers: { ...owner.headers, "x-tenant": other.tenant } });
    expect({ status: viaHeader.status, body: await viaHeader.json() }).toEqual({ status: 200, body: { devices: [] } });
  });

  it("is each shop's own, even for one person who owns two", async () => {
    const fon = await signIn();
    const mali = await setupShop();
    const khaoHom = await setupShop("Khao Hom");
    const asOwnerOfMali = (await linkedOwner(mali, fon)).headers;
    const asOwnerOfKhaoHom = (await linkedOwner(khaoHom, fon)).headers;
    const mint = await joinHelper(mali, "Mint");
    const beam = await joinHelper(khaoHom, "Beam");
    expect((await devicesAt(asOwnerOfMali)).body.devices.map((device) => [device.helperId, device.name]))
      .toEqual([[mint.id, "Mint"]]);
    expect((await devicesAt(asOwnerOfKhaoHom)).body.devices.map((device) => [device.helperId, device.name]))
      .toEqual([[beam.id, "Beam"]]);
  });

  it("answers a session that no longer works as every owner route does", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    expect((await devicesAt(owner.headers)).status).toBe(200);
    expect((await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: mint.id })).status).toBe(200);
    expect(await devicesAt(owner.headers)).toMatchObject({ status: 401, body: { error: "unlinked", unlinkedAt: expect.any(String) } });
    expect(await devicesAt(mint.headers)).toMatchObject({ status: 401, body: { error: "removed", removedAt: expect.any(String) } });
  });

  it("is answered 503, never a shorter list, when the shop's record or its session check cannot be reached", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    await joinHelper(shop, "Mint");
    const at = (method: string, path: string) => (request: Request) =>
      request.method === method && new URL(request.url).pathname === path;
    for (const throws of [false, true]) {
      for (const fails of [at("GET", "/people"), at("POST", "/people/owner-session-check")]) {
        expect(await callWith(failingWhere("TENANT", fails, throws), "/v1/people/devices", { headers: owner.headers }))
          .toEqual({ status: 503, body: { error: "people_unavailable" } });
      }
    }
  });
});

describe("how long a sign-in is listed", () => {
  it("is as long as a session lasts, and no more than the newest fifty", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    // The alert is about a session that could still be open, so a sign-in is listed as long as a session lasts.
    expect(HELPER_SESSION_TTL_MS).toBe(30 * DAY);

    // One that is older than that is not listed, even before another change drops it from the record.
    await rewriteRecord(shop, (record) => ({ ...record, signIns: [...(record.signIns ?? []),
      { sessionId: "hs-too-old", helperId: mint.id, at: Date.now() - 31 * DAY }] }));
    expect((await devicesAt(owner.headers)).body.devices).toHaveLength(1);
    expect((await recordOf(shop)).signIns).toHaveLength(2);

    // The next sign-in drops it, and keeps only the newest fifty of the rest.
    await rewriteRecord(shop, (record) => ({ ...record, signIns: [
      ...Array.from({ length: 60 }, (_, i) => ({ sessionId: `hs-planted-${i}`, helperId: mint.id, at: Date.now() - (i + 1) * 1000 })),
      { sessionId: "hs-too-old", helperId: mint.id, at: Date.now() - 31 * DAY }] }));
    await newDevice(mint, shop);
    const kept = (await recordOf(shop)).signIns!;
    expect(kept).toHaveLength(50);
    expect(kept.map((one) => one.sessionId)).not.toContain("hs-too-old");
    expect(kept.slice(1, 3).map((one) => one.sessionId)).toEqual(["hs-planted-0", "hs-planted-1"]);
    const listed = (await devicesAt(owner.headers)).body.devices;
    expect(listed).toHaveLength(50);
    expect(listed[0]!.id).toBe(kept[0]!.sessionId);
  });

  it("reads a shop whose record was written before sign-ins were kept as having none, and starts the list at the next one", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    await rewriteRecord(shop, ({ signIns: _gone, ...older }) => older);
    expect(await devicesAt(owner.headers)).toEqual({ status: 200, body: { devices: [] } });
    await newDevice(mint, shop);
    expect((await devicesAt(owner.headers)).body.devices).toMatchObject([{ helperId: mint.id, name: "Mint" }]);
  });

  it("does not list a sign-in of someone who is not a helper of the shop", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    await joinHelper(shop, "Mint");
    await rewriteRecord(shop, (record) => ({ ...record, signIns: [...(record.signIns ?? []),
      { sessionId: "hs-stranger", helperId: "helper-nobody", at: Date.now() }] }));
    expect((await devicesAt(owner.headers)).body.devices.map((device) => device.id)).not.toContain("hs-stranger");
  });
});
