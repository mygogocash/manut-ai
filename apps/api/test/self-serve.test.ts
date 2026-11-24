import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { templates } from "@manut/shop-templates";
import { describe, expect, it } from "vitest";
import { testOutbox } from "../src/email-sender";
import worker, { type Env } from "../src/index";
import type { PeopleRecord } from "../src/people-store";
import type { PilotShopRecord } from "../src/pilot-store";
import { MADE_RESERVATION_MS, SHOPS_MADE_LIMIT } from "../src/shops-store";
import { tenantStub } from "../src/tenant-data";
import {
  admin,
  asSession,
  auditEntries,
  bindings,
  call,
  failingWhere,
  joinHelper,
  setupShop,
  signIn,
  type SignedIn,
} from "./people-fixtures";
import { sourceWorker } from "./source-worker";

// Making a shop of one's own (docs/several-shops.md, "A shop its owner makes"; docs/pilot-api.md, "Making a shop of your
// own"): off until the owner opens sign-ups, made by the operator's own code with its template, owned by the person from
// the write that makes it, limited per account, and left out of the pilot gate's cohort.

type Made = { shop: { id: string; name: string; ownerName: string; template: string | null }; role: string;
  account: { id: string }; session: { accessToken: string; expiresAt: string } };

const make = (person: { headers: { authorization?: string } }, body: unknown) =>
  asSession<Made & { error?: string; limit?: number }>(person.headers, "POST", "/v1/shops/new", body);

const shopBody = (name = "Khao Hom", template: string | null = "food") => ({ name, ownerName: "Dao", template });

/// Signs `email` in through the real email code exchange, as the desktop's Settings › Developer does.
async function emailSignIn(email: string): Promise<SignedIn> {
  const asked = await sourceWorker.fetch("https://api.manut.test/v1/auth/email/code", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  expect(asked.status).toBe(200);
  const sent = testOutbox().filter((one) => one.to === email);
  const code = /sign-in code is (\d{6})\./.exec(sent[sent.length - 1]?.text ?? "")?.[1];
  expect(code).toBeDefined();
  const deviceId = `device-${crypto.randomUUID()}`;
  const exchanged = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "email", email, code, deviceId }) });
  expect(exchanged.status).toBe(200);
  const body = (await exchanged.json()) as { tenant: string; accessToken: string; refreshToken: string };
  return { ...body, deviceId, headers: { authorization: `Bearer ${body.accessToken}` } };
}

/// The Worker with `changes` to its settings, and an AUTH and a TENANT that only count the calls that reach them.
function counting(changes: Record<string, unknown>) {
  let calls = 0;
  const counted = (name: "AUTH" | "TENANT") => ({ idFromName: (id: string) => bindings[name].idFromName(id),
    get: () => ({ fetch: async () => { calls++; return Response.json({ fixture: true }); } }) });
  return { env: { ...bindings, ...changes, AUTH: counted("AUTH"), TENANT: counted("TENANT") } as unknown as Env,
    calls: () => calls };
}

async function send(target: Env, init: { method: string; authorization?: string; body?: string }) {
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  const headers = new Headers({ "content-type": "application/json", "cf-connecting-ip": `2001:db8:${groups.join(":")}` });
  if (init.authorization) headers.set("authorization", init.authorization);
  if (init.body !== undefined) headers.set("content-length", String(new TextEncoder().encode(init.body).length));
  const context = createExecutionContext();
  const response = await worker.fetch(new Request("https://api.manut.test/v1/shops/new", { method: init.method, headers,
    ...(init.body === undefined ? {} : { body: init.body }) }), target, context);
  await waitOnExecutionContext(context);
  return response;
}

async function listed(person: SignedIn) {
  const shops = await asSession<{ shops: { id: string; name: string; ownerName: string; role: string }[] }>(person.headers,
    "GET", "/v1/shops");
  expect(shops.status).toBe(200);
  return shops.body.shops;
}

async function consoleShops() {
  const shops = await admin<{ shops: { tenant: string; name: string; template?: string; selfServe?: boolean }[] }>("GET",
    "/v1/admin/pilot/shops");
  expect(shops.status).toBe(200);
  return shops.body.shops;
}

