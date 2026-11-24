import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import worker from "../src/index";
import type { PeopleRecord } from "../src/people-store";
import { mintApprovalToken, mintDeletionToken, mintInviteToken } from "../src/approval-link";
import { tenantDelete, tenantExport, tenantStub } from "../src/tenant-data";
import { tenantSession } from "./authenticated-fixtures";
import {
  accept,
  admin,
  asSession,
  auditEntries,
  bindings,
  decide,
  invite,
  inviteToken,
  joinHelper,
  ownerConsents,
  plantRequest,
  proposeReply,
  setFlags,
  setupShop,
  shopConsents,
  shopTask,
  signIn,
  storedRequest,
  stubLine,
  WEB,
  type Joined,
  type Shop,
} from "./people-fixtures";

// The people around a shop (docs/people.md; docs/pilot-api.md, "Helpers"), through the real Worker and objects: the
// operator invites a helper with a link the API never sends; the helper signs in with Apple and joins only as the
// account the invite names; a helper session opens the shop's approvals and nothing else; removal signs a helper out
// on every device at once; cover never moves money or posts; and a helper passes a request on to the owner with a note.
// The global fetch counts LINE pushes and answers everything else 599, so nothing leaves the test.

const DAY = 24 * 60 * 60 * 1000;
let line: ReturnType<typeof stubLine>;

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
  line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
});

afterEach(() => {
  vi.restoreAllMocks();
});

type PeopleList = {
  tenant: string;
  owner: { name: string };
  helpers: { id: string; name: string; identity: Record<string, string>; joinedAt: string; devices: number }[];
  invites: { id: string; name: string; identity: Record<string, string>; status: string; createdAt: string;
    expiresAt: string; inviteUrl?: string }[];
  away: { helperId: string; name: string; until: string; inForce: boolean } | null;
  passedOn: { requestId: string; kind: string; by: string; name: string; note: string; at: string }[];
  removed: { id: string; name: string }[];
};

async function people(shop: Shop) {
  const listed = await admin<PeopleList>("GET", `/v1/admin/people?tenant=${encodeURIComponent(shop.tenant)}`);
  expect(listed.status).toBe(200);
  return listed.body;
}

/// The shop's people record as its TenantObject holds it.
async function storedPeople(shop: Shop): Promise<PeopleRecord | undefined> {
  return runInDurableObject(tenantStub(bindings, shop.tenant), async (_instance, state) =>
    state.storage.get<PeopleRecord>(`people:${encodeURIComponent(shop.tenant)}`));
}

