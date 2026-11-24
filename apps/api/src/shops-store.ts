/// Several shops, from AuthObject's side (docs/several-shops.md): which shops each signed-in person is in, and the
/// one-use codes an owner gives the operator to link their account to a shop. Both are global, so they live in
/// AuthObject beside the lifted per-tenant indexes (the company membership index, the inbound routes, the pilot shop
/// registry), each person's rows under one key named by their verified subject (`apple:<sub>`).
///
/// The index is never the authority. A shop's own people record (people-store.ts) says who owns it and who helps
/// there; a row here only lets `GET /v1/shops` find that shop without reading every shop, and every use reads the
/// shop's record again (shops.ts). So a row that outlived its link lists nothing and opens nothing.
///
/// - `identity-shops:<subject>`: rows of `{ shop, role, ref, at }`, one per shop and role. `ref` is the id of the link
///   the row was written for (the owner account's or the helper's), so taking a row out never takes out the row a
///   newer link wrote in the meantime.
/// - `owner-code:<SHA-256 of the code>`: `{ subject, expiresAt }`, for 15 minutes, used once. Only the hash is kept.
/// - `owner-code-of:<subject>`: the hash of that person's current code, so asking for a new one replaces the last.
/// - `shops-made:<subject>`: the shops the person made themselves (self-serve.ts), rows of `{ shop, at, done }`. A row is
///   reserved before its shop is made, so how many shops one account may make is decided here, in one transaction,
///   however many requests race; it is `done` once the shop is on the console's list and in the person's index, which the
///   same transaction writes, so the two never disagree about a shop its owner made.
///
/// Every change runs inside `transactionSync` with the synchronous KV API, as people-store.ts's do, so two changes to
/// one person's rows or to one code are decided one after the other. Writes need the Worker's `x-admin` header, like
/// the other global index writes in AuthObject.

import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { pilotRegistryKey } from "./pilot-store";
import { authCall, type TenantDataEnv } from "./tenant-data";

export type ShopRole = "owner" | "helper";

/// One row of a person's index: a shop they are in, as what, for which link, and when the row was written.
export type IdentityShopRow = { shop: string; role: ShopRole; ref: string; at: number };

/// One shop a person made themselves: reserved at `at`, and `done` once it is listed and indexed.
export type MadeShopRow = { shop: string; at: number; done: boolean };

/// How long a link code works (docs/several-shops.md): long enough to send it in a chat, short enough that an old
/// message is no use to anyone.
export const OWNER_CODE_TTL_MS = 15 * 60 * 1000;

/// How many shops one account may have made itself at a time (docs/decisions.md, 24 Nov 2026): enough for an owner with a
/// second shop and a try that went wrong, and few enough that one sign-in cannot fill the console. A shop that was deleted
/// no longer counts. Shops an operator made and linked to the account never count: this limits making, not owning.
export const SHOPS_MADE_LIMIT = 3;

/// How long a reserved row counts before its shop is listed. Making a shop takes seconds; a row still not done after this
/// is a make that failed part way, and stops counting, so a failure never takes one of the person's shops for good.
export const MADE_RESERVATION_MS = 10 * 60 * 1000;

const MAX_BODY_BYTES = 16 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/// The longest link id a row keeps: people.ts and shops.ts mint `helper-` and `owner-` and a UUID.
const MAX_REF = 256;

type OwnerCode = { subject: string; expiresAt: number };
type Answer = { status: number; body: unknown };
type Write = (kv: SyncKvStorage, body: Record<string, unknown>, nowMs: number) => Answer;

const enc = encodeURIComponent;
const ROWS_PREFIX = "identity-shops:";
const MADE_PREFIX = "shops-made:";
const keys = {
  rows: (subject: string) => `${ROWS_PREFIX}${enc(subject)}`,
  code: (hash: string) => `owner-code:${hash}`,
  codeOf: (subject: string) => `owner-code-of:${enc(subject)}`,
  made: (subject: string) => `${MADE_PREFIX}${enc(subject)}`,
};

/// The rows of a person's made shops that still count at `nowMs`: a shop on the console's list (made, and not deleted
/// since), or one reserved lately whose make is still on its way. The registry is this object's own (pilot-store.ts), so
/// the check is in the same transaction as the write it decides.
function countingMade(kv: SyncKvStorage, rows: readonly MadeShopRow[], nowMs: number): MadeShopRow[] {
  return rows.filter((row) => kv.get(pilotRegistryKey(row.shop)) !== undefined ||
    (!row.done && nowMs - row.at < MADE_RESERVATION_MS));
}

