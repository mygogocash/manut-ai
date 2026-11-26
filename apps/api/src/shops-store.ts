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
/// - `pilot-making:<tenant>`: the journal of makes, one row per shop that is being made, from before anything of the shop
///   is written until the write that lists it: `{ tenant, name, ownerName, template, by, at }`, where `by` is the person
///   who is making it themselves, or null for an operator's make. It is how a make that stopped part way is found again.
///   Asking for the same shop again (the same name, owner name and template, by the same person or by an operator) finds
///   the row and finishes that shop, never a second one, and the write that lists the shop takes its row off. Making a
///   shop is the mirror of deleting one (tenant-data.ts): a deletion keeps the shop on the list until it is finished, and
///   a make keeps it off the list until it is finished, and the same request finishes either.
/// - `self-serve-makes-today`: `{ day, count }`, how many shops people began to make themselves on that Bangkok day, all
///   accounts together, which `SELF_SERVE_MAKES_PER_DAY` caps.
///
/// Every change runs inside `transactionSync` with the synchronous KV API, as people-store.ts's do, so two changes to
/// one person's rows or to one code are decided one after the other. Writes need the Worker's `x-admin` header, like
/// the other global index writes in AuthObject.

import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { listShop, MAKING_PREFIX, pilotMakingKey, pilotRegistryKey, TEMPLATE_ID } from "./pilot-store";
import { authCall, type TenantDataEnv } from "./tenant-data";

export type ShopRole = "owner" | "helper";

/// One row of a person's index: a shop they are in, as what, for which link, and when the row was written.
export type IdentityShopRow = { shop: string; role: ShopRole; ref: string; at: number };

/// One shop a person made themselves: reserved at `at`, and `done` once it is listed and indexed.
export type MadeShopRow = { shop: string; at: number; done: boolean };

/// One shop that is being made, as it was asked for, and who asked: `by` is the person who makes it themselves, null for an
/// operator. `at` is when it was first asked for.
export type MakingRow = { tenant: string; name: string; ownerName: string; template: string | null; by: string | null;
  at: number };

/// How long a link code works (docs/several-shops.md): long enough to send it in a chat, short enough that an old
/// message is no use to anyone.
export const OWNER_CODE_TTL_MS = 15 * 60 * 1000;

/// How many shops one account may have made itself at a time (docs/decisions.md, 24 Nov 2026): enough for an owner with a
/// second shop and a try that went wrong, and few enough that one sign-in cannot fill the console. A shop that was deleted
/// no longer counts. Shops an operator made and linked to the account never count: this limits making, not owning.
export const SHOPS_MADE_LIMIT = 3;

/// How many shops people may begin to make themselves in one Bangkok day, all accounts together (docs/decisions.md, 24 Nov
/// 2026). `SHOPS_MADE_LIMIT` counts per account, and one mailbox can have as many accounts as it likes, so this is what
/// bounds what sign-ups add to the console, the pilot gate and the backend in a day, whoever asks. Decided in the same
/// transaction as the make's slot (`POST /pilot-making/begin`), so racing makes cannot pass it. A make already on its way
/// was counted when it began, and an operator's make never counts.
export const SELF_SERVE_MAKES_PER_DAY = 20;

/// The day's count of self-serve makes: one key, which the first make of a new Bangkok day starts again from zero.
type MakesToday = { day: number; count: number };
export const MAKES_TODAY_KEY = "self-serve-makes-today";
const DAY_MS = 24 * 3600 * 1000;
const BANGKOK_OFFSET_MS = 7 * 3600 * 1000;

/// How long a reserved row counts before its shop is listed. Making a shop takes seconds; a row still not done after this
/// is a make that failed part way, and stops counting, so a failure never takes one of the person's shops for good.
/// Asking again for the same shop reserves it again (`begin`), so a make finished later still has its slot.
export const MADE_RESERVATION_MS = 10 * 60 * 1000;