describe("invites", () => {
  it("makes an invite for one identity that lasts 7 days, with a link to copy that the API never sends", async () => {
    const shop = await setupShop();
    const before = line.outbound().length;
    const made = await invite(shop, "  Mint  ", { kind: "email", address: "Mint@BaanMali.example" });
    expect(made.status).toBe(200);
    const { invite: created, inviteUrl } = made.body;
    expect(created).toMatchObject({ name: "Mint", status: "pending",
      identity: { kind: "email", address: "Mint@BaanMali.example" } });
    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(7 * DAY);
    expect(inviteUrl.startsWith(`${WEB}/join/`)).toBe(true);
    // Nothing was sent anywhere: the operator copies the link.
    expect(line.outbound().length).toBe(before);
    // The console shows the same link again while the invite waits.
    const listed = await people(shop);
    expect(listed.invites).toEqual([{ ...created, inviteUrl }]);
    // The log names the invite by its id, never the name or the address.
    const logged = (await auditEntries(shop.tenant)).find((entry) => entry.action === "invite.created");
    expect(logged).toMatchObject({ actor: { kind: "operator" }, subject: { inviteId: created.id }, outcome: "ok" });
    expect(JSON.stringify(logged)).not.toMatch(/mint/i);
  });

  it("refuses a bad identity, a bad name, a second open invite to one identity and a current helper", async () => {
    const shop = await setupShop();
    expect(await invite(shop, "Mint", { kind: "email", address: "no-at-sign" })).toMatchObject({ status: 400,
      body: { error: "bad_identity" } });
    expect(await invite(shop, "Mint", { kind: "line", id: "" })).toMatchObject({ status: 400,
      body: { error: "bad_identity" } });
    expect((await invite(shop, "Mint", { kind: "phone", number: "0812345678" })).status).toBe(400);
    expect((await invite(shop, "", { kind: "line", id: "Umint" })).status).toBe(400);
    expect((await invite(shop, "x".repeat(81), { kind: "line", id: "Umint" })).status).toBe(400);
    expect((await invite(shop, "Mint", { kind: "line", id: "Umint" })).status).toBe(200);
    expect(await invite(shop, "Mint again", { kind: "line", id: "Umint" })).toMatchObject({ status: 409,
      body: { error: "already_invited" } });
    const helper = await joinHelper(shop, "Beam");
    expect(await invite(shop, "Beam again", { kind: "email", address: helper.email.toUpperCase() })).toMatchObject({
      status: 409, body: { error: "already_helper" } });
  });

  it("answers for pilot shops only, and needs a configured link secret", async () => {
    expect((await admin("POST", "/v1/admin/people/invites", { tenant: "pilot:not-a-shop", name: "Mint",
      identity: { kind: "line", id: "Umint" } })).status).toBe(404);
    expect((await admin("POST", "/v1/admin/people/invites", { name: "Mint" })).status).toBe(400);
    expect((await admin("GET", "/v1/admin/people?tenant=pilot%3Anot-a-shop")).status).toBe(404);
  });

  it("joins the account the invite was sent to, once, and gives that device a helper session", async () => {
    const shop = await setupShop();
    const made = await invite(shop, "Mint", { kind: "email", address: "mint@baanmali.example" });
    const token = inviteToken(made.body.inviteUrl);
    const mint = await signIn("MINT@baanmali.example");
    const joined = await accept(mint, token);
    expect(joined.status).toBe(200);
    const body = joined.body as unknown as Joined;
    expect(body).toMatchObject({ answer: "joined", shop: { id: shop.tenant, name: "Baan Mali", ownerName: "Fon" },
      helper: { name: "Mint" } });
    expect(body.session.accessToken.startsWith("mhs1.")).toBe(true);
    expect(Date.parse(body.session.expiresAt) - Date.now()).toBeGreaterThan(29 * DAY);
    // Once: the next person with the link, even the same one, hears it was used.
    expect(await accept(mint, token)).toMatchObject({ status: 409, body: { answer: "already_used" } });
    const listed = await people(shop);
    expect(listed.helpers).toEqual([{ id: body.helper.id, name: "Mint",
      identity: { kind: "email", address: "mint@baanmali.example" }, joinedAt: expect.any(String), devices: 1 }]);
    expect(listed.invites[0]).toMatchObject({ status: "used" });
    expect(listed.invites[0]).not.toHaveProperty("inviteUrl");
    // Only the token's hash is kept.
    const stored = await storedPeople(shop);
    expect(JSON.stringify(stored)).not.toContain(body.session.accessToken);
    const logged = (await auditEntries(shop.tenant)).find((entry) => entry.action === "helper.joined");
    expect(logged).toMatchObject({ actor: { kind: "helper", id: body.helper.id },
      subject: { inviteId: made.body.invite.id, helperId: body.helper.id } });
  });

  it("tells the wrong account which shop and which kind of account, never the address, and keeps the invite", async () => {
    const shop = await setupShop();
    const byEmail = await invite(shop, "Mint", { kind: "email", address: "mint@baanmali.example" });
    const byLine = await invite(shop, "Beam", { kind: "line", id: "Ubeambaanmali" });
    const stranger = await signIn("beam.k@example.test");
    expect(await accept(stranger, inviteToken(byEmail.body.inviteUrl))).toEqual({ status: 403, body: {
      answer: "wrong_account", shop: { name: "Baan Mali", ownerName: "Fon" }, invitedOn: "email" } });
    // Nothing signs in as a LINE account yet, so a LINE invite is the wrong account for every Apple session.
    expect(await accept(stranger, inviteToken(byLine.body.inviteUrl))).toMatchObject({ status: 403,
      body: { answer: "wrong_account", invitedOn: "line" } });
    // A session whose email Apple did not verify is no one's account.
    expect((await accept(await signIn(), inviteToken(byEmail.body.inviteUrl))).body).toMatchObject({
      answer: "wrong_account" });
    expect((await accept(await signIn("mint@baanmali.example"), inviteToken(byEmail.body.inviteUrl))).status).toBe(200);
  });

  it("answers expired, revoked and unknown with nothing about the shop", async () => {
    const shop = await setupShop();
    const mint = await signIn("mint@baanmali.example");
    // Revoked.
    const revoked = await invite(shop, "Mint", { kind: "email", address: "mint@baanmali.example" });
    const revocation = await admin("POST", "/v1/admin/people/invites/revoke", { tenant: shop.tenant,
      inviteId: revoked.body.invite.id });
    expect(revocation).toMatchObject({ status: 200, body: { invite: { status: "revoked" } } });
    expect(await accept(mint, inviteToken(revoked.body.inviteUrl))).toEqual({ status: 410, body: { answer: "revoked" } });
    expect(await admin("POST", "/v1/admin/people/invites/revoke", { tenant: shop.tenant,
      inviteId: revoked.body.invite.id })).toMatchObject({ status: 409, body: { error: "not_pending" } });
    expect(await admin("POST", "/v1/admin/people/invites/revoke", { tenant: shop.tenant, inviteId: "inv-nope" }))
      .toMatchObject({ status: 404, body: { error: "unknown_invite" } });
    // Expired: an invite made 8 days ago, as the shop's record would hold it.
    const old = await invite(shop, "Mint", { kind: "email", address: "mint@baanmali.example" });
    await runInDurableObject(tenantStub(bindings, shop.tenant), async (_instance, state) => {
      const key = `people:${encodeURIComponent(shop.tenant)}`;
      const record = (await state.storage.get<PeopleRecord>(key))!;
      const invites = record.state.invites.map((one) => one.id === old.body.invite.id
        ? { ...one, createdAt: Date.now() - 8 * DAY, expiresAt: Date.now() - DAY } : one);
      await state.storage.put(key, { ...record, state: { ...record.state, invites } });
    });
    const expiredAt = (await people(shop)).invites.find((one) => one.id === old.body.invite.id)!;
    expect(expiredAt.status).toBe("expired");
    expect(expiredAt).not.toHaveProperty("inviteUrl");
    const oldToken = await mintInviteToken(bindings.APPROVAL_LINK_SECRET, { tenant: shop.tenant,
      inviteId: old.body.invite.id, expiresAtMs: Date.parse(expiredAt.expiresAt) });
    expect(await accept(mint, oldToken)).toEqual({ status: 410, body: { answer: "expired" } });
    // Unknown: an invite this shop never made, a token that does not verify, and the owner's other links.
    const never = await mintInviteToken(bindings.APPROVAL_LINK_SECRET, { tenant: shop.tenant, inviteId: "inv-never",
      expiresAtMs: Date.now() + DAY });
    for (const token of [
      never,
      `${never.slice(0, -2)}AA`,
      "not-a-token",
      await mintApprovalToken(bindings.APPROVAL_LINK_SECRET, { tenant: shop.tenant, taskId: "t",
        actionId: old.body.invite.id, expiresAtMs: Date.now() + DAY }),
      await mintDeletionToken(bindings.APPROVAL_LINK_SECRET, { tenant: shop.tenant, confirmationId: old.body.invite.id,
        expiresAtMs: Date.now() + DAY }),
    ]) {
      expect(await accept(mint, token)).toEqual({ status: 404, body: { answer: "unknown" } });
    }
  });

  it("needs a signed-in session to join, and the operator key is not one", async () => {
    const shop = await setupShop();
    const made = await invite(shop, "Mint", { kind: "email", address: "mint@baanmali.example" });
    const token = inviteToken(made.body.inviteUrl);
    expect(await accept({ headers: {} }, token)).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect((await accept({ headers: { authorization: "Bearer test-key" } }, token)).status).toBe(401);
    // A helper session is not a sign-in either.
    const helper = await joinHelper(shop, "Beam");
    expect((await accept(helper, token)).status).toBe(401);
    expect((await asSession((await signIn("mint@baanmali.example")).headers, "POST", "/v1/people/accept",
      { token, role: "owner" })).status).toBe(400);
  });
});

