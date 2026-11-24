import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { MAX_HELPER_SESSIONS } from "@manut/people-rules";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";
import { MAX_OWNER_SESSIONS, type PeopleRecord } from "../src/people-store";
import { relaySourceGroup } from "../src/relay";
import { tenantStub } from "../src/tenant-data";
import { asSession, bindings, joinHelper, setupShop, signIn, type SignedIn } from "./people-fixtures";
import { sourceWorker } from "./source-worker";

// The limits on what a signed-in person can make the backend do over and over (docs/pilot-api.md, "Sessions" and "Opening
// a shop session"): deleting their own data, counted per source address before the session is read, and opening shop
// sessions, counted per person; and how many sessions one helper or one owner account keeps open at once.

const API = "https://api.manut.test";

/// An address of a /64 of its own, so no other test's requests share its bucket.
function address(): string {
  return `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 12).match(/.{4}/g)!.join(":")}::1`;
}

async function send(request: Request, target: Env = bindings): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

function deletion(headers: { authorization: string }, ip: string): Request {
  return new Request(`${API}/v1/tenant/data`, { method: "DELETE", headers: { ...headers, "cf-connecting-ip": ip } });
}

/// A limiter that records every key and answers `success` with `allow`.
function fakeLimiter(allow: (key: string) => boolean) {
  const keys: string[] = [];
  const limiter = { limit: async ({ key }: { key: string }) => {
    keys.push(key);
    return { success: allow(key) };
  } } as RateLimit;
  return { limiter, keys };
}

/// A shop the person made themselves, and the owner session it came with.
async function ownShop(person: SignedIn): Promise<{ shop: string; owner: { authorization: string } }> {
  const made = await asSession<{ shop: { id: string }; session: { accessToken: string } }>(person.headers, "POST",
    "/v1/shops/new", { name: `Shop ${crypto.randomUUID().slice(0, 6)}`, ownerName: "Dao", template: null });
  expect(made.status).toBe(201);
  return { shop: made.body.shop.id, owner: { authorization: `Bearer ${made.body.session.accessToken}` } };
}

async function peopleRecord(shop: string): Promise<PeopleRecord | undefined> {
  return runInDurableObject(tenantStub(bindings, shop), (_instance, state) =>
    state.storage.get<PeopleRecord>(`people:${encodeURIComponent(shop)}`));
}

const works = async (headers: { authorization: string }) =>
  (await asSession(headers, "GET", "/v1/approvals?state=open")).status;

describe("deleting one's own data", () => {
  it("counts every try per source address before the session is read", async () => {
    const { limiter, keys } = fakeLimiter(() => false);
    let woken = 0;
    const target = { ...bindings, TENANT_DELETE_LIMITER: limiter,
      AUTH: { idFromName: (name: string) => bindings.AUTH.idFromName(name),
        get: () => ({ fetch: async () => { woken++; return Response.json({ ok: true, tenant: "apple:x" }); } }) },
    } as unknown as Env;
    const ip = address();
    const response = await send(deletion({ authorization: "Bearer any-session" }, ip), target);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual({ error: "rate_limited" });
    // The bucket is the address's source group, an IPv6 /64 here, as every ingress limit's is.
    expect(keys).toEqual([relaySourceGroup(ip)]);
    expect(woken).toBe(0);
    // Without the binding nothing is deleted either.
    const unbound = await send(deletion({ authorization: "Bearer any-session" }, ip),
      { ...target, TENANT_DELETE_LIMITER: undefined } as unknown as Env);
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: "rate_limit_unavailable" });
    expect(woken).toBe(0);
  });

  it("lets one address delete strangers' own data 10 times a minute, and no more", async () => {
    // Each deletion ends every session of its person, so each try needs a sign-in of its own. An email sign-in is refused
    // on this route altogether (index.ts, `REFUSED_PERSON`), so the strangers sign in with Apple, which keeps it for now.
    const fill = async () => {
      const ip = address();
      const strangers: SignedIn[] = [];
      for (let n = 0; n < 11; n++) strangers.push(await signIn());
      const statuses: number[] = [];
      for (const stranger of strangers) statuses.push((await send(deletion(stranger.headers, ip))).status);
      return { statuses, last: strangers[10]! };
    };
    // The real limiter counts in 60-second windows, so a run that crosses into a new one is repeated once.
    let run = await fill();
    if (run.statuses[10] !== 429) run = await fill();
    expect(run.statuses.slice(0, 10)).toEqual(Array(10).fill(200));
    expect(run.statuses[10]).toBe(429);
    // The refused stranger's session was not even read, let alone wiped: it still works elsewhere.
    expect((await asSession(run.last.headers, "GET", "/v1/shops")).status).toBe(200);
  });
});

