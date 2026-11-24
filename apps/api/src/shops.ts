/// Several shops, from the Worker's side (docs/several-shops.md; docs/pilot-api.md, "Several shops"). One signed-in
/// person may own some pilot shops and help at others. This file has two parts:
///
/// - The person's own routes, which take the lifted signed-in session and nothing else: the shops they are in, with
///   their role at each (`GET /v1/shops`); a shop session for one of them (`POST /v1/shops/session`), which is how they
///   act for a shop; and a one-use code for the operator to link their account to a shop as its owner
///   (`POST /v1/shops/owner-code`).
/// - The routes a shop session itself calls here: the app ends its own shop session when the person signs out
///   (`POST /v1/shops/session/end`), and the owner's session reads and changes the shop's consent to cloud work and reads
///   its export, on the lifted routes' own paths (`/v1/consent/cloud`, `/v1/tenant/export`), which answer every other
///   credential as before.
/// - The operator's routes, under the admin gate as exact `ADMIN_METHODS` entries: link the account a code names to a
///   shop as its owner, and unlink it. The shop's audit log records both under the operator's Access identity.
///
/// Who may act for a shop, and as what, is always the shop's own people record (people-store.ts). The person's index in
/// AuthObject (shops-store.ts) only finds their shops, and every answer here reads each shop's record again. A shop the
/// person is not linked to answers 404, as a shop that does not exist does. The person names a shop only when they ask
/// for a session for it; nothing a request says ever names a role.

