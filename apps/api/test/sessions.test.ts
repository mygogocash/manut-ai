import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sessionIndexKey, sessionIndexPrefix, SWEEP_BATCH, SWEEP_EVERY_SECONDS } from "../src/session-index";
import { SCAN_PAGE } from "../src/shops-store";
import { appleIdentity, asSession, bindings, signIn, type SignedIn } from "./people-fixtures";
import { sourceWorker } from "./source-worker";

// The lifted auth's sessions in the one global AuthObject (session-index.ts; docs/pilot-api.md, "Sessions"): the alarm
// sweeps ended ones a bounded page a run, each tenant's chains have rows of their own so a wipe reads only those, sessions
// made before the rows existed are found all the same, and the shop indexes are read a page at a time, and not at all for
// a person's own deletion.

const DAY = 24 * 3600;
const now = () => Date.now() / 1000;
const enc = encodeURIComponent;
const sorted = (keys: readonly string[]) => [...keys].sort();

/// An AuthObject of the test's own, so it sees only the records it wrote.
function freshAuth(): DurableObjectStub {
  return bindings.AUTH.get(bindings.AUTH.idFromName(`sessions-${crypto.randomUUID()}`));
}

const hex = () => crypto.randomUUID().replaceAll("-", "");

/// One grant chain as the auth object keeps it: the access record (unless `accessRecord` is false, as for a chain whose
/// access record already went), the refresh grant, and its row in the tenant's index unless it is `legacy`, made before
/// the index. Times are seconds since the epoch.
function chain(tenant: string, options: { access?: number; grant?: number; born?: number; generation?: number;
  legacy?: boolean; accessRecord?: boolean } = {}) {
  const accessHash = `a${hex()}`;
  const refreshHash = `r${hex()}`;
  const generation = options.generation ?? 0;
  const records: Record<string, unknown> = {};
  if (options.accessRecord !== false) {
    records[`sat:${accessHash}`] = { tenant, deviceId: "device", exp: options.access ?? now() + 3600, refreshHash,
      wipeGeneration: generation };
  }
  records[`srt:${refreshHash}`] = { accessHash, tenant, deviceId: "device", exp: options.grant ?? now() + 30 * DAY,
    born: options.born ?? now(), wipeGeneration: generation };
  if (!options.legacy) records[sessionIndexKey(tenant, refreshHash)] = { accessHash, generation };
  return { accessHash, refreshHash, records, keys: Object.keys(records) };
}

async function putAll(stub: DurableObjectStub, records: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(records);
  await runInDurableObject(stub, async (_instance, state) => {
    for (let i = 0; i < entries.length; i += 128) await state.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
  });
}

/// Which of `keys` the object still holds.
async function present(stub: DurableObjectStub, keys: readonly string[]): Promise<string[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const found: string[] = [];
    for (let i = 0; i < keys.length; i += 128) found.push(...(await state.storage.get(keys.slice(i, i + 128))).keys());
    return sorted(found);
  });
}

/// Runs the object's alarm until the sweep has finished a pass. Each run is due a minute on, so the alarm never also fires
/// by itself between two runs and the test's own reads.
async function sweepPass(stub: DurableObjectStub): Promise<void> {
  for (let run = 0; run < 100; run++) {
    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    if (await runInDurableObject(stub, (_instance, state) => state.storage.get("session-sweep")) === undefined) return;
  }
  throw new Error("the sweep never finished its pass");
}

function wipe(stub: DurableObjectStub, tenant: string): Promise<Response> {
  return stub.fetch("https://auth/tenant-wipe", { method: "POST",
    headers: { "content-type": "application/json", "x-wipe": "1" }, body: JSON.stringify({ tenant }) });
}

/// Signs in with Apple as `sub` through the real exchange, so one person can hold several sessions.
async function signInAs(sub: string): Promise<SignedIn> {
  const deviceId = `device-${crypto.randomUUID()}`;
  const nonce = "people-nonce";
  const response = await sourceWorker.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken: await appleIdentity({ sub }), nonce, deviceId }) });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { tenant: string; accessToken: string; refreshToken: string };
  return { ...body, deviceId, headers: { authorization: `Bearer ${body.accessToken}` } };
}

