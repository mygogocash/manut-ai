/// The shop's site sign-ins, the outposts that type them, and the one-time grants between the two, kept in its vault
/// object (`CredObject`, `t:${tenant}`) beside its connections (docs/browser-control.md). This is the object's side,
/// and the Worker's calls into it; the routes are browser-control.ts's, and the worker's two steps are on the job
/// flow's port (job-flow.ts).
///
/// A sign-in's password is sealed with the vault's own keys (cred-crypto.ts) and leaves this object in one place only:
/// `POST /sign-in-grants/open`, for the outpost that has just used up a grant bound to it. Every other answer is the
/// public view, which says only that a password is set. An outpost's credential is never here at all: the Worker mints
/// it, hands it out once, and gives this object only its SHA-256 digest.
///
/// Paths, each with the Worker's `x-tenant` (a record of another tenant reads as not found), and writes also with
/// `x-vault`, the same defence in depth as `x-pilot` and `x-audit`:
///
/// - `GET /sign-ins`: the live sign-ins, oldest first.
/// - `POST /sign-ins` `{ site, origins, username, password, members }`: a new sign-in.
/// - `POST /sign-ins/password` `{ signInId, password }`: a new password, which also mends a broken sign-in.
/// - `POST /sign-ins/broken` `{ signInId, member }`: a member named on it reports that the site refused the password.
/// - `POST /sign-ins/remove` `{ signInId }`: removes it, leaving a tombstone with no account and no secret.
/// - `GET /outposts`: the outposts, oldest first, each online or asleep as of now.
/// - `POST /outposts` `{ name, kind, credentialHash }`: a new outpost.
/// - `POST /outposts/heartbeat` `{ outpostId, credentialHash }`: its beat, refused 401 unless the digest is its own.
/// - `POST /outposts/remove` `{ outpostId }`: removes it, refusing every grant still waiting for it.
/// - `POST /outposts/credential` `{ outpostId, credentialHash }`: a new credential's digest in place of the old one.
/// - `POST /sign-in-grants` `{ signInId, outpostId, member, taskId, attemptId }`: a grant, for a member named on a
///   working sign-in, to an online outpost, for 60 seconds.
/// - `POST /sign-in-grants/claim` `{ grantId, outpostId, credentialHash }`: the outpost's redeem, first half. Checks the
///   grant is its own, unused and on time, and uses it up whatever comes next; answers what it is bound to.
/// - `POST /sign-in-grants/open` `{ grantId, outpostId, credentialHash }`: the second half, once the Worker has seen the
///   attempt still runs. Answers the username, the password and the origins, once per grant.

import { DEFAULT_ROSTER } from "@manut/member-grants";
import { appendAudit, type AuditActor, type AuditSubject } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { openSecret, sealSecret, type SealedSecret } from "./cred-crypto";
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

export const OUTPOST_KINDS = ["this_mac", "cloud"] as const;
export type OutpostKind = (typeof OUTPOST_KINDS)[number];

/// A machine the team's browser runs on: this Mac through the desktop app, or a cloud outpost.
type OutpostRecord = {
  id: string;
  tenant: string;
  name: string;
  kind: OutpostKind;
  /// The SHA-256 of its credential, in hex.
  credentialHash: string;
  lastHeartbeatAt: string | null;
  createdAt: string;
};

export type OutpostView = Omit<OutpostRecord, "tenant" | "credentialHash"> & { status: "online" | "asleep" };

/// An outpost beats every 30 seconds while it is awake, so one silent for 90 has missed three beats and is asleep.
export const ONLINE_WINDOW_MS = 90_000;

/// One outpost's permission to type one sign-in for one attempt's member, once, within a minute.
type GrantRecord = {
  id: string;
  tenant: string;
  signInId: string;
  outpostId: string;
  taskId: string;
  attemptId: string;
  /// The attempt's member, as the task object recorded it when the grant was asked for.
  member: string;
  issuedAt: string;
  expiresAt: string;
  /// When its outpost first redeemed it, whatever came of that. From then on it is used up.
  usedAt: string | null;
  /// When the password was answered for it.
  openedAt: string | null;
};

/// What a grant is bound to, which the Worker needs to check the attempt and write the log. Never the password.
export type GrantBinding = { signInId: string; taskId: string; attemptId: string; member: string };