describe("helper sessions", () => {
  it("open the shop's approvals and nothing else", async () => {
    const shop = await setupShop();
    const reply = await proposeReply(shop, "Your parcel left this morning.");
    const helper = await joinHelper(shop);
    const open = await asSession<{ approvals: { taskId: string; record: { request: { id: string } } }[] }>(
      helper.headers, "GET", "/v1/approvals?state=open");
    expect(open.status).toBe(200);
    expect(open.body.approvals.map((entry) => entry.record.request.id)).toEqual([reply.actionId]);
    // Every route of the lifted session API that takes no shop session refuses it: a helper never acts as the shop.
    for (const [method, path] of [["DELETE", "/v1/tenant/data"], ["GET", "/v1/connections"]] as const) {
      expect((await asSession(helper.headers, method, path)).status).toBe(401);
    }
    // The shop's consent, export, tasks, schedules and attention items take the owner's shop session, so they tell a
    // helper's session they are the owner's, as the team's routines do, rather than that it ended; and they read and
    // write nothing for it.
    for (const [method, path, body] of [["GET", "/v1/tenant/export"], ["GET", "/v1/consent/cloud"],
      ["PUT", "/v1/consent/cloud", { enabled: false }], ["GET", "/v1/tasks"], ["GET", "/v1/schedules"],
      ["GET", "/v1/inbound/attention"]] as const) {
      expect(await asSession(helper.headers, method, path, body)).toEqual({ status: 403, body: { error: "owner_only" } });
    }
  });

  it("open on another device for the same verified identity, and for no one else", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const laptop = await signIn(helper.email);
    const opened = await asSession<{ helper: { id: string }; session: { accessToken: string } }>(laptop.headers, "POST",
      "/v1/people/session", { shop: shop.tenant });
    expect(opened.status).toBe(200);
    expect(opened.body.helper.id).toBe(helper.id);
    const second = { authorization: `Bearer ${opened.body.session.accessToken}` };
    expect((await asSession(second, "GET", "/v1/approvals?state=open")).status).toBe(200);
    expect((await people(shop)).helpers[0]?.devices).toBe(2);
    expect((await auditEntries(shop.tenant)).some((entry) => entry.action === "helper.session_opened" &&
      entry.subject.helperId === helper.id)).toBe(true);
    // Anyone else hears only that they are not a helper of that shop, whatever the shop is.
    const stranger = await signIn("someone@example.test");
    for (const target of [shop.tenant, "pilot:not-a-shop"]) {
      expect(await asSession(stranger.headers, "POST", "/v1/people/session", { shop: target })).toEqual({ status: 403,
        body: { error: "not_a_helper" } });
    }
    expect((await asSession({}, "POST", "/v1/people/session", { shop: shop.tenant })).status).toBe(401);
  });

  it("answers 401 to a token whose shop was changed, and to one that never existed", async () => {
    const shop = await setupShop();
    const other = await setupShop("Another shop");
    const helper = await joinHelper(shop);
    const [prefix, , secret] = helper.headers.authorization.slice("Bearer ".length).split(".");
    const moved = `${prefix}.${btoa(other.tenant).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${secret}`;
    expect((await asSession({ authorization: `Bearer ${moved}` }, "GET", "/v1/approvals?state=open")).status).toBe(401);
    expect((await asSession({ authorization: `Bearer ${prefix}.bm9wZQ.${"0".repeat(64)}` }, "GET",
      "/v1/approvals?state=open")).status).toBe(401);
  });
});