import { sameIdentity, type Identity } from "@manut/people-rules";
import type { AuditActor } from "./audit-log";
import { sha256Hex } from "./auth";
import { readBodyBytes, readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import {
  bearer,
  callerOf,
  hasExactly,
  isShopSession,
  openHelperSession,
  openOwnerSession,
  ownerActor,
  peopleCall,
  queryNamesSession,
  readPeople,
  readShop,
  signedInPerson,
  type Caller,
  type PeopleEnv,
  type SignedInPerson,
} from "./people";
import type { OwnerAccount } from "./people-store";
import { operatorIdentity } from "./pilot";
import type { PilotShopRecord } from "./pilot-store";
import { newShopRoute, type SelfServeEnv } from "./self-serve";
import { sessionOpenRefusal } from "./session-limits";
import {
  indexShop,
  keepOwnerCode,
  OWNER_CODE_TTL_MS,
  readIdentityShops,
  redeemOwnerCode,
  unindexShop,
  type ShopRole,
} from "./shops-store";
import { tenantCall, tenantExport, type TenantDataEnv } from "./tenant-data";

const MAX_BODY_BYTES = 16 * 1024;
/// The letters a link code is made of: Crockford's base 32, which leaves out I, L, O and U, so nobody reading a code
/// aloud or typing it mistakes one letter for another. 32 letters, so each random byte's low five bits pick one with
/// no bias.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
/// How many fresh codes to draw when one collides with another person's live code, which 40 random bits make rare.
const CODE_DRAWS = 3;
/// The owner's shops come first in a list, then the ones they help at.
const ROLE_ORDER: Readonly<Record<ShopRole, number>> = { owner: 0, helper: 1 };

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const iso = (ms: number) => new Date(ms).toISOString();

/// The same answer for a shop the person is not in and a shop that does not exist, so no one learns which shops exist.
const notFound = () => json({ error: "not_found" }, 404);

/// `/v1/shops*` (making a shop of one's own is self-serve.ts's) and `/v1/admin/shops/owner*` (after the admin gate), and
/// `/v1/consent/cloud` and `/v1/tenant/export` with a shop session. Answers null for any other path, and for those two
/// with any other credential.
export async function shopsRoute(request: Request, url: URL, env: PeopleEnv & TenantDataEnv & SelfServeEnv,
  ctx: ExecutionContext): Promise<Response | null> {
  switch (url.pathname) {
    case "/v1/shops":
    case "/v1/shops/session":
    case "/v1/shops/owner-code":
      return personRoute(request, url.pathname, env);
    // A shop the person makes themselves (self-serve.ts), off until the owner opens sign-ups.
    case "/v1/shops/new":
      return newShopRoute(request, env);
    case "/v1/shops/session/end":
      return endSessionRoute(request, env);
    case "/v1/consent/cloud":
    case "/v1/tenant/export":
      return shopDataRoute(request, url, env);
    case "/v1/admin/shops/owner":
    case "/v1/admin/shops/owner/unlink":
      return operatorRoute(request, url, env, ctx);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The person's routes
// ---------------------------------------------------------------------------

/// Who is asking comes first, as on every session route: someone with no signed-in session learns nothing about the
/// route, not even its method. A shop session and the operator key are not a signed-in session.
async function personRoute(request: Request, path: string, env: PeopleEnv): Promise<Response> {
  const person = await signedInPerson(bearer(request), env);
  if (!person) return json({ error: "unauthorized" }, 401);
  const method = path === "/v1/shops" ? "GET" : "POST";
  if (request.method !== method) return json({ error: "method_not_allowed" }, 405);
  try {
    if (path === "/v1/shops") return await listShops(env, person);
    if (path === "/v1/shops/session") return await openShop(request, env, person);
    return await ownerCode(request, env, person);
  } catch {
    return json({ error: "shops_unavailable" }, 503);
  }
}

/// The person's role at `tenant` and the shop's record, from the shop's own people record: the owner while their account
/// is the one linked, else a helper while a current helper has the identity they signed in with. Null when they are
/// neither, or the tenant is not a pilot shop. Throws when the shop's records cannot be read, so no answer takes a
/// failed read for having no role.
async function standingAt(env: PeopleEnv, person: SignedInPerson, tenant: string):
  Promise<{ shop: PilotShopRecord; role: ShopRole } | null> {
  const shop = await readShop(env, tenant);
  if (!shop) return null;
  const people = await readPeople(env, tenant);
  if (!people) throw new Error("people_unavailable");
  if (people.ownerAccount?.subject === person.tenant) return { shop, role: "owner" };
  const account: Identity | null = person.email ? { kind: "email", address: person.email } : null;
  if (account && people.state.helpers.some((helper) => sameIdentity(helper.identity, account))) {
    return { shop, role: "helper" };
  }
  return null;
}

/// `GET /v1/shops`: every shop the person is in, the ones they own first and then the ones they help at, each by name,
/// with their role at it. Each shop in their index is read again, and a shop whose record no longer names them is left
/// out. A shop that cannot be read fails the whole answer rather than leaving it out: a shop missing from the list would
/// read as no longer theirs.
async function listShops(env: PeopleEnv, person: SignedInPerson): Promise<Response> {
  const rows = await readIdentityShops(env, person.tenant);
  if (!rows) return json({ error: "shops_unavailable" }, 503);
  const tenants = [...new Set(rows.map((row) => row.shop))].filter(isValidTenant);
  const standings = await Promise.all(tenants.map((tenant) => standingAt(env, person, tenant)));
  const shops = standings.filter((standing) => standing !== null).sort((a, b) =>
    ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || compare(a.shop.name, b.shop.name) || compare(a.shop.tenant, b.shop.tenant));
  return json({ shops: shops.map(({ shop, role }) => ({ id: shop.tenant, name: shop.name, ownerName: shop.ownerName,
    role })) });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/// `POST /v1/shops/session` with exactly `{ shop }`: a shop session for one shop the person is in, as the role the
/// shop's record gives them. The owner's session if their account is the one linked, else a helper's if they are one;
/// a shop they are in neither way answers 404, as a shop that does not exist does. A body with any other field, a role
/// above all, is refused. Every try counts against the person's own limit on opening sessions before the body or the shop
/// is read (session-limits.ts), so the web app's `POST /v1/web/shops`, which opens its sessions here, counts too.
async function openShop(request: Request, env: PeopleEnv, person: SignedInPerson): Promise<Response> {
  const limited = await sessionOpenRefusal(env, person.tenant);
  if (limited) return limited;
  const body = await exactBody(request, ["shop"]);
  if (body instanceof Response) return body;
  if (!isValidTenant(body.shop)) return json({ error: "invalid_request" }, 400);
  const shop = await readShop(env, body.shop);
  if (!shop) return notFound();
  const named = { id: shop.tenant, name: shop.name, ownerName: shop.ownerName };
  const asOwner = await openOwnerSession(env, person, shop.tenant);
  if (asOwner === null) return json({ error: "shops_unavailable" }, 503);
  if (asOwner !== "not_the_owner") return json({ shop: named, role: "owner", ...asOwner });
  const asHelper = await openHelperSession(env, person, shop.tenant);
  if (asHelper === null) return json({ error: "shops_unavailable" }, 503);
  if (asHelper !== "not_a_helper") return json({ shop: named, role: "helper", ...asHelper });
  return notFound();
}

/// `POST /v1/shops/owner-code` with no body, or `{}`: a code the person sends their operator so the operator can link
/// this account to their shop as its owner (docs/several-shops.md). It names the account that asked, works once, for 15
/// minutes, and replaces the person's last code. Only its SHA-256 is kept. A body naming anything, an account above
/// all, is refused: the code is for whoever is signed in.
async function ownerCode(request: Request, env: PeopleEnv, person: SignedInPerson): Promise<Response> {
  const read = await readBodyBytes(request, MAX_BODY_BYTES);
  if (!read.ok) return json({ error: read.error }, read.status);
  if (read.value.byteLength > 0) {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(read.value));
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!isRecord(value) || Object.keys(value).length > 0) return json({ error: "invalid_request" }, 400);
  }
  for (let draw = 0; draw < CODE_DRAWS; draw++) {
    const code = newOwnerCode();
    const expiresAt = Date.now() + OWNER_CODE_TTL_MS;
    const kept = await keepOwnerCode(env, person.tenant, await sha256Hex(code), expiresAt);
    if (kept === "kept") return json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: iso(expiresAt) });
    if (kept === "failed") break;
  }
  return json({ error: "shops_unavailable" }, 503);
}

function newOwnerCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(CODE_LENGTH))].map((byte) => CODE_ALPHABET.charAt(byte & 31)).join("");
}

/// A code as the operator typed it, in the one form it was kept in: capitals, without spaces or dashes, and with the
/// letters people mistake for digits read as those digits, as Crockford's base 32 reads them. Null when it cannot be a
/// code at all.
function typedCode(value: string): string | null {
  const code = value.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE_SHAPE.test(code) ? code : null;
}

/// The body when it holds exactly `keys`, or the refusal: anything else is refused rather than dropped, so a client's
/// claim never even looks as if it were read.
async function exactBody(request: Request, keys: readonly string[]): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, keys)) return json({ error: "invalid_request" }, 400);
  return body;
}

// ---------------------------------------------------------------------------
// A shop session's own routes
// ---------------------------------------------------------------------------

/// `GET` and `PUT /v1/consent/cloud`, and `GET /v1/tenant/export`, with a shop session (docs/several-shops.md, slice 4).
/// These are the lifted routes' own paths, so an app reads its shop's consent and export the same way with whichever
/// session it holds. Only a token shaped as a shop session is answered here; every other credential is left to the lifted
/// routes, which answer it as before (index.ts): the shop's own session and a person's sign-in for their own tenant, the
/// operator key and no credential with 401.
///
/// Both are the owner's. A helper's session is told so (403 `owner_only`), as on the team's routines, rather than that
/// it ended. Withdrawing consent stops the team's work; it never sends anything, and giving it permits only what each
/// approval still asks the owner for. The operator has no route that writes consent, and still has none.
///
/// The export is the answer's body, as the lifted export is: the app reads it with the session in the `Authorization`
/// header and saves the file itself, so no link is made and no token is ever put in a URL. It is not written to the
/// audit log, as neither the lifted export nor the operator's is.
///
/// The order is who is asking (401 or 503), then the role (403), the method (405), and the query and the body (400).
async function shopDataRoute(request: Request, url: URL, env: PeopleEnv & TenantDataEnv): Promise<Response | null> {
  if (!isShopSession(bearer(request))) return null;
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  const consent = url.pathname === "/v1/consent/cloud";
  if (request.method !== "GET" && !(consent && request.method === "PUT")) {
    return json({ error: "method_not_allowed" }, 405);
  }
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  if (!consent) return shopExport(env, caller.shop);
  return request.method === "GET" ? readConsent(env, caller.shop) : recordConsent(request, env, caller);
}

