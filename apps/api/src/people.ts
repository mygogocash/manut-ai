/// The people around a shop, from the Worker's side (docs/people.md; docs/pilot-api.md, "Helpers"). The rules are
/// `@manut/people-rules`'; the shop's record, its one transaction per change and its audit entry are people-store.ts's,
/// in the shop's TenantObject. This file has four parts:
///
/// - The operator routes, under the admin gate as exact `ADMIN_METHODS` entries: the operator invites, removes and sets
///   cover on the owner's word, whether or not the owner has an account linked (an owner without one, or one who lost
///   their phone, still asks the operator).
/// - The owner's own routes for the same changes, from their shop session (docs/several-shops.md, slice 4). Both kinds
///   of route make each change through the same operation of the shop's record, so there is one way to make it. One more
///   is theirs alone: the sign-ins helpers made lately (`GET /v1/people/devices`), which the owner's app reads to tell
///   them once of a new device (docs/people.md, "A helper's new device").
/// - A helper's own two routes, which need a signed-in session of the lifted auth: joining through an invite, and opening
///   the shop on another device. Each gives that device a helper session for the one shop.
/// - `callerOf`, who is calling a shop's session routes (approvals.ts, routines.ts, memory.ts, shops.ts and the owner's
///   routes here): the shop's own session is its owner, a helper session is a helper of the shop it names, and an owner
///   session is the owner of the shop it names. The role is never read from a request.
///
/// A helper session is a bearer token, `mhs1.<shop, base64url>.<64 hex characters>`. The shop's record keeps only its
/// SHA-256. The lifted AuthObject has no record of it, so every lifted session route answers 401 to it: a helper can
/// never act as the shop. An owner session (docs/several-shops.md) is the same shape under `mos1.`, given to the account
/// the operator linked to the shop as its owner, and kept the same way under that account. Nothing here sends anything:
/// an invite is a link the operator copies (LINE and email are parked).

import { coverAt, type Identity, type Invite, type PeopleState } from "@manut/people-rules";
import { mintInviteToken, openInviteToken } from "./approval-link";
import type { AuditActor } from "./audit-log";
import { sha256Hex } from "./auth";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { operatorIdentity } from "./pilot";
import { keptIdentity, keptName, type OwnerSessionCheck, type PeopleView, type SessionCheck } from "./people-store";
import type { PilotShopRecord } from "./pilot-store";
import { sessionOpenRefusal, type SessionLimitEnv } from "./session-limits";
import { indexShop } from "./shops-store";
import { authCall, tenantCall, type TenantDataEnv } from "./tenant-data";

export type PeopleEnv = Pick<TenantDataEnv, "AUTH" | "TENANT"> & SessionLimitEnv & {
  /// Where the web app lives: an invite's link is `${WEB_ORIGIN}/join/{token}`.
  WEB_ORIGIN?: string;
  /// Signs invite links, as it signs the owner's links (approval-link.ts).
  APPROVAL_LINK_SECRET?: string;
  /// The operator key, which is never a session.
  CLOUD_API_KEY?: string;
};