/// Puts `shop` in `subject`'s index as `role` through the link `ref`, replacing their row for that shop and role.
function putRow(kv: SyncKvStorage, row: { subject: string; shop: string; role: ShopRole; ref: string }, nowMs: number) {
  const rows = kv.get<IdentityShopRow[]>(keys.rows(row.subject)) ?? [];
  const others = rows.filter((one) => !(one.shop === row.shop && one.role === row.role));
  kv.put(keys.rows(row.subject), [...others, { shop: row.shop, role: row.role, ref: row.ref, at: nowMs }]);
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function refused(status: number, error: string): Answer {
  return { status, body: { error } };
}

/// The row a write names, or null when it is not one: a subject, a shop, a role and the link's id.
function rowOf(body: Record<string, unknown>): { subject: string; shop: string; role: ShopRole; ref: string } | null {
  const { subject, shop, role, ref } = body;
  if (!isValidTenant(subject) || !isValidTenant(shop) || (role !== "owner" && role !== "helper")) return null;
  if (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_REF) return null;
  return { subject, shop, role, ref };
}

const WRITES: Readonly<Record<string, Write>> = {
  /// `{ subject, shop, role, ref }`: the person is in `shop` as `role`, through the link `ref`. Replaces their row for
  /// that shop and role, so writing it again only refreshes it.
  "POST /identity-shops": (kv, body, nowMs) => {
    const row = rowOf(body);
    if (!row) return refused(400, "invalid_request");
    putRow(kv, row, nowMs);
    return { status: 200, body: { indexed: true } };
  },

  /// `{ subject, shop }`: reserves one of the person's made shops for `shop`, before anything of it is made, or refuses
  /// with 409 `too_many_shops` while `SHOPS_MADE_LIMIT` of theirs still count. Rows that no longer count are dropped.
  "POST /shops-made/reserve": (kv, body, nowMs) => {
    const { subject, shop } = body;
    if (!isValidTenant(subject) || !isValidTenant(shop)) return refused(400, "invalid_request");
    const counting = countingMade(kv, kv.get<MadeShopRow[]>(keys.made(subject)) ?? [], nowMs);
    if (counting.length >= SHOPS_MADE_LIMIT) return refused(409, "too_many_shops");
    kv.put(keys.made(subject), [...counting.filter((row) => row.shop !== shop), { shop, at: nowMs, done: false }]);
    return { status: 200, body: { reserved: true } };
  },

  /// `{ subject, shop, ref }`: the shop the person reserved is made. In one transaction it goes on the console's list (the
  /// pilot registry's row, as `/pilot-shops` writes it), into the person's index as theirs through the owner link `ref`,
  /// and its row is done. A shop with no reservation still on its way is refused, 409 `not_reserved`, and nothing is
  /// written: a make that outlived its reservation is not let past the limit.
  "POST /shops-made/finish": (kv, body, nowMs) => {
    const row = rowOf({ ...body, role: "owner" });
    if (!row) return refused(400, "invalid_request");
    const rows = kv.get<MadeShopRow[]>(keys.made(row.subject)) ?? [];
    const reserved = rows.find((one) => one.shop === row.shop && !one.done && nowMs - one.at < MADE_RESERVATION_MS);
    if (!reserved) return refused(409, "not_reserved");
    kv.put(pilotRegistryKey(row.shop), { tenant: row.shop, createdAt: new Date(nowMs).toISOString() });
    putRow(kv, row, nowMs);
    kv.put(keys.made(row.subject), rows.map((one) => (one === reserved ? { ...one, done: true } : one)));
    return { status: 200, body: { listed: true } };
  },

  /// `{ subject, shop }`: a make that failed gives its reservation back, so it does not count for its ten minutes.
  "POST /shops-made/release": (kv, body) => {
    const { subject, shop } = body;
    if (!isValidTenant(subject) || !isValidTenant(shop)) return refused(400, "invalid_request");
    const rows = kv.get<MadeShopRow[]>(keys.made(subject)) ?? [];
    const kept = rows.filter((one) => !(one.shop === shop && !one.done));
    if (kept.length === rows.length) return { status: 200, body: { released: false } };
    if (kept.length === 0) kv.delete(keys.made(subject));
    else kv.put(keys.made(subject), kept);
    return { status: 200, body: { released: true } };
  },

  /// `{ subject, shop, role, ref }`: takes that row out, only while it is still the one the link `ref` wrote.
  "POST /identity-shops/remove": (kv, body) => {
    const row = rowOf(body);
    if (!row) return refused(400, "invalid_request");
    const rows = kv.get<IdentityShopRow[]>(keys.rows(row.subject)) ?? [];
    const kept = rows.filter((one) => !(one.shop === row.shop && one.role === row.role && one.ref === row.ref));
    if (kept.length === rows.length) return { status: 200, body: { removed: false } };
    if (kept.length === 0) kv.delete(keys.rows(row.subject));
    else kv.put(keys.rows(row.subject), kept);
    return { status: 200, body: { removed: true } };
  },

  /// `{ subject, codeHash, expiresAt }`: keeps a new code for the person, replacing the one they had. A hash another
  /// person's live code already holds is refused, so one code can never name two people; the Worker draws another.
  "POST /owner-codes": (kv, body, nowMs) => {
    const { subject, codeHash, expiresAt } = body;
    if (!isValidTenant(subject) || typeof codeHash !== "string" || !SHA256_HEX.test(codeHash) || !isTime(expiresAt)) {
      return refused(400, "invalid_request");
    }
    const holder = kv.get<OwnerCode>(keys.code(codeHash));
    if (holder && holder.subject !== subject && holder.expiresAt > nowMs) return refused(409, "code_taken");
    const previous = kv.get<string>(keys.codeOf(subject));
    if (previous !== undefined) kv.delete(keys.code(previous));
    kv.put(keys.code(codeHash), { subject, expiresAt } satisfies OwnerCode);
    kv.put(keys.codeOf(subject), codeHash);
    return { status: 200, body: { kept: true } };
  },

  /// `{ codeHash }`: uses a code: the person it names, or why it names nobody. A code goes the first time it is tried,
  /// whatever the answer, so a late one cannot be tried again either.
  "POST /owner-codes/redeem": (kv, body, nowMs) => {
    const { codeHash } = body;
    if (typeof codeHash !== "string" || !SHA256_HEX.test(codeHash)) return refused(400, "invalid_request");
    const stored = kv.get<OwnerCode>(keys.code(codeHash));
    if (!stored) return refused(404, "unknown_code");
    kv.delete(keys.code(codeHash));
    if (kv.get<string>(keys.codeOf(stored.subject)) === codeHash) kv.delete(keys.codeOf(stored.subject));
    if (stored.expiresAt <= nowMs) return refused(410, "code_expired");
    return { status: 200, body: { subject: stored.subject } };
  },
};

/// `/identity-shops`, `/owner-codes` and `/shops-made` on AuthObject:
/// - `GET /identity-shops?subject=`: the person's rows;
/// - `POST /identity-shops`, `POST /identity-shops/remove`: add or take out one row;
/// - `POST /owner-codes`, `POST /owner-codes/redeem`: keep a new code, or use one;
/// - `POST /shops-made/reserve`, `/finish`, `/release`: a shop the person makes themselves, before, after, or failed.
export async function shopsAuthRoute(storage: DurableObjectStorage, request: Request, url: URL): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /identity-shops") {
    const subject = url.searchParams.get("subject") ?? "";
    if (!isValidTenant(subject)) return json({ error: "invalid_request" }, 400);
    return json({ rows: storage.kv.get<IdentityShopRow[]>(keys.rows(subject)) ?? [] });
  }
  const write = WRITES[route];
  if (!write) return json({ error: "not_found" }, 404);
  if (request.headers.get("x-admin") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value)) return json({ error: "invalid_request" }, 400);
  const body = parsed.value;
  const answer = storage.transactionSync(() => write(storage.kv, body, Date.now()));
  return json(answer.body, answer.status);
}