/// The shop's whole export, as the lifted export assembles it (tenant-data.ts): a part it cannot read is named in a 500,
/// and an object it cannot reach at all is 503. Every answer is `no-store`.
async function shopExport(env: TenantDataEnv, shop: string): Promise<Response> {
  try {
    return await tenantExport(env, shop);
  } catch {
    return json({ error: "export_unavailable" }, 503);
  }
}

/// The shop's consent record: `{ cloudWork, updatedAt }`, or `{ cloudWork: false }` before anyone answered.
async function readConsent(env: TenantDataEnv, shop: string): Promise<Response> {
  return consentAnswer(() => tenantCall(env, shop, `/consent?tenant=${encodeURIComponent(shop)}`));
}

/// `PUT` with exactly `{ enabled }`, true or false: the owner gives or withdraws the shop's consent. It is the same
/// record the owner's link and the lifted route write, in one write with its audit entry, which names the owner's linked
/// account (tenant-object.ts).
async function recordConsent(request: Request, env: TenantDataEnv, caller: Extract<Caller, { role: "owner" }>):
  Promise<Response> {
  const body = await exactBody(request, ["enabled"]);
  if (body instanceof Response) return body;
  if (typeof body.enabled !== "boolean") return json({ error: "invalid_request" }, 400);
  return consentAnswer(() => tenantCall(env, caller.shop, "/consent", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenant: caller.shop, cloudWork: body.enabled, actor: ownerActor(caller) }) }));
}

/// The consent record the shop's object answered, or 503 when the object failed or could not be reached.
async function consentAnswer(call: () => Promise<Response>): Promise<Response> {
  try {
    const response = await call();
    if (!response.ok) {
      await response.body?.cancel();
      return json({ error: "consent_unavailable" }, 503);
    }
    return json(await response.json());
  } catch {
    return json({ error: "consent_unavailable" }, 503);
  }
}

/// `POST /v1/shops/session/end` with exactly `{}` and the shop session itself as the bearer: the app ends its own session
/// of one shop when the person signs out of this device. Exactly that session ends, an owner's (`mos1.`) or a helper's
/// (`mhs1.`), in one write to the shop's people record with its audit entry; the person's other devices, their other
/// shops and their own sign-in are untouched, and the same token answers 401 everywhere from then on. It answers
/// `{ ended: { shop, role } }`.
///
/// Who is asking is checked first, with the same check every shop-session route makes (`callerOf`), so a token is ended here
/// exactly while it still works there, and one that does not answers as it does there: 401 `unauthorized`, `removed` or
/// `unlinked`. Then the credential's kind, then the method, then the body.
async function endSessionRoute(request: Request, env: PeopleEnv): Promise<Response> {
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  // The shop's own session and a person's sign-in are the lifted auth's sessions, not shop sessions. They are real
  // credentials, so this is 403 and not 401: an app that sent the wrong one must not read its sign-in as ended. Signing out
  // of one of them is the lifted auth's own route, and nothing here ends it.
  if (caller.role === "owner" && caller.accountId === undefined) return json({ error: "not_a_shop_session" }, 403);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  // The session names the shop, the role and the account. Nothing in the body may, so a body with any field is refused.
  const body = await exactBody(request, []);
  if (body instanceof Response) return body;
  try {
    const response = await peopleCall(env, caller.shop,
      caller.role === "owner" ? "/people/end-owner-session" : "/people/end-helper-session",
      { tokenHash: await sha256Hex(bearer(request)) });
    if (!response.ok) {
      await response.body?.cancel();
      return json({ error: "people_unavailable" }, 503);
    }
    // The record checks the session again where it ends it, so another device sending the same token a moment before
    // wins and this one hears 401: the session is gone either way, which is what was asked.
    const { ok } = (await response.json()) as { ok: boolean };
    return ok ? json({ ended: { shop: caller.shop, role: caller.role } }) : json({ error: "unauthorized" }, 401);
  } catch {
    return json({ error: "people_unavailable" }, 503);
  }
}

