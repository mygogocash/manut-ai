import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { templates } from "@manut/shop-templates";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import type { PeopleRecord } from "../src/people-store";
import { MADE_RESERVATION_MS, SHOPS_MADE_LIMIT, type MadeShopRow, type MakingRow } from "../src/shops-store";
import { authCall, tenantDelete, tenantStub } from "../src/tenant-data";
import { admin, asSession, auditEntries, bindings, signIn, type SignedIn } from "./people-fixtures";

// Making a shop that stops part way (docs/pilot-api.md, "A make that stops part way"). A make writes to several objects: the
// journal of makes and the person's slot in AuthObject, the shop's clocks, the shop's own object, and last the console's
// list. Each test here makes one of those calls fail, on the operator's route and on the person's own, and checks what is
// left, that asking again finishes the same shop, that no slot is lost, what the console lists and what the log says.

const FOOD = templates().find((template) => template.id === "food")!;
const ROUTINES = FOOD.routines.length;
const AUTH = () => bindings.AUTH.get(bindings.AUTH.idFromName("auth"));

/// What the log of a shop made whole says, oldest first: the shop, then its template's setup. A shop its owner makes also
/// says who made it and linked, and the owner's first session.
const WHOLE = ["shop.created", "template.applied", ...Array<string>(ROUTINES).fill("routine.created")];
const WHOLE_BY_OWNER = ["shop.created", "shop.made_by_owner", "owner.linked", "owner.session_opened", "template.applied",
  ...Array<string>(ROUTINES).fill("routine.created")];

type Binding = "AUTH" | "TENANT" | "SCHEDULES";
type Fail = { binding: Binding; method: string; path: string | string[]; times?: number; lost?: boolean; throws?: boolean };

/// The Worker's environment with the next `times` calls (once, or `Infinity`) of one kind to one object answering 500, as when
/// that object cannot be reached, or with `throws`, throwing as a call to an object that is down does; with `lost`, the object
/// does the work and only its answer is lost on the way back. Every other call reaches the real objects. `seen` is every call
/// that went through, as `METHOD /path`.
function failing(fail: Fail) {
  let left = fail.times ?? 1;
  const seen: string[] = [];
  const namespace = bindings[fail.binding];
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          seen.push(`${request.method} ${path}`);
          if (request.method === fail.method && [fail.path].flat().includes(path) && left > 0) {
            left--;
            if (fail.lost) await (await stub.fetch(request)).arrayBuffer();
            if (fail.throws) throw new Error("fixture: object unreachable");
            return Response.json({ error: "fixture_call_failed" }, { status: 500 });
          }
          return stub.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { env: { ...bindings, [fail.binding]: wrapped } as Env, seen };
}

type Call = { method: string; path: string };

/// The Worker's environment where each call of kind `hold` waits until `times` calls of kind `after` have been answered, so
/// that two asks for one shop overlap at the step a test is about, however busy the machine is, instead of the second coming
/// after the first is over.
function overlapping(binding: Binding, after: Call, hold: Call, times = 2): Env {
  let answered = 0;
  let enough!: () => void;
  const enoughAnswered = new Promise<void>((resolve) => { enough = resolve; });
  const namespace = bindings[binding];
  const wrapped = {
    idFromName: (name: string) => namespace.idFromName(name),
    get: (id: DurableObjectId) => {
      const stub = namespace.get(id);
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const path = new URL(request.url).pathname;
          const is = (call: Call) => request.method === call.method && path === call.path;
          if (is(hold)) await enoughAnswered;
          const answer = await stub.fetch(request);
          if (is(after) && ++answered >= times) enough();
          return answer;
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { ...bindings, [binding]: wrapped } as Env;
}

const BEGIN: Call = { method: "POST", path: "/pilot-making/begin" };

async function send(target: Env, path: string, init: { method?: string; authorization?: string; body?: unknown;
  operator?: boolean }) {
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  const headers = new Headers({ "content-type": "application/json", "cf-connecting-ip": `2001:db8:${groups.join(":")}` });
  if (init.operator) headers.set("authorization", "Bearer test-key");
  if (init.authorization) headers.set("authorization", init.authorization);
  const context = createExecutionContext();
  if (init.operator) {
    Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD, getIdentity: async () => undefined },
      configurable: true });
  }
  const response = await worker.fetch(new Request(`https://api.manut.test${path}`, { method: init.method ?? "POST", headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }), target, context);
  await waitOnExecutionContext(context);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const operatorMake = (target: Env, body: unknown) => send(target, "/v1/admin/pilot/shops", { operator: true, body });
const ownMake = (target: Env, person: SignedIn, body: unknown) =>
  send(target, "/v1/shops/new", { authorization: person.headers.authorization, body });

const uniqueName = (label: string) => `${label} ${crypto.randomUUID().slice(0, 6)}`;
const operatorBody = (name: string) => ({ name, ownerName: "Fon", template: "food" });
const ownBody = (name: string) => ({ name, ownerName: "Dao", template: "food" });

/// The journal of makes: every shop that has begun and is not yet listed.
async function journal(name?: string): Promise<MakingRow[]> {
  const rows = await runInDurableObject(AUTH(), async (_instance, state) =>
    [...state.storage.kv.list<MakingRow>({ prefix: "pilot-making:" })].map(([, row]) => row));
  return name === undefined ? rows : rows.filter((row) => row.name === name);
}

/// The person's slots: their made shops, each reserved, and `done` once listed.
async function slots(person: SignedIn): Promise<MadeShopRow[]> {
  return runInDurableObject(AUTH(), async (_instance, state) =>
    state.storage.kv.get<MadeShopRow[]>(`shops-made:${encodeURIComponent(person.tenant)}`) ?? []);
}