const MAX_BODY_BYTES = 16 * 1024;
/// How long a helper session lasts, and an owner session as well. There is no refresh: the person opens the shop again
/// with their signed-in session, which the lifted auth keeps alive for up to 90 days. Removal, or unlinking the owner's
/// account, ends a session at once, whatever is left of it.
export const HELPER_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const HELPER_TOKEN = /^mhs1\.([A-Za-z0-9_-]{1,512})\.([0-9a-f]{64})$/;
/// An owner session: the same shape under its own prefix, so the token says which of the shop's records holds it.
const OWNER_TOKEN = /^mos1\.([A-Za-z0-9_-]{1,512})\.([0-9a-f]{64})$/;
/// What the shop's object answers to a change it understood: the change, or a refusal of the rules'. Anything else is
/// the object failing, and is not passed on as if it were an answer.
const ANSWERED = new Set([200, 400, 403, 404, 409]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// Whether `value` holds exactly the keys a route reads. Anything else, a `role` above all, is refused rather than
/// dropped, so a client's claim never even looks as if it were read.
export function hasExactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

const iso = (ms: number) => new Date(ms).toISOString();

export function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/// Constant-time comparison, as index.ts compares the operator key. Email sign-in compares a code's HMAC with it too
/// (auth-object.ts).
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function base64url(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/// The text a base64url segment spells, or null unless the segment is that text's one canonical spelling.
function fromBase64url(segment: string): string | null {
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return base64url(text) === segment ? text : null;
  } catch {
    return null;
  }
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function usableSecret(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= 32;
}

// ---------------------------------------------------------------------------
// Who is calling
// ---------------------------------------------------------------------------

/// A person signed in with the lifted auth: their tenant, which is the verified provider subject (or, signed in by email,
/// `email:` and the address's hash), and the email the sign-in verified when the session has one.
export type SignedInPerson = { tenant: string; email?: string };

/// Who is signed in with the lifted auth: the tenant, and the email the sign-in verified when the session has one: the
/// one Apple verified, or the address a sign-in code went to (auth-object.ts, email-code.ts). Null for no session, an
/// ended one, a shop session and the operator key, which is never a session.
export async function signedInPerson(token: string, env: PeopleEnv): Promise<SignedInPerson | null> {
  if (!token || (env.CLOUD_API_KEY && timingSafeEqual(token, env.CLOUD_API_KEY))) return null;
  const response = await authCall(env, "/verify", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }) });
  if (!response.ok) return null;
  const result = (await response.json().catch(() => null)) as { ok?: unknown; tenant?: unknown; email?: unknown } | null;
  if (result?.ok !== true || typeof result.tenant !== "string" || !result.tenant) return null;
  return { tenant: result.tenant, ...(typeof result.email === "string" ? { email: result.email } : {}) };
}

/// The identity a signed-in person can show an invite: the email their sign-in verified, or none. A helper is known in
/// the shop by that address, so either sign-in that verified it opens their helper sessions. Nothing signs in as a LINE
/// account yet (docs/people.md, "What needs the owner").
function accountOf(person: { email?: string }): Identity | null {
  return person.email ? { kind: "email", address: person.email } : null;
}