// ---------------------------------------------------------------------------
// The operator's routes (the admin gate in index.ts already required Access, the operator key and an exact
// ADMIN_METHODS entry)
// ---------------------------------------------------------------------------

/// `POST /v1/admin/shops/owner` with exactly `{ tenant, code }`, and `POST /v1/admin/shops/owner/unlink` with exactly
/// `{ tenant }`. Each names an existing pilot shop, checked before a code is used, so a code is never spent on a shop
/// that is not there.
async function operatorRoute(request: Request, url: URL, env: PeopleEnv, ctx: ExecutionContext): Promise<Response> {
  const linking = url.pathname === "/v1/admin/shops/owner";
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  if (!hasExactly(body, linking ? ["tenant", "code"] : ["tenant"])) return json({ error: "invalid_request" }, 400);
  if (linking && typeof body.code !== "string") return json({ error: "invalid_request" }, 400);
  try {
    const shop = await readShop(env, body.tenant);
    if (!shop) return json({ error: "shop_not_found" }, 404);
    // Who the shop's audit log names for the change: the operator's Access identity (audit-log.ts).
    const actor: AuditActor = { kind: "operator", email: await operatorIdentity(ctx) };
    return linking ? await linkOwner(env, shop.tenant, body.code as string, actor)
      : await unlinkOwner(env, shop.tenant, actor);
  } catch {
    return json({ error: "shops_unavailable" }, 503);
  }
}

/// Links the account the code names to the shop as its owner: the code is used up first, so one code makes one link,
/// then the shop's record links the account with its audit entry in one write, then the account's index gets the shop.
/// The link stands in the shop's record even if that last write fails; the answer says so, and linking the same account
/// again with a new code writes the row.
async function linkOwner(env: PeopleEnv, tenant: string, typed: string, actor: AuditActor): Promise<Response> {
  const code = typedCode(typed);
  if (!code) return json({ error: "unknown_code" }, 404);
  const redeemed = await redeemOwnerCode(env, await sha256Hex(code));
  if (!redeemed) return json({ error: "shops_unavailable" }, 503);
  if ("error" in redeemed) return json({ error: redeemed.error }, redeemed.status);
  const response = await peopleCall(env, tenant, "/people/link-owner", { accountId: `owner-${crypto.randomUUID()}`,
    subject: redeemed.subject, actor });
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 409 ? json({ error: "already_linked" }, 409) : json({ error: "shops_unavailable" }, 503);
  }
  const { ownerAccount } = (await response.json()) as { ownerAccount: OwnerAccount };
  if (!(await indexShop(env, ownerAccount.subject, { shop: tenant, role: "owner", ref: ownerAccount.id }))) {
    return json({ error: "index_unavailable" }, 503);
  }
  return json({ tenant, ownerAccount: { id: ownerAccount.id, linkedAt: iso(ownerAccount.linkedAt) } });
}

/// Unlinks the shop's owner account. The shop's record ends every one of its sessions in the same write, then the
/// account's index loses the shop; a row left behind if that fails lists nothing, since every list reads the shop's
/// record again.
async function unlinkOwner(env: PeopleEnv, tenant: string, actor: AuditActor): Promise<Response> {
  const response = await peopleCall(env, tenant, "/people/unlink-owner", { actor });
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 404 ? json({ error: "not_linked" }, 404) : json({ error: "shops_unavailable" }, 503);
  }
  const done = (await response.json()) as { unlinked: string; subject: string; sessionsEnded: number };
  await unindexShop(env, done.subject, { shop: tenant, role: "owner", ref: done.unlinked });
  return json({ tenant, unlinked: done.unlinked, sessionsEnded: done.sessionsEnded });
}