const MAX_BODY_BYTES = 16 * 1024;
/// Rows a scan of a whole index reads at a time (every person's rows, the journal of makes), so no scan ever holds all of
/// them at once: the storage API loads everything a `list` names into memory.
export const SCAN_PAGE = 128;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/// The longest name a shop or its owner may have here: the operator's route allows 200 (pilot.ts), the person's own 80.
const MAX_NAME = 200;
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

/// The shop a make asks for, or null when it is not one: the tenant the Worker would give it, the names and the template
/// as they were asked for, and, for a person making their own shop, who they are.
function makeOf(body: Record<string, unknown>):
  { tenant: string; name: string; ownerName: string; template: string | null; subject: string | null } | null {
  const { tenant, name, ownerName, template, subject } = body;
  const named = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_NAME;
  if (!isValidTenant(tenant) || !named(name) || !named(ownerName)) return null;
  if (template !== null && !(typeof template === "string" && TEMPLATE_ID.test(template))) return null;
  if (subject !== undefined && subject !== null && !isValidTenant(subject)) return null;
  return { tenant, name, ownerName, template, subject: subject ?? null };
}

/// Hands `visit` the rows under `prefix`, `SCAN_PAGE` at a time in key order. A page is read whole before `visit` sees it,
/// so `visit` may change the rows it was handed, and the next page starts after the last key of this one.
function eachPage<T>(kv: SyncKvStorage, prefix: string, visit: (page: [string, T][]) => void): void {
  for (let after: string | undefined; ;) {
    const page = [...kv.list<T>({ prefix, limit: SCAN_PAGE, ...(after === undefined ? {} : { startAfter: after }) })];
    if (page.length > 0) visit(page);
    if (page.length < SCAN_PAGE) return;
    after = page[page.length - 1]![0];
  }
}

