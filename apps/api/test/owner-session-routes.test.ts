import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { proposeFact } from "../src/memory";
import { tenantCall } from "../src/tenant-data";
import { tenantSession } from "./authenticated-fixtures";
import {
  accept,
  admin,
  asSession,
  auditEntries,
  bindings,
  call,
  callWith,
  decide,
  failingWhere,
  invite,
  inviteToken,
  joinHelper,
  linkedOwner,
  ownerSession,
  proposeReply,
  setFlags,
  setupShop,
  signIn,
  stubLine,
  WEB,
  type Joined,
  type Shop,
} from "./people-fixtures";

// What an owner's shop session reaches beyond the shop's approvals and the team's routines (docs/several-shops.md, slice
// 4; docs/pilot-api.md, "Several shops"), through the real Worker and objects: what the team knows, the shop's consent to
// cloud work, its export, and its helpers. Every route takes the shop and the role from the session alone, answers a
// helper's session 403 owner_only, answers a session that unlinking, removal or signing out ended as every route does,
// takes an exact body, and names the linked account in the shop's audit log, never the account itself, an email or a
// name. The global fetch counts LINE pushes and answers everything else 599, so nothing leaves the test, and none of
// these routes sends anything.

const DAY = 24 * 60 * 60 * 1000;
const APPROVE = { optionId: "approve", seenRevision: 1 };
const enc = encodeURIComponent;
let line: ReturnType<typeof stubLine>;

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
  line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Fact = { id: string; text: string; status: "confirmed" | "waiting"; createdAt: number; updatedAt: number;
  correctedAt?: number; source: { kind: string } };
type Memory = { tenant: string; facts: Fact[]; forgottenCount: number };
type People = {
  tenant: string;
  owner: { name: string; account: { id: string; linkedAt: string; devices: number } | null };
  helpers: { id: string; name: string; devices: number }[];
  invites: { id: string; name: string; status: string; inviteUrl?: string }[];
  away: { helperId: string; name: string; until: string; inForce: boolean } | null;
  removed: { id: string; name: string }[];
};

/// The shop's memory, as the operator reads it.
async function memoryOf(tenant: string): Promise<Memory> {
  const read = await admin<Memory>("GET", `/v1/admin/memory?tenant=${enc(tenant)}`);
  expect(read.status).toBe(200);
  return read.body;
}

/// The shop's people, as the operator reads them.
async function peopleOf(tenant: string): Promise<People> {
  const read = await admin<People>("GET", `/v1/admin/people?tenant=${enc(tenant)}`);
  expect(read.status).toBe(200);
  return read.body;
}