/// What a worker is told of its grant: enough to hand the outpost its step, nothing it could type.
export type SignInGrant = { grantId: string; signInId: string; site: string; outpostId: string; expiresAt: string };

/// A grant lives one minute.
export const GRANT_TTL_MS = 60_000;
/// Dead grants are deleted when the next one is issued, once they have been dead this long.
const GRANT_KEEP_MS = 10 * 60_000;

const MAX_BODY_BYTES = 16 * 1024;
/// Live sign-ins per shop, so one shop's vault cannot grow without bound.
const MAX_SIGN_INS = 50;
const MAX_SITE = 80;
const MAX_ORIGINS = 5;
const MAX_ORIGIN_LENGTH = 256;
const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;
/// Outposts per shop.
const MAX_OUTPOSTS = 20;
const MAX_NAME = 80;
/// Characters that cannot be typed into a form field, and are never part of a name or an account.
const CONTROL = /[\u0000-\u001f\u007f]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
/// A task or attempt id as the job flow mints them, in the audit log's own alphabet.
const TASK_REF = /^[A-Za-z0-9._:-]{1,256}$/;
/// An attempt's executor, as the task object bounds it.
const MAX_MEMBER = 128;
const EMPTY_SEAL: SealedSecret = { keyTag: "", iv: "", data: "" };
/// Durable Object storage takes at most 128 keys per delete call.
const STORAGE_BATCH = 128;