/// What the shop's own object holds, and whether the console's list has it.
async function shopState(tenant: string) {
  const key = encodeURIComponent(tenant);
  const stored = await runInDurableObject(tenantStub(bindings, tenant), async (_instance, state) => ({
    shop: await state.storage.get<{ name: string; template?: string; selfServe?: true }>(`pilot-shop:${key}`),
    routines: (await state.storage.get<{ routines: unknown[]; questions: unknown[] }>(`routines:${key}`)) ?? null,
    people: await state.storage.get<PeopleRecord>(`people:${key}`),
  }));
  const listed = ((await (await authCall(bindings, `/pilot-shops?tenant=${encodeURIComponent(tenant)}`)).json()) as
    { registered: boolean }).registered;
  return { ...stored, listed, log: (await auditEntries(tenant)).map((entry) => entry.action).reverse() };
}

async function consoleRows(name: string) {
  const listed = await admin<{ shops: { tenant: string; name: string; ownerName: string; template?: string; consent: boolean;
    selfServe?: boolean; deleting?: unknown }[] }>("GET", "/v1/admin/pilot/shops");
  expect(listed.status).toBe(200);
  return listed.body.shops.filter((shop) => shop.name === name);
}

async function personsShops(person: SignedIn, name: string) {
  const listed = await asSession<{ shops: { id: string; name: string }[] }>(person.headers, "GET", "/v1/shops");
  expect(listed.status).toBe(200);
  return listed.body.shops.filter((shop) => shop.name === name);
}

/// How many more shops the person can make now, trying with fresh names until the limit says no.
async function slotsLeft(person: SignedIn): Promise<number> {
  let made = 0;
  for (let n = 0; n < SHOPS_MADE_LIMIT + 2; n++) {
    const answer = await ownMake(bindings, person, { name: uniqueName(`Filler ${n}`), ownerName: "Dao", template: null });
    if (answer.status === 201) made++;
    else expect(answer.body).toEqual({ error: "too_many_shops", limit: SHOPS_MADE_LIMIT });
  }
  return made;
}

type Step = { when: string; fail: Fail };

/// Every call a make makes to an object, in the order it makes them, after the one that begins it.
const OPERATOR_STEPS: Step[] = [
  { when: "finding out whether the shop is already there fails", fail: { binding: "TENANT", method: "GET", path: "/pilot/shop" } },
  { when: "the shop's clocks cannot be written", fail: { binding: "SCHEDULES", method: "POST", path: "/routine-clocks" } },
  { when: "the shop's own write fails", fail: { binding: "TENANT", method: "POST", path: "/pilot/shop" } },
  { when: "the shop's own write is done but its answer is lost", fail: { binding: "TENANT", method: "POST", path: "/pilot/shop",
    lost: true } },
  { when: "listing the shop fails", fail: { binding: "AUTH", method: "POST", path: "/pilot-shops", times: Infinity } },
];