/// Part of AuthObject's tenant wipe. A deleted shop leaves every person's index, as the lifted wipe takes out the
/// inbound routes that name a tenant. A person who deletes their own data loses the link code they were waiting to
/// send, but keeps their rows: those point at their shops' records, which their own data's deletion does not reach,
/// and leaving a shop is unlinking or removal (docs/several-shops.md).
export function wipeShopsTenant(storage: DurableObjectStorage, tenant: string): void {
  storage.transactionSync(() => {
    const kv = storage.kv;
    // Read every row first and write after, so no write lands under a list that is still being read.
    const indexes = [...kv.list<IdentityShopRow[]>({ prefix: ROWS_PREFIX })];
    for (const [key, rows] of indexes) {
      const kept = rows.filter((row) => row.shop !== tenant);
      if (kept.length === rows.length) continue;
      if (kept.length === 0) kv.delete(key);
      else kv.put(key, kept);
    }
    // A deleted shop its owner made stops counting against their limit: its row goes with it.
    const made = [...kv.list<MadeShopRow[]>({ prefix: MADE_PREFIX })];
    for (const [key, rows] of made) {
      const kept = rows.filter((row) => row.shop !== tenant);
      if (kept.length === rows.length) continue;
      if (kept.length === 0) kv.delete(key);
      else kv.put(key, kept);
    }
    const code = kv.get<string>(keys.codeOf(tenant));
    if (code !== undefined) {
      kv.delete(keys.code(code));
      kv.delete(keys.codeOf(tenant));
    }
  });
}