const keys = {
  signIn: (id: string) => `signin:${id}`,
  signIns: "signin:",
  outpost: (id: string) => `outpost:${id}`,
  outposts: "outpost:",
  grant: (id: string) => `signin-grant:${id}`,
  grants: "signin-grant:",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// The paths this module answers inside the vault object.
export function isSignInVaultPath(pathname: string): boolean {
  return pathname === "/sign-ins" || pathname.startsWith("/sign-ins/") || pathname === "/outposts" ||
    pathname.startsWith("/outposts/") || pathname === "/sign-in-grants" || pathname.startsWith("/sign-in-grants/");
}

/// Whether two hex digests are the same, in time that does not depend on where they differ.
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/// Online while its last beat is under 90 seconds old; asleep otherwise, and before its first beat.
function outpostStatus(lastHeartbeatAt: string | null, nowMs: number): "online" | "asleep" {
  if (lastHeartbeatAt === null) return "asleep";
  const at = Date.parse(lastHeartbeatAt);
  return Number.isFinite(at) && nowMs - at < ONLINE_WINDOW_MS ? "online" : "asleep";
}

function outpostView(record: OutpostRecord, nowMs: number): OutpostView {
  return { id: record.id, name: record.name, kind: record.kind, status: outpostStatus(record.lastHeartbeatAt, nowMs),
    lastHeartbeatAt: record.lastHeartbeatAt, createdAt: record.createdAt };
}

async function outpostsOf(storage: DurableObjectStorage, tenant: string): Promise<OutpostRecord[]> {
  const records = [...(await storage.list<OutpostRecord>({ prefix: keys.outposts })).values()]
    .filter((record) => record.tenant === tenant);
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/// The outpost that presented this credential digest, or null. An unknown outpost, another tenant's, and a digest
/// that is not its own all read the same, so a caller learns nothing from which it was.
async function authenticated(storage: DurableObjectStorage, tenant: string, outpostId: unknown,
  credentialHash: unknown): Promise<OutpostRecord | null> {
  if (typeof outpostId !== "string" || !UUID.test(outpostId) || typeof credentialHash !== "string" ||
      !DIGEST.test(credentialHash)) {
    return null;
  }
  const record = await storage.get<OutpostRecord>(keys.outpost(outpostId));
  if (!record || record.tenant !== tenant) return null;
  return sameDigest(record.credentialHash, credentialHash) ? record : null;
}

const UNAUTHORIZED = { error: "unauthorized" };

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

function viewOf(record: SignInRecord): SignInView {
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
  if (route === "GET /outposts") {
    const nowMs = Date.now();
    return json({ outposts: (await outpostsOf(storage, tenant)).map((record) => outpostView(record, nowMs)) });
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
    case "POST /sign-ins/broken":
      return markBroken(storage, tenant, body);
    case "POST /sign-ins/remove":
      return removeSignIn(storage, tenant, body);
    case "POST /outposts":
      return registerOutpost(storage, tenant, body);
    case "POST /outposts/heartbeat":
      return outpostHeartbeat(storage, tenant, body);
    case "POST /outposts/remove":
      return removeOutpost(storage, tenant, body);
    case "POST /outposts/credential":
      return rotateCredential(storage, tenant, body);
    case "POST /sign-in-grants":
      return issueGrant(storage, tenant, body);
    case "POST /sign-in-grants/claim":
      return claimGrant(storage, tenant, body);
    case "POST /sign-in-grants/open":
      return openGrant(storage, vaultKeys, tenant, body);
    default:
      return json({ error: "not_found" }, 404);
  }
}

/// The site refused the saved password: a member named on the sign-in says so, and nobody uses it until the owner
/// types a new one. A second report keeps the first's time and member, which is when it broke.
async function markBroken(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const record = await liveSignIn(storage, tenant, body.signInId);
  if (!record) return json(NOT_FOUND, 404);
  if (typeof body.member !== "string" || !record.members.includes(body.member)) {
    return json({ error: "member_not_allowed" }, 403);
  }
  if (record.state === "broken") return json({ signIn: viewOf(record) });
  const broken: SignInRecord = { ...record, state: "broken", brokenAt: new Date().toISOString(),
    brokenBy: body.member };
  await storage.put(keys.signIn(record.id), broken);
  return json({ signIn: viewOf(broken) });
}

/// Why a grant's sign-in cannot be used for its member now, or null when it can: removed, the member since taken off
/// it, or broken. The member is checked before the state, so a member who may not use a sign-in learns nothing of it.
function unusable(record: SignInRecord | null, member: string): { status: number; error: string } | null {
  if (!record) return { status: 404, error: "sign_in_not_found" };
  if (!record.members.includes(member)) return { status: 403, error: "member_not_allowed" };
  if (record.state === "broken") return { status: 409, error: "sign_in_broken" };
  return null;
}

/// A grant for the attempt's member to have `outpostId` type the sign-in, if the member is named on it, it is working,
/// and the outpost is online. The member, the task and the attempt come from the control plane, which read them from
/// the task object; the sign-in and the outpost are what the worker named.
async function issueGrant(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const { member, taskId, attemptId } = body;
  if (typeof member !== "string" || member.length === 0 || member.length > MAX_MEMBER ||
      typeof taskId !== "string" || !TASK_REF.test(taskId) || typeof attemptId !== "string" ||
      !TASK_REF.test(attemptId)) {
    return json({ error: "invalid_request" }, 400);
  }
  const signIn = await liveSignIn(storage, tenant, body.signInId);
  const refused = unusable(signIn, member);
  if (refused || !signIn) return json({ error: refused?.error ?? "sign_in_not_found" }, refused?.status ?? 404);
  const outpost = typeof body.outpostId === "string" && UUID.test(body.outpostId)
    ? await storage.get<OutpostRecord>(keys.outpost(body.outpostId)) : undefined;
  if (!outpost || outpost.tenant !== tenant) return json({ error: "outpost_not_found" }, 404);
  const nowMs = Date.now();
  // One that is asleep could not use it within its minute; better the worker hears so now.
  if (outpostStatus(outpost.lastHeartbeatAt, nowMs) !== "online") return json({ error: "outpost_asleep" }, 409);
  await pruneGrants(storage, nowMs);
  const grant: GrantRecord = { id: crypto.randomUUID(), tenant, signInId: signIn.id, outpostId: outpost.id, taskId,
    attemptId, member, issuedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + GRANT_TTL_MS).toISOString(),
    usedAt: null, openedAt: null };
  await storage.put(keys.grant(grant.id), grant);
  return json({ grant: { grantId: grant.id, signInId: signIn.id, site: signIn.site, outpostId: outpost.id,
    expiresAt: grant.expiresAt } satisfies SignInGrant });
}

/// Deletes the grants that have been dead for ten minutes, so the vault does not keep one per step for ever. Their
/// history is in the audit log.
async function pruneGrants(storage: DurableObjectStorage, nowMs: number): Promise<void> {
  const dead: string[] = [];
  for (const [key, grant] of await storage.list<GrantRecord>({ prefix: keys.grants })) {
    if (Date.parse(grant.expiresAt) + GRANT_KEEP_MS < nowMs) dead.push(key);
  }
  for (let i = 0; i < dead.length; i += STORAGE_BATCH) await storage.delete(dead.slice(i, i + STORAGE_BATCH));
}

/// The grant an authenticated outpost names, or a refusal. The binding goes with every refusal about a grant that
/// exists, for the Worker's audit entry; the Worker never passes it to the outpost.
async function grantFor(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<{ outpost: OutpostRecord; grant: GrantRecord } | Response> {
  const outpost = await authenticated(storage, tenant, body.outpostId, body.credentialHash);
  if (!outpost) return json(UNAUTHORIZED, 401);
  const grant = typeof body.grantId === "string" && UUID.test(body.grantId)
    ? await storage.get<GrantRecord>(keys.grant(body.grantId)) : undefined;
  if (!grant || grant.tenant !== tenant) return json({ error: "grant_not_found" }, 404);
  if (grant.outpostId !== outpost.id) return json({ error: "wrong_outpost", binding: bindingOf(grant) }, 403);
  return { outpost, grant };
}

function bindingOf(grant: GrantRecord): GrantBinding {
  return { signInId: grant.signInId, taskId: grant.taskId, attemptId: grant.attemptId, member: grant.member };
}

/// The redeem's first half. Another outpost's grant is refused without being used, so it stays for its own; past that
/// point the grant is used up in the same step as these checks, before anything else can run, so of any number of
/// redeems at most one ever gets further.
async function claimGrant(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const found = await grantFor(storage, tenant, body);
  if (found instanceof Response) return found;
  const { grant } = found;
  const binding = bindingOf(grant);
  if (grant.usedAt !== null) return json({ error: "grant_used", binding }, 409);
  const nowMs = Date.now();
  if (!(nowMs < Date.parse(grant.expiresAt))) return json({ error: "grant_expired", binding }, 409);
  await storage.put(keys.grant(grant.id), { ...grant, usedAt: new Date(nowMs).toISOString() } satisfies GrantRecord);
  const refused = unusable(await liveSignIn(storage, tenant, grant.signInId), grant.member);
  if (refused) return json({ error: refused.error, binding }, refused.status);
  return json({ binding });
}

/// The redeem's second half: the password, once per grant, for a grant its outpost has just claimed and still on time.
/// The grant is marked opened before the password is unsealed, so a failure part way can only lose it, never answer it
/// twice; and the sign-in's last use is written only once the password is out.
async function openGrant(storage: DurableObjectStorage, vaultKeys: SignInVaultKeys, tenant: string,
  body: Record<string, unknown>): Promise<Response> {
  const found = await grantFor(storage, tenant, body);
  if (found instanceof Response) return found;
  const { grant } = found;
  if (grant.usedAt === null || grant.openedAt !== null) return json({ error: "grant_used" }, 409);
  const nowMs = Date.now();
  if (!(nowMs < Date.parse(grant.expiresAt))) return json({ error: "grant_expired" }, 409);
  const signIn = await liveSignIn(storage, tenant, grant.signInId);
  const refused = unusable(signIn, grant.member);
  if (refused || !signIn) return json({ error: refused?.error ?? "sign_in_not_found" }, refused?.status ?? 404);
  const key = vaultKeys.CRED_KEY;
  if (!key) return json({ error: "vault_not_configured" }, 503);
  await storage.put(keys.grant(grant.id), { ...grant, openedAt: new Date(nowMs).toISOString() } satisfies GrantRecord);
  let password: string;
  try {
    password = await openSecret(signIn.sealed, key, vaultKeys.CRED_KEY_PREVIOUS);
  } catch {
    return json({ error: "unseal_failed" }, 500);
  }
  // Read again before writing, since unsealing let other requests in: a sign-in removed meanwhile stays removed.
  const current = await liveSignIn(storage, tenant, grant.signInId);
  if (current) {
    await storage.put(keys.signIn(current.id), { ...current, lastUsedAt: new Date(nowMs).toISOString(),
      lastUsedBy: grant.member } satisfies SignInRecord);
  }
  return json({ signInId: signIn.id, site: signIn.site, origins: signIn.origins, username: signIn.username, password });
}

/// Part of the vault's tenant wipe (cred-object.ts): every sign-in, tombstones included, every outpost and every grant.
export async function wipeSignInVault(storage: DurableObjectStorage):
  Promise<{ signInsWiped: number; outpostsWiped: number; grantsWiped: number }> {
  const doomed = async (prefix: string) => [...(await storage.list({ prefix })).keys()];
  const signIns = await doomed(keys.signIns);
  const outposts = await doomed(keys.outposts);
  const grants = await doomed(keys.grants);
  const all = [...signIns, ...outposts, ...grants];
  for (let i = 0; i < all.length; i += STORAGE_BATCH) await storage.delete(all.slice(i, i + STORAGE_BATCH));
  return { signInsWiped: signIns.length, outpostsWiped: outposts.length, grantsWiped: grants.length };
}

async function registerOutpost(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || [...name].length > MAX_NAME || CONTROL.test(name)) return json({ error: "invalid_name" }, 400);
  const kind = OUTPOST_KINDS.find((known) => known === body.kind);
  if (!kind) return json({ error: "invalid_kind" }, 400);
  if (typeof body.credentialHash !== "string" || !DIGEST.test(body.credentialHash)) {
    return json({ error: "invalid_request" }, 400);
  }
  if ((await outpostsOf(storage, tenant)).length >= MAX_OUTPOSTS) return json({ error: "too_many_outposts" }, 409);
  const record: OutpostRecord = { id: crypto.randomUUID(), tenant, name, kind, credentialHash: body.credentialHash,
    lastHeartbeatAt: null, createdAt: new Date().toISOString() };
  await storage.put(keys.outpost(record.id), record);
  return json({ outpost: outpostView(record, Date.now()) });
}

/// The outpost of `tenant` an operator names, or null for a malformed id, one never made, one removed, or another
/// tenant's.
async function outpostOf(storage: DurableObjectStorage, tenant: string, id: unknown): Promise<OutpostRecord | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const record = await storage.get<OutpostRecord>(keys.outpost(id));
  return record && record.tenant === tenant ? record : null;
}