describe("an operator's make that stops part way", () => {
  it("makes nothing when it cannot begin, and the next try makes one shop", async () => {
    const name = uniqueName("Begin");
    const down = failing({ binding: "AUTH", method: "POST", path: "/pilot-making/begin" });
    expect(await operatorMake(down.env, operatorBody(name))).toEqual({ status: 503, body: { error: "shop_unavailable" } });
    // The shop's own object was never reached, and nothing is on the journal or the console's list.
    expect(down.seen.filter((call) => call.includes("/pilot/") || call.includes("/routine-clocks"))).toEqual([]);
    expect(await journal(name)).toEqual([]);
    expect(await consoleRows(name)).toEqual([]);
    const retried = await operatorMake(bindings, operatorBody(name));
    expect(retried.status).toBe(200);
    expect(await consoleRows(name)).toHaveLength(1);
    expect(await journal(name)).toEqual([]);
  });

  it("finishes the shop it began when only the answer to beginning was lost", async () => {
    const name = uniqueName("Begin lost");
    const lost = failing({ binding: "AUTH", method: "POST", path: "/pilot-making/begin", lost: true });
    expect((await operatorMake(lost.env, operatorBody(name))).status).toBe(503);
    const [began] = await journal(name);
    expect(began).toMatchObject({ name, ownerName: "Fon", template: "food", by: null });
    // Nothing of the shop is written yet, so there is nothing to clear and nothing listed.
    expect(await shopState(began!.tenant)).toMatchObject({ shop: undefined, routines: null, listed: false, log: [] });
    const retried = await operatorMake(bindings, operatorBody(name));
    expect(retried).toEqual({ status: 200, body: { tenant: began!.tenant, name, ownerName: "Fon", template: "food" } });
    expect(await consoleRows(name)).toHaveLength(1);
  });

  it.each(OPERATOR_STEPS)("when $when it lists nothing, and asking again finishes the same shop", async ({ fail }) => {
    const name = uniqueName("Op");
    const down = failing(fail);
    expect(await operatorMake(down.env, operatorBody(name))).toEqual({ status: 503, body: { error: "shop_unavailable" } });

    // What is left: the make on the journal, and no shop on the console's list.
    const [began] = await journal(name);
    expect(began).toBeDefined();
    expect(await consoleRows(name)).toEqual([]);
    const left = await shopState(began!.tenant);
    expect(left.listed).toBe(false);
    // The shop's own object holds the shop whole, or nothing of it: never a record without its setup, or a log that says more
    // than was written.
    if (left.shop) {
      expect(left.routines?.routines).toHaveLength(ROUTINES);
      expect(left.log).toEqual(WHOLE);
    } else {
      expect(left).toMatchObject({ routines: null, log: [] });
    }

    // Asking again finishes that very shop, once. A shop that is already there is not set up again: no clock is written for
    // routines that will never be stored.
    const again = failing({ binding: "SCHEDULES", method: "POST", path: "/routine-clocks", times: 0 });
    const retried = await operatorMake(again.env, operatorBody(name));
    expect(again.seen.includes("POST /routine-clocks")).toBe(!left.shop);
    expect(retried).toEqual({ status: 200, body: { tenant: began!.tenant, name, ownerName: "Fon", template: "food" } });
    const made = await shopState(began!.tenant);
    expect(made).toMatchObject({ listed: true, shop: { name, template: "food" } });
    expect(made.routines?.routines).toHaveLength(ROUTINES);
    expect(made.log).toEqual(WHOLE);
    expect(await consoleRows(name)).toEqual([{ tenant: began!.tenant, name, ownerName: "Fon", template: "food", consent: false }]);
    expect(await journal(name)).toEqual([]);
  });

  it("makes a shop whose listing was done but not answered in one try, and no second on asking again", async () => {
    const name = uniqueName("Lost listing");
    const lost = failing({ binding: "AUTH", method: "POST", path: "/pilot-shops", lost: true });
    const made = await operatorMake(lost.env, operatorBody(name));
    // The last step is asked twice, so a lost answer is no failure: the shop is made, listed once, and off the journal.
    expect(made.status).toBe(200);
    expect(lost.seen.filter((call) => call === "POST /pilot-shops")).toHaveLength(2);
    expect(await consoleRows(name)).toHaveLength(1);
    expect(await journal(name)).toEqual([]);
    expect((await shopState(made.body.tenant as string)).log).toEqual(WHOLE);
  });

  it("does not move a shop on the list when it is listed again", async () => {
    const first = await operatorMake(bindings, operatorBody(uniqueName("Order")));
    const second = await operatorMake(bindings, operatorBody(uniqueName("Order")));
    const order = async () => ((await admin<{ shops: { tenant: string }[] }>("GET", "/v1/admin/pilot/shops")).body.shops)
      .map((shop) => shop.tenant).filter((tenant) => tenant === first.body.tenant || tenant === second.body.tenant);
    const before = await order();
    expect(before).toEqual([first.body.tenant, second.body.tenant]);
    for (let n = 0; n < 2; n++) {
      expect((await authCall(bindings, "/pilot-shops", { method: "POST", headers: { "content-type": "application/json",
        "x-admin": "1" }, body: JSON.stringify({ tenant: first.body.tenant }) })).status).toBe(200);
    }
    expect(await order()).toEqual(before);
  });

  it("asks again for a different shop and finds no part-made one: only the same names and template are the same shop", async () => {
    const name = uniqueName("Same");
    const down = failing({ binding: "SCHEDULES", method: "POST", path: "/routine-clocks" });
    expect((await operatorMake(down.env, operatorBody(name))).status).toBe(503);
    const [began] = await journal(name);
    for (const other of [{ ...operatorBody(name), ownerName: "Someone else" }, { ...operatorBody(name), template: "fashion" },
      { ...operatorBody(name), template: null }, operatorBody(`${name} 2`)]) {
      const made = await operatorMake(bindings, other);
      expect(made.status).toBe(200);
      expect(made.body.tenant).not.toBe(began!.tenant);
    }
    // The one that stopped is where it was, for the same request to finish.
    expect(await journal(name)).toEqual([began]);
    const same = await operatorMake(bindings, operatorBody(name));
    expect(same.body.tenant).toBe(began!.tenant);
    expect(await journal(name)).toEqual([]);
  });

  it("makes one shop when the same make is asked twice at once", async () => {
    const name = uniqueName("Twice");
    const target = overlapping("AUTH", BEGIN, { method: "POST", path: "/pilot-shops" });
    const answers = await Promise.all([operatorMake(target, operatorBody(name)), operatorMake(target, operatorBody(name))]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(answers[1]!.body.tenant).toBe(answers[0]!.body.tenant);
    const rows = await consoleRows(name);
    expect(rows).toHaveLength(1);
    // One shop, set up once: the second try found the first's, and the log says it was made once.
    expect((await shopState(rows[0]!.tenant)).log).toEqual(WHOLE);
    expect(await journal(name)).toEqual([]);
  });

  // It makes and checks a whole shop once for every step the make takes, so it takes a few seconds alone and went past
  // the five-second default on a gate with several helpers' tests running at once; it has thirty.
  it("treats an object that throws as one that answers 500, at every step", async () => {
    const begin: Fail = { binding: "AUTH", method: "POST", path: "/pilot-making/begin" };
    for (const fail of [begin, ...OPERATOR_STEPS.map((step) => step.fail)]) {
      const name = uniqueName("Thrown");
      const down = failing({ ...fail, throws: true });
      expect(await operatorMake(down.env, operatorBody(name))).toEqual({ status: 503, body: { error: "shop_unavailable" } });
      expect(await consoleRows(name)).toEqual([]);
      const [began] = await journal(name);
      const retried = await operatorMake(bindings, operatorBody(name));
      expect(retried.status).toBe(200);
      if (began) expect(retried.body.tenant).toBe(began.tenant);
      expect(await consoleRows(name)).toHaveLength(1);
      expect((await shopState(retried.body.tenant as string)).log).toEqual(WHOLE);
      expect(await journal(name)).toEqual([]);
    }
  }, 30_000);

  it("goes on with a shop that another try of the same make wrote in the meantime, and logs it once", async () => {
    const name = uniqueName("Meanwhile");
    // Both tries have looked and found no shop before either writes, so one of them writes into a shop the other wrote.
    const target = overlapping("TENANT", { method: "GET", path: "/pilot/shop" }, { method: "POST", path: "/pilot/shop" });
    const answers = await Promise.all([operatorMake(target, operatorBody(name)), operatorMake(target, operatorBody(name))]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect(answers[1]!.body.tenant).toBe(answers[0]!.body.tenant);
    const rows = await consoleRows(name);
    expect(rows).toHaveLength(1);
    expect((await shopState(rows[0]!.tenant)).log).toEqual(WHOLE);
    expect(await journal(name)).toEqual([]);
  });

  it("makes a shop with no template whole in the same way", async () => {
    const name = uniqueName("Plain");
    const down = failing({ binding: "TENANT", method: "POST", path: "/pilot/shop", lost: true });
    expect((await operatorMake(down.env, { name, ownerName: "Fon", template: null })).status).toBe(503);
    const [began] = await journal(name);
    expect((await shopState(began!.tenant)).log).toEqual(["shop.created"]);
    expect((await operatorMake(bindings, { name, ownerName: "Fon", template: null })).body).toEqual({ tenant: began!.tenant,
      name, ownerName: "Fon" });
    expect((await shopState(began!.tenant)).log).toEqual(["shop.created"]);
    expect(await consoleRows(name)).toHaveLength(1);
  });
});

describe("a make by its owner that stops part way", () => {
  const OWN_STEPS: Step[] = [
    { when: "finding out whether the shop is already there fails", fail: { binding: "TENANT", method: "GET", path: "/pilot/shop" } },
    { when: "the shop's clocks cannot be written", fail: { binding: "SCHEDULES", method: "POST", path: "/routine-clocks" } },
    { when: "the shop's own write fails", fail: { binding: "TENANT", method: "POST", path: "/pilot/shop" } },
    { when: "the shop's own write is done but its answer is lost", fail: { binding: "TENANT", method: "POST", path: "/pilot/shop",
      lost: true } },
    { when: "listing the shop fails", fail: { binding: "AUTH", method: "POST", path: "/shops-made/finish", times: Infinity } },
  ];

  it("takes no slot when it cannot begin, and the next try makes one shop", async () => {
    const person = await signIn();
    const name = uniqueName("Begin");
    const down = failing({ binding: "AUTH", method: "POST", path: "/pilot-making/begin" });
    expect(await ownMake(down.env, person, ownBody(name))).toEqual({ status: 503, body: { error: "shop_unavailable" } });
    expect(await slots(person)).toEqual([]);
    expect(await journal(name)).toEqual([]);
    expect((await ownMake(bindings, person, ownBody(name))).status).toBe(201);
    expect(await personsShops(person, name)).toHaveLength(1);
    expect(await slotsLeft(person)).toBe(SHOPS_MADE_LIMIT - 1);
  });

  it("gives back the slot it took when only the answer to beginning was lost, and the next try finishes that shop", async () => {
    const person = await signIn();
    const name = uniqueName("Begin lost");
    const lost = failing({ binding: "AUTH", method: "POST", path: "/pilot-making/begin", lost: true });
    expect((await ownMake(lost.env, person, ownBody(name))).status).toBe(503);
    // The slot it took is given back at once, rather than held for ten minutes, and the make is on the journal.
    expect(await slots(person)).toEqual([]);
    const [began] = await journal(name);
    expect(began).toMatchObject({ name, by: person.tenant });
    const retried = await ownMake(bindings, person, ownBody(name));
    expect(retried.status).toBe(201);
    expect((retried.body.shop as { id: string }).id).toBe(began!.tenant);
    expect(await slotsLeft(person)).toBe(SHOPS_MADE_LIMIT - 1);
  });

  it.each(OWN_STEPS)("when $when it lists nothing and loses no slot, and asking again finishes the same shop",
    async ({ fail }) => {
      const person = await signIn();
      const name = uniqueName("Own");
      const down = failing(fail);
      expect(await ownMake(down.env, person, ownBody(name))).toEqual({ status: 503, body: { error: "shop_unavailable" } });

      // What is left: the make on the journal, no slot held, and the shop on neither list.
      const [began] = await journal(name);
      expect(began).toMatchObject({ name, ownerName: "Dao", template: "food", by: person.tenant });
      expect(await slots(person)).toEqual([]);
      expect(await consoleRows(name)).toEqual([]);
      expect(await personsShops(person, name)).toEqual([]);
      const left = await shopState(began!.tenant);
      expect(left.listed).toBe(false);
      if (left.shop) {
        // Whole, with its owner linked in the same write: the account, and the one session whose token was never sent.
        expect(left.routines?.routines).toHaveLength(ROUTINES);
        expect(left.log).toEqual(WHOLE_BY_OWNER);
        expect(left.people?.ownerAccount?.subject).toBe(person.tenant);
        expect(Object.keys(left.people?.ownerSessions ?? {})).toHaveLength(1);
      } else {
        expect(left).toMatchObject({ routines: null, people: undefined, log: [] });
      }

      // Asking again finishes that very shop, on a slot it takes again, and sets nothing up that is already there.
      const again = failing({ binding: "SCHEDULES", method: "POST", path: "/routine-clocks", times: 0 });
      const retried = await ownMake(again.env, person, ownBody(name));
      expect(again.seen.includes("POST /routine-clocks")).toBe(!left.shop);
      expect(retried.status).toBe(201);
      const shop = retried.body.shop as { id: string; name: string; template: string };
      expect(shop).toEqual({ id: began!.tenant, name, ownerName: "Dao", template: "food" });
      expect(await slots(person)).toEqual([{ shop: began!.tenant, at: expect.any(Number), done: true }]);
      expect(await consoleRows(name)).toEqual([{ tenant: began!.tenant, name, ownerName: "Dao", template: "food", consent: false,
        selfServe: true }]);
      expect(await personsShops(person, name)).toEqual([{ id: began!.tenant, name, ownerName: "Dao", role: "owner" }]);
      expect(await journal(name)).toEqual([]);

      // The session it was given is the owner's, and works.
      const session = retried.body.session as { accessToken: string };
      const owner = { authorization: `Bearer ${session.accessToken}` };
      expect((await asSession(owner, "GET", "/v1/routines")).status).toBe(200);
      const made = await shopState(began!.tenant);
      expect(made.routines?.routines).toHaveLength(ROUTINES);
      // Made once: one `shop.created`, one link, the template once. A shop an earlier try wrote also opened a session for this
      // one, and the log says so.
      expect(made.log).toEqual(left.shop ? [...WHOLE_BY_OWNER, "owner.session_opened"] : WHOLE_BY_OWNER);
      expect(made.people?.ownerAccount?.id).toBe((retried.body.account as { id: string }).id);

      // No slot was lost: with this shop made, the others fit.
      expect(await slotsLeft(person)).toBe(SHOPS_MADE_LIMIT - 1);
    });

  it("gives a shop whose first session's token never reached anyone a session of its own, for the account that was linked", async () => {
    const person = await signIn();
    const name = uniqueName("Session");
    const lost = failing({ binding: "TENANT", method: "POST", path: "/pilot/shop", lost: true });
    const first = await ownMake(lost.env, person, ownBody(name));
    // Nothing that carries a token is sent for a make that failed.
    expect(JSON.stringify(first.body)).not.toContain("mos1.");
    const [began] = await journal(name);
    const before = await shopState(began!.tenant);
    const firstHash = Object.keys(before.people?.ownerSessions ?? {});
    const retried = await ownMake(bindings, person, ownBody(name));
    expect(retried.status).toBe(201);
    expect((retried.body.account as { id: string }).id).toBe(before.people?.ownerAccount?.id);
    const after = await shopState(began!.tenant);
    // The first session is still in the record, for a token nobody holds; the second is this answer's, a different one.
    expect(Object.keys(after.people?.ownerSessions ?? {})).toHaveLength(2);
    expect(Object.keys(after.people?.ownerSessions ?? {})).toEqual(expect.arrayContaining(firstHash));
    // The person's own list had nothing of it until the shop was listed, and then has it once.
    expect(await personsShops(person, name)).toHaveLength(1);
  });

  it("puts the shop in the person's list only when it is listed, even when an earlier try wrote it", async () => {
    const person = await signIn();
    const name = uniqueName("Agree");
    const first = failing({ binding: "TENANT", method: "POST", path: "/pilot/shop", lost: true });
    expect((await ownMake(first.env, person, ownBody(name))).status).toBe(503);
    // The second try finds the shop written and opens a session on it, then cannot list it.
    const second = failing({ binding: "AUTH", method: "POST", path: "/shops-made/finish", times: Infinity });
    expect((await ownMake(second.env, person, ownBody(name))).status).toBe(503);
    // The console and the person's own list still agree: neither has it.
    expect(await consoleRows(name)).toEqual([]);
    expect(await personsShops(person, name)).toEqual([]);
    expect((await ownMake(bindings, person, ownBody(name))).status).toBe(201);
    expect(await consoleRows(name)).toHaveLength(1);
    expect(await personsShops(person, name)).toHaveLength(1);
  });

  it("finishes a make on the slot it still holds, when the account is at its limit with it", async () => {
    const person = await signIn();
    for (let n = 0; n < SHOPS_MADE_LIMIT - 1; n++) {
      expect((await ownMake(bindings, person, { name: uniqueName(`Made ${n}`), ownerName: "Dao", template: null })).status).toBe(201);
    }
    const name = uniqueName("Held");
    // The make fails, and so does giving its slot back: the slot stays held, so the account counts as at its limit.
    const down = failing({ binding: "AUTH", method: "POST", path: ["/shops-made/finish", "/shops-made/release"], times: Infinity });
    expect((await ownMake(down.env, person, ownBody(name))).status).toBe(503);
    expect(await slots(person)).toHaveLength(SHOPS_MADE_LIMIT);
    expect((await ownMake(bindings, person, { name: uniqueName("Another"), ownerName: "Dao", template: null })).status).toBe(409);
    // The same make is the shop that holds the slot, so it finishes on it rather than asking for another.
    const [began] = await journal(name);
    const retried = await ownMake(bindings, person, ownBody(name));
    expect(retried.status).toBe(201);
    expect((retried.body.shop as { id: string }).id).toBe(began!.tenant);
    expect(await slots(person)).toHaveLength(SHOPS_MADE_LIMIT);
    expect(await slotsLeft(person)).toBe(0);
  });

  // It makes and checks a whole shop once for every step the make takes, so it takes a few seconds alone and went past
  // the five-second default on a gate with several helpers' tests running at once; it has thirty.
  it("treats an object that throws as one that answers 500, at every step, and loses no slot", async () => {
    const begin: Fail = { binding: "AUTH", method: "POST", path: "/pilot-making/begin" };
    for (const fail of [begin, ...OWN_STEPS.map((step) => step.fail)]) {
      const person = await signIn();
      const name = uniqueName("Thrown");
      const down = failing({ ...fail, throws: true });
      expect(await ownMake(down.env, person, ownBody(name))).toEqual({ status: 503, body: { error: "shop_unavailable" } });
      expect(await slots(person)).toEqual([]);
      expect(await consoleRows(name)).toEqual([]);
      expect(await personsShops(person, name)).toEqual([]);
      const [began] = await journal(name);
      const retried = await ownMake(bindings, person, ownBody(name));
      expect(retried.status).toBe(201);
      if (began) expect((retried.body.shop as { id: string }).id).toBe(began.tenant);
      expect(await personsShops(person, name)).toHaveLength(1);
      expect(await consoleRows(name)).toHaveLength(1);
      expect(await journal(name)).toEqual([]);
      expect(await slotsLeft(person)).toBe(SHOPS_MADE_LIMIT - 1);
    }
  }, 30_000);

  it("gives the slot back when a try that finds the shop written cannot open its session, and the next try finishes it", async () => {
    const person = await signIn();
    const name = uniqueName("Opening");
    const first = failing({ binding: "TENANT", method: "POST", path: "/pilot/shop", lost: true });
    expect((await ownMake(first.env, person, ownBody(name))).status).toBe(503);
    const second = failing({ binding: "TENANT", method: "POST", path: "/people/open-owner-session" });
    expect(await ownMake(second.env, person, ownBody(name))).toEqual({ status: 503, body: { error: "shop_unavailable" } });
    expect(await slots(person)).toEqual([]);
    expect(await consoleRows(name)).toEqual([]);
    expect(await personsShops(person, name)).toEqual([]);
    const [began] = await journal(name);
    const third = await ownMake(bindings, person, ownBody(name));
    expect(third.status).toBe(201);
    expect((third.body.shop as { id: string }).id).toBe(began!.tenant);
    expect((await shopState(began!.tenant)).log.filter((action) => action === "shop.created")).toHaveLength(1);
  });

  it("answers a lost answer to the last step as a made shop, once", async () => {
    const person = await signIn();
    const name = uniqueName("Lost listing");
    const lost = failing({ binding: "AUTH", method: "POST", path: "/shops-made/finish", lost: true });
    const made = await ownMake(lost.env, person, ownBody(name));
    expect(made.status).toBe(201);
    expect(lost.seen.filter((call) => call === "POST /shops-made/finish")).toHaveLength(2);
    expect(await personsShops(person, name)).toHaveLength(1);
    expect(await consoleRows(name)).toHaveLength(1);
    expect(await slots(person)).toEqual([{ shop: (made.body.shop as { id: string }).id, at: expect.any(Number), done: true }]);
    expect(await journal(name)).toEqual([]);
    expect((await shopState((made.body.shop as { id: string }).id)).log).toEqual(WHOLE_BY_OWNER);
    expect(await slotsLeft(person)).toBe(SHOPS_MADE_LIMIT - 1);
  });

  it("goes on with a shop that another try of the same make wrote in the meantime, with one session each", async () => {
    const person = await signIn();
    const name = uniqueName("Meanwhile");
    const target = overlapping("TENANT", { method: "GET", path: "/pilot/shop" }, { method: "POST", path: "/pilot/shop" });
    const answers = await Promise.all([ownMake(target, person, ownBody(name)), ownMake(target, person, ownBody(name))]);
    expect(answers.map((answer) => answer.status)).toEqual([201, 201]);
    const ids = answers.map((answer) => (answer.body.shop as { id: string }).id);
    expect(ids[1]).toBe(ids[0]);
    // The one that wrote the shop holds the session its write opened; the other opened one of its own for the same account.
    expect((answers[1]!.body.account as { id: string }).id).toBe((answers[0]!.body.account as { id: string }).id);
    expect((answers[1]!.body.session as { accessToken: string }).accessToken)
      .not.toBe((answers[0]!.body.session as { accessToken: string }).accessToken);
    for (const answer of answers) {
      const owner = { authorization: `Bearer ${(answer.body.session as { accessToken: string }).accessToken}` };
      expect((await asSession(owner, "GET", "/v1/routines")).status).toBe(200);
    }
    expect(await personsShops(person, name)).toHaveLength(1);
    expect(await slots(person)).toHaveLength(1);
    expect((await shopState(ids[0]!)).log.filter((action) => action === "shop.created")).toHaveLength(1);
  });

  it("finishes the shop, after the ten minutes its slot was held, on a slot it takes again", async () => {
    const person = await signIn();
    const name = uniqueName("Late");
    const down = failing({ binding: "TENANT", method: "POST", path: "/pilot/shop" });
    expect((await ownMake(down.env, person, ownBody(name))).status).toBe(503);
    const [began] = await journal(name);
    // Other makes by the person, ten minutes on, as if their slots had all been held and lapsed: the journal is not a slot.
    await runInDurableObject(AUTH(), async (_instance, state) => {
      const key = `shops-made:${encodeURIComponent(person.tenant)}`;
      const rows = state.storage.kv.get<MadeShopRow[]>(key) ?? [];
      state.storage.kv.put(key, rows.map((row) => ({ ...row, at: row.at - MADE_RESERVATION_MS })));
    });
    const retried = await ownMake(bindings, person, ownBody(name));
    expect(retried.status).toBe(201);
    expect((retried.body.shop as { id: string }).id).toBe(began!.tenant);
    expect(await slotsLeft(person)).toBe(SHOPS_MADE_LIMIT - 1);
  });

  it("refuses to finish a part-made shop for an account that has since made all it may, and changes nothing", async () => {
    const person = await signIn();
    const name = uniqueName("Over");
    const down = failing({ binding: "SCHEDULES", method: "POST", path: "/routine-clocks" });
    expect((await ownMake(down.env, person, ownBody(name))).status).toBe(503);
    const [began] = await journal(name);
    // Its slot was given back, so the account can fill all it may with other shops.
    for (let n = 0; n < SHOPS_MADE_LIMIT; n++) {
      expect((await ownMake(bindings, person, { name: uniqueName(`Fill ${n}`), ownerName: "Dao", template: null })).status).toBe(201);
    }
    const slotsBefore = await slots(person);
    expect(await ownMake(bindings, person, ownBody(name))).toEqual({ status: 409, body: { error: "too_many_shops",
      limit: SHOPS_MADE_LIMIT } });
    expect(await slots(person)).toEqual(slotsBefore);
    expect(await journal(name)).toEqual([began]);
    expect(await consoleRows(name)).toEqual([]);
  });

  it("does not finish another person's make, nor an operator's, that has the same names", async () => {
    const [one, another] = [await signIn(), await signIn()];
    const name = uniqueName("Shared");
    const down = failing({ binding: "SCHEDULES", method: "POST", path: "/routine-clocks", times: Infinity });
    expect((await ownMake(down.env, one, ownBody(name))).status).toBe(503);
    expect((await operatorMake(down.env, { name, ownerName: "Dao", template: "food" })).status).toBe(503);
    const rows = await journal(name);
    expect(rows.map((row) => row.by).sort()).toEqual([null, one.tenant].sort());
    const theirs = await ownMake(bindings, another, ownBody(name));
    expect(theirs.status).toBe(201);
    const ids = rows.map((row) => row.tenant);
    expect(ids).not.toContain((theirs.body.shop as { id: string }).id);
    // Each of the other two is still its own, for its own request to finish.
    expect(await journal(name)).toEqual(rows);
    const mine = await ownMake(bindings, one, ownBody(name));
    expect(ids).toContain((mine.body.shop as { id: string }).id);
    expect((await operatorMake(bindings, { name, ownerName: "Dao", template: "food" })).status).toBe(200);
    expect(await journal(name)).toEqual([]);
    expect(await consoleRows(name)).toHaveLength(3);
  });

  it("makes one shop when the same person asks twice at once, with one slot", async () => {
    const person = await signIn();
    const name = uniqueName("Twice");
    const target = overlapping("AUTH", BEGIN, { method: "POST", path: "/shops-made/finish" });
    const answers = await Promise.all([ownMake(target, person, ownBody(name)), ownMake(target, person, ownBody(name))]);
    expect(answers.map((answer) => answer.status)).toEqual([201, 201]);
    expect((answers[1]!.body.shop as { id: string }).id).toBe((answers[0]!.body.shop as { id: string }).id);
    expect(await personsShops(person, name)).toHaveLength(1);
    expect(await consoleRows(name)).toHaveLength(1);
    expect(await slots(person)).toHaveLength(1);
    expect(await slotsLeft(person)).toBe(SHOPS_MADE_LIMIT - 1);
  });
});

describe("the journal of makes", () => {
  const begin = (body: Record<string, unknown>) => authCall(bindings, "/pilot-making/begin", { method: "POST",
    headers: { "content-type": "application/json", "x-admin": "1" }, body: JSON.stringify(body) });
  const shop = () => `pilot:${crypto.randomUUID()}`;

  it("keeps a make until its shop is listed, and answers the same shop to the same make", async () => {
    const name = uniqueName("Journal");
    const first = shop();
    const asked = { tenant: first, name, ownerName: "Fon", template: "food" };
    expect(await (await begin(asked)).json()).toEqual({ tenant: first, resumed: false });
    // The same asking, from another candidate tenant: the first's.
    expect(await (await begin({ ...asked, tenant: shop() })).json()).toEqual({ tenant: first, resumed: true });
    expect(await journal(name)).toEqual([{ tenant: first, name, ownerName: "Fon", template: "food", by: null, at: expect.any(Number) }]);
    // Listing it ends the make, and a second asking for the same names is a new shop.
    expect((await authCall(bindings, "/pilot-shops", { method: "POST", headers: { "content-type": "application/json",
      "x-admin": "1" }, body: JSON.stringify({ tenant: first }) })).status).toBe(200);
    expect(await journal(name)).toEqual([]);
    const next = shop();
    expect(await (await begin({ ...asked, tenant: next })).json()).toEqual({ tenant: next, resumed: false });
  });

  it("refuses what is not a make, and writes nothing", async () => {
    const good = { tenant: shop(), name: "Valid", ownerName: "Fon", template: "food" };
    const cases: Record<string, unknown>[] = [
      { ...good, tenant: "" }, { ...good, tenant: 7 }, { ...good, name: "" }, { ...good, name: "x".repeat(201) },
      { ...good, ownerName: 3 }, { ...good, template: "Not An Id" }, { ...good, template: 4 }, { ...good, subject: 5 },
      { name: "Valid", ownerName: "Fon", template: null },
    ];
    for (const body of cases) expect((await begin(body)).status).toBe(400);
    expect((await authCall(bindings, "/pilot-making/begin", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(good) })).status).toBe(403);
    expect(await journal("Valid")).toEqual([]);
  });

  it("finishes a person's shop once or twice, and never one that was not begun or has been deleted", async () => {
    const person = await signIn();
    const made = await ownMake(bindings, person, ownBody(uniqueName("Done")));
    const id = (made.body.shop as { id: string }).id;
    const accountId = (made.body.account as { id: string }).id;
    const finish = (tenant: string) => authCall(bindings, "/shops-made/finish", { method: "POST", headers: {
      "content-type": "application/json", "x-admin": "1" }, body: JSON.stringify({ subject: person.tenant, shop: tenant,
      ref: accountId }) });
    expect((await finish(id)).status).toBe(200);
    expect((await finish(shop())).status).toBe(409);
    // Deleted, the shop is no longer the person's, and finishing it again does not bring it back.
    expect((await admin("POST", "/v1/admin/pilot/deletions", { tenant: id, confirmName: (made.body.shop as { name: string }).name })).status)
      .toBe(200);
    expect((await finish(id)).status).toBe(409);
    expect((await consoleRowsByTenant(id))).toEqual([]);
  });

  it("goes with the shop when the shop is deleted, whatever stopped it", async () => {
    const name = uniqueName("Cleared");
    const down = failing({ binding: "TENANT", method: "POST", path: "/pilot/shop", lost: true });
    expect((await operatorMake(down.env, operatorBody(name))).status).toBe(503);
    const [began] = await journal(name);
    expect((await shopState(began!.tenant)).shop).toBeDefined();
    // The operator's own deletion, by the shop's id and exact name, clears a part-made shop as it clears any shop that never
    // went live, and the wipe it runs takes the shop's row off the journal.
    const deleted = await admin("POST", "/v1/admin/pilot/deletions", { tenant: began!.tenant, confirmName: name });
    expect(deleted.status).toBe(200);
    expect(await journal(name)).toEqual([]);
    expect(await shopState(began!.tenant)).toMatchObject({ shop: undefined, routines: null, listed: false, log: [] });
    // And asking again makes a new shop, since the old one is gone.
    const again = await operatorMake(bindings, operatorBody(name));
    expect(again.status).toBe(200);
    expect(again.body.tenant).not.toBe(began!.tenant);
  });

  it("goes with a make that wrote nothing of its shop, when that shop is wiped", async () => {
    const name = uniqueName("Nothing written");
    const down = failing({ binding: "SCHEDULES", method: "POST", path: "/routine-clocks" });
    expect((await operatorMake(down.env, operatorBody(name))).status).toBe(503);
    const [began] = await journal(name);
    expect((await tenantDelete(bindings, began!.tenant)).status).toBe(200);
    expect(await journal(name)).toEqual([]);
  });
});

async function consoleRowsByTenant(tenant: string) {
  const listed = await admin<{ shops: { tenant: string }[] }>("GET", "/v1/admin/pilot/shops");
  return listed.body.shops.filter((shop) => shop.tenant === tenant);
}

describe("the shop's own write", () => {
  const write = (tenant: string, body: Record<string, unknown>) => tenantStub(bindings, tenant).fetch(new Request(
    "https://tenant/pilot/shop", { method: "POST", headers: { "content-type": "application/json", "x-pilot": "1" },
      body: JSON.stringify({ tenant, name: "Direct", ownerName: "Fon", taskId: "pilot-task-direct", ...body }) }));

  const routine = (id: string) => ({ id, name: "Say hello", action: "brief", timeZone: "Asia/Bangkok", trigger: { kind: "daily",
    at: "08:00" }, asksFirst: true, member: "ton", paused: true, createdAt: new Date().toISOString(), template: "food" });
  const setup = (overrides: Record<string, unknown> = {}) => ({ template: "food", members: ["nam"], routines: [routine("rt-one")],
    questions: [{ id: "q1", text: "What do you sell?" }], ...overrides });

  it("keeps the record, the setup and every entry in one write", async () => {
    const tenant = `pilot:${crypto.randomUUID()}`;
    const puts: Record<string, unknown>[] = [];
    const response = await runInDurableObject(tenantStub(bindings, tenant), async (instance, state) => {
      const original = state.storage.put.bind(state.storage);
      (state.storage as { put: unknown }).put = (...args: unknown[]) => {
        puts.push(args[0] as Record<string, unknown>);
        return (original as (...all: unknown[]) => Promise<void>)(...args);
      };
      try {
        return await instance.fetch(new Request("https://tenant/pilot/shop", { method: "POST", headers: {
          "content-type": "application/json", "x-pilot": "1" }, body: JSON.stringify({ tenant, name: "Direct", ownerName: "Fon",
          taskId: "pilot-task-direct", template: "food", setup: setup(), actor: { kind: "operator", email: null } }) }));
      } finally {
        (state.storage as { put: unknown }).put = original;
      }
    });
    expect(response.status).toBe(200);
    // One put, holding the shop, the routines' record, and the entries for the shop, the template and its routine.
    expect(puts).toHaveLength(1);
    const keys = Object.keys(puts[0]!);
    expect(keys.filter((key) => key.startsWith("pilot-shop:"))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith("routines:"))).toHaveLength(1);
    expect(keys.filter((key) => key.startsWith("audit:") || key.includes("audit"))).toHaveLength(3);
  });

  it("makes nothing when its setup is not the template's, or is more than a shop keeps, or is not a setup", async () => {
    const tooMany = Array.from({ length: 51 }, (_, n) => routine(`rt-${n}`));
    const cases: Record<string, unknown>[] = [
      { template: "food", setup: setup({ template: "fashion" }) },
      { setup: setup() },
      { template: "food", setup: setup({ routines: tooMany }) },
      { template: "food", setup: setup({ members: ["nam", "nam"] }) },
      { template: "food", setup: setup({ questions: [{ id: "q1" }] }) },
      { template: "food", setup: "setup" },
      { template: "food", setup: null },
    ];
    for (const body of cases) {
      const tenant = `pilot:${crypto.randomUUID()}`;
      expect((await write(tenant, body)).status).toBe(400);
      expect(await shopState(tenant)).toMatchObject({ shop: undefined, routines: null, listed: false, log: [] });
    }
  });

  it("answers a shop that is already there with 409 and changes nothing", async () => {
    const tenant = `pilot:${crypto.randomUUID()}`;
    expect((await write(tenant, { template: "food", setup: setup() })).status).toBe(200);
    const before = await shopState(tenant);
    expect(before.routines?.routines).toHaveLength(1);
    expect(before.log).toEqual(["shop.created", "template.applied", "routine.created"]);
    expect((await write(tenant, { template: "food", setup: setup({ routines: [routine("rt-two")] }) })).status).toBe(409);
    expect(await shopState(tenant)).toEqual(before);
  });
});