/// The shop's own records, read from its object's storage.
async function stored(tenant: string): Promise<{ shop: PilotShopRecord | undefined; people: PeopleRecord | undefined }> {
  return runInDurableObject(tenantStub(bindings, tenant), async (_instance, state) => ({
    shop: await state.storage.get<PilotShopRecord>(`pilot-shop:${encodeURIComponent(tenant)}`),
    people: await state.storage.get<PeopleRecord>(`people:${encodeURIComponent(tenant)}`),
  }));
}

describe("making a shop of one's own, while sign-ups are closed", () => {
  it("answers sign_ups_closed to everyone, whatever they send, and reads nothing", async () => {
    const person = await signIn();
    for (const closed of [undefined, "", "off", "1", "true", "ON"]) {
      const target = counting({ SELF_SERVE_SHOPS: closed });
      for (const request of [
        { method: "POST", authorization: person.headers.authorization, body: JSON.stringify(shopBody()) },
        { method: "POST", body: JSON.stringify(shopBody()) },
        { method: "GET", authorization: person.headers.authorization },
        { method: "POST", authorization: "Bearer test-key", body: "not json" },
      ]) {
        const response = await send(target.env, request);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "sign_ups_closed" });
      }
      expect(target.calls()).toBe(0);
    }
  });

  it("makes no shop and lists none while closed", async () => {
    const person = await signIn();
    const response = await send({ ...bindings, SELF_SERVE_SHOPS: undefined } as unknown as Env, { method: "POST",
      authorization: person.headers.authorization, body: JSON.stringify(shopBody("Closed Shop")) });
    expect(response.status).toBe(403);
    expect(await listed(person)).toEqual([]);
    expect((await consoleShops()).some((shop) => shop.name === "Closed Shop")).toBe(false);
  });
});