/// A new shop session token for `shop`: a helper's under `mhs1`, an owner's under `mos1`.
function mintToken(prefix: "mhs1" | "mos1", shop: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}.${base64url(shop)}.${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/// The shop a shop session token of `pattern`'s kind names, or null when the token is not one. Naming a shop proves
/// nothing: only that shop's record holding the token's hash does.
function tokenShop(pattern: RegExp, token: string): string | null {
  const match = pattern.exec(token);
  const shop = match?.[1] ? fromBase64url(match[1]) : null;
  return shop !== null && isValidTenant(shop) ? shop : null;
}

/// Who is calling a shop's session routes: its approvals, and for its owner its routines, memory, consent, export and
/// people. The role comes from the credential alone:
/// - an owner session is the `owner` of the shop it names, while that shop's record holds it under the account linked
///   now, unended and unexpired (docs/several-shops.md); the decision names that account (`accountId`);
/// - a helper session is a `helper` of the shop it names, while that shop's record holds it, unended and unexpired;
/// - any other bearer is the lifted auth's session, whose tenant is the shop and its `owner` (the shop's own session).
export type Caller =
  | { role: "owner"; shop: string; accountId?: string }
  | { role: "helper"; shop: string; helperId: string; name: string };

/// Who a decision or a change names when the shop's own session makes it, as `owner-link` names the owner's link
/// (pilot.ts). An owner session names the account linked to the shop instead (docs/several-shops.md).
export const OWNER_SESSION = "owner-session";

/// Who the shop's audit log names for a change its owner makes from a session: the linked account by its id for an
/// owner session, and `owner-session` for the shop's own session, as their decisions name them (approvals.ts). Never
/// the account's subject, an email or a name.
export function ownerActor(caller: Extract<Caller, { role: "owner" }>): AuditActor {
  return { kind: "owner", id: caller.accountId ?? OWNER_SESSION };
}

/// Whether a bearer token has the shape of a shop session, an owner's (`mos1.`) or a helper's (`mhs1.`). The shape only
/// says which check to make: a session works only while its shop's record holds its hash (`callerOf`).
export function isShopSession(token: string): boolean {
  return tokenShop(OWNER_TOKEN, token) !== null || tokenShop(HELPER_TOKEN, token) !== null;
}

/// What only the session decides. A request that names any of these in its query is refused rather than read, so a
/// client's claim never even looks as if it were read.
export const SESSION_DECIDES = ["shop", "tenant", "role"] as const;

export function queryNamesSession(url: URL): boolean {
  return SESSION_DECIDES.some((name) => url.searchParams.has(name));
}

/// The caller, or the refusal to send: 401 `unauthorized` for no session, 401 `removed` with the time for a session
/// whose helper the owner removed, and 401 `unlinked` with the time for an owner session whose account the operator
/// unlinked, so the app can say which.
export async function callerOf(request: Request, env: PeopleEnv): Promise<Caller | Response> {
  const token = bearer(request);
  const owned = tokenShop(OWNER_TOKEN, token);
  if (owned !== null) return ownerCallerOf(env, owned, token);
  const shop = tokenShop(HELPER_TOKEN, token);
  if (shop !== null) {
    const checked = await peopleCall(env, shop, "/people/session-check", { tokenHash: await sha256Hex(token) })
      .catch(() => null);
    if (!checked?.ok) return json({ error: "people_unavailable" }, 503);
    const session = (await checked.json()) as SessionCheck;
    if (session.ok) return { role: "helper", shop, helperId: session.helperId, name: session.name };
    if (session.error === "removed") return json({ error: "removed", removedAt: iso(session.removedAt) }, 401);
    return json({ error: "unauthorized" }, 401);
  }
  const person = await signedInPerson(token, env);
  return person ? { role: "owner", shop: person.tenant } : json({ error: "unauthorized" }, 401);
}

/// The owner of `shop`, for an owner session the shop's record holds under its linked account, or the refusal to send.
async function ownerCallerOf(env: PeopleEnv, shop: string, token: string): Promise<Caller | Response> {
  const checked = await peopleCall(env, shop, "/people/owner-session-check", { tokenHash: await sha256Hex(token) })
    .catch(() => null);
  if (!checked?.ok) return json({ error: "people_unavailable" }, 503);
  const session = (await checked.json()) as OwnerSessionCheck;
  if (session.ok) return { role: "owner", shop, accountId: session.accountId };
  if (session.error === "unlinked") return json({ error: "unlinked", unlinkedAt: iso(session.unlinkedAt) }, 401);
  return json({ error: "unauthorized" }, 401);
}

// ---------------------------------------------------------------------------
// The shop's record
// ---------------------------------------------------------------------------

/// A change to the shop's people record, with the Worker's `x-people` header (people-store.ts).
export function peopleCall(env: Pick<TenantDataEnv, "TENANT">, tenant: string, path: string, body: Record<string, unknown>) {
  return tenantCall(env, tenant, path, { method: "POST", headers: { "content-type": "application/json", "x-people": "1" },
    body: JSON.stringify({ tenant, ...body }) });
}

/// The shop's people, or null when its object cannot be read.
export async function readPeople(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<PeopleView | null> {
  try {
    const response = await tenantCall(env, tenant, `/people?tenant=${encodeURIComponent(tenant)}`);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return (await response.json()) as PeopleView;
  } catch {
    return null;
  }
}

/// The pilot shop, or null when the tenant is not one. Throws when the shop's object cannot be read, so no route takes
/// a failed read for a missing shop.
export async function readShop(env: Pick<TenantDataEnv, "TENANT">, tenant: string): Promise<PilotShopRecord | null> {
  const response = await tenantCall(env, tenant, `/pilot/shop?tenant=${encodeURIComponent(tenant)}`);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new Error(`shop_read_${response.status}`);
  return ((await response.json()) as { shop: PilotShopRecord }).shop;
}

// ---------------------------------------------------------------------------
// What the console reads
// ---------------------------------------------------------------------------

type InviteView = { id: string; name: string; identity: Identity; status: "pending" | "used" | "revoked" | "expired";
  createdAt: string; expiresAt: string; inviteUrl?: string };

function inviteView(invite: Invite, name: string, nowMs: number): InviteView {
  return {
    id: invite.id,
    name,
    identity: invite.identity,
    // An invite past its 7 days is never used, so it reads as expired whatever the record still says.
    status: invite.status === "pending" && nowMs >= invite.expiresAt ? "expired" : invite.status,
    createdAt: iso(invite.createdAt),
    expiresAt: iso(invite.expiresAt),
  };
}

/// The invite's link, minted again at the same expiry, or null when links cannot be made in this environment.
async function inviteUrl(env: PeopleEnv, tenant: string, invite: Invite): Promise<string | null> {
  const webOrigin = originOf(env.WEB_ORIGIN);
  if (!webOrigin || !usableSecret(env.APPROVAL_LINK_SECRET)) return null;
  const token = await mintInviteToken(env.APPROVAL_LINK_SECRET, { tenant, inviteId: invite.id,
    expiresAtMs: invite.expiresAt });
  return `${webOrigin}/join/${token}`;
}

function awayView(state: PeopleState, names: Record<string, string>, nowMs: number) {
  if (!state.away) return null;
  return { helperId: state.away.helperId, name: names[state.away.helperId] ?? "", until: iso(state.away.until),
    inForce: coverAt(state, nowMs) !== null };
}

/// `GET /v1/admin/people` for the operator and `GET /v1/people` for the owner's session: the owner, with the account the
/// operator linked and how many devices have it open, every helper with how many devices they have open, every invite (a
/// pending one with its link to copy), the cover, the notes helpers passed on, and the helpers who were removed, by
/// name, so what they did can still be read with their name. The owner's account is shown by its link's id, never by
/// the subject it signs in as.
async function peopleList(env: PeopleEnv, shop: PilotShopRecord, view: PeopleView) {
  const { state, names, devices, ownerAccount } = view;
  const nowMs = Date.now();
  const invites = await Promise.all(state.invites.map(async (invite) => {
    const shown = inviteView(invite, names[invite.id] ?? "", nowMs);
    const url = shown.status === "pending" ? await inviteUrl(env, shop.tenant, invite) : null;
    return url ? { ...shown, inviteUrl: url } : shown;
  }));
  return {
    tenant: shop.tenant,
    owner: { name: shop.ownerName, account: ownerAccount ? { id: ownerAccount.id, linkedAt: iso(ownerAccount.linkedAt),
      devices: view.ownerDevices } : null },
    helpers: state.helpers.map((helper) => ({ id: helper.id, name: names[helper.id] ?? "", identity: helper.identity,
      joinedAt: iso(helper.joinedAt), devices: devices[helper.id] ?? 0 })),
    invites,
    away: awayView(state, names, nowMs),
    passedOn: state.passedOn.map((passed) => ({ requestId: passed.requestId, kind: passed.kind, by: passed.by,
      name: names[passed.by] ?? "", note: passed.note, at: iso(passed.at) })),
    removed: state.removed.map((id) => ({ id, name: names[id] ?? "" })),
  };
}

/// `GET /v1/people/devices` for the owner's session: each sign-in a helper made lately, newest first, so the owner's app
/// can tell them once of a new device (docs/people.md, "A helper's new device"). Only the helper's id and the name the
/// owner gave them, when the session was opened, and the session's own id, which the app keeps to know it has already said
/// so. That id is no credential: a session is its token, which only its device holds, and the shop's record keeps only the
/// token's hash. Never a token, a hash, an email, a LINE id or the account a helper signed in with.
function deviceList(_env: PeopleEnv, _shop: PilotShopRecord, view: PeopleView) {
  return { devices: view.signIns.map((signIn) => ({ id: signIn.sessionId, helperId: signIn.helperId,
    name: view.names[signIn.helperId] ?? "", openedAt: iso(signIn.at) })) };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/// `/v1/admin/people*` (after the admin gate), the owner's own `/v1/people`, its devices and its changes, and a helper's
/// own `/v1/people/accept` and `/v1/people/session`. Answers null for any other path.
export async function peopleRoute(request: Request, url: URL, env: PeopleEnv, ctx: ExecutionContext):
  Promise<Response | null> {
  if (url.pathname === "/v1/admin/people" || url.pathname.startsWith("/v1/admin/people/")) {
    return operatorRoute(request, url, env, ctx);
  }
  if (url.pathname === "/v1/people/accept" || url.pathname === "/v1/people/session") {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    return url.pathname === "/v1/people/accept" ? acceptInvite(request, env) : openSession(request, env);
  }
  if (url.pathname === "/v1/people") return ownerRoute(request, url, env, null);
  if (url.pathname === "/v1/people/devices") return ownerRoute(request, url, env, null, deviceList);
  const change = url.pathname.startsWith("/v1/people/") ? changeAt(url.pathname.slice("/v1/people/".length)) : null;
  return change ? ownerRoute(request, url, env, change) : null;
}

type Write = (env: PeopleEnv, shop: PilotShopRecord, body: Record<string, unknown>, actor: AuditActor) =>
  Promise<Response>;

/// One change to the shop's people: `keys` is the exact body the owner's session sends for it (the operator's also names
/// the shop's `tenant`), `exact` checks what must be exact inside it, and `write` makes the change through its one
/// operation of the shop's record (people-store.ts), whoever asks, so there is one way to make each change.
type Change = { keys: readonly string[]; exact?: (body: Record<string, unknown>) => boolean; write: Write };

/// The changes, by the last part of their path: `/v1/admin/people/<path>` for the operator, on the owner's word, and
/// `/v1/people/<path>` for the owner's own session.
const CHANGES: Readonly<Record<string, Change>> = {
  invites: { keys: ["name", "identity"], exact: (body) => isExactIdentity(body.identity), write: createInvite },
  "invites/revoke": { keys: ["inviteId"], write: async (env, shop, body, actor) => {
    if (typeof body.inviteId !== "string") return json({ error: "invalid_request" }, 400);
    const response = await peopleCall(env, shop.tenant, "/people/revoke-invite", { inviteId: body.inviteId, actor });
    const answer = await answered(response);
    if (response.status !== 200) return answer;
    const { invite } = (await answer.json()) as { invite: Invite };
    const people = await readPeople(env, shop.tenant);
    return json({ invite: inviteView(invite, people?.names[invite.id] ?? "", Date.now()) });
  } },
  remove: { keys: ["helperId"], write: async (env, shop, body, actor) => {
    if (typeof body.helperId !== "string") return json({ error: "invalid_request" }, 400);
    return answered(await peopleCall(env, shop.tenant, "/people/remove", { helperId: body.helperId, actor }));
  } },
  away: { keys: ["helperId", "until"], write: async (env, shop, body, actor) => {
    if (typeof body.helperId !== "string") return json({ error: "invalid_request" }, 400);
    // A date the rules can compare, or `bad_date`, as the rules answer a date that is not in the future.
    const until = typeof body.until === "string" ? Date.parse(body.until) : Number.NaN;
    if (!Number.isFinite(until)) return json({ error: "bad_date" }, 400);
    const response = await peopleCall(env, shop.tenant, "/people/away", { helperId: body.helperId, until, actor });
    if (response.status !== 200) return answered(response);
    await response.body?.cancel();
    const people = await readPeople(env, shop.tenant);
    if (!people) return json({ error: "people_unavailable" }, 503);
    return json({ away: awayView(people.state, people.names, Date.now()) });
  } },
  "away/clear": { keys: [], write: async (env, shop, _body, actor) =>
    answered(await peopleCall(env, shop.tenant, "/people/away-clear", { actor })) },
};

/// The change at `path`, or null. Only a path the table names as its own: never a name every object inherits.
function changeAt(path: string): Change | null {
  return Object.hasOwn(CHANGES, path) ? CHANGES[path] ?? null : null;
}

/// Whether an invite's identity is exactly a LINE account (`{ kind, id }`) or an email (`{ kind, address }`). The shop's
/// record keeps only those fields anyway (`keptIdentity`); a session's invite refuses anything more rather than drop it.
function isExactIdentity(value: unknown): boolean {
  return isRecord(value) && ((value.kind === "line" && hasExactly(value, ["kind", "id"])) ||
    (value.kind === "email" && hasExactly(value, ["kind", "address"])));
}

/// What the shop's object answered, passed on when it is an answer, or 503 when the object failed.
async function answered(response: Response): Promise<Response> {
  if (!ANSWERED.has(response.status)) {
    await response.body?.cancel();
    return json({ error: "people_unavailable" }, 503);
  }
  return json(await response.json(), response.status);
}

async function operatorRoute(request: Request, url: URL, env: PeopleEnv, ctx: ExecutionContext): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "GET /v1/admin/people") {
      const tenant = url.searchParams.get("tenant") ?? "";
      if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
      const shop = await readShop(env, tenant);
      if (!shop) return json({ error: "shop_not_found" }, 404);
      const view = await readPeople(env, tenant);
      return view ? json(await peopleList(env, shop, view)) : json({ error: "people_unavailable" }, 503);
    }
    const change = request.method === "POST" && url.pathname.startsWith("/v1/admin/people/")
      ? changeAt(url.pathname.slice("/v1/admin/people/".length)) : null;
    if (!change) return json({ error: "not_found" }, 404);
    const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
    if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
    const shop = await readShop(env, body.tenant);
    if (!shop) return json({ error: "shop_not_found" }, 404);
    // Who the shop's audit log names for the change: the operator's Access identity (audit-log.ts).
    return await change.write(env, shop, body, { kind: "operator", email: await operatorIdentity(ctx) });
  } catch {
    return json({ error: "people_unavailable" }, 503);
  }
}