const OUTPOST_NOT_FOUND = { error: "outpost_not_found" };

/// Writes every entry, at most 128 keys per call as Durable Object storage takes them.
async function putAll(storage: DurableObjectStorage, entries: Record<string, unknown>): Promise<void> {
  const all = Object.entries(entries);
  for (let i = 0; i < all.length; i += STORAGE_BATCH) await storage.put(Object.fromEntries(all.slice(i, i + STORAGE_BATCH)));
}

/// Removal deletes the outpost, so its credential stops working at once: every outpost request is checked against the
/// digest kept here, and there is none. In the same step, each grant still waiting for it (not used, not late) is used
/// up, so nothing can ever redeem it. Nothing else here awaits anything but this object's own storage, so no request
/// comes between the reads and the writes. The audit log keeps the outpost's history.
async function removeOutpost(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const outpost = await outpostOf(storage, tenant, body.outpostId);
  if (!outpost) return json(OUTPOST_NOT_FOUND, 404);
  const nowMs = Date.now();
  const usedAt = new Date(nowMs).toISOString();
  const grants: Record<string, GrantRecord> = {};
  for (const [key, grant] of await storage.list<GrantRecord>({ prefix: keys.grants })) {
    if (grant.tenant === tenant && grant.outpostId === outpost.id && grant.usedAt === null &&
        nowMs < Date.parse(grant.expiresAt)) {
      grants[key] = { ...grant, usedAt };
    }
  }
  await putAll(storage, grants);
  await storage.delete(keys.outpost(outpost.id));
  return json({ removed: true, outpostId: outpost.id, grantsRefused: Object.keys(grants).length });
}