describe("making a shop of one's own", () => {
  it.each([...templates().map((template) => template.id), null])("makes a shop from template %s, owned by the person", async (id) => {
    const person = await signIn();
    const name = `Shop ${crypto.randomUUID().slice(0, 6)}`;
    const made = await make(person, shopBody(name, id));
    expect(made.status).toBe(201);
    expect(made.body.shop).toEqual({ id: expect.stringMatching(/^pilot:[0-9a-f-]{36}$/), name, ownerName: "Dao", template: id });
    expect(made.body.role).toBe("owner");
    expect(made.body.account.id).toMatch(/^owner-[0-9a-f-]{36}$/);
    expect(made.body.session.accessToken).toMatch(/^mos1\./);
    const days = (Date.parse(made.body.session.expiresAt) - Date.now()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    // Nothing in the answer names the person's identity.
    expect(JSON.stringify(made.body)).not.toContain(person.tenant);

    const tenant = made.body.shop.id;
    // Their own list has it, as theirs, and the console lists it, marked as made by its owner.
    expect(await listed(person)).toEqual([{ id: tenant, name, ownerName: "Dao", role: "owner" }]);
    const row = (await consoleShops()).find((shop) => shop.tenant === tenant);
    expect(row).toMatchObject({ tenant, name, ownerName: "Dao", selfServe: true, consent: false });
    expect(row?.template).toBe(id ?? undefined);

    // The session it was given is the owner's, on the owner's routes: the team's routines are the template's, each paused.
    const owner = { authorization: `Bearer ${made.body.session.accessToken}` };
    const routines = await asSession<{ team: { members: string[] }; routines: { paused: boolean; template?: string }[] }>(owner,
      "GET", "/v1/routines");
    expect(routines.status).toBe(200);
    const template = templates().find((one) => one.id === id);
    expect(routines.body.routines).toHaveLength(template?.routines.length ?? 0);
    expect(routines.body.routines.every((routine) => routine.paused && routine.template === id)).toBe(true);
    if (template) expect(routines.body.team.members).toEqual(template.team.filter((member) => member !== "kit"));
    expect((await asSession(owner, "GET", "/v1/approvals?state=open")).status).toBe(200);
    // The first-week questions are kept, as an operator's template keeps them.
    const questions = await admin<{ template: string | null; questions: { text: string }[] }>("GET",
      `/v1/admin/questions?tenant=${encodeURIComponent(tenant)}`);
    expect(questions.body.template).toBe(id);
    expect(questions.body.questions.map((question) => question.text)).toEqual(template?.questions ?? []);
    // Opening the shop again with the sign-in gives another owner session, as for a shop an operator linked.
    const again = await asSession<{ role: string }>(person.headers, "POST", "/v1/shops/session", { shop: tenant });
    expect(again.body.role).toBe("owner");
  });

  it("makes a shop for a person signed in by a code sent by email, too", async () => {
    const person = await emailSignIn(`dao-${crypto.randomUUID()}@khaohom.example`);
    expect(person.tenant).toMatch(/^email:/);
    const made = await make(person, shopBody("Khao Hom", "food"));
    expect(made.status).toBe(201);
    expect(await listed(person)).toEqual([{ id: made.body.shop.id, name: "Khao Hom", ownerName: "Dao", role: "owner" }]);
  });

  it("links the owner in the very write that makes the shop, with its first session and every entry", async () => {
    const person = await signIn();
    const made = await make(person, shopBody("Baan Fon", "handmade"));
    const tenant = made.body.shop.id;
    const { shop, people } = await stored(tenant);
    expect(shop).toMatchObject({ tenant, name: "Baan Fon", ownerName: "Dao", template: "handmade", selfServe: true });
    // One write: the link, its session and the shop share one moment, the shop's own clock.
    expect(people?.ownerAccount).toEqual({ id: made.body.account.id, subject: person.tenant, linkedAt: Date.parse(shop!.createdAt) });
    const sessions = Object.values(people?.ownerSessions ?? {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ accountId: made.body.account.id, expiresAt: Date.parse(made.body.session.expiresAt) });
    expect(people?.state.helpers).toEqual([]);
    expect(people?.sessions).toEqual({});

    const entries = (await auditEntries(tenant)).reverse();
    const byOwner = { kind: "owner", id: made.body.account.id };
    const about = { ownerAccountId: made.body.account.id };
    expect(entries.slice(0, 4)).toEqual([
      expect.objectContaining({ actor: byOwner, action: "shop.created", subject: {}, outcome: "ok", at: shop!.createdAt }),
      expect.objectContaining({ actor: byOwner, action: "shop.made_by_owner", subject: about, outcome: "ok", at: shop!.createdAt }),
      expect.objectContaining({ actor: byOwner, action: "owner.linked", subject: about, outcome: "ok", at: shop!.createdAt }),
      expect.objectContaining({ actor: byOwner, action: "owner.session_opened", subject: about, outcome: "ok", at: shop!.createdAt }),
    ]);
    // Then the template, applied as the operator's route applies it, by the same account.
    expect(entries.slice(4).map((entry) => entry.action)).toEqual(["template.applied", "routine.created", "routine.created",
      "routine.created", "routine.created"]);
    expect(entries.every((entry) => entry.actor.kind === "owner" && entry.actor.id === made.body.account.id)).toBe(true);
    // The log names the account by its link id only: never the person's subject.
    expect(JSON.stringify(entries)).not.toContain(person.tenant);
  });

  it("never makes a shop half owned: a shop write with an owner that is not whole makes nothing", async () => {
    const tenant = `pilot:${crypto.randomUUID()}`;
    const response = await tenantStub(bindings, tenant).fetch(new Request("https://tenant/pilot/shop", { method: "POST",
      headers: { "content-type": "application/json", "x-pilot": "1" },
      body: JSON.stringify({ tenant, name: "Half", ownerName: "Dao", taskId: "pilot-task-half",
        owner: { accountId: "owner-1", subject: "apple:x", sessionId: "os-1", tokenHash: "not-a-hash", expiresAt: 1 } }) }));
    expect(response.status).toBe(400);
    expect(await stored(tenant)).toEqual({ shop: undefined, people: undefined });
  });

  it("names the person's email nowhere in the shop's log", async () => {
    const email = `noi-${crypto.randomUUID()}@ranpanoi.example`;
    const person = await signIn(email);
    const made = await make(person, shopBody("Ran Pa Noi", null));
    const entries = await auditEntries(made.body.shop.id);
    expect(entries.map((entry) => entry.action).sort()).toEqual(["owner.linked", "owner.session_opened", "shop.created",
      "shop.made_by_owner"]);
    expect(JSON.stringify(entries)).not.toContain(email);
    expect(JSON.stringify(entries)).not.toContain(person.tenant);
  });
});

describe("the limits on making shops", () => {
  it(`lets one account make ${SHOPS_MADE_LIMIT} shops at a time, and says so plainly after`, async () => {
    const person = await signIn();
    const ids: string[] = [];
    for (let n = 1; n <= SHOPS_MADE_LIMIT; n++) {
      const made = await make(person, shopBody(`Shop ${n}`, null));
      expect(made.status).toBe(201);
      ids.push(made.body.shop.id);
    }
    const refused = await make(person, shopBody("One too many", null));
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: "too_many_shops", limit: SHOPS_MADE_LIMIT });
    expect((await listed(person)).map((shop) => shop.id).sort()).toEqual([...ids].sort());
    expect((await consoleShops()).some((shop) => shop.name === "One too many")).toBe(false);
    // Another account has a limit of its own.
    expect((await make(await signIn(), shopBody("Someone else's", null))).status).toBe(201);
    // A shop of theirs that is deleted stops counting: an operator deletes one that never went live, and one more fits.
    const deleted = await admin("POST", "/v1/admin/pilot/deletions", { tenant: ids[0], confirmName: "Shop 1" });
    expect(deleted.status).toBe(200);
    expect((await make(person, shopBody("After a deletion", null))).status).toBe(201);
    expect((await make(person, shopBody("Still too many", null))).status).toBe(409);
  });

  it("holds the limit when several requests race", async () => {
    const person = await signIn();
    const answers = await Promise.all(Array.from({ length: SHOPS_MADE_LIMIT + 2 }, (_, n) =>
      make(person, shopBody(`Racing ${n}`, null))));
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(SHOPS_MADE_LIMIT);
    expect(answers.filter((answer) => answer.status === 409)).toHaveLength(2);
    expect(await listed(person)).toHaveLength(SHOPS_MADE_LIMIT);
  });

  it("does not count shops an operator linked to the account", async () => {
    const person = await signIn();
    for (const name of ["Linked 1", "Linked 2", "Linked 3"]) {
      const shop = await setupShop(name);
      const code = await asSession<{ code: string }>(person.headers, "POST", "/v1/shops/owner-code");
      expect((await admin("POST", "/v1/admin/shops/owner", { tenant: shop.tenant, code: code.body.code })).status).toBe(200);
    }
    expect((await make(person, shopBody("Made too", null))).status).toBe(201);
  });

  it("gives a failed make's slot back, and lists nothing of it", async () => {
    const person = await signIn();
    // The shop's own object refuses the write: nothing is made, listed or counted.
    const shopDown = failingWhere("TENANT", (request) => new URL(request.url).pathname === "/pilot/shop");
    for (let n = 0; n < SHOPS_MADE_LIMIT + 1; n++) {
      const failed = await send(shopDown, { method: "POST", authorization: person.headers.authorization,
        body: JSON.stringify(shopBody(`Down ${n}`, null)) });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: "shop_unavailable" });
    }
    // AuthObject cannot list it: the shop's records exist, but it is on no list, and its slot goes back.
    const listingDown = failingWhere("AUTH", (request) => new URL(request.url).pathname === "/shops-made/finish");
    const unlisted = await send(listingDown, { method: "POST", authorization: person.headers.authorization,
      body: JSON.stringify(shopBody("Not listed", "fashion")) });
    expect(unlisted.status).toBe(503);
    expect(await unlisted.json()).toEqual({ error: "shop_unavailable" });
    expect(await listed(person)).toEqual([]);
    expect((await consoleShops()).some((shop) => shop.name === "Not listed" || shop.name.startsWith("Down "))).toBe(false);
    for (let n = 1; n <= SHOPS_MADE_LIMIT; n++) expect((await make(person, shopBody(`Up ${n}`, null))).status).toBe(201);
  });

  it(`lets a reservation that never finished stop counting after ${MADE_RESERVATION_MS / 60_000} minutes`, async () => {
    const person = await signIn();
    const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    // A make that begins and goes no further: each asks for a shop of its own name, so none finds another on the journal.
    const reserve = (shop: string, name: string) => auth.fetch(new Request("https://auth/pilot-making/begin", { method: "POST",
      headers: { "content-type": "application/json", "x-admin": "1" },
      body: JSON.stringify({ tenant: shop, name, ownerName: "Dao", template: null, subject: person.tenant }) }));
    for (let n = 0; n < SHOPS_MADE_LIMIT; n++) expect((await reserve(`pilot:${crypto.randomUUID()}`, `Began ${n}`)).status).toBe(200);
    expect((await reserve(`pilot:${crypto.randomUUID()}`, "One too many")).status).toBe(409);
    // Ten minutes on, as if every one of those makes had failed without giving its slot back.
    await runInDurableObject(auth, async (_instance, state) => {
      const key = `shops-made:${encodeURIComponent(person.tenant)}`;
      const rows = state.storage.kv.get<{ shop: string; at: number; done: boolean }[]>(key) ?? [];
      state.storage.kv.put(key, rows.map((row) => ({ ...row, at: row.at - MADE_RESERVATION_MS })));
    });
    expect((await make(person, shopBody("After the wait", null))).status).toBe(201);
  });
});