/// What an owner's session reads of the shop's people: the whole list (`peopleList`), or only the sign-ins helpers made
/// (`deviceList`). Both are read from the one view of the shop's record, behind the same checks.
type Read = (env: PeopleEnv, shop: PilotShopRecord, view: PeopleView) => unknown;

/// `GET /v1/people` and `POST /v1/people/<change>` (`change` null for a read): the owner managing the shop's helpers
/// from their own session (docs/several-shops.md, slice 4). The shop and the role come from the session alone
/// (`callerOf`), so the body names neither, and a session of another shop never reaches this one's people. A helper's
/// session is told the route is the owner's rather than that it ended, as on the team's routines. The log names the
/// owner's linked account by its id (`ownerActor`). Nothing here sends anything: an invite's link is the owner's to send.
///
/// The order is who is asking (401 or 503), then the role (403), the method (405), the query and the body (400), and only
/// then the shop's record.
async function ownerRoute(request: Request, url: URL, env: PeopleEnv, change: Change | null, read: Read = peopleList):
  Promise<Response> {
  const caller = await callerOf(request, env);
  if (caller instanceof Response) return caller;
  if (caller.role !== "owner") return json({ error: "owner_only" }, 403);
  if (request.method !== (change ? "POST" : "GET")) return json({ error: "method_not_allowed" }, 405);
  if (queryNamesSession(url)) return json({ error: "invalid_request" }, 400);
  try {
    if (!change) {
      const shop = await readShop(env, caller.shop);
      // People exist for pilot shops: a person's own sign-in acts for their own tenant, which has none.
      if (!shop) return json({ error: "not_found" }, 404);
      const view = await readPeople(env, shop.tenant);
      return view ? json(await read(env, shop, view)) : json({ error: "people_unavailable" }, 503);
    }
    const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
    if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
    const body = parsed.value;
    if (!isRecord(body) || !hasExactly(body, change.keys) || (change.exact && !change.exact(body))) {
      return json({ error: "invalid_request" }, 400);
    }
    const shop = await readShop(env, caller.shop);
    if (!shop) return json({ error: "not_found" }, 404);
    return await change.write(env, shop, body, ownerActor(caller));
  } catch {
    return json({ error: "people_unavailable" }, 503);
  }
}