/// A new credential's digest in place of the old one, so the old credential stops working at once. The outpost reads
/// as asleep until the holder of the new one beats: no new grant goes to a machine that may not hold it. Grants already
/// waiting for the outpost stay, for the new credential.
async function rotateCredential(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  if (typeof body.credentialHash !== "string" || !DIGEST.test(body.credentialHash)) {
    return json({ error: "invalid_request" }, 400);
  }
  const outpost = await outpostOf(storage, tenant, body.outpostId);
  if (!outpost) return json(OUTPOST_NOT_FOUND, 404);
  const rotated: OutpostRecord = { ...outpost, credentialHash: body.credentialHash, lastHeartbeatAt: null };
  await storage.put(keys.outpost(outpost.id), rotated);
  return json({ outpost: outpostView(rotated, Date.now()) });
}

/// A beat changes only the time of the last one: it is the outpost saying it is awake, not work.
async function outpostHeartbeat(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const outpost = await authenticated(storage, tenant, body.outpostId, body.credentialHash);
  if (!outpost) return json(UNAUTHORIZED, 401);
  const nowMs = Date.now();
  const beating: OutpostRecord = { ...outpost, lastHeartbeatAt: new Date(nowMs).toISOString() };
  await storage.put(keys.outpost(outpost.id), beating);
  return json({ outpost: outpostView(beating, nowMs) });
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

/// The vault's refusal code, or `vault_unavailable` for an answer that names none.
function refusalOf(body: Record<string, unknown>): string {
  return typeof body.error === "string" ? body.error : "vault_unavailable";
}

/// Ids a worker named, kept in an audit entry only when they could be the vault's (a UUID), so the log never refuses
/// the entry for a malformed one.
function namedIds(ids: { signInId?: unknown; outpostId?: unknown }): AuditSubject {
  return {
    ...(typeof ids.signInId === "string" && UUID.test(ids.signInId) ? { signInId: ids.signInId } : {}),
    ...(typeof ids.outpostId === "string" && UUID.test(ids.outpostId) ? { outpostId: ids.outpostId } : {}),
  };
}

/// Where the worker's step happens: the attempt, and the member the task object recorded it for.
export type AttemptRef = { tenant: string; taskId: string; attemptId: string; member: string };

/// The worker's sign-in step (job-flow.ts, `signIn`), once the port has read the switches and consent and the
/// attempt's own heartbeat. Asks the vault for a grant and writes `signin.requested`, issued or refused, under the
/// attempt.
export async function issueSignInGrant(env: VaultEnv, attempt: AttemptRef, signInId: unknown, outpostId: unknown):
  Promise<{ ok: true; value: SignInGrant } | { ok: false; error: string }> {
  const { tenant, taskId, attemptId, member } = attempt;
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, tenant, "POST", "/sign-in-grants",
      { signInId, outpostId, member, taskId, attemptId }));
  } catch {
    answer = null;
  }
  if (!answer) return { ok: false, error: "vault_unavailable" };
  const actor: AuditActor = { kind: "worker", attemptId };
  const subject: AuditSubject = { ...namedIds({ signInId, outpostId }), taskId, attemptId };
  if (answer.status !== 200 || !isRecord(answer.body.grant)) {
    const error = refusalOf(answer.body);
    await appendAudit(env, tenant, { actor, action: "signin.requested", subject, outcome: "refused", reason: error });
    return { ok: false, error };
  }
  const grant = answer.body.grant as SignInGrant;
  await appendAudit(env, tenant, { actor, action: "signin.requested", subject: { ...subject, grantId: grant.grantId },
    outcome: "ok" });
  return { ok: true, value: grant };
}