describe("removing a helper", () => {
  it("signs them out on every device at once, takes their invites and cover, and keeps what they approved with their name", async () => {
    const shop = await setupShop();
    const reply = await proposeReply(shop, "We ship on Monday.");
    await ownerConsents(reply);
    const helper = await joinHelper(shop, "Mint");
    const laptop = await asSession<{ session: { accessToken: string } }>((await signIn(helper.email)).headers, "POST",
      "/v1/people/session", { shop: shop.tenant });
    const devices = [helper.headers, { authorization: `Bearer ${laptop.body.session.accessToken}` }];
    // Mint approves a reply before she is removed.
    expect((await decide(helper.headers, reply.actionId, { optionId: "approve", seenRevision: 1 })).status).toBe(200);
    expect((await admin("POST", "/v1/admin/people/away", { tenant: shop.tenant, helperId: helper.id,
      until: new Date(Date.now() + 3 * DAY).toISOString() })).status).toBe(200);
    // A pending invite bound to Mint's address, as if re-sent by another path while she was a helper.
    await runInDurableObject(tenantStub(bindings, shop.tenant), async (_instance, state) => {
      const key = `people:${encodeURIComponent(shop.tenant)}`;
      const record = (await state.storage.get<PeopleRecord>(key))!;
      await state.storage.put(key, { ...record, state: { ...record.state, invites: [...record.state.invites, { id: "inv-again",
        identity: { kind: "email", address: helper.email }, createdAt: Date.now(), expiresAt: Date.now() + DAY,
        status: "pending" }] } });
    });
    const waiting = await plantRequest(shop.tenant, await shopTask(shop.tenant), "reply");

    const removed = await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: helper.id });
    expect(removed).toEqual({ status: 200, body: { removed: helper.id, sessionsEnded: 2, invitesRevoked: ["inv-again"],
      coverEnded: true } });
    for (const headers of devices) {
      const late = await decide(headers, waiting, { optionId: "approve", seenRevision: 1 });
      expect(late.status).toBe(401);
      expect(late.body.error).toBe("removed");
      expect(Number.isFinite(Date.parse(late.body.removedAt ?? ""))).toBe(true);
      expect((await asSession(headers, "GET", "/v1/approvals?state=open")).body).toMatchObject({ error: "removed" });
    }
    expect((await storedRequest(shop.tenant, reply.taskId, reply.actionId)).action.state).toBe("confirmed");
    expect(line.pushes()).toBe(1);
    const listed = await people(shop);
    expect(listed.helpers).toEqual([]);
    expect(listed.away).toBeNull();
    expect(listed.removed).toEqual([{ id: helper.id, name: "Mint" }]);
    expect(listed.invites.find((one) => one.id === "inv-again")?.status).toBe("revoked");
    // What Mint approved stays in the log under her id, which the people list still names.
    const entries = await auditEntries(shop.tenant);
    expect(entries.some((entry) => entry.action === "approval.decided" && entry.actor.kind === "helper" &&
      entry.actor.id === helper.id && entry.outcome === "approved")).toBe(true);
    expect(entries.find((entry) => entry.action === "helper.removed")).toMatchObject({ actor: { kind: "operator" },
      subject: { helperId: helper.id } });
    // She cannot open the shop again, and removing her twice finds no helper.
    expect((await asSession((await signIn(helper.email)).headers, "POST", "/v1/people/session",
      { shop: shop.tenant })).status).toBe(403);
    expect(await admin("POST", "/v1/admin/people/remove", { tenant: shop.tenant, helperId: helper.id }))
      .toMatchObject({ status: 404, body: { error: "not_a_helper" } });
  });
});