/// `POST /v1/admin/people/invites` with `{ tenant, name, identity }`, or the owner's `POST /v1/people/invites` with
/// `{ name, identity }`: an invite for one LINE account (`{ kind: "line", id }`) or one email (`{ kind: "email",
/// address }`), for 7 days, once, and its link for whoever asked to copy and send. Nothing is sent.
async function createInvite(env: PeopleEnv, shop: PilotShopRecord, body: Record<string, unknown>, actor: AuditActor):
  Promise<Response> {
  const name = keptName(body.name);
  const identity = keptIdentity(body.identity);
  if (!name || !identity) return json({ error: "invalid_request" }, 400);
  const webOrigin = originOf(env.WEB_ORIGIN);
  if (!webOrigin) return json({ error: "not_configured", setting: "WEB_ORIGIN" }, 503);
  if (!usableSecret(env.APPROVAL_LINK_SECRET)) return json({ error: "not_configured", setting: "APPROVAL_LINK_SECRET" }, 503);
  const response = await peopleCall(env, shop.tenant, "/people/invite", { inviteId: `inv-${crypto.randomUUID()}`,
    identity, name, actor });
  if (response.status !== 200) return answered(response);
  const { invite } = (await response.json()) as { invite: Invite };
  return json({ invite: inviteView(invite, name, Date.now()), inviteUrl: await inviteUrl(env, shop.tenant, invite) });
}

