/// The shop's site sign-ins, kept in its vault object (`CredObject`, `t:${tenant}`) beside its connections
/// (docs/browser-control.md). This is the object's side; the routes are browser-control.ts's.
///
/// A sign-in's password is sealed with the vault's own keys (cred-crypto.ts). No answer from here holds it: each
/// answers the public view, which says only that a password is set.
///
/// Paths, each with the Worker's `x-tenant` (a record of another tenant reads as not found), and writes also with
/// `x-vault`, the same defence in depth as `x-pilot` and `x-audit`:
///
/// - `GET /sign-ins`: the live sign-ins, oldest first.
/// - `POST /sign-ins` `{ site, origins, username, password, members }`: a new sign-in.
/// - `POST /sign-ins/password` `{ signInId, password }`: a new password, which also mends a broken sign-in.
/// - `POST /sign-ins/remove` `{ signInId }`: removes it, leaving a tombstone with no account and no secret.

import { DEFAULT_ROSTER } from "@manut/member-grants";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { sealSecret, type SealedSecret } from "./cred-crypto";
import { credStub, type TenantDataEnv } from "./tenant-data";

export type SignInVaultKeys = { CRED_KEY?: string; CRED_KEY_PREVIOUS?: string };

/// What the Worker's side needs: the vault, and the shop's object for its audit log.
export type VaultEnv = Pick<TenantDataEnv, "CRED" | "TENANT">;

/// What the vault keeps for one sign-in. `sealed` is the password; the rest is what the owner sees.
type SignInRecord = {
  id: string;
  tenant: string;
  /// The name people use: "Shopee Seller Centre".
  site: string;
  /// Where the password may be typed, and what an outpost may browse for this sign-in: https origins only.
  origins: string[];
  username: string;
  sealed: SealedSecret;
  /// The members who may use it.
  members: string[];
  state: "working" | "broken";
  /// When a member first reported that the site refused the saved password, and which member.
  brokenAt: string | null;
  brokenBy: string | null;
  passwordSetAt: string;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
  createdAt: string;
  /// Set when it is removed; a removed sign-in keeps no username and no seal.
  removedAt: string | null;
};

/// What any answer may say about a sign-in: everything but the tenant, the seal and the tombstone.
export type SignInView = Omit<SignInRecord, "tenant" | "sealed" | "removedAt"> & { passwordSet: true };

/// The members a sign-in may name: those whose jobs run through a connection in `@manut/member-grants`' roster. Buddy
/// routes work and never signs in to a site.
export const SIGN_IN_MEMBERS: readonly string[] = DEFAULT_ROSTER
  .filter((member) => member.capabilities.some((capability) => capability.needsConnection))
  .map((member) => member.id);

const MAX_BODY_BYTES = 16 * 1024;
/// Live sign-ins per shop, so one shop's vault cannot grow without bound.
const MAX_SIGN_INS = 50;
const MAX_SITE = 80;
const MAX_ORIGINS = 5;
const MAX_ORIGIN_LENGTH = 256;
const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;
/// Characters that cannot be typed into a form field, and are never part of a name or an account.
const CONTROL = /[\u0000-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMPTY_SEAL: SealedSecret = { keyTag: "", iv: "", data: "" };

const keys = {
  signIn: (id: string) => `signin:${id}`,
  signIns: "signin:",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// The paths this module answers inside the vault object.
export function isSignInVaultPath(pathname: string): boolean {
  return pathname === "/sign-ins" || pathname.startsWith("/sign-ins/");
}

/// A site's name as people write it, trimmed: one to 80 characters, Thai counted the same as English.
function siteOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const site = value.trim();
  return site.length > 0 && [...site].length <= MAX_SITE && !CONTROL.test(site) ? site : null;
}

/// One to five distinct https origins, each written exactly as the URL parser writes an origin: no path, no port it
/// would drop, no account in it, lower case. So what is stored is what a page's origin is compared with.
function originsOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ORIGINS) return null;
  const origins: string[] = [];
  for (const origin of value) {
    if (typeof origin !== "string" || origin.length > MAX_ORIGIN_LENGTH || origins.includes(origin)) return null;
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" || parsed.origin !== origin) return null;
    origins.push(origin);
  }
  return origins;
}

/// The account's name on the site, kept exactly as given, since the outpost types it as it is.
function usernameOf(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_USERNAME && !CONTROL.test(value)
    ? value : null;
}

/// Any text up to 1,024 characters: a password is typed exactly as the owner gave it.
function passwordOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PASSWORD ? value : null;
}

/// One or more distinct members from `SIGN_IN_MEMBERS`.
function membersOf(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > SIGN_IN_MEMBERS.length) return null;
  if (!value.every((member): member is string => typeof member === "string" && SIGN_IN_MEMBERS.includes(member))) {
    return null;
  }
  return new Set(value).size === value.length ? [...value] : null;
}

export function viewOf(record: SignInRecord): SignInView {
  return {
    id: record.id,
    site: record.site,
    origins: record.origins,
    username: record.username,
    members: record.members,
    state: record.state,
    passwordSet: true,
    passwordSetAt: record.passwordSetAt,
    brokenAt: record.brokenAt,
    brokenBy: record.brokenBy,
    lastUsedAt: record.lastUsedAt,
    lastUsedBy: record.lastUsedBy,
    createdAt: record.createdAt,
  };
}

/// A live sign-in of `tenant` by its id, or null for a malformed id, one never made, one removed, or another tenant's.
async function liveSignIn(storage: DurableObjectStorage, tenant: string, id: unknown): Promise<SignInRecord | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const record = await storage.get<SignInRecord>(keys.signIn(id));
  return record && record.tenant === tenant && record.removedAt === null ? record : null;
}