/// The worker's report that the site refused a sign-in's password (job-flow.ts, `signInBroken`), once the port has read
/// the switches and consent and the attempt's own heartbeat. Writes `signin.broken`, done or refused, under the attempt.
export async function reportSignInBroken(env: VaultEnv, attempt: AttemptRef, signInId: unknown):
  Promise<{ ok: true; value: { signInId: string; state: "broken" } } | { ok: false; error: string }> {
  const { tenant, taskId, attemptId, member } = attempt;
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, tenant, "POST", "/sign-ins/broken", { signInId, member }));
  } catch {
    answer = null;
  }
  if (!answer) return { ok: false, error: "vault_unavailable" };
  const actor: AuditActor = { kind: "worker", attemptId };
  const subject: AuditSubject = { ...namedIds({ signInId }), taskId, attemptId };
  if (answer.status !== 200 || !isRecord(answer.body.signIn)) {
    const error = refusalOf(answer.body);
    await appendAudit(env, tenant, { actor, action: "signin.broken", subject, outcome: "refused", reason: error });
    return { ok: false, error };
  }
  await appendAudit(env, tenant, { actor, action: "signin.broken", subject, outcome: "ok" });
  return { ok: true, value: { signInId: String(answer.body.signIn.id), state: "broken" } };
}