/// A shop session for `shop`, a helper's unless `prefix` says an owner's: the token for the device, its hash for the
/// shop's record, and its end.
async function newSession(shop: string, prefix: "mhs1" | "mos1" = "mhs1") {
  const accessToken = mintToken(prefix, shop);
  return { accessToken, tokenHash: await sha256Hex(accessToken),
    sessionId: `${prefix === "mos1" ? "os" : "hs"}-${crypto.randomUUID()}`, expiresAt: Date.now() + HELPER_SESSION_TTL_MS };
}

/// A new owner session for `shop`, minted as `openOwnerSession` mints one, for a shop whose owner makes it and so holds its
/// first session from the write that makes it (self-serve.ts).
export function newOwnerSession(shop: string) {
  return newSession(shop, "mos1");
}

/// The session a device is given, as it is sent: the token once, and its end.
export const sessionOf = (session: { accessToken: string; expiresAt: number }) =>
  ({ accessToken: session.accessToken, expiresAt: iso(session.expiresAt) });

/// The person's signed-in session and the one field a helper's route reads, or the refusal to send.
async function personAndField(request: Request, env: PeopleEnv, field: string):
  Promise<{ person: { tenant: string; email?: string }; value: string } | Response> {
  const person = await signedInPerson(bearer(request), env);
  if (!person) return json({ error: "unauthorized" }, 401);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body) || !hasExactly(body, [field]) || typeof body[field] !== "string") {
    return json({ error: "invalid_request" }, 400);
  }
  return { person, value: body[field] };
}