describe("opening a shop session", () => {
  it("counts every try per person, on both routes, before the shop is read", async () => {
    const person = await signIn(`dao-${crypto.randomUUID()}@khaohom.example`);
    const { limiter, keys } = fakeLimiter(() => false);
    const target = { ...bindings, SHOP_SESSION_LIMITER: limiter } as unknown as Env;
    for (const path of ["/v1/shops/session", "/v1/people/session"]) {
      const response = await send(new Request(`${API}${path}`, { method: "POST", headers: { ...person.headers,
        "content-type": "application/json", "cf-connecting-ip": address() }, body: JSON.stringify({ shop: "pilot:none" }) }),
      target);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(await response.json()).toEqual({ error: "rate_limited" });
    }
    // One bucket, the person's, whatever address each try came from.
    expect(keys).toEqual([person.tenant, person.tenant]);
    const unbound = await send(new Request(`${API}/v1/shops/session`, { method: "POST", headers: { ...person.headers,
      "content-type": "application/json", "cf-connecting-ip": address() }, body: JSON.stringify({ shop: "pilot:none" }) }),
    { ...bindings, SHOP_SESSION_LIMITER: undefined } as unknown as Env);
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toEqual({ error: "rate_limit_unavailable" });
  });

  it("lets one person open 20 a minute, and no more, without touching anyone else's", async () => {
    const fill = async () => {
      const person = await signIn();
      const { shop } = await ownShop(person);
      const statuses: number[] = [];
      for (let n = 0; n < 21; n++) {
        statuses.push((await asSession(person.headers, "POST", "/v1/shops/session", { shop })).status);
      }
      return { person, shop, statuses };
    };
    let run = await fill();
    if (run.statuses[20] !== 429) run = await fill();
    expect(run.statuses.slice(0, 20)).toEqual(Array(20).fill(200));
    expect(run.statuses[20]).toBe(429);
    // The helper's route shares the person's bucket.
    expect((await asSession(run.person.headers, "POST", "/v1/people/session", { shop: run.shop })).status).toBe(429);
    // Someone else is not limited by it.
    const other = await signIn();
    expect((await asSession(other.headers, "POST", "/v1/shops/session", { shop: run.shop })).status).toBe(404);
  });
});

describe("sessions per helper and per owner account", () => {
  it(`keeps at most ${MAX_HELPER_SESSIONS} of a helper's sessions open, ending the oldest`, async () => {
    const shop = await setupShop("Cap Shop");
    const helper = await joinHelper(shop, "Mint");
    const opened: { authorization: string }[] = [helper.headers];
    for (let n = 0; n < MAX_HELPER_SESSIONS + 2; n++) {
      const answer = await asSession<{ session: { accessToken: string } }>(helper.person.headers, "POST",
        "/v1/people/session", { shop: shop.tenant });
      expect(answer.status).toBe(200);
      opened.push({ authorization: `Bearer ${answer.body.session.accessToken}` });
    }
    const ended = opened.length - MAX_HELPER_SESSIONS;
    for (const headers of opened.slice(0, ended)) expect(await works(headers)).toBe(401);
    for (const headers of opened.slice(ended)) expect(await works(headers)).toBe(200);
    const record = await peopleRecord(shop.tenant);
    expect(Object.values(record?.sessions ?? {}).filter((one) => one.helperId === helper.id)).toHaveLength(MAX_HELPER_SESSIONS);
    expect(record?.state.helpers.find((one) => one.id === helper.id)?.sessions).toHaveLength(MAX_HELPER_SESSIONS);
  });

  it(`keeps at most ${MAX_OWNER_SESSIONS} of the owner account's sessions open, ending the oldest`, async () => {
    const person = await signIn();
    const { shop, owner } = await ownShop(person);
    const opened: { authorization: string }[] = [owner];
    for (let n = 0; n < MAX_OWNER_SESSIONS + 2; n++) {
      const answer = await asSession<{ session: { accessToken: string } }>(person.headers, "POST", "/v1/shops/session", { shop });
      expect(answer.status).toBe(200);
      opened.push({ authorization: `Bearer ${answer.body.session.accessToken}` });
    }
    const ended = opened.length - MAX_OWNER_SESSIONS;
    for (const headers of opened.slice(0, ended)) expect(await works(headers)).toBe(401);
    for (const headers of opened.slice(ended)) expect(await works(headers)).toBe(200);
    expect(Object.keys((await peopleRecord(shop))?.ownerSessions ?? {})).toHaveLength(MAX_OWNER_SESSIONS);
  });
});