async function liveSignIns(storage: DurableObjectStorage, tenant: string): Promise<SignInRecord[]> {
  const records = [...(await storage.list<SignInRecord>({ prefix: keys.signIns })).values()]
    .filter((record) => record.tenant === tenant && record.removedAt === null);
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

const NOT_FOUND = { error: "sign_in_not_found" };

/// Everything under `/sign-ins` in the vault object. See the module note.
export async function signInVaultRoute(
  storage: DurableObjectStorage,
  vaultKeys: SignInVaultKeys,
  request: Request,
  url: URL,
): Promise<Response> {
  const tenant = request.headers.get("x-tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "not_found" }, 404);
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /sign-ins") {
    return json({ signIns: (await liveSignIns(storage, tenant)).map(viewOf) });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (request.headers.get("x-vault") !== "1") return json({ error: "forbidden" }, 403);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  switch (route) {
    case "POST /sign-ins":
      return createSignIn(storage, vaultKeys, tenant, body);
    case "POST /sign-ins/password":
      return replacePassword(storage, vaultKeys, tenant, body);
    case "POST /sign-ins/remove":
      return removeSignIn(storage, tenant, body);
    default:
      return json({ error: "not_found" }, 404);
  }
}

async function createSignIn(storage: DurableObjectStorage, vaultKeys: SignInVaultKeys, tenant: string,
  body: Record<string, unknown>): Promise<Response> {
  const site = siteOf(body.site);
  if (site === null) return json({ error: "invalid_site" }, 400);
  const origins = originsOf(body.origins);
  if (origins === null) return json({ error: "invalid_origins" }, 400);
  const username = usernameOf(body.username);
  if (username === null) return json({ error: "invalid_username" }, 400);
  const password = passwordOf(body.password);
  if (password === null) return json({ error: "invalid_password" }, 400);
  const members = membersOf(body.members);
  if (members === null) return json({ error: "invalid_members" }, 400);
  const key = vaultKeys.CRED_KEY;
  if (!key) return json({ error: "vault_not_configured" }, 503);
  // Sealed before the count is read, so the count and the write below are one step that nothing else can come
  // between: the object takes no other request while it waits only on its own storage.
  const sealed = await sealSecret(password, key);
  if ((await liveSignIns(storage, tenant)).length >= MAX_SIGN_INS) return json({ error: "too_many_sign_ins" }, 409);
  const now = new Date().toISOString();
  const record: SignInRecord = { id: crypto.randomUUID(), tenant, site, origins, username, sealed, members,
    state: "working", brokenAt: null, brokenBy: null, passwordSetAt: now, lastUsedAt: null, lastUsedBy: null,
    createdAt: now, removedAt: null };
  await storage.put(keys.signIn(record.id), record);
  return json({ signIn: viewOf(record) });
}

/// A new password mends a broken sign-in: the owner typing one is what "Needs a new password" asks for.
async function replacePassword(storage: DurableObjectStorage, vaultKeys: SignInVaultKeys, tenant: string,
  body: Record<string, unknown>): Promise<Response> {
  const password = passwordOf(body.password);
  if (password === null) return json({ error: "invalid_password" }, 400);
  const key = vaultKeys.CRED_KEY;
  if (!key) return json({ error: "vault_not_configured" }, 503);
  // Sealed first, for the same reason as at creation: a removal can never land between the read and the write and
  // be undone by it.
  const sealed = await sealSecret(password, key);
  const record = await liveSignIn(storage, tenant, body.signInId);
  if (!record) return json(NOT_FOUND, 404);
  const replaced: SignInRecord = { ...record, sealed, passwordSetAt: new Date().toISOString(), state: "working",
    brokenAt: null, brokenBy: null };
  await storage.put(keys.signIn(record.id), replaced);
  return json({ signIn: viewOf(replaced) });
}

/// Removal wipes the account and the seal but keeps the record as a tombstone, as a revoked connection does, so a
/// restored backup cannot quietly bring back a password the owner took away.
async function removeSignIn(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const record = await liveSignIn(storage, tenant, body.signInId);
  if (!record) return json(NOT_FOUND, 404);
  await storage.put(keys.signIn(record.id), { ...record, username: "", sealed: EMPTY_SEAL,
    removedAt: new Date().toISOString() } satisfies SignInRecord);
  return json({ removed: true, signInId: record.id });
}

// The Worker's side: calling the shop's vault object, and reading what it answered.

/// One call to the shop's vault object, with the tenant the Worker verified and, for a write, `x-vault`.
export function vaultCall(env: Pick<TenantDataEnv, "CRED">, tenant: string, method: "GET" | "POST", path: string,
  body?: Record<string, unknown>): Promise<Response> {
  const headers = new Headers({ "x-tenant": tenant });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("x-vault", "1");
  }
  return credStub(env, tenant).fetch(new Request(`https://cred${path}`, { method, headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
}

/// What the vault answers to a request it understood (a record, or a refusal with its status), or null when it did
/// not answer one: anything else is the vault failing, and is not passed on as if it were an answer. A 503 is an
/// answer only when it says the vault's key is not configured.
export async function vaultAnswer(response: Response): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (![200, 400, 401, 403, 404, 409, 503].includes(response.status)) {
    await response.body?.cancel();
    return null;
  }
  const body = await response.json().catch(() => null);
  if (!isRecord(body)) return null;
  if (response.status === 503 && body.error !== "vault_not_configured") return null;
  return { status: response.status, body };
}