const ANSWER_STATUS: Readonly<Record<string, number>> = { expired: 410, revoked: 410, already_used: 409, unknown: 404 };

/// `POST /v1/people/accept` with `{ token }` and a signed-in session: someone opens an invite. Only the account the invite
/// names joins (`@manut/people-rules`' `acceptInvite`), and joining gives this device a helper session.
async function acceptInvite(request: Request, env: PeopleEnv): Promise<Response> {
  const asked = await personAndField(request, env, "token");
  if (asked instanceof Response) return asked;
  try {
    const claim = await openInviteToken(env.APPROVAL_LINK_SECRET, asked.value);
    if (!claim) return json({ answer: "unknown" }, 404);
    // The shop is read before anything changes, so a helper who joins always hears it: a read failing after the join
    // would leave the invite used and the device with no session.
    const shop = await readShop(env, claim.tenant);
    if (!shop) return json({ answer: "unknown" }, 404);
    const session = await newSession(shop.tenant);
    const response = await peopleCall(env, shop.tenant, "/people/accept", { inviteId: claim.inviteId,
      account: accountOf(asked.person), helperId: `helper-${crypto.randomUUID()}`, sessionId: session.sessionId,
      tokenHash: session.tokenHash, expiresAt: session.expiresAt });
    if (!response.ok) {
      await response.body?.cancel();
      return json({ error: "people_unavailable" }, 503);
    }
    const answer = (await response.json()) as { answer: string; helperId?: string; name?: string; invitedOn?: string };
    if (answer.answer === "joined") {
      // The shop goes into the person's index, so their other devices find it (docs/several-shops.md). Best effort: the
      // join stands either way, and opening the shop again writes the row.
      if (answer.helperId) await indexShop(env, asked.person.tenant, { shop: shop.tenant, role: "helper", ref: answer.helperId });
      return json({ answer: "joined", shop: { id: shop.tenant, name: shop.name, ownerName: shop.ownerName },
        helper: { id: answer.helperId, name: answer.name }, session: sessionOf(session) });
    }
    if (answer.answer === "wrong_account") {
      return json({ answer: "wrong_account", shop: { name: shop.name, ownerName: shop.ownerName },
        invitedOn: answer.invitedOn }, 403);
    }
    return json({ answer: answer.answer }, ANSWER_STATUS[answer.answer] ?? 404);
  } catch {
    return json({ error: "people_unavailable" }, 503);
  }
}