describe("cover while the owner is away", () => {
  it("sets one current helper to cover until a date, shows it, and clears it", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const until = new Date(Date.now() + 4 * DAY).toISOString();
    expect(await admin("POST", "/v1/admin/people/away", { tenant: shop.tenant, helperId: helper.id, until }))
      .toMatchObject({ status: 200, body: { away: { helperId: helper.id, name: "Mint", until, inForce: true } } });
    expect((await people(shop)).away).toEqual({ helperId: helper.id, name: "Mint", until, inForce: true });
    expect(await admin("POST", "/v1/admin/people/away", { tenant: shop.tenant, helperId: helper.id,
      until: new Date(Date.now() - DAY).toISOString() })).toMatchObject({ status: 400, body: { error: "bad_date" } });
    expect(await admin("POST", "/v1/admin/people/away", { tenant: shop.tenant, helperId: helper.id, until: "Friday" }))
      .toMatchObject({ status: 400, body: { error: "bad_date" } });
    expect(await admin("POST", "/v1/admin/people/away", { tenant: shop.tenant, helperId: "helper-nobody", until }))
      .toMatchObject({ status: 404, body: { error: "not_a_helper" } });
    expect(await admin("POST", "/v1/admin/people/away/clear", { tenant: shop.tenant })).toEqual({ status: 200,
      body: { away: null } });
    expect((await people(shop)).away).toBeNull();
    const actions = (await auditEntries(shop.tenant)).map((entry) => entry.action);
    expect(actions.filter((action) => action === "away.set")).toHaveLength(1);
    expect(actions.filter((action) => action === "away.cleared")).toHaveLength(1);
  });

  it("never moves money, posts, payment confirmations or commands to the covering helper", async () => {
    const shop = await setupShop();
    await shopConsents(shop.tenant);
    const helper = await joinHelper(shop, "Mint");
    expect((await admin("POST", "/v1/admin/people/away", { tenant: shop.tenant, helperId: helper.id,
      until: new Date(Date.now() + 4 * DAY).toISOString() })).status).toBe(200);
    const taskId = await shopTask(shop.tenant);
    for (const kind of ["money", "public_post", "payment_confirmation", "command"] as const) {
      const requestId = await plantRequest(shop.tenant, taskId, kind);
      for (const optionId of ["approve", "decline"]) {
        const refused = await decide(helper.headers, requestId, { optionId, seenRevision: 1 });
        expect(refused.status).toBe(403);
        expect(refused.body).toMatchObject({ error: "not_permitted", result: { ok: false, refused: "not_permitted" } });
      }
      expect((await storedRequest(shop.tenant, taskId, requestId)).record.status).toBe("pending");
    }
    // What a helper may decide stays theirs, covering or not.
    const message = await plantRequest(shop.tenant, taskId, "message");
    expect((await decide(helper.headers, message, { optionId: "decline", seenRevision: 1 })).status).toBe(200);
  });
});