// ---------------------------------------------------------------------------
// The Worker's calls
// ---------------------------------------------------------------------------

async function authWrite(env: Pick<TenantDataEnv, "AUTH">, path: string, body: Record<string, unknown>) {
  return authCall(env, path, { method: "POST", headers: { "content-type": "application/json", "x-admin": "1" },
    body: JSON.stringify(body) });
}

/// The rows of `subject`'s index, or null when AuthObject cannot be read.
export async function readIdentityShops(env: Pick<TenantDataEnv, "AUTH">, subject: string):
  Promise<IdentityShopRow[] | null> {
  try {
    const response = await authCall(env, `/identity-shops?subject=${enc(subject)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { rows } = (await response.json()) as { rows?: unknown };
    return Array.isArray(rows) ? (rows as IdentityShopRow[]) : null;
  } catch {
    return null;
  }
}

/// Puts `row.shop` in `subject`'s index. Answers whether the row was written; never throws, since a missing row only
/// keeps the shop off the person's list and the shop's record still decides everything.
export async function indexShop(env: Pick<TenantDataEnv, "AUTH">, subject: string,
  row: { shop: string; role: ShopRole; ref: string }): Promise<boolean> {
  try {
    const response = await authWrite(env, "/identity-shops", { subject, ...row });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/// Takes `row.shop` out of `subject`'s index while the row is still the one the link `row.ref` wrote. Best effort, for
/// the same reason as `indexShop`.
export async function unindexShop(env: Pick<TenantDataEnv, "AUTH">, subject: string,
  row: { shop: string; role: ShopRole; ref: string }): Promise<boolean> {
  try {
    const response = await authWrite(env, "/identity-shops/remove", { subject, ...row });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/// Keeps the hash of a new code for `subject`: `kept`, `taken` when another person's live code has the same hash (draw
/// another), or `failed` when AuthObject cannot be reached.
export async function keepOwnerCode(env: Pick<TenantDataEnv, "AUTH">, subject: string, codeHash: string,
  expiresAt: number): Promise<"kept" | "taken" | "failed"> {
  try {
    const response = await authWrite(env, "/owner-codes", { subject, codeHash, expiresAt });
    await response.body?.cancel();
    if (response.ok) return "kept";
    return response.status === 409 ? "taken" : "failed";
  } catch {
    return "failed";
  }
}

/// Reserves one of `subject`'s made shops for `shop`: `reserved`, `too_many` at the limit, or `failed` when AuthObject
/// cannot be reached.
export async function reserveMadeShop(env: Pick<TenantDataEnv, "AUTH">, subject: string, shop: string):
  Promise<"reserved" | "too_many" | "failed"> {
  try {
    const response = await authWrite(env, "/shops-made/reserve", { subject, shop });
    await response.body?.cancel();
    if (response.ok) return "reserved";
    return response.status === 409 ? "too_many" : "failed";
  } catch {
    return "failed";
  }
}

/// Lists the shop its owner made and puts it in their index, in one write. Answers whether it was written.
export async function finishMadeShop(env: Pick<TenantDataEnv, "AUTH">, subject: string, shop: string, ref: string):
  Promise<boolean> {
  try {
    const response = await authWrite(env, "/shops-made/finish", { subject, shop, ref });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/// Gives back a reservation whose shop could not be made. Best effort: one left behind stops counting by itself.
export async function releaseMadeShop(env: Pick<TenantDataEnv, "AUTH">, subject: string, shop: string): Promise<void> {
  try {
    const response = await authWrite(env, "/shops-made/release", { subject, shop });
    await response.body?.cancel();
  } catch {
    // It lapses after MADE_RESERVATION_MS.
  }
}

/// Uses the code with this hash: the person it names, its refusal (404 `unknown_code`, 410 `code_expired`), or null
/// when AuthObject cannot be reached.
export async function redeemOwnerCode(env: Pick<TenantDataEnv, "AUTH">, codeHash: string):
  Promise<{ subject: string } | { status: 404 | 410; error: "unknown_code" | "code_expired" } | null> {
  try {
    const response = await authWrite(env, "/owner-codes/redeem", { codeHash });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return response.status === 404 ? { status: 404, error: "unknown_code" } : { status: 410, error: "code_expired" };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { subject } = (await response.json()) as { subject?: unknown };
    return typeof subject === "string" ? { subject } : null;
  } catch {
    return null;
  }
}