/// `POST /v1/people/session` with `{ shop }` and a signed-in session: a helper opens the shop on another device, as the
/// identity they joined with. Anyone else, for any shop or none, hears only `not_a_helper`. Every try counts against the
/// person's own limit on opening sessions before the shop is read (session-limits.ts).
async function openSession(request: Request, env: PeopleEnv): Promise<Response> {
  const asked = await personAndField(request, env, "shop");
  if (asked instanceof Response) return asked;
  const limited = await sessionOpenRefusal(env, asked.person.tenant);
  if (limited) return limited;
  if (!isValidTenant(asked.value)) return json({ error: "invalid_request" }, 400);
  try {
    const shop = await readShop(env, asked.value);
    if (!shop) return json({ error: "not_a_helper" }, 403);
    const opened = await openHelperSession(env, asked.person, shop.tenant);
    if (opened === "not_a_helper") return json({ error: "not_a_helper" }, 403);
    if (!opened) return json({ error: "people_unavailable" }, 503);
    return json({ shop: { id: shop.tenant, name: shop.name, ownerName: shop.ownerName }, ...opened });
  } catch {
    return json({ error: "people_unavailable" }, 503);
  }
}

type DeviceSession = { accessToken: string; expiresAt: string };

/// A helper session of `shop` for `person`, as the identity they joined with: the helper and the session to send the
/// device, `not_a_helper` for anyone else, or null when the shop's record cannot be reached. The shop goes into the
/// person's index too, so their other devices find it (docs/several-shops.md).
export async function openHelperSession(env: PeopleEnv, person: SignedInPerson, shop: string):
  Promise<{ helper: { id: string; name: string }; session: DeviceSession } | "not_a_helper" | null> {
  const session = await newSession(shop);
  const response = await peopleCall(env, shop, "/people/open-session", { account: accountOf(person),
    sessionId: session.sessionId, tokenHash: session.tokenHash, expiresAt: session.expiresAt });
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 403 ? "not_a_helper" : null;
  }
  const helper = (await response.json()) as { helperId: string; name: string };
  await indexShop(env, person.tenant, { shop, role: "helper", ref: helper.helperId });
  return { helper: { id: helper.helperId, name: helper.name }, session: sessionOf(session) };
}

/// An owner session of `shop` for `person`, while their account is the one the operator linked to the shop
/// (docs/several-shops.md): the account and the session to send the device, `not_the_owner` for anyone else, or null
/// when the shop's record cannot be reached. The shop goes into the person's index again, which mends a row a failed
/// write left out, unless `options.index` is false: a shop its owner is still making goes into their index only in the
/// write that lists it (self-serve.ts), so the console's list and theirs never disagree about it.
export async function openOwnerSession(env: PeopleEnv, person: SignedInPerson, shop: string,
  options: { index?: boolean } = {}):
  Promise<{ account: { id: string }; session: DeviceSession } | "not_the_owner" | null> {
  const session = await newSession(shop, "mos1");
  const response = await peopleCall(env, shop, "/people/open-owner-session", { subject: person.tenant,
    sessionId: session.sessionId, tokenHash: session.tokenHash, expiresAt: session.expiresAt });
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 403 ? "not_the_owner" : null;
  }
  const { accountId } = (await response.json()) as { accountId: string };
  if (options.index !== false) await indexShop(env, person.tenant, { shop, role: "owner", ref: accountId });
  return { account: { id: accountId }, session: sessionOf(session) };
}

/// A helper passes a request on to the owner with a note (`@manut/people-rules`' `passOn`), from the facts of the request
/// as its own task holds them. Answers the note as kept, or the rules' refusal; times are ISO strings.
export async function passOnToOwner(
  env: Pick<TenantDataEnv, "TENANT">,
  caller: Extract<Caller, { role: "helper" }>,
  request: { id: string; kind: string; decided: { by: string; at: number } | null },
  taskId: string,
  note: string,
): Promise<Response> {
  const response = await peopleCall(env, caller.shop, "/people/pass-on", { helperId: caller.helperId, request, taskId,
    note });
  if (!ANSWERED.has(response.status)) {
    await response.body?.cancel();
    return json({ error: "people_unavailable" }, 503);
  }
  const answer = (await response.json()) as Record<string, unknown>;
  if (typeof answer.at === "number") answer.at = iso(answer.at);
  if (isRecord(answer.passedOn) && typeof answer.passedOn.at === "number") {
    answer.passedOn = { ...answer.passedOn, at: iso(answer.passedOn.at) };
  }
  return json(answer, response.status);
}