describe("passing a request on", () => {
  it("hands the owner a request the helper may not decide, with a note, and decides nothing", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const taskId = await shopTask(shop.tenant);
    const refund = await plantRequest(shop.tenant, taskId, "money");
    const passed = await asSession<{ passedOn: Record<string, unknown> }>(helper.headers, "POST",
      `/v1/approvals/${refund}/pass-on`, { note: "  The customer sent a photo of the broken jar.  " });
    expect(passed.status).toBe(200);
    expect(passed.body.passedOn).toEqual({ requestId: refund, kind: "money", by: helper.id,
      note: "The customer sent a photo of the broken jar.", at: expect.any(String) });
    expect((await storedRequest(shop.tenant, taskId, refund)).record.status).toBe("pending");
    // The owner sees the note with the request, wherever the shop's approvals are listed.
    const owner = await tenantSession(shop.tenant);
    const open = await asSession<{ approvals: { record: { request: { id: string } }; passedOn?: unknown }[] }>(owner,
      "GET", "/v1/approvals?state=open");
    expect(open.body.approvals.find((entry) => entry.record.request.id === refund)?.passedOn).toEqual({ by: helper.id,
      name: "Mint", note: "The customer sent a photo of the broken jar.", at: expect.any(String) });
    expect((await people(shop)).passedOn).toEqual([{ requestId: refund, kind: "money", by: helper.id, name: "Mint",
      note: "The customer sent a photo of the broken jar.", at: expect.any(String) }]);
    // The log names the request, never the note.
    const logged = (await auditEntries(shop.tenant)).find((entry) => entry.action === "request.passed_on");
    expect(logged).toMatchObject({ actor: { kind: "helper", id: helper.id }, subject: { requestId: refund, taskId } });
    expect(JSON.stringify(logged)).not.toContain("broken jar");
    // The owner still decides.
    expect((await decide(owner, refund, { optionId: "decline", seenRevision: 1 })).status).toBe(200);
  });

  it("refuses a bad note, a request the helper may decide, a decided one, a second pass, and the owner", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const owner = await tenantSession(shop.tenant);
    const taskId = await shopTask(shop.tenant);
    const post = await plantRequest(shop.tenant, taskId, "public_post");
    const pass = (requestId: string, note: unknown, headers: { authorization: string } = helper.headers) =>
      asSession(headers, "POST", `/v1/approvals/${requestId}/pass-on`, { note });
    expect(await pass(post, "   ")).toMatchObject({ status: 400, body: { error: "bad_note" } });
    expect(await pass(post, "x".repeat(501))).toMatchObject({ status: 400, body: { error: "bad_note" } });
    expect((await pass(post, 42)).status).toBe(400);
    expect((await pass(post, "ก".repeat(500))).status).toBe(200);
    expect(await pass(post, "again")).toMatchObject({ status: 409, body: { error: "already_passed" } });
    expect(await pass(await plantRequest(shop.tenant, taskId, "reply"), "for you")).toMatchObject({ status: 409,
      body: { error: "decide_yourself" } });
    const decided = await plantRequest(shop.tenant, taskId, "money");
    expect((await decide(owner, decided, { optionId: "decline", seenRevision: 1 })).status).toBe(200);
    expect(await pass(decided, "too late")).toMatchObject({ status: 409, body: { error: "already_decided",
      by: "owner-session", at: expect.any(String) } });
    expect(await pass("no-such-request", "where")).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await pass(await plantRequest(shop.tenant, taskId, "money"), "for me", owner)).toMatchObject({ status: 403,
      body: { error: "not_a_helper" } });
  });
});