/// The earliest make on the journal that is for the very shop `make` asks for: the same names, template and asker. There
/// is at most one, since a make that finds one never writes another. The journal is read a page at a time.
function heldMake(kv: SyncKvStorage, make: { name: string; ownerName: string; template: string | null; subject: string | null }):
  MakingRow | undefined {
  let held: MakingRow | undefined;
  eachPage<MakingRow>(kv, MAKING_PREFIX, (page) => {
    for (const [, row] of page) {
      if (row.by !== make.subject || row.name !== make.name || row.ownerName !== make.ownerName || row.template !== make.template) continue;
      if (!held || row.at < held.at) held = row;
    }
  });
  return held;
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

  /// `{ tenant, name, ownerName, template, subject? }`: a make begins, before anything of the shop is written. If the same
  /// shop is already on the journal (the same names, template and asker: an earlier try that stopped part way), that is
  /// the shop to make, and this one finishes it; if not, `tenant` is, and its row goes on the journal. Answers the tenant
  /// to make, and whether it was one already on its way.
  ///
  /// For a person making their own shop (`subject`) the same transaction reserves one of their made shops for it, or
  /// refuses with 409 `too_many_shops` while `SHOPS_MADE_LIMIT` of their others still count, and writes nothing. A shop
  /// already on its way counts as itself, so finishing it never asks for a second slot. Rows that no longer count are dropped.
  /// A new one also counts against the day's sign-ups, all accounts together: past `SELF_SERVE_MAKES_PER_DAY` it is
  /// refused with 429 `sign_ups_full` and `retryAfter`, the whole seconds until the next Bangkok day, and writes nothing.
  "POST /pilot-making/begin": (kv, body, nowMs) => {
    const make = makeOf(body);
    if (!make) return refused(400, "invalid_request");
    const held = heldMake(kv, make);
    const tenant = held?.tenant ?? make.tenant;
    if (make.subject !== null) {
      const others = countingMade(kv, kv.get<MadeShopRow[]>(keys.made(make.subject)) ?? [], nowMs)
        .filter((row) => row.shop !== tenant);
      if (others.length >= SHOPS_MADE_LIMIT) return refused(409, "too_many_shops");
      if (!held) {
        const day = Math.floor((nowMs + BANGKOK_OFFSET_MS) / DAY_MS);
        const today = kv.get<MakesToday>(MAKES_TODAY_KEY);
        const count = today?.day === day ? today.count : 0;
        if (count >= SELF_SERVE_MAKES_PER_DAY) {
          const retryAfter = Math.ceil(((day + 1) * DAY_MS - BANGKOK_OFFSET_MS - nowMs) / 1000);
          return { status: 429, body: { error: "sign_ups_full", retryAfter } };
        }
        kv.put(MAKES_TODAY_KEY, { day, count: count + 1 } satisfies MakesToday);
      }
      kv.put(keys.made(make.subject), [...others, { shop: tenant, at: nowMs, done: false }]);
    }
    if (!held) {
      kv.put(pilotMakingKey(tenant), { tenant, name: make.name, ownerName: make.ownerName, template: make.template,
        by: make.subject, at: nowMs } satisfies MakingRow);
    }
    return { status: 200, body: { tenant, resumed: held !== undefined } };
  },

  /// `{ subject, shop, ref }`: the shop the person made is whole. In one transaction it goes on the console's list (the
  /// pilot registry's row, as `/pilot-shops` writes it) and its make leaves the journal, into the person's index as theirs
  /// through the owner link `ref`, and its row is done. A shop with no reservation still on its way is refused, 409
  /// `not_reserved`, and nothing is written: a make that outlived its reservation is not let past the limit. A shop already
  /// done answers the same again, so a make may ask twice when the answer to the first was lost.
  "POST /shops-made/finish": (kv, body, nowMs) => {
    const row = rowOf({ ...body, role: "owner" });
    if (!row) return refused(400, "invalid_request");
    const rows = kv.get<MadeShopRow[]>(keys.made(row.subject)) ?? [];
    const reserved = rows.find((one) => one.shop === row.shop && (one.done || nowMs - one.at < MADE_RESERVATION_MS));
    if (!reserved) return refused(409, "not_reserved");
    listShop(kv, row.shop, nowMs);
    putRow(kv, row, nowMs);
    if (!reserved.done) kv.put(keys.made(row.subject), rows.map((one) => (one === reserved ? { ...one, done: true } : one)));
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

/// `/identity-shops`, `/owner-codes`, `/pilot-making` and `/shops-made` on AuthObject:
/// - `GET /identity-shops?subject=`: the person's rows;
/// - `POST /identity-shops`, `POST /identity-shops/remove`: add or take out one row;
/// - `POST /owner-codes`, `POST /owner-codes/redeem`: keep a new code, or use one;
/// - `POST /pilot-making/begin`: a make begins (an operator's or a person's own), or finds the one that stopped part way;
/// - `POST /shops-made/finish`, `/release`: a shop the person made themselves is whole and listed, or its make failed.
///   An operator's make ends with the registry's own `POST /pilot-shops` (pilot-store.ts).
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

/// Whether `tenant` is a person's own: a sign-in's, Apple's (`apple:<sub>`, auth.ts) or an email code's (`email:<hash>`,
/// email-code.ts). The Worker makes every shop `pilot:<uuid>` (pilot.ts `newShopTenant`), so no person's tenant names a shop.
function isPersonTenant(tenant: string): boolean {
  return tenant.startsWith("apple:") || tenant.startsWith("email:");
}

/// Takes `shop` out of every row list under `prefix`, a page at a time, deleting a list it empties.
function dropShopRows<T extends { shop: string }>(kv: SyncKvStorage, prefix: string, shop: string): void {
  eachPage<T[]>(kv, prefix, (page) => {
    for (const [key, rows] of page) {
      const kept = rows.filter((row) => row.shop !== shop);
      if (kept.length === rows.length) continue;
      if (kept.length === 0) kv.delete(key);
      else kv.put(key, kept);
    }
  });
}

/// Part of AuthObject's tenant wipe. A deleted shop leaves every person's index, as the lifted wipe takes out the
/// inbound routes that name a tenant. A person who deletes their own data loses the link code they were waiting to
/// send, but keeps their rows: those point at their shops' records, which their own data's deletion does not reach,
/// and leaving a shop is unlinking or removal (docs/several-shops.md).
///
/// Only a shop's deletion reads the indexes, a page at a time: a person's tenant names no shop, so their deletion, which
/// any signed-in person can ask for, reads nobody's rows at all.
export function wipeShopsTenant(storage: DurableObjectStorage, tenant: string): void {
  storage.transactionSync(() => {
    const kv = storage.kv;
    if (!isPersonTenant(tenant)) {
      dropShopRows<IdentityShopRow>(kv, ROWS_PREFIX, tenant);
      // A deleted shop its owner made stops counting against their limit: its row goes with it.
      dropShopRows<MadeShopRow>(kv, MADE_PREFIX, tenant);
    }
    // A shop that is deleted is no longer being made, whatever stopped: its row on the journal goes with it.
    kv.delete(pilotMakingKey(tenant));
    const code = kv.get<string>(keys.codeOf(tenant));
    if (code !== undefined) {
      kv.delete(keys.code(code));
      kv.delete(keys.codeOf(tenant));
    }
  });
}

/// The shops `subject` began to make themselves that are still on the journal of makes: a make that stopped part way and
/// that nobody asked for again ("A make that stops part way", docs/pilot-api.md). Read a page at a time. Deleting the
/// person's account deletes each of them (account-deletion.ts), since each may hold the names they typed.
export function personMakes(kv: SyncKvStorage, subject: string): string[] {
  const tenants: string[] = [];
  eachPage<MakingRow>(kv, MAKING_PREFIX, (page) => {
    for (const [, row] of page) if (row.by === subject) tenants.push(row.tenant);
  });
  return tenants;
}

/// Part of deleting a person's account (account-store.ts), in the caller's transaction: every row this file keeps of
/// theirs. Their index of shops, which their own data's deletion keeps (`wipeShopsTenant`, above), goes here, with the
/// shops they made, their waiting link code and every make of theirs still on the journal. By the time this runs the
/// shops they owned are deleted and they have left the ones they helped at, so no row of theirs could open anything.
export function forgetPersonShops(kv: SyncKvStorage, subject: string): void {
  kv.delete(keys.rows(subject));
  kv.delete(keys.made(subject));
  const code = kv.get<string>(keys.codeOf(subject));
  if (code !== undefined) {
    kv.delete(keys.code(code));
    kv.delete(keys.codeOf(subject));
  }
  eachPage<MakingRow>(kv, MAKING_PREFIX, (page) => {
    for (const [key, row] of page) if (row.by === subject) kv.delete(key);
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

/// Begins a make (`POST /pilot-making/begin`), and for a person making their own shop (`make.subject`) reserves one of
/// their made shops for it. Answers the tenant to make: `make.tenant`, unless the same shop is already on its way, and then
/// that one's. `too_many` at the limit of a person's made shops, `{ full }` with the seconds until the next Bangkok day
/// when the day's sign-ups are full, or null when AuthObject cannot be reached, in which case nothing is known to have
/// begun: if only the answer was lost, the make is on the journal and asking again finds it.
export async function beginMake(env: Pick<TenantDataEnv, "AUTH">, make: { tenant: string; name: string; ownerName: string;
  template: string | null; subject?: string }): Promise<{ tenant: string } | "too_many" | { full: number } | null> {
  try {
    const response = await authWrite(env, "/pilot-making/begin", make);
    if (response.status === 409) {
      await response.body?.cancel();
      return "too_many";
    }
    if (response.status === 429) {
      const { retryAfter } = (await response.json()) as { retryAfter?: unknown };
      return { full: typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : 1 };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { tenant } = (await response.json()) as { tenant?: unknown };
    return typeof tenant === "string" ? { tenant } : null;
  } catch {
    return null;
  }
}

/// Asks again, once, when a call that is safe to repeat did not succeed: the work may have been done and only its answer
/// lost on the way back, and asking the last step of a make again is cheaper than answering the person with a failure for a
/// shop that is made.
export async function twice(call: () => Promise<boolean>): Promise<boolean> {
  return (await call()) || (await call());
}

/// Lists the shop its owner made and puts it in their index, in one write. Answers whether it was written. Safe to repeat.
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