describe("the auth object's sweep", () => {
  it("deletes an ended session's records at the alarm, where they used to stay for ever", async () => {
    const stub = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    const ended = chain("email:review", { access: 1, grant: 1 });
    await putAll(stub, ended.records);
    await sweepPass(stub);
    expect(await present(stub, ended.keys)).toEqual([]);
  });

  it(`reads at most ${SWEEP_BATCH} session records a run, and goes on from where it stopped`, async () => {
    const stub = freshAuth();
    const endedCount = SWEEP_BATCH + 40;
    const key = (n: number) => `sat:0-${String(n).padStart(4, "0")}`;
    // Ended access records whose keys sort first, then live chains.
    await putAll(stub, Object.fromEntries(Array.from({ length: endedCount }, (_, n) =>
      [key(n), { tenant: "apple:gone", deviceId: "device", exp: now() - 60, refreshHash: "r-gone" }])));
    const live = Array.from({ length: 10 }, () => chain("apple:kept"));
    await putAll(stub, Object.assign({}, ...live.map((one) => one.records)));
    const left = () => runInDurableObject(stub, async (_instance, state) => (await state.storage.list({ prefix: "sat:0-" })).size);
    const place = () => runInDurableObject(stub, async (_instance, state) =>
      ({ cursor: await state.storage.get("session-sweep"), alarm: await state.storage.getAlarm() }));

    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await left()).toBe(endedCount - SWEEP_BATCH);
    const between = await place();
    expect(between.cursor).toEqual({ prefix: "sat:", after: key(SWEEP_BATCH - 1) });
    // A pass part way through runs again soon, not an hour on.
    expect(between.alarm).toBeLessThanOrEqual(Date.now() + 15_000);

    await runInDurableObject(stub, (_instance, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await left()).toBe(0);
    const after = await place();
    expect(after.cursor).toBeUndefined();
    expect(await present(stub, live.flatMap((one) => one.keys))).toEqual(sorted(live.flatMap((one) => one.keys)));
    // The pass is over and sessions are left: the next starts an hour on.
    expect(after.alarm).toBeGreaterThan(Date.now() + (SWEEP_EVERY_SECONDS - 120) * 1000);
    expect(after.alarm).toBeLessThanOrEqual(Date.now() + SWEEP_EVERY_SECONDS * 1000);
  });

  it("takes a grant past its 30 days or its chain's 90, with its access record and its row, and keeps live ones", async () => {
    const stub = freshAuth();
    const expired = chain("apple:a", { access: now() - 30 * DAY, grant: now() - 60 });
    const capped = chain("apple:b", { access: now() - 60, born: now() - 91 * DAY });
    // Refreshed just before its 90 days: its access record still has part of its hour, so the chain waits.
    const lastHour = chain("apple:c", { born: now() - 91 * DAY });
    // Its hour is over but its grant can still refresh: only the access record goes.
    const refreshable = chain("apple:d", { access: now() - 60 });
    await putAll(stub, { ...expired.records, ...capped.records, ...lastHour.records, ...refreshable.records });
    await sweepPass(stub);
    expect(await present(stub, expired.keys)).toEqual([]);
    expect(await present(stub, capped.keys)).toEqual([]);
    expect(await present(stub, lastHour.keys)).toEqual(sorted(lastHour.keys));
    expect(await present(stub, refreshable.keys)).toEqual(sorted(refreshable.keys.filter((one) => !one.startsWith("sat:"))));
  });

  it("gives every live grant made before the index its row on the first pass, then marks the index filled", async () => {
    const stub = freshAuth();
    const old = chain("apple:old", { legacy: true, generation: 2 });
    await putAll(stub, old.records);
    await sweepPass(stub);
    expect(await runInDurableObject(stub, async (_instance, state) => ({
      row: await state.storage.get(sessionIndexKey("apple:old", old.refreshHash)),
      filled: await state.storage.get("session-index-filled"),
    }))).toEqual({ row: { accessHash: old.accessHash, generation: 2 }, filled: true });
  });
});

describe("a tenant's wipe", () => {
  it("reads only its own tenant's sessions", async () => {
    const stub = freshAuth();
    // An empty object's first pass ends at once, and the index is filled.
    await sweepPass(stub);
    const mine = [chain("apple:mine"), chain("apple:mine")];
    const theirs = chain("apple:theirs");
    // A record nobody can read as a session: a wipe that reads every session fails on it.
    await putAll(stub, { ...mine[0]!.records, ...mine[1]!.records, ...theirs.records, "sat:unreadable": null });
    const response = await wipe(stub, "apple:mine");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionsWiped: 2 });
    expect(await present(stub, mine.flatMap((one) => one.keys))).toEqual([]);
    expect(await present(stub, theirs.keys)).toEqual(sorted(theirs.keys));
    expect(await present(stub, ["sat:unreadable"])).toEqual(["sat:unreadable"]);
  });

  it("ends its sessions made before the index, before the first pass and after it", async () => {
    // Before any pass the wipe also looks the old way: an old chain, an old grant whose access record already went, and
    // a chain with its row.
    const before = freshAuth();
    const old = chain("apple:old", { legacy: true });
    const orphan = chain("apple:old", { legacy: true, accessRecord: false });
    const indexed = chain("apple:old");
    const kept = chain("apple:someone-else", { legacy: true });
    await putAll(before, { ...old.records, ...orphan.records, ...indexed.records, ...kept.records });
    const first = await wipe(before, "apple:old");
    expect(await first.json()).toEqual({ sessionsWiped: 3 });
    expect(await present(before, [...old.keys, ...orphan.keys, ...indexed.keys])).toEqual([]);
    expect(await present(before, kept.keys)).toEqual(sorted(kept.keys));

    // After the first pass the old chain has its row, and the wipe finds it there, reading nobody else's records.
    const after = freshAuth();
    const older = chain("apple:old", { legacy: true });
    await putAll(after, older.records);
    await sweepPass(after);
    await putAll(after, { "sat:unreadable": null });
    const second = await wipe(after, "apple:old");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ sessionsWiped: 1 });
    expect(await present(after, [...older.keys, sessionIndexKey("apple:old", older.refreshHash)])).toEqual([]);
  });

  it("ends every session of a person who deletes their data, through the Worker, and no one else's", async () => {
    const sub = `wipe-${crypto.randomUUID()}`;
    const first = await signInAs(sub);
    const second = await signInAs(sub);
    const other = await signIn();
    // A refresh moves the second chain on, and its row with it.
    const refreshed = await sourceWorker.fetch("https://api.manut.test/v1/auth/refresh", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: second.refreshToken, deviceId: second.deviceId }) });
    expect(refreshed.status).toBe(200);
    const moved = (await refreshed.json()) as { accessToken: string };
    const rows = () => runInDurableObject(bindings.AUTH.get(bindings.AUTH.idFromName("auth")), async (_instance, state) =>
      (await state.storage.list({ prefix: sessionIndexPrefix(first.tenant) })).size);
    expect(await rows()).toBe(2);

    const wiped = await asSession<{ sessionsWiped?: number }>(first.headers, "DELETE", "/v1/tenant/data");
    expect(wiped.status).toBe(200);
    expect(wiped.body.sessionsWiped).toBe(2);
    expect(await rows()).toBe(0);
    expect((await asSession({ authorization: `Bearer ${moved.accessToken}` }, "GET", "/v1/shops")).status).toBe(401);
    expect((await asSession(other.headers, "GET", "/v1/shops")).status).toBe(200);
  });
});