describe("the shop's record", () => {
  it("knows a session only by its own hash, never by a name every object inherits", async () => {
    const shop = await setupShop();
    await joinHelper(shop, "Mint");
    for (const tokenHash of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const checked = await tenantStub(bindings, shop.tenant).fetch(new Request("https://tenant/people/session-check", {
        method: "POST", headers: { "content-type": "application/json", "x-people": "1" },
        body: JSON.stringify({ tenant: shop.tenant, tokenHash }) }));
      expect(await checked.json()).toEqual({ ok: false, error: "unauthorized" });
    }
  });

  it("ends a session only by its own hash, never by a name every object inherits, and only at the Worker's asking", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const end = (path: string, tokenHash: string, headers: Record<string, string> = { "x-people": "1" }) =>
      tenantStub(bindings, shop.tenant).fetch(new Request(`https://tenant${path}`, { method: "POST",
        headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ tenant: shop.tenant, tokenHash }) }));
    for (const path of ["/people/end-helper-session", "/people/end-owner-session"]) {
      for (const tokenHash of ["__proto__", "constructor", "toString", "hasOwnProperty", "0".repeat(64)]) {
        expect(await (await end(path, tokenHash)).json()).toEqual({ ok: false, error: "unauthorized" });
      }
      // Without the Worker's header nothing is ended, not even a session the record holds.
      const held = await sha256Hex(helper.headers.authorization.slice("Bearer ".length));
      expect((await end(path, held, {})).status).toBe(403);
    }
    // The helper's own session was never ended by any of it.
    expect((await asSession(helper.headers, "GET", "/v1/approvals?state=open")).status).toBe(200);
  });

  it("keeps an invited email without outer spaces, and still matches it without case", async () => {
    const shop = await setupShop();
    const made = await invite(shop, "Mint", { kind: "email", address: "  Mint@BaanMali.example  " });
    expect(made.body.invite).toMatchObject({ identity: { kind: "email", address: "Mint@BaanMali.example" } });
    expect((await accept(await signIn("mint@baanmali.example"), inviteToken(made.body.inviteUrl))).status).toBe(200);
  });

  it("fails the shop's approvals rather than listing them without the notes passed on", async () => {
    const shop = await setupShop();
    await proposeReply(shop, "We open at nine.");
    const owner = await tenantSession(shop.tenant);
    const namespace = bindings.TENANT;
    const failing = { ...bindings, TENANT: {
      idFromName: (name: string) => namespace.idFromName(name),
      get: (id: DurableObjectId) => {
        const stub = namespace.get(id);
        return { fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname === "/people") return Response.json({ error: "fixture" }, { status: 500 });
          return stub.fetch(request);
        } };
      },
    } as unknown as DurableObjectNamespace };
    const context = createExecutionContext();
    const response = await worker.fetch(new Request("https://api.manut.test/v1/approvals?state=open",
      { headers: owner }), failing, context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "approvals_unavailable" });
  });
});

describe("the shop's export and deletion", () => {
  it("export the people without a session's token or hash, and deletion signs every helper out", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const exported = await tenantExport(bindings, shop.tenant);
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as { people?: { state: { helpers: { id: string }[] }; names: unknown;
      ownerAccount: unknown } };
    expect(Object.keys(body.people ?? {}).sort()).toEqual(["names", "ownerAccount", "state"]);
    expect(body.people?.ownerAccount).toBeNull();
    expect(body.people?.state.helpers.map((one) => one.id)).toEqual([helper.id]);
    expect(body.people?.names).toEqual({ [helper.id]: "Mint", [(await people(shop)).invites[0]!.id]: "Mint" });
    const secret = helper.headers.authorization.split(".")[2]!;
    expect(JSON.stringify(body)).not.toContain(secret);
    // The tenant deletion a shop's wipe runs takes the people with everything else, so no helper can open it again.
    expect((await tenantDelete(bindings, shop.tenant)).status).toBe(200);
    expect(await storedPeople(shop)).toBeUndefined();
    expect((await asSession(helper.headers, "GET", "/v1/approvals?state=open")).status).toBe(401);
  });
});