describe("what making a shop refuses", () => {
  it("refuses names that are empty, too long or not a name, and a template that is not one, making nothing", async () => {
    const person = await signIn();
    const cases: [unknown, number, string][] = [
      [{ ...shopBody(), name: "" }, 400, "invalid_name"],
      [{ ...shopBody(), name: "   " }, 400, "invalid_name"],
      [{ ...shopBody(), name: "x".repeat(81) }, 400, "invalid_name"],
      [{ ...shopBody(), name: "Baan\nMali" }, 400, "invalid_name"],
      [{ ...shopBody(), name: 7 }, 400, "invalid_name"],
      [{ ...shopBody(), ownerName: "" }, 400, "invalid_owner_name"],
      [{ ...shopBody(), ownerName: "y".repeat(81) }, 400, "invalid_owner_name"],
      [{ ...shopBody(), template: "bakery" }, 400, "unknown_template"],
      [{ ...shopBody(), template: 3 }, 400, "unknown_template"],
      [{ ...shopBody(), template: { id: "food" } }, 400, "unknown_template"],
      [{ name: "Khao Hom", ownerName: "Dao" }, 400, "invalid_request"],
      [{ ...shopBody(), owner: person.tenant }, 400, "invalid_request"],
      [{ ...shopBody(), role: "owner" }, 400, "invalid_request"],
      [{ ...shopBody(), tenant: "pilot:x" }, 400, "invalid_request"],
      [[shopBody()], 400, "invalid_request"],
    ];
    for (const [body, status, error] of cases) {
      const refused = await make(person, body);
      expect({ body: JSON.stringify(body), status: refused.status, error: refused.body.error }).toEqual({
        body: JSON.stringify(body), status, error });
    }
    const notJson = await call("/v1/shops/new", { method: "POST", headers: { ...person.headers,
      "content-type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "invalid_json" });
    // A name keeps its letters, trimmed and composed: "  Café  " is "Café".
    const trimmed = await make(person, shopBody("  Café  ", null));
    expect(trimmed.body.shop.name).toBe("Café");
    expect(await listed(person)).toHaveLength(1);
  });

  it("asks who is signed in first, then the method", async () => {
    expect((await asSession({}, "POST", "/v1/shops/new", shopBody())).body).toEqual({ error: "unauthorized" });
    expect((await asSession({ authorization: "Bearer test-key" }, "POST", "/v1/shops/new", shopBody())).status).toBe(401);
    expect((await asSession({ authorization: "Bearer nothing" }, "GET", "/v1/shops/new")).status).toBe(401);
    const person = await signIn();
    expect((await asSession(person.headers, "GET", "/v1/shops/new")).body).toEqual({ error: "method_not_allowed" });
    expect((await asSession(person.headers, "PUT", "/v1/shops/new", shopBody())).status).toBe(405);
  });

  it("refuses a shop session and a helper session: making a shop takes the person's own sign-in", async () => {
    const person = await signIn();
    const made = await make(person, shopBody("Owned", null));
    const ownerSession = { authorization: `Bearer ${made.body.session.accessToken}` };
    const asOwner = await make({ headers: ownerSession }, shopBody("From a shop session", null));
    expect(asOwner).toEqual({ status: 401, body: { error: "unauthorized" } });
    const helper = await joinHelper(await setupShop("Baan Mali"));
    const asHelper = await make({ headers: helper.headers }, shopBody("From a helper session", null));
    expect(asHelper).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect((await consoleShops()).some((shop) => shop.name.startsWith("From a "))).toBe(false);
  });
});

describe("the pilot gate and a shop its owner made", () => {
  it("lists it, marked, and leaves it out of the cohort", async () => {
    const person = await signIn();
    const made = await make(person, shopBody("Gate Shop", "fashion"));
    const operators = await setupShop("Operator's Shop");
    const gate = await admin<{ shops: { tenant: string; selfServe?: boolean; inCohort: boolean }[] }>("GET",
      "/v1/admin/pilot/gate");
    expect(gate.status).toBe(200);
    expect(gate.body.shops.find((shop) => shop.tenant === made.body.shop.id)).toMatchObject({ selfServe: true, inCohort: false });
    const theirs = gate.body.shops.find((shop) => shop.tenant === operators.tenant);
    expect(theirs?.inCohort).toBe(true);
    expect(theirs?.selfServe).toBeUndefined();
  });

  it("is counted once an operator adds it, and left out again when they take it back, each change in its log", async () => {
    const made = await make(await signIn(), shopBody("Added Shop", null));
    const tenant = made.body.shop.id;
    const inCohort = async () => (await admin<{ shops: { tenant: string; inCohort: boolean }[] }>("GET", "/v1/admin/pilot/gate"))
      .body.shops.find((shop) => shop.tenant === tenant)?.inCohort;
    expect(await admin("POST", "/v1/admin/pilot/gate/cohort", { tenant, counted: true })).toEqual({ status: 200,
      body: { tenant, counted: true } });
    expect(await inCohort()).toBe(true);
    // Asking for what already holds changes and records nothing.
    expect((await admin("POST", "/v1/admin/pilot/gate/cohort", { tenant, counted: true })).body).toEqual({ tenant, counted: true });
    expect(await admin("POST", "/v1/admin/pilot/gate/cohort", { tenant, counted: false })).toEqual({ status: 200,
      body: { tenant, counted: false } });
    expect(await inCohort()).toBe(false);
    const changes = (await auditEntries(tenant)).filter((entry) => entry.action.startsWith("cohort."));
    expect(changes.map((entry) => [entry.action, entry.actor.kind, entry.subject])).toEqual([
      ["cohort.removed", "operator", {}],
      ["cohort.added", "operator", {}],
    ]);
  });

  it("refuses a shop an operator made, which is always counted, and a body that is not exactly the change", async () => {
    const operators = await setupShop("Always Counted");
    expect(await admin("POST", "/v1/admin/pilot/gate/cohort", { tenant: operators.tenant, counted: true })).toEqual({ status: 409,
      body: { error: "not_self_serve" } });
    const made = await make(await signIn(), shopBody("Body Shop", null));
    for (const body of [{ tenant: made.body.shop.id }, { tenant: made.body.shop.id, counted: "yes" },
      { tenant: made.body.shop.id, counted: true, by: "me" }]) {
      expect((await admin("POST", "/v1/admin/pilot/gate/cohort", body)).body).toEqual({ error: "invalid_request" });
    }
    expect((await admin("POST", "/v1/admin/pilot/gate/cohort", { counted: true })).body).toEqual({ error: "tenant_required" });
    expect((await admin("POST", "/v1/admin/pilot/gate/cohort", { tenant: "pilot:nobody", counted: true })).status).toBe(404);
    // Only the operator reaches it: a person's session is not the admin gate's.
    const person = await signIn();
    expect((await asSession(person.headers, "POST", "/v1/admin/pilot/gate/cohort", { tenant: made.body.shop.id,
      counted: true })).status).toBe(403);
  });
});