describe("the shop indexes", () => {
  it("take a deleted shop out of every person's rows, a page at a time", async () => {
    const stub = freshAuth();
    const shop = `pilot:${crypto.randomUUID()}`;
    const other = `pilot:${crypto.randomUUID()}`;
    const subjects = Array.from({ length: SCAN_PAGE * 2 + 5 }, (_, n) => `apple:person-${String(n).padStart(4, "0")}`);
    const records: Record<string, unknown> = {};
    subjects.forEach((subject, n) => {
      // Every third person is only in the deleted shop, so their list goes altogether.
      records[`identity-shops:${enc(subject)}`] = n % 3 === 0 ? [{ shop, role: "owner", ref: "r", at: 1 }]
        : [{ shop, role: "owner", ref: "r", at: 1 }, { shop: other, role: "helper", ref: "h", at: 1 }];
      records[`shops-made:${enc(subject)}`] = n % 3 === 0 ? [{ shop, at: 1, done: true }]
        : [{ shop, at: 1, done: true }, { shop: other, at: 1, done: true }];
    });
    await putAll(stub, records);
    expect((await wipe(stub, shop)).status).toBe(200);
    const left = await runInDurableObject(stub, async (_instance, state) => ({
      rows: [...(await state.storage.list<{ shop: string }[]>({ prefix: "identity-shops:" })).values()],
      made: [...(await state.storage.list<{ shop: string }[]>({ prefix: "shops-made:" })).values()],
    }));
    const kept = subjects.filter((_, n) => n % 3 !== 0).length;
    for (const lists of [left.rows, left.made]) {
      expect(lists).toHaveLength(kept);
      expect(lists.every((rows) => rows.length === 1 && rows[0]!.shop === other)).toBe(true);
    }
  });

  it("are not read at all for a person's own deletion", async () => {
    const stub = freshAuth();
    // Not a list of rows: reading it fails.
    await putAll(stub, { [`identity-shops:${enc("apple:someone")}`]: 5 });
    expect((await wipe(stub, `apple:${crypto.randomUUID()}`)).status).toBe(200);
    expect((await wipe(stub, `email:${hex()}${hex()}`)).status).toBe(200);
    // The control: a shop's deletion does read the rows, and fails on the same one.
    const control = await wipe(stub, `pilot:${crypto.randomUUID()}`).then((response) => response.status, () => "threw");
    expect(control).not.toBe(200);
  });

  it("find a make on the journal past its first page", async () => {
    const stub = freshAuth();
    const records: Record<string, unknown> = {};
    for (let n = 0; n < SCAN_PAGE + 5; n++) {
      const tenant = `pilot:0-${String(n).padStart(4, "0")}`;
      records[`pilot-making:${enc(tenant)}`] = { tenant, name: `Other ${n}`, ownerName: "Dao", template: null, by: null, at: 1 };
    }
    // The make asked for again, last in key order.
    records[`pilot-making:${enc("pilot:zz-wanted")}`] = { tenant: "pilot:zz-wanted", name: "Wanted", ownerName: "Dao",
      template: null, by: null, at: 1 };
    await putAll(stub, records);
    const begun = await stub.fetch("https://auth/pilot-making/begin", { method: "POST",
      headers: { "content-type": "application/json", "x-admin": "1" },
      body: JSON.stringify({ tenant: `pilot:${crypto.randomUUID()}`, name: "Wanted", ownerName: "Dao", template: null }) });
    expect(await begun.json()).toEqual({ tenant: "pilot:zz-wanted", resumed: true });
  });
});