/// The shop's consent, as its object holds it.
async function consentOf(tenant: string): Promise<{ cloudWork: boolean; updatedAt?: string }> {
  const response = await tenantCall(bindings, tenant, `/consent?tenant=${enc(tenant)}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { cloudWork: boolean; updatedAt?: string };
}

/// What the owner did from a session, newest first, leaving out opening the shop on a device.
async function ownersEntries(tenant: string) {
  return (await auditEntries(tenant)).filter((entry) => entry.actor.kind === "owner" &&
    entry.action !== "owner.session_opened");
}

/// A pilot shop as the operator first makes it: no LINE connection, so only its owner's consent can make it live.
async function quietShop(name: string): Promise<Shop> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name, ownerName: "Dao" });
  expect(created.status).toBe(200);
  return { tenant: created.body.tenant, connectionId: "", name };
}

/// The same token, made to name another shop: the shop a token names proves nothing on its own.
function movedTo(headers: { authorization: string }, tenant: string): { authorization: string } {
  const [prefix, , secret] = headers.authorization.slice("Bearer ".length).split(".");
  const shop = btoa(tenant).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { authorization: `Bearer ${prefix}.${shop}.${secret}` };
}

describe("what the team knows, from the owner's session", () => {
  it("reads all of it, and the owner confirms, remembers, corrects and forgets, named by the linked account", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    // What a customer said waits for the owner; what the operator relayed is the owner's own word.
    const proposed = await proposeFact(bindings, shop.tenant, "Delivers to Chiang Mai", { kind: "customer", chat: "chat-1" });
    expect(proposed).toMatchObject({ ok: true, fact: { status: "waiting" } });
    const waitingId = proposed.ok ? proposed.fact.id : "";
    expect((await admin("POST", "/v1/admin/memory/remember", { tenant: shop.tenant, text: "Closed on Mondays" })).status)
      .toBe(200);

    const read = await asSession<Memory>(owner.headers, "GET", "/v1/memory");
    expect(read.status).toBe(200);
    expect(read.body.tenant).toBe(shop.tenant);
    expect(read.body.facts.map((fact) => [fact.text, fact.status])).toEqual([["Delivers to Chiang Mai", "waiting"],
      ["Closed on Mondays", "confirmed"]]);
    expect(read.body.forgottenCount).toBe(0);

    // "It's true", the owner's own words, a correction, and Forget.
    expect(await asSession(owner.headers, "POST", "/v1/memory/confirm", { id: waitingId })).toMatchObject({ status: 200,
      body: { id: waitingId, status: "confirmed" } });
    const remembered = await asSession<Fact>(owner.headers, "POST", "/v1/memory/remember",
      { text: "Free shipping on orders over 1,000 baht" });
    expect(remembered).toMatchObject({ status: 200, body: { status: "confirmed", source: { kind: "owner" } } });
    expect(await asSession(owner.headers, "POST", "/v1/memory/correct", { id: remembered.body.id,
      text: "Free shipping on orders over 1,500 baht" })).toMatchObject({ status: 200, body: { id: remembered.body.id,
      text: "Free shipping on orders over 1,500 baht", correctedAt: expect.any(Number) } });
    expect(await asSession(owner.headers, "POST", "/v1/memory/forget", { id: waitingId })).toEqual({ status: 200,
      body: { id: waitingId } });
    // The package's refusals, answered as the operator's routes answer them, change nothing.
    expect(await asSession(owner.headers, "POST", "/v1/memory/remember", { text: " closed on  MONDAYS " })).toEqual({
      status: 409, body: { error: "already_known" } });
    expect(await asSession(owner.headers, "POST", "/v1/memory/remember", { text: "   " })).toEqual({ status: 400,
      body: { error: "invalid_text" } });
    expect(await asSession(owner.headers, "POST", "/v1/memory/confirm", { id: "f999" })).toEqual({ status: 404,
      body: { error: "not_found" } });

    // The operator reads the same memory.
    const relayed = await memoryOf(shop.tenant);
    expect(relayed.facts.map((fact) => fact.text)).toEqual(["Closed on Mondays", "Free shipping on orders over 1,500 baht"]);
    expect(relayed.forgottenCount).toBe(1);
    // The log names the linked account and each fact by its id: never the words, the account's subject or a name.
    const owners = { kind: "owner", id: owner.accountId };
    expect((await ownersEntries(shop.tenant)).map((entry) => [entry.action, entry.actor, entry.subject])).toEqual([
      ["memory.forgotten", owners, { factId: waitingId }],
      ["memory.corrected", owners, { factId: remembered.body.id }],
      ["memory.remembered", owners, { factId: remembered.body.id }],
      ["memory.confirmed", owners, { factId: waitingId }],
    ]);
    const log = JSON.stringify(await auditEntries(shop.tenant));
    for (const kept of ["Chiang Mai", "Free shipping", "Mondays", owner.person.tenant]) expect(log).not.toContain(kept);
    expect(line.pushes()).toBe(0);
  });

  it("takes exactly the fields each change reads, and the shop from the session alone", async () => {
    const shop = await setupShop();
    const other = await setupShop("Khao Hom");
    const owner = await linkedOwner(shop);
    for (const [path, body] of [
      ["/v1/memory/remember", { text: "Open late on Fridays", tenant: other.tenant }],
      ["/v1/memory/remember", { text: "Open late on Fridays", shop: other.tenant }],
      ["/v1/memory/remember", { text: "Open late on Fridays", role: "owner" }],
      ["/v1/memory/remember", { text: "Open late on Fridays", source: { kind: "customer", chat: "chat-1" } }],
      ["/v1/memory/confirm", { id: "f1", text: "Open late on Fridays" }],
      ["/v1/memory/correct", { id: "f1" }],
      ["/v1/memory/forget", {}],
      ["/v1/memory/remember", ["Open late on Fridays"]],
      ["/v1/memory/remember", "Open late on Fridays"],
      ["/v1/memory/remember", null],
    ] as const) {
      expect(await asSession(owner.headers, "POST", path, body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    // A shop or a role named in the query is refused, never read, and a header naming another shop is not read either.
    for (const query of [`tenant=${enc(other.tenant)}`, `shop=${enc(other.tenant)}`, "role=owner"]) {
      expect(await asSession(owner.headers, "GET", `/v1/memory?${query}`)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
      expect(await asSession(owner.headers, "POST", `/v1/memory/remember?${query}`, { text: "Open late on Fridays" }))
        .toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    const viaHeader = await call("/v1/memory", { headers: { ...owner.headers, "x-tenant": other.tenant } });
    expect(((await viaHeader.json()) as Memory).tenant).toBe(shop.tenant);
    // Each route has one method, and no route leads to a worker's proposal.
    expect(await asSession(owner.headers, "POST", "/v1/memory", {})).toEqual({ status: 405,
      body: { error: "method_not_allowed" } });
    expect(await asSession(owner.headers, "GET", "/v1/memory/remember")).toEqual({ status: 405,
      body: { error: "method_not_allowed" } });
    expect(await asSession(owner.headers, "POST", "/v1/memory/propose", { text: "Open late on Fridays",
      source: { kind: "owner" } })).toEqual({ status: 404, body: { error: "not_found" } });
    // Nothing was written to either shop.
    for (const tenant of [shop.tenant, other.tenant]) expect((await memoryOf(tenant)).facts).toEqual([]);
  });

  it("is the owner's: a helper's session reaches none of it", async () => {
    const shop = await setupShop();
    await linkedOwner(shop);
    const helper = await joinHelper(shop);
    expect((await admin("POST", "/v1/admin/memory/remember", { tenant: shop.tenant, text: "Closed on Mondays" })).status)
      .toBe(200);
    for (const [method, path, body] of [["GET", "/v1/memory"], ["POST", "/v1/memory/remember", { text: "Open late" }],
      ["POST", "/v1/memory/confirm", { id: "f1" }], ["POST", "/v1/memory/correct", { id: "f1", text: "Open on Mondays" }],
      ["POST", "/v1/memory/forget", { id: "f1" }]] as const) {
      expect(await asSession(helper.headers, method, path, body)).toEqual({ status: 403, body: { error: "owner_only" } });
    }
    expect((await memoryOf(shop.tenant)).facts.map((fact) => [fact.text, fact.status])).toEqual([["Closed on Mondays",
      "confirmed"]]);
    expect((await auditEntries(shop.tenant)).filter((entry) => entry.action.startsWith("memory.") &&
      entry.actor.kind !== "operator")).toEqual([]);
  });

  it("keeps the shop's own session on the shop's memory, named owner-session, and a person's sign-in out of it", async () => {
    const shop = await setupShop();
    const own = await tenantSession(shop.tenant);
    expect((await asSession(own, "POST", "/v1/memory/remember", { text: "Closed on Mondays" })).status).toBe(200);
    expect(await asSession<Memory>(own, "GET", "/v1/memory")).toMatchObject({ status: 200,
      body: { tenant: shop.tenant, facts: [{ text: "Closed on Mondays", status: "confirmed" }] } });
    expect((await auditEntries(shop.tenant)).find((entry) => entry.action === "memory.remembered")?.actor).toEqual({
      kind: "owner", id: "owner-session" });
    // A person's own sign-in is the owner of their own tenant only, which is no shop: what the team knows is a shop's, so
    // it is answered not_found, as the owner's people and Google answer it, and nothing is kept for that tenant.
    const person = await signIn();
    expect(await asSession(person.headers, "GET", "/v1/memory")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await asSession(person.headers, "POST", "/v1/memory/remember", { text: "Kept for a stranger" })).toEqual({
      status: 404, body: { error: "not_found" } });
    const kept = await tenantCall(bindings, person.tenant, `/memory?tenant=${encodeURIComponent(person.tenant)}`);
    expect(await kept.json()).toMatchObject({ facts: [] });
    // Its body is still checked first, so a wrong one is refused before anything is read.
    expect(await asSession(person.headers, "POST", "/v1/memory/remember", { text: "x", tenant: shop.tenant })).toEqual({
      status: 400, body: { error: "invalid_request" } });
  });
});

describe("the shop's consent to cloud work, from the owner's session", () => {
  it("gives and withdraws it, named by the linked account, and every approval reads it at once", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const reply = await proposeReply(shop, "Your parcel left this morning.");
    expect(await asSession(owner.headers, "GET", "/v1/consent/cloud")).toEqual({ status: 200, body: { cloudWork: false } });
    expect(await decide(owner.headers, reply.actionId, APPROVE)).toMatchObject({ status: 403,
      body: { error: "consent_required" } });

    const given = await asSession(owner.headers, "PUT", "/v1/consent/cloud", { enabled: true });
    expect(given).toEqual({ status: 200, body: { cloudWork: true, updatedAt: expect.any(String) } });
    expect(await asSession(owner.headers, "GET", "/v1/consent/cloud")).toEqual(given);
    // The owner's link reads the same consent.
    const view = await call(`/v1/pilot/approvals/${reply.token}`);
    expect(((await view.json()) as { needsConsent: boolean }).needsConsent).toBe(false);

    // Withdrawn, an approval waits again and nothing is sent.
    expect(await asSession(owner.headers, "PUT", "/v1/consent/cloud", { enabled: false })).toEqual({ status: 200,
      body: { cloudWork: false, updatedAt: expect.any(String) } });
    expect(await decide(owner.headers, reply.actionId, APPROVE)).toMatchObject({ status: 403,
      body: { error: "consent_required" } });
    expect(line.pushes()).toBe(0);

    // Given again, the owner's approval is sent, once.
    expect((await asSession(owner.headers, "PUT", "/v1/consent/cloud", { enabled: true })).status).toBe(200);
    expect(await decide(owner.headers, reply.actionId, APPROVE)).toMatchObject({ status: 200,
      body: { result: { ok: true, decision: { decidedBy: owner.accountId, role: "owner" } }, action: "confirmed" } });
    expect(line.pushes()).toBe(1);
    // The log names the linked account each time, by its id.
    const owners = { kind: "owner", id: owner.accountId };
    expect((await ownersEntries(shop.tenant)).filter((entry) => entry.action.startsWith("consent."))
      .map((entry) => [entry.action, entry.actor, entry.subject, entry.outcome])).toEqual([
      ["consent.given", owners, {}, "ok"],
      ["consent.withdrawn", owners, {}, "ok"],
      ["consent.given", owners, {}, "ok"],
    ]);
  });

  it("keeps a shop live once its owner has answered, so deleting it still needs the owner's yes after a withdrawal", async () => {
    // One owner gave consent and withdrew it; the other only ever withdrew it. Neither shop has a LINE connection.
    for (const [name, answers] of [["Sabai Tea", [true, false]], ["Khao Hom", [false]]] as const) {
      const shop = await quietShop(name);
      const owner = await linkedOwner(shop);
      for (const enabled of answers) {
        expect((await asSession(owner.headers, "PUT", "/v1/consent/cloud", { enabled })).status).toBe(200);
      }
      const asked = await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: name });
      expect(asked).toMatchObject({ status: 202, body: { status: "awaiting_owner",
        confirmUrl: expect.stringMatching(`^${WEB}/delete/`) } });
      // Nothing was deleted: the owner's session still reads the shop.
      expect(await asSession(owner.headers, "GET", "/v1/consent/cloud")).toMatchObject({ status: 200,
        body: { cloudWork: false } });
    }
  });

  it("takes exactly { enabled } with true or false, and the shop from the session alone", async () => {
    const shop = await setupShop();
    const other = await setupShop("Khao Hom");
    const owner = await linkedOwner(shop);
    for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, { cloudWork: true },
      { enabled: true, tenant: other.tenant }, { enabled: true, shop: other.tenant }, { enabled: true, role: "owner" },
      [true], "true", null]) {
      expect(await asSession(owner.headers, "PUT", "/v1/consent/cloud", body)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    const raw = await call("/v1/consent/cloud", { method: "PUT",
      headers: { ...owner.headers, "content-type": "application/json" }, body: "{not json" });
    expect({ status: raw.status, body: await raw.json() }).toEqual({ status: 400, body: { error: "invalid_json" } });
    for (const query of [`tenant=${enc(other.tenant)}`, `shop=${enc(other.tenant)}`, "role=owner"]) {
      expect(await asSession(owner.headers, "GET", `/v1/consent/cloud?${query}`)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
      expect(await asSession(owner.headers, "PUT", `/v1/consent/cloud?${query}`, { enabled: true })).toEqual({
        status: 400, body: { error: "invalid_request" } });
    }
    for (const method of ["POST", "DELETE", "PATCH"]) {
      expect(await asSession(owner.headers, method, "/v1/consent/cloud", { enabled: true })).toEqual({ status: 405,
        body: { error: "method_not_allowed" } });
    }
    // Nothing was recorded for either shop.
    for (const tenant of [shop.tenant, other.tenant]) expect(await consentOf(tenant)).toEqual({ cloudWork: false });
    expect((await ownersEntries(shop.tenant)).filter((entry) => entry.action.startsWith("consent."))).toEqual([]);
  });

  it("is the owner's: a helper's session may neither read nor change it, and no operator may write it", async () => {
    const shop = await setupShop();
    await linkedOwner(shop);
    const helper = await joinHelper(shop);
    for (const [method, body] of [["GET"], ["PUT", { enabled: true }], ["PUT", { enabled: false }]] as const) {
      expect(await asSession(helper.headers, method, "/v1/consent/cloud", body)).toEqual({ status: 403,
        body: { error: "owner_only" } });
    }
    // The operator key is no session, with Access or without, and no operator route writes consent.
    expect((await asSession({ authorization: "Bearer test-key" }, "PUT", "/v1/consent/cloud", { enabled: true })).status)
      .toBe(401);
    expect((await admin("PUT", "/v1/consent/cloud", { enabled: true })).status).toBe(401);
    expect((await admin("PUT", `/v1/consent/cloud?tenant=${enc(shop.tenant)}`, { enabled: true })).status).toBe(401);
    expect(await consentOf(shop.tenant)).toEqual({ cloudWork: false });
  });

  it("leaves the shop's own session and a person's sign-in on the lifted route, as before", async () => {
    const shop = await setupShop();
    // The shop's own session gives consent through the lifted route (the fixture does), and the log names the owner.
    const own = await tenantSession(shop.tenant);
    expect(await asSession(own, "GET", "/v1/consent/cloud")).toEqual({ status: 200,
      body: { cloudWork: true, updatedAt: expect.any(String) } });
    expect((await auditEntries(shop.tenant)).find((entry) => entry.action === "consent.given")?.actor).toEqual({
      kind: "owner" });
    // A person's sign-in reads and writes their own tenant's consent, never a shop's.
    const person = await signIn();
    expect(await asSession(person.headers, "PUT", "/v1/consent/cloud", { enabled: true })).toMatchObject({ status: 200,
      body: { cloudWork: true } });
    expect(await consentOf(person.tenant)).toMatchObject({ cloudWork: true });
    // It is the lifted route itself, untouched: it still takes a field it never read, which a shop session's is refused.
    const shopOwner = await linkedOwner(shop);
    expect(await asSession(person.headers, "PUT", "/v1/consent/cloud", { enabled: false, note: "lifted" }))
      .toMatchObject({ status: 200, body: { cloudWork: false } });
    expect(await asSession(shopOwner.headers, "PUT", "/v1/consent/cloud", { enabled: false, note: "lifted" })).toEqual({
      status: 400, body: { error: "invalid_request" } });
    expect(await consentOf(shop.tenant)).toMatchObject({ cloudWork: true });
  });
});

describe("the shop's export, from the owner's session", () => {
  it("answers the whole export as the answer's body, kept by no cache and sent through no link", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    await proposeReply(shop, "We open at nine.");
    const before = line.outbound().length;
    const response = await call("/v1/tenant/export", { headers: owner.headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const exported = (await response.json()) as Record<string, unknown> & { tenant: string;
      people: { ownerAccount: { id: string } | null }; pilot: { shop: { name: string } } };
    expect(exported.tenant).toBe(shop.tenant);
    expect(exported.pilot.shop.name).toBe("Baan Mali");
    expect(exported.people.ownerAccount).toMatchObject({ id: owner.accountId });
    // The same parts as the operator's export of the shop.
    const operators = await admin("GET", `/v1/admin/pilot/export?tenant=${enc(shop.tenant)}`);
    expect(operators.status).toBe(200);
    expect(Object.keys(exported).sort()).toEqual(Object.keys(operators.body).sort());
    // No session's token or hash is in it, and nothing was sent anywhere to deliver it.
    const text = JSON.stringify(exported);
    for (const headers of [owner.headers, helper.headers]) {
      const token = headers.authorization.slice("Bearer ".length);
      expect(text).not.toContain(token.split(".")[2]!);
      expect(text).not.toContain(await sha256Hex(token));
    }
    expect(line.outbound().length).toBe(before);
  });

  it("is the owner's: a helper's session is refused, a shop named in the query is refused, and it has one method", async () => {
    const shop = await setupShop();
    const other = await setupShop("Khao Hom");
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    expect(await asSession(helper.headers, "GET", "/v1/tenant/export")).toEqual({ status: 403,
      body: { error: "owner_only" } });
    for (const query of [`tenant=${enc(other.tenant)}`, `shop=${enc(other.tenant)}`, "role=owner"]) {
      expect(await asSession(owner.headers, "GET", `/v1/tenant/export?${query}`)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect(await asSession(owner.headers, method, "/v1/tenant/export")).toEqual({ status: 405,
        body: { error: "method_not_allowed" } });
    }
  });

  it("leaves deleting the shop with the owner's confirmation link", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    expect(await asSession(owner.headers, "DELETE", "/v1/tenant/data")).toEqual({ status: 401,
      body: { error: "unauthorized" } });
    // The shop is all there, and the owner's session still works.
    expect((await admin("GET", `/v1/admin/pilot/export?tenant=${enc(shop.tenant)}`)).status).toBe(200);
    expect((await asSession(owner.headers, "GET", "/v1/tenant/export")).status).toBe(200);
  });
});

describe("the shop's helpers, from the owner's session", () => {
  it("invites, covers, revokes and removes, each named by the linked account, and sends nothing", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const before = line.outbound().length;
    expect(await asSession<People>(owner.headers, "GET", "/v1/people")).toMatchObject({ status: 200, body: {
      tenant: shop.tenant, owner: { name: "Fon", account: { id: owner.accountId, devices: 1 } }, helpers: [],
      invites: [], away: null, removed: [] } });

    // The owner invites Mint by email and is given the link to send her: the API sends nothing.
    const email = `mint-${crypto.randomUUID()}@baanmali.example`;
    const made = await asSession<{ invite: { id: string }; inviteUrl: string }>(owner.headers, "POST", "/v1/people/invites",
      { name: "Mint", identity: { kind: "email", address: email } });
    expect(made).toMatchObject({ status: 200, body: { invite: { name: "Mint", status: "pending",
      identity: { kind: "email", address: email } } } });
    expect(made.body.inviteUrl.startsWith(`${WEB}/join/`)).toBe(true);
    // Mint joins through it on her phone, then opens the shop on her laptop.
    const mint = await signIn(email);
    const joined = await accept(mint, inviteToken(made.body.inviteUrl));
    expect(joined.status).toBe(200);
    const { helper, session } = joined.body as unknown as Joined;
    const phone = { authorization: `Bearer ${session.accessToken}` };
    const reopened = await asSession<{ session: { accessToken: string } }>(mint.headers, "POST", "/v1/people/session",
      { shop: shop.tenant });
    expect(reopened.status).toBe(200);
    const laptop = { authorization: `Bearer ${reopened.body.session.accessToken}` };

    // Cover while the owner is away, then back.
    const until = new Date(Date.now() + 3 * DAY).toISOString();
    expect(await asSession(owner.headers, "POST", "/v1/people/away", { helperId: helper.id, until })).toEqual({
      status: 200, body: { away: { helperId: helper.id, name: "Mint", until, inForce: true } } });
    expect(await asSession(owner.headers, "POST", "/v1/people/away/clear", {})).toEqual({ status: 200,
      body: { away: null } });
    // An invite for Beam's LINE account, revoked before he uses it.
    const beam = await asSession<{ invite: { id: string } }>(owner.headers, "POST", "/v1/people/invites",
      { name: "Beam", identity: { kind: "line", id: "Ubeambaanmali" } });
    expect(beam.status).toBe(200);
    expect(await asSession(owner.headers, "POST", "/v1/people/invites/revoke", { inviteId: beam.body.invite.id }))
      .toMatchObject({ status: 200, body: { invite: { id: beam.body.invite.id, name: "Beam", status: "revoked" } } });

    // Mint covers again; then the owner removes her, which signs both her devices out at once and ends her cover.
    expect((await asSession(owner.headers, "POST", "/v1/people/away", { helperId: helper.id, until })).status).toBe(200);
    expect(await asSession(owner.headers, "POST", "/v1/people/remove", { helperId: helper.id })).toEqual({ status: 200,
      body: { removed: helper.id, sessionsEnded: 2, invitesRevoked: [], coverEnded: true } });
    for (const headers of [phone, laptop]) {
      expect(await asSession(headers, "GET", "/v1/approvals?state=open")).toMatchObject({ status: 401,
        body: { error: "removed" } });
    }
    expect(await asSession<People>(owner.headers, "GET", "/v1/people")).toMatchObject({ status: 200, body: {
      helpers: [], away: null, removed: [{ id: helper.id, name: "Mint" }],
      invites: [{ name: "Mint", status: "used" }, { name: "Beam", status: "revoked" }] } });

    // The log names the linked account for each change, and the invite or the helper by id: never a name, an address, a
    // LINE id or the account's subject.
    const changes = await ownersEntries(shop.tenant);
    expect(changes.map((entry) => entry.action)).toEqual(["helper.removed", "away.set", "invite.revoked", "invite.created",
      "away.cleared", "away.set", "invite.created"]);
    for (const entry of changes) expect(entry.actor).toEqual({ kind: "owner", id: owner.accountId });
    expect(changes[0]?.subject).toEqual({ helperId: helper.id });
    const log = JSON.stringify(await auditEntries(shop.tenant));
    for (const kept of ["Mint", "Beam", email, "Ubeambaanmali", owner.person.tenant]) expect(log).not.toContain(kept);
    expect(line.outbound().length).toBe(before);
  });

  it("takes exactly the fields each change reads, an identity's own included, and the shop from the session alone", async () => {
    const shop = await setupShop();
    const other = await setupShop("Khao Hom");
    const owner = await linkedOwner(shop);
    const identity = { kind: "email", address: "pim@baanmali.example" };
    for (const [path, body] of [
      ["/v1/people/invites", { name: "Pim", identity, tenant: other.tenant }],
      ["/v1/people/invites", { name: "Pim", identity, role: "owner" }],
      ["/v1/people/invites", { name: "Pim", identity: { ...identity, role: "owner" } }],
      ["/v1/people/invites", { name: "Pim", identity: { kind: "line", id: "Upim", address: "pim@baanmali.example" } }],
      ["/v1/people/invites", { name: "Pim", identity: { kind: "phone", number: "0812345678" } }],
      ["/v1/people/invites", { name: "Pim" }],
      ["/v1/people/invites/revoke", { inviteId: "inv-1", tenant: other.tenant }],
      ["/v1/people/invites/revoke", { inviteId: 42 }],
      ["/v1/people/remove", { helperId: "helper-1", shop: other.tenant }],
      ["/v1/people/remove", []],
      ["/v1/people/away", { helperId: "helper-1" }],
      ["/v1/people/away/clear", { tenant: other.tenant }],
      ["/v1/people/away/clear", null],
    ] as const) {
      expect(await asSession(owner.headers, "POST", path, body)).toEqual({ status: 400, body: { error: "invalid_request" } });
    }
    // The rules' own refusals, answered as the operator's routes answer them.
    expect(await asSession(owner.headers, "POST", "/v1/people/invites", { name: "Pim",
      identity: { kind: "email", address: "no-at-sign" } })).toEqual({ status: 400, body: { error: "bad_identity" } });
    expect(await asSession(owner.headers, "POST", "/v1/people/away", { helperId: "helper-nobody", until: "Friday" }))
      .toEqual({ status: 400, body: { error: "bad_date" } });
    expect(await asSession(owner.headers, "POST", "/v1/people/away", { helperId: "helper-nobody",
      until: new Date(Date.now() + DAY).toISOString() })).toEqual({ status: 404, body: { error: "not_a_helper" } });
    expect(await asSession(owner.headers, "POST", "/v1/people/remove", { helperId: "helper-nobody" })).toEqual({
      status: 404, body: { error: "not_a_helper" } });
    expect(await asSession(owner.headers, "POST", "/v1/people/invites/revoke", { inviteId: "inv-nobody" })).toEqual({
      status: 404, body: { error: "unknown_invite" } });
    // A shop or a role named in the query is refused, never read; and each route has one method.
    for (const query of [`tenant=${enc(other.tenant)}`, `shop=${enc(other.tenant)}`, "role=owner"]) {
      expect(await asSession(owner.headers, "GET", `/v1/people?${query}`)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
      expect(await asSession(owner.headers, "POST", `/v1/people/away/clear?${query}`, {})).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    expect(await asSession(owner.headers, "POST", "/v1/people", {})).toEqual({ status: 405,
      body: { error: "method_not_allowed" } });
    expect(await asSession(owner.headers, "GET", "/v1/people/invites")).toEqual({ status: 405,
      body: { error: "method_not_allowed" } });
    // Nothing was made in either shop, and nothing was logged.
    for (const tenant of [shop.tenant, other.tenant]) expect((await peopleOf(tenant)).invites).toEqual([]);
    expect(await ownersEntries(shop.tenant)).toEqual([]);
  });

  it("reaches only its own shop's helpers and invites, not even those of another shop the same person owns", async () => {
    const fon = await signIn();
    const mali = await setupShop();
    const khaoHom = await setupShop("Khao Hom");
    const asOwnerOfMali = (await linkedOwner(mali, fon)).headers;
    const asOwnerOfKhaoHom = (await linkedOwner(khaoHom, fon)).headers;
    const beam = await joinHelper(khaoHom, "Beam");
    const pending = await invite(khaoHom, "Pim", { kind: "email", address: "pim@khaohom.example" });
    expect(pending.status).toBe(200);
    const until = new Date(Date.now() + DAY).toISOString();
    expect(await asSession(asOwnerOfMali, "POST", "/v1/people/remove", { helperId: beam.id })).toEqual({ status: 404,
      body: { error: "not_a_helper" } });
    expect(await asSession(asOwnerOfMali, "POST", "/v1/people/away", { helperId: beam.id, until })).toEqual({
      status: 404, body: { error: "not_a_helper" } });
    expect(await asSession(asOwnerOfMali, "POST", "/v1/people/invites/revoke", { inviteId: pending.body.invite.id }))
      .toEqual({ status: 404, body: { error: "unknown_invite" } });
    expect((await asSession<People>(asOwnerOfMali, "GET", "/v1/people")).body.helpers).toEqual([]);
    // Khao Hom's helper works on, and Khao Hom's own owner session manages its people.
    expect((await asSession(beam.headers, "GET", "/v1/approvals?state=open")).status).toBe(200);
    const khaoHomPeople = await asSession<People>(asOwnerOfKhaoHom, "GET", "/v1/people");
    expect(khaoHomPeople.body.helpers.map((one) => one.id)).toEqual([beam.id]);
    expect(khaoHomPeople.body.invites.find((one) => one.id === pending.body.invite.id)?.status).toBe("pending");
    expect((await asSession(asOwnerOfKhaoHom, "POST", "/v1/people/remove", { helperId: beam.id })).status).toBe(200);
  });

  it("is the owner's: a helper's session can neither read nor change who helps, not even to take itself off", async () => {
    const shop = await setupShop();
    await linkedOwner(shop);
    const mint = await joinHelper(shop, "Mint");
    const beam = await joinHelper(shop, "Beam");
    const until = new Date(Date.now() + DAY).toISOString();
    for (const [method, path, body] of [["GET", "/v1/people"],
      ["POST", "/v1/people/invites", { name: "Pim", identity: { kind: "line", id: "Upim" } }],
      ["POST", "/v1/people/invites/revoke", { inviteId: "inv-1" }], ["POST", "/v1/people/remove", { helperId: beam.id }],
      ["POST", "/v1/people/remove", { helperId: mint.id }], ["POST", "/v1/people/away", { helperId: mint.id, until }],
      ["POST", "/v1/people/away/clear", {}]] as const) {
      expect(await asSession(mint.headers, method, path, body)).toEqual({ status: 403, body: { error: "owner_only" } });
    }
    const people = await peopleOf(shop.tenant);
    expect(people.helpers.map((one) => [one.name, one.devices])).toEqual([["Mint", 1], ["Beam", 1]]);
    expect(people.away).toBeNull();
    expect(people.invites.map((one) => one.name)).toEqual(["Mint", "Beam"]);
  });

  it("keeps the shop's own session able to manage them, named owner-session, and a person's sign-in has no people", async () => {
    const shop = await setupShop();
    const own = await tenantSession(shop.tenant);
    const made = await asSession<{ invite: { id: string } }>(own, "POST", "/v1/people/invites",
      { name: "Mint", identity: { kind: "line", id: "Umintbaanmali" } });
    expect(made.status).toBe(200);
    expect((await auditEntries(shop.tenant)).find((entry) => entry.action === "invite.created")).toMatchObject({
      actor: { kind: "owner", id: "owner-session" }, subject: { inviteId: made.body.invite.id } });
    // A person's own sign-in acts for their own tenant, which is no pilot shop and has no people.
    const person = await signIn();
    expect(await asSession(person.headers, "GET", "/v1/people")).toEqual({ status: 404, body: { error: "not_found" } });
    expect(await asSession(person.headers, "POST", "/v1/people/invites", { name: "Mint",
      identity: { kind: "line", id: "Umintbaanmali" } })).toEqual({ status: 404, body: { error: "not_found" } });
  });
});

describe("a session that no longer works", () => {
  /// One request to each kind of route this slice opened.
  const ROUTES = [["GET", "/v1/memory"], ["POST", "/v1/memory/remember", { text: "Open late on Fridays" }],
    ["GET", "/v1/consent/cloud"], ["PUT", "/v1/consent/cloud", { enabled: true }], ["GET", "/v1/tenant/export"],
    ["GET", "/v1/people"], ["POST", "/v1/people/invites", { name: "Pim", identity: { kind: "line", id: "Upim" } }],
    ["POST", "/v1/people/away/clear", {}]] as const;

  it("is answered 401 on every route with its reason: none, unknown, signed out, unlinked or removed", async () => {
    const shop = await setupShop();
    const other = await setupShop("Khao Hom");
    const owner = await linkedOwner(shop);
    const helper = await joinHelper(shop);
    const signedOut = await ownerSession(owner.person, shop);
    expect((await asSession(signedOut, "POST", "/v1/shops/session/end", {})).status).toBe(200);
    const [prefix, named] = owner.headers.authorization.slice("Bearer ".length).split(".");
    for (const headers of [{}, { authorization: "Bearer test-key" }, signedOut, movedTo(owner.headers, other.tenant),
      { authorization: `Bearer ${prefix}.${named}.${"0".repeat(64)}` }]) {
      for (const [method, path, body] of ROUTES) {
        expect(await asSession(headers, method, path, body)).toEqual({ status: 401, body: { error: "unauthorized" } });
      }
    }
    // Unlinking the account and removing the helper end their sessions, and each says why.
    expect((await admin("POST", "/v1/admin/shops/owner/unlink", { tenant: shop.tenant })).status).toBe(200);
    expect((await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: helper.id })).status)
      .toBe(200);
    for (const [method, path, body] of ROUTES) {
      expect(await asSession(owner.headers, method, path, body)).toMatchObject({ status: 401,
        body: { error: "unlinked", unlinkedAt: expect.any(String) } });
      expect(await asSession(helper.headers, method, path, body)).toMatchObject({ status: 401,
        body: { error: "removed", removedAt: expect.any(String) } });
    }
    // None of them wrote anything.
    expect((await memoryOf(shop.tenant)).facts).toEqual([]);
    expect(await consentOf(shop.tenant)).toEqual({ cloudWork: false });
    expect((await peopleOf(shop.tenant)).invites.map((one) => one.name)).toEqual(["Mint"]);
  });

  it("is answered 503, and nothing changes, when the shop's records cannot be reached", async () => {
    const shop = await setupShop();
    const owner = await linkedOwner(shop);
    const at = (method: string, path: string) => (request: Request) =>
      request.method === method && new URL(request.url).pathname === path;
    const send = (body: unknown) => (body === undefined ? {} : { body });
    // The session cannot be checked: every route says so, rather than answering as if there were no session.
    for (const throws of [false, true]) {
      const unchecked = failingWhere("TENANT", at("POST", "/people/owner-session-check"), throws);
      for (const [method, path, body] of ROUTES) {
        expect(await callWith(unchecked, path, { method, headers: owner.headers, ...send(body) })).toEqual({ status: 503,
          body: { error: "people_unavailable" } });
      }
    }
    // Each route's own record.
    for (const [fails, method, path, body, error] of [
      [at("GET", "/memory"), "GET", "/v1/memory", undefined, "memory_unavailable"],
      [at("POST", "/memory/remember"), "POST", "/v1/memory/remember", { text: "Open late on Fridays" }, "memory_unavailable"],
      [at("GET", "/consent"), "GET", "/v1/consent/cloud", undefined, "consent_unavailable"],
      [at("POST", "/consent"), "PUT", "/v1/consent/cloud", { enabled: true }, "consent_unavailable"],
      [at("GET", "/people"), "GET", "/v1/people", undefined, "people_unavailable"],
      [at("POST", "/people/invite"), "POST", "/v1/people/invites", { name: "Pim", identity: { kind: "line", id: "Upim" } },
        "people_unavailable"],
    ] as const) {
      for (const throws of [false, true]) {
        expect(await callWith(failingWhere("TENANT", fails, throws), path, { method, headers: owner.headers, ...send(body) }))
          .toEqual({ status: 503, body: { error } });
      }
    }
    // The export names a part it could not read, as the operator's does; an object it cannot reach at all is 503.
    expect(await callWith(failingWhere("TENANT", at("GET", "/people/export")), "/v1/tenant/export",
      { headers: owner.headers })).toEqual({ status: 500, body: { error: "export_incomplete", failed: ["people"] } });
    expect(await callWith(failingWhere("TENANT", at("GET", "/index"), true), "/v1/tenant/export",
      { headers: owner.headers })).toEqual({ status: 503, body: { error: "export_unavailable" } });
    // Nothing changed.
    expect((await memoryOf(shop.tenant)).facts).toEqual([]);
    expect(await consentOf(shop.tenant)).toEqual({ cloudWork: false });
    expect((await peopleOf(shop.tenant)).invites).toEqual([]);
  });
});
