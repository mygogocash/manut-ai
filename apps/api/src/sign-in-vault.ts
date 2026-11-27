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
/// - `POST /sign-ins/members` `{ signInId, members }`: who may use it from now on, and nothing else changed.
/// - `POST /sign-ins/change` `{ signInId, origins, username, password }`: its account and its addresses, with its password
///   typed again (`password` a string), or only addresses taken away (`password` null). See `changeSignIn`.
/// - `POST /sign-ins/broken` `{ signInId, member }`: a member named on it reports that the site refused the password.
/// - `POST /sign-ins/remove` `{ signInId }`: removes it, leaving a tombstone with no account and no secret.
/// - `POST /sign-ins/reseal` `{}`: every live sign-in sealed again under the current key, after a rotation (reseal.ts).
/// - `GET /outposts`: the outposts, oldest first, each online or asleep as of now.
/// - `POST /outposts` `{ name, kind, credentialHash }`: a new outpost.
/// - `POST /outposts/heartbeat` `{ outpostId, credentialHash }`: its beat, refused 401 unless the digest is its own.
/// - `POST /outposts/remove` `{ outpostId }`: removes it, refusing every grant still waiting for it.
/// - `POST /outposts/rename` `{ outpostId, name }`: a new name for it, and nothing else changed.
/// - `POST /outposts/credential` `{ outpostId, credentialHash }`: a new credential's digest in place of the old one.
/// - `POST /sign-in-grants` `{ signInId, outpostId, member, taskId, attemptId }`: a grant, for a member named on a
///   working sign-in, to an online outpost, for 60 seconds.
/// - `POST /sign-in-grants/claim` `{ grantId, outpostId, credentialHash }`: the outpost's redeem, first half. Checks the
///   grant is its own, unused and on time, and uses it up whatever comes next; answers what it is bound to.
/// - `POST /sign-in-grants/open` `{ grantId, outpostId, credentialHash }`: the second half, once the Worker has seen the
///   attempt still runs. Answers the username, the password and the origins, once per grant.
///
/// And the step channel, the browser steps a worker queues for an outpost (docs/browser-control.md):
///
/// - `POST /browser-steps` `{ kind, outpostId, url?, selector?, grantId?, member, taskId, attemptId }`: a step, for an
///   online outpost, going only to the origins of a working sign-in the member is named on.
/// - `GET /browser-steps/view?stepId=&taskId=&attemptId=`: a step as the worker that queued it sees it.
/// - `POST /browser-steps/pending` `{ outpostId, credentialHash }`: the outpost's steps waiting to be handed out.
/// - `POST /browser-steps/take` `{ outpostId, credentialHash, take, refuse }`: hands those the Worker let through out,
///   once each, and refuses the rest.
/// - `POST /browser-steps/report` `{ stepId, outpostId, credentialHash, outcome, code?, text? }`: the outpost's report,
///   once, held until the Worker has landed it in the attempt's events.
/// - `POST /browser-steps/settle` `{ stepId, code? }`: the Worker's word on a held report: landed, or refused.
/// - `POST /browser-steps/submit` `{ outpostId, requestId, revision, signInId, url, action, site, member, taskId,
///   attemptId }`: a write step, for an approved request the Worker read from the task object (browser-writes.ts), never
///   from the worker's word. It carries no values: the outpost gets them from the approved write as it is begun.
/// - `POST /browser-steps/refuse` `{ stepId, code }`: the Worker could not begin a write step it had just taken, so the
///   outpost never has it.

import { DEFAULT_ROSTER } from "@manut/member-grants";
import type { SubmitAction, SubmitValue } from "./browser-writes";
import { appendAudit, type AuditActor, type AuditSubject } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { openSecret, sealSecret, type SealedSecret } from "./cred-crypto";
import { resealStore, type ResealStore } from "./reseal";
import { timingSafeEqual } from "./timing-safe";
import { credStub, type TenantDataEnv } from "./tenant-data";

export type SignInVaultKeys = { CRED_KEY?: string; CRED_KEY_PREVIOUS?: string };

/// What the Worker's side needs: the vault, and the shop's object for its audit log.
export type VaultEnv = Pick<TenantDataEnv, "CRED" | "TENANT">;

/// What the vault keeps for one sign-in. `sealed` is the password; the rest is what the owner sees.
export type SignInRecord = {
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
  /// The browser step that carries it to its outpost, once one does: a grant goes in one step only. Absent on grants
  /// issued before steps existed, and on any no step carries.
  stepId?: string;
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
  step: (id: string) => `browser-step:${id}`,
  steps: "browser-step:",
  /// The last number given in the order steps were queued (`StepRecord.seq`); outside the steps' prefix, so a list of the
  /// steps never reads it.
  stepSeq: "browser-step-seq",
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
    pathname.startsWith("/outposts/") || pathname === "/sign-in-grants" || pathname.startsWith("/sign-in-grants/") ||
    pathname === "/browser-steps" || pathname.startsWith("/browser-steps/");
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
  // in time that does not depend on where the two digests differ
  return timingSafeEqual(record.credentialHash, credentialHash) ? record : null;
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
  if (route === "GET /browser-steps/view") return viewStep(storage, tenant, url);
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
    case "POST /sign-ins/members":
      return changeMembers(storage, tenant, body);
    case "POST /sign-ins/change":
      return changeSignIn(storage, vaultKeys, tenant, body);
    case "POST /sign-ins/broken":
      return markBroken(storage, tenant, body);
    case "POST /sign-ins/remove":
      return removeSignIn(storage, tenant, body);
    case "POST /sign-ins/reseal":
      return resealSignIns(storage, vaultKeys, tenant, body);
    case "POST /outposts":
      return registerOutpost(storage, tenant, body);
    case "POST /outposts/heartbeat":
      return outpostHeartbeat(storage, tenant, body);
    case "POST /outposts/remove":
      return removeOutpost(storage, tenant, body);
    case "POST /outposts/rename":
      return renameOutpost(storage, tenant, body);
    case "POST /outposts/credential":
      return rotateCredential(storage, tenant, body);
    case "POST /sign-in-grants":
      return issueGrant(storage, tenant, body);
    case "POST /sign-in-grants/claim":
      return claimGrant(storage, tenant, body);
    case "POST /sign-in-grants/open":
      return openGrant(storage, vaultKeys, tenant, body);
    case "POST /browser-steps":
      return queueStep(storage, tenant, body);
    case "POST /browser-steps/pending":
      return pendingSteps(storage, tenant, body);
    case "POST /browser-steps/take":
      return takeSteps(storage, tenant, body);
    case "POST /browser-steps/report":
      return reportStep(storage, vaultKeys, tenant, body);
    case "POST /browser-steps/settle":
      return settleStep(storage, tenant, body);
    case "POST /browser-steps/submit":
      return queueSubmit(storage, tenant, body);
    case "POST /browser-steps/refuse":
      return refuseTaken(storage, tenant, body);
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

/// Part of the vault's tenant wipe (cred-object.ts): every sign-in, tombstones included, every outpost, every grant and
/// every browser step.
export async function wipeSignInVault(storage: DurableObjectStorage):
  Promise<{ signInsWiped: number; outpostsWiped: number; grantsWiped: number; stepsWiped: number }> {
  const doomed = async (prefix: string) => [...(await storage.list({ prefix })).keys()];
  const signIns = await doomed(keys.signIns);
  const outposts = await doomed(keys.outposts);
  const grants = await doomed(keys.grants);
  const steps = await doomed(keys.steps);
  // the steps' counter goes with them: it holds no one's data, but a wiped vault keeps nothing
  const all = [...signIns, ...outposts, ...grants, ...steps, keys.stepSeq];
  for (let i = 0; i < all.length; i += STORAGE_BATCH) await storage.delete(all.slice(i, i + STORAGE_BATCH));
  return { signInsWiped: signIns.length, outpostsWiped: outposts.length, grantsWiped: grants.length,
    stepsWiped: steps.length };
}

/// An outpost's name as people write it, trimmed: one to 80 characters, Thai counted the same as English. The same rule
/// at registration and at a rename, so a name one takes the other takes too.
function outpostNameOf(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 && [...name].length <= MAX_NAME && !CONTROL.test(name) ? name : null;
}

async function registerOutpost(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const name = outpostNameOf(body.name);
  if (name === null) return json({ error: "invalid_name" }, 400);
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
/// up, so nothing can ever redeem it, and each of its steps still waiting or running is refused (`outpost_removed`), so
/// its worker hears so at once rather than when the step runs out of time. A step already reported is left to the
/// Worker, which is landing it. Nothing else here awaits anything but this object's own storage, so no request comes
/// between the reads and the writes. The audit log keeps the outpost's history.
async function removeOutpost(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const outpost = await outpostOf(storage, tenant, body.outpostId);
  if (!outpost) return json(OUTPOST_NOT_FOUND, 404);
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const grants: Record<string, GrantRecord> = {};
  for (const [key, grant] of await storage.list<GrantRecord>({ prefix: keys.grants })) {
    if (grant.tenant === tenant && grant.outpostId === outpost.id && grant.usedAt === null &&
        nowMs < Date.parse(grant.expiresAt)) {
      grants[key] = { ...grant, usedAt: at };
    }
  }
  const steps: Record<string, StepRecord> = {};
  for (const step of await stepsOf(storage, tenant)) {
    if (step.outpostId === outpost.id && (step.state === "queued" || step.state === "taken") &&
        nowMs < Date.parse(step.expiresAt)) {
      steps[keys.step(step.id)] = refusedStep(step, "outpost_removed", at);
    }
  }
  await putAll(storage, { ...grants, ...steps });
  await storage.delete(keys.outpost(outpost.id));
  return json({ removed: true, outpostId: outpost.id, stepsRefused: Object.keys(steps).length,
    grantsRefused: Object.keys(grants).length });
}

/// A new name, so the owner can tell their machines apart: every Mac registers itself as "This Mac", which says the
/// wrong thing on any other Mac. Only the name changes. The credential, the last heartbeat, and every grant and step
/// waiting for the outpost stay as they were, so renaming never stops its work. The read and the write wait only on this
/// object's own storage, so a heartbeat cannot land between them and be undone.
async function renameOutpost(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const name = outpostNameOf(body.name);
  if (name === null) return json({ error: "invalid_name" }, 400);
  const outpost = await outpostOf(storage, tenant, body.outpostId);
  if (!outpost) return json(OUTPOST_NOT_FOUND, 404);
  const renamed: OutpostRecord = { ...outpost, name };
  await storage.put(keys.outpost(outpost.id), renamed);
  return json({ outpost: outpostView(renamed, Date.now()) });
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

/// Who may use a sign-in from now on, checked as at creation (`membersOf`: one or more of the members whose jobs run
/// through a connection). Nothing else about it changes: not its password, whether it works, or when it was last used.
/// A member taken off loses it at once, since every grant, redeem and step reads the members from the record as it
/// happens (`unusable`), so nothing issued to that member before the change can be used after it. A redeem already past
/// that check as the change lands finishes, as one does when a sign-in is removed. The read and the write wait only on
/// this object's own storage, so nothing can land between them and be undone.
async function changeMembers(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const members = membersOf(body.members);
  if (members === null) return json({ error: "invalid_members" }, 400);
  const record = await liveSignIn(storage, tenant, body.signInId);
  if (!record) return json(NOT_FOUND, 404);
  const changed: SignInRecord = { ...record, members };
  await storage.put(keys.signIn(record.id), changed);
  return json({ signIn: viewOf(changed) });
}

/// A sign-in's account and its addresses from now on (docs/browser-control.md, "Changing a sign-in"). The danger is a
/// stored password typed where it was never meant to go: someone holding a stolen owner session points a password they
/// never knew at an address of their own, and the next sign-in step types it into their page. So the rule is that a
/// password is only ever typed into the account and the addresses it was given with:
///
/// - Adding or changing any address, or changing the account, needs the password typed again in the same change
///   (`password` a string). It is sealed as adding seals it, so the record's addresses, account and password always
///   came together, from one person who knew the password. That person may be the one with the stolen session, but then
///   the password the vault types is theirs, and the owner's is gone from the vault rather than sent anywhere new.
/// - Taking addresses away, keeping at least one, and nothing else, may go without it (`password` null): the password
///   then goes to fewer of the places it was given for, never to a new one.
///
/// Anything else without the password is refused `password_required`, and a change that keeps the account and the same
/// addresses (in any order) is refused `no_change`: a new password alone is `/sign-ins/password`'s, so the log's entry
/// for a change always means the account or the addresses moved. Every value is checked with the rules adding uses
/// (`originsOf`, `usernameOf`, `passwordOf`), so the vault never keeps here what it would refuse there. A new password
/// mends a broken sign-in, as `/sign-ins/password` does; taking addresses away leaves it as it was. Who may use it and
/// when it was last used stay.
///
/// The password is sealed before the record is read, as at a new password, so the read, the checks and the write wait
/// only on this object's own storage and nothing (a removal, another change) can land between them and be undone. A
/// redeem already past its own read as the change lands finishes with the record it read, whose password was given for
/// the addresses it read: the rule holds for it too.
async function changeSignIn(storage: DurableObjectStorage, vaultKeys: SignInVaultKeys, tenant: string,
  body: Record<string, unknown>): Promise<Response> {
  const origins = originsOf(body.origins);
  if (origins === null) return json({ error: "invalid_origins" }, 400);
  const username = usernameOf(body.username);
  if (username === null) return json({ error: "invalid_username" }, 400);
  // Absent reads as null, so a call that leaves the password out can only take addresses away.
  const typed = body.password === undefined || body.password === null ? null : passwordOf(body.password);
  if (typed === null && body.password !== undefined && body.password !== null) {
    return json({ error: "invalid_password" }, 400);
  }
  let sealed: SealedSecret | null = null;
  if (typed !== null) {
    const key = vaultKeys.CRED_KEY;
    if (!key) return json({ error: "vault_not_configured" }, 503);
    sealed = await sealSecret(typed, key);
  }
  const record = await liveSignIn(storage, tenant, body.signInId);
  if (!record) return json(NOT_FOUND, 404);
  const sameAccount = username === record.username;
  // Origins are distinct on both sides (`originsOf` refuses a repeat), so every new one being an old one and the counts
  // being equal is the same set.
  const onlyKept = origins.every((origin) => record.origins.includes(origin));
  if (sameAccount && onlyKept && origins.length === record.origins.length) return json({ error: "no_change" }, 400);
  if (sealed === null && !(sameAccount && onlyKept)) return json({ error: "password_required" }, 400);
  const changed: SignInRecord = { ...record, origins, username,
    ...(sealed !== null ? { sealed, passwordSetAt: new Date().toISOString(), state: "working" as const, brokenAt: null,
      brokenBy: null } : {}) };
  await storage.put(keys.signIn(record.id), changed);
  return json({ signIn: viewOf(changed) });
}

/// Removal wipes the account and the seal but keeps the record as a tombstone, as a revoked connection does, so a
/// restored backup cannot quietly bring back a password the owner took away. It is the one removal, the operator's and
/// the owner's alike. Nothing else needs to change with it: every grant, redeem and step reads the sign-in as it happens
/// (`liveSignIn`, `unusable`), so a grant issued before the removal is refused at its claim and again at its open
/// (`sign_in_not_found`), no new one is issued, a step carrying one is refused as it is handed out, and no step goes to its
/// addresses any more. A redeem whose open had already read the sign-in as the removal lands finishes, with the password
/// the owner gave for those addresses.
async function removeSignIn(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const record = await liveSignIn(storage, tenant, body.signInId);
  if (!record) return json(NOT_FOUND, 404);
  await storage.put(keys.signIn(record.id), { ...record, username: "", sealed: EMPTY_SEAL,
    removedAt: new Date().toISOString() } satisfies SignInRecord);
  return json({ removed: true, signInId: record.id });
}

/// The shop's live sign-ins as re-sealing reaches them (reseal.ts). A removed sign-in keeps no password, so it is never
/// one of them, and one removed while its password was being sealed again is read back as gone and left removed.
export function signInResealStore(storage: DurableObjectStorage, tenant: string): ResealStore<SignInRecord> {
  return {
    live: () => liveSignIns(storage, tenant),
    reread: async (id) => (await liveSignIn(storage, tenant, id)) ?? undefined,
    write: (record) => storage.put(keys.signIn(record.id), record),
  };
}

/// `POST /sign-ins/reseal` with exactly `{}`: after an operator rotates the vault's key, every live sign-in of the shop
/// whose password is sealed under another key is sealed again under the current one, so the previous key can be retired
/// (reseal.ts). It answers how many it sealed, how many already were, any it could not open, and how many still need
/// the previous key.
async function resealSignIns(storage: DurableObjectStorage, vaultKeys: SignInVaultKeys, tenant: string,
  body: Record<string, unknown>): Promise<Response> {
  if (Object.keys(body).length > 0) return json({ error: "invalid_request" }, 400);
  const key = vaultKeys.CRED_KEY;
  if (!key) return json({ error: "vault_not_configured" }, 503);
  return json(await resealStore(signInResealStore(storage, tenant),
    { CRED_KEY: key, CRED_KEY_PREVIOUS: vaultKeys.CRED_KEY_PREVIOUS }));
}

// The step channel: what a worker asks an outpost's browser to do, and how it went (docs/browser-control.md).

/// The steps a worker may queue in its own words, each of them reading: going to a page, reading its text, and signing in
/// so that it can read. Any other kind is refused here (`step_kind_not_allowed`).
export const READ_STEP_KINDS = ["open", "read", "sign_in"] as const;
/// Every kind of step, with the one that writes: `submit`, a write an approved approval-core request names exactly
/// (browser-writes.ts). It is queued only through its own path, with what the Worker read from the approved request.
export const STEP_KINDS = [...READ_STEP_KINDS, "submit"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
type ReadStepKind = (typeof READ_STEP_KINDS)[number];

/// How an outpost may say a step failed: a fixed list, so a report can never carry free text, or anything a page or a
/// sign-in held, into the task's events or the audit log. `origin_not_allowed`: a page was, or went, somewhere the
/// step's origins do not include, and the outpost stopped there. `page_unavailable`: the page did not load.
/// `selector_not_found`: nothing on the page matched the read's selector. `sign_in_refused`: the site refused the
/// saved password, so the worker reports the sign-in broken (`signInBroken`). `grant_refused`: the redeem was refused,
/// so there was nothing to type. `submit_refused`: a write step's site refused what was submitted and kept the form, so
/// nothing changed. `not_run`: the outpost did not do what the step asks (a kind it does not know, a step missing what
/// its kind needs, or a stop before the step began or, for a write, before anything was typed), so nothing was
/// submitted. `navigation_refused`: a write step, before it pressed anything, had the page or one of its frames try to go
/// off the step's origins; the outpost refused it and stopped, so nothing was submitted. `sign_in_interrupted`: the site
/// asked for more than the saved sign-in (a check that you are a person, a code sent to a phone, "verify it's you"), so
/// the outpost stopped there; the sign-in was not refused, so the worker does not report it broken. `timed_out` and
/// `browser_error`: anything else.
export const STEP_FAILURES = ["origin_not_allowed", "page_unavailable", "selector_not_found", "sign_in_refused",
  "grant_refused", "submit_refused", "not_run", "navigation_refused", "sign_in_interrupted", "timed_out",
  "browser_error"] as const;

/// A step lives two minutes from when it is queued, or until its grant ends if that is sooner. An outpost asks for its
/// steps every few seconds and a page loads in seconds, so a step normally ends well inside a minute; two leave room for
/// a slow site, and stay well inside the attempt's five-minute lease, so a worker waiting on its step keeps its attempt.
/// A step for an outpost that stopped answering fails within two minutes rather than holding the worker up.
export const STEP_TTL_MS = 120_000;
/// The most a read brings back: 4 KB once written as JSON in UTF-8, some 4,000 letters of English or 1,300 of Thai. It
/// goes into the task's events whole, as part of one agent event (which may take 8 KB), and it is what a worker's model
/// will read, so a step reads the part of a page it needs (a selector) rather than all of it.
export const MAX_READ_TEXT_BYTES = 4 * 1024;
/// Steps one outpost holds at once, waiting, running or reported, so no worker can fill the shop's vault.
const MAX_OPEN_STEPS = 20;
/// Steps one fetch hands out, and so the attempts one fetch reads.
const MAX_FETCH_STEPS = 5;
const MAX_URL = 2048;
const MAX_SELECTOR = 256;
/// A refusal's code, as the audit log takes one.
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/// `queued` until its outpost takes it, `taken` while it runs, `reported` once the outpost said how it went and until
/// that has landed in the attempt's events; then `done` or `failed` as the outpost said, or `refused` when the control
/// plane would not let it run or stand.
type StepState = "queued" | "taken" | "reported" | "done" | "failed" | "refused";

type StepRecord = {
  id: string;
  tenant: string;
  kind: StepKind;
  /// `open`: the page, written as the URL parser writes it. `submit`: the approved write's page.
  url: string | null;
  /// `read`: the part of the page to read; null reads the whole page.
  selector: string | null;
  /// `sign_in`: the grant it carries, and the grant's sign-in and its site. `submit`: no grant; the write's sign-in and
  /// its site.
  grantId: string | null;
  signInId: string | null;
  site: string | null;
  /// `submit`: the approved request it carries, the revision it was approved at, and the write's action (for its title).
  /// Absent on steps queued before write steps existed.
  requestId?: string | null;
  revision?: number | null;
  action?: string | null;
  outpostId: string;
  taskId: string;
  attemptId: string;
  /// The attempt's member, as the task object recorded it.
  member: string;
  queuedAt: string;
  /// Its place in the order this vault queued steps, so two queued in the same millisecond keep the order they were asked
  /// in. Absent on steps queued before it existed, which sort as 0.
  seq?: number;
  expiresAt: string;
  takenAt: string | null;
  reportedAt: string | null;
  settledAt: string | null;
  state: StepState;
  /// What the outpost reported, held while `reported`.
  outcome: "done" | "failed" | null;
  /// Why it failed or was refused: one of STEP_FAILURES, `text_withheld`, or the control plane's refusal.
  code: string | null;
  /// What a `read` read, once it is done. Dropped when the step is refused.
  text: string | null;
};

/// What a worker may ask for. The member, the task and the attempt are the control plane's to add, never the worker's.
export type NewBrowserStep =
  | { kind: "open"; outpostId: string; url: string }
  | { kind: "read"; outpostId: string; selector?: string }
  | { kind: "sign_in"; outpostId: string; grantId: string }
  /// A write: the approved request it carries and the revision it was approved at, nothing else (browser-writes.ts).
  | { kind: "submit"; outpostId: string; requestId: string; revision: number };

/// A step as the worker that queued it sees it. `expired` is a step that did not end within its time. A step reported
/// but not yet landed in the attempt's events still reads `taken`, so a worker never acts on an outcome its attempt's
/// events do not hold.
export type BrowserStepView = {
  stepId: string;
  kind: StepKind;
  outpostId: string;
  state: "queued" | "taken" | "done" | "failed" | "refused" | "expired";
  queuedAt: string;
  expiresAt: string;
  url?: string;
  selector?: string;
  signInId?: string;
  /// `submit`: the approved request it carries.
  requestId?: string;
  code?: string;
  text?: string;
};

/// A step as its outpost is handed it: what to do, and the origins its browser may be on while doing it. A `submit`
/// step's action, form and values are the approved write's, added by the Worker as the write is begun.
export type OutpostStep = {
  stepId: string;
  kind: StepKind;
  url?: string;
  selector?: string;
  grantId?: string;
  action?: SubmitAction;
  form?: string;
  values?: SubmitValue[];
  origins: string[];
  expiresAt: string;
};

/// The ids a step is bound to, for the Worker's audit entries: never its page, what it read, or anything typed. A write
/// step's request is also its action (`requestId`, `actionId`: one id).
export type StepBinding = { stepId: string; taskId: string; attemptId: string; signInId?: string; grantId?: string;
  requestId?: string; actionId?: string };

/// A reported step, as the Worker needs it to land its outcome in the attempt's events.
export type ReportedStep = {
  stepId: string;
  kind: StepKind;
  url: string | null;
  selector: string | null;
  site: string | null;
  /// `submit`: the write's action, for its title.
  action: string | null;
  queuedAt: string;
  outcome: "done" | "failed";
  code: string | null;
  text: string | null;
};

function isStepFailure(value: unknown): value is (typeof STEP_FAILURES)[number] {
  return typeof value === "string" && (STEP_FAILURES as readonly string[]).includes(value);
}

/// Whether a read's text fits: at most 4 KB once written as JSON, so its event fits whatever the text holds.
function readTextFits(text: string): boolean {
  return new TextEncoder().encode(JSON.stringify(text)).byteLength <= MAX_READ_TEXT_BYTES;
}

/// What a report can be checked for before the vault reads its step: `invalid_report` for one no step could take,
/// `text_too_long` for a read's text over 4 KB as JSON, or null. Its step's kind is checked in the vault.
export function reportShapeError(fields: Record<string, unknown>): "invalid_report" | "text_too_long" | null {
  const { outcome, code, text } = fields;
  if (outcome === "done") {
    if (code !== undefined) return "invalid_report";
    if (text === undefined) return null;
    if (typeof text !== "string") return "invalid_report";
    return readTextFits(text) ? null : "text_too_long";
  }
  if (outcome === "failed") return text === undefined && isStepFailure(code) ? null : "invalid_report";
  return "invalid_report";
}

/// A page to open, or null: an https URL with no account in it and no space, at most 2,048 characters as given and as
/// the URL parser writes it.
export function urlOf(value: unknown): URL | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL || /[\s\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hostname === "" ||
      parsed.href.length > MAX_URL) {
    return null;
  }
  return parsed;
}

/// The part of a page to read: a selector of 1 to 256 characters with no control character, null for the whole page,
/// or undefined for anything else.
export function selectorOf(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > MAX_SELECTOR || CONTROL.test(value)) {
    return undefined;
  }
  return value;
}

/// The origins `member` may browse now: those of every working sign-in of the shop that names them.
async function workingOrigins(storage: DurableObjectStorage, tenant: string, member: string): Promise<string[]> {
  const origins = new Set<string>();
  for (const signIn of await liveSignIns(storage, tenant)) {
    if (signIn.state === "working" && signIn.members.includes(member)) for (const origin of signIn.origins) origins.add(origin);
  }
  return [...origins];
}

/// Oldest first: by when it was queued, then by its place in the vault's order, so steps queued in the same millisecond
/// (a worker asks for open, sign in and read one after the other) are handed out in the order they were asked for, not in
/// the order of their random ids. An outpost that signed in before it opened the page would sign in on the wrong page.
export function stepOrder(a: { queuedAt: string; seq?: number; id: string }, b: { queuedAt: string; seq?: number; id: string }): number {
  return a.queuedAt.localeCompare(b.queuedAt) || (a.seq ?? 0) - (b.seq ?? 0) || a.id.localeCompare(b.id);
}

async function stepsOf(storage: DurableObjectStorage, tenant: string): Promise<StepRecord[]> {
  const records = [...(await storage.list<StepRecord>({ prefix: keys.steps })).values()]
    .filter((record) => record.tenant === tenant);
  return records.sort(stepOrder);
}

/// The next place in the order this vault queues steps. A Durable Object lets no other request's storage call in while one
/// of its own is in flight, so with nothing but storage calls between this and the put that keeps it, no two steps share a
/// number.
async function nextStepSeq(storage: DurableObjectStorage): Promise<number> {
  return ((await storage.get<number>(keys.stepSeq)) ?? 0) + 1;
}

/// A step of `tenant` by its id, or null for a malformed id, one never made, one pruned, or another tenant's.
async function stepOf(storage: DurableObjectStorage, tenant: string, id: unknown): Promise<StepRecord | null> {
  if (typeof id !== "string" || !UUID.test(id)) return null;
  const record = await storage.get<StepRecord>(keys.step(id));
  return record && record.tenant === tenant ? record : null;
}

/// The step refused with `code`, keeping nothing it read.
function refusedStep(step: StepRecord, code: string, at: string): StepRecord {
  return { ...step, state: "refused", outcome: null, code, text: null, settledAt: at };
}

function bindingOfStep(step: StepRecord): StepBinding {
  return { stepId: step.id, taskId: step.taskId, attemptId: step.attemptId,
    ...(step.signInId !== null ? { signInId: step.signInId } : {}),
    ...(step.grantId !== null ? { grantId: step.grantId } : {}),
    ...(typeof step.requestId === "string" ? { requestId: step.requestId, actionId: step.requestId } : {}) };
}

function workerView(step: StepRecord, nowMs: number): BrowserStepView {
  const running = step.state === "queued" || step.state === "taken" || step.state === "reported";
  const state: BrowserStepView["state"] = !running ? step.state as BrowserStepView["state"]
    : !(nowMs < Date.parse(step.expiresAt)) ? "expired" : step.state === "queued" ? "queued" : "taken";
  const ended = state === "done" || state === "failed" || state === "refused";
  return {
    stepId: step.id,
    kind: step.kind,
    outpostId: step.outpostId,
    state,
    queuedAt: step.queuedAt,
    expiresAt: step.expiresAt,
    ...(step.url !== null ? { url: step.url } : {}),
    ...(step.selector !== null ? { selector: step.selector } : {}),
    ...(step.signInId !== null ? { signInId: step.signInId } : {}),
    ...(typeof step.requestId === "string" ? { requestId: step.requestId } : {}),
    ...(ended && step.code !== null ? { code: step.code } : {}),
    ...(ended && step.text !== null ? { text: step.text } : {}),
  };
}

function handedStep(step: StepRecord, origins: string[]): OutpostStep {
  return {
    stepId: step.id,
    kind: step.kind,
    ...(step.url !== null ? { url: step.url } : {}),
    ...(step.selector !== null ? { selector: step.selector } : {}),
    ...(step.grantId !== null ? { grantId: step.grantId } : {}),
    origins,
    expiresAt: step.expiresAt,
  };
}

/// The fields each read kind takes besides the outpost, so nothing rides along that nothing reads.
const STEP_FIELDS: Readonly<Record<ReadStepKind, string>> = { open: "url", read: "selector", sign_in: "grantId" };

/// A step for an outpost to run in the attempt's browser. The member, the task and the attempt come from the control
/// plane, which read them from the task object; the kind, the outpost and what to do are what the worker asked for. In
/// order: the kind (reading only), the outpost (the shop's, and online), then what the kind needs. An `open` goes to an
/// https page on an origin of a working sign-in the member is named on; a `read` needs at least one such sign-in, since
/// its outpost may only be on their origins; a `sign_in` carries an unused grant of this attempt, for this outpost, in
/// no other step, and lives no longer than it.
async function queueStep(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const { member, taskId, attemptId } = body;
  if (typeof member !== "string" || member.length === 0 || member.length > MAX_MEMBER ||
      typeof taskId !== "string" || !TASK_REF.test(taskId) || typeof attemptId !== "string" ||
      !TASK_REF.test(attemptId)) {
    return json({ error: "invalid_request" }, 400);
  }
  // A write is never queued from what a worker asked for: only through `/browser-steps/submit`.
  const kind = READ_STEP_KINDS.find((known) => known === body.kind);
  if (!kind) return json({ error: "step_kind_not_allowed" }, 403);
  if (Object.values(STEP_FIELDS).some((field) => field !== STEP_FIELDS[kind] && body[field] !== undefined)) {
    return json({ error: "invalid_request" }, 400);
  }
  const outpost = await outpostOf(storage, tenant, body.outpostId);
  if (!outpost) return json(OUTPOST_NOT_FOUND, 404);
  const nowMs = Date.now();
  // One that is asleep could not take it in time; better the worker hears so now.
  if (outpostStatus(outpost.lastHeartbeatAt, nowMs) !== "online") return json({ error: "outpost_asleep" }, 409);
  let expiresMs = nowMs + STEP_TTL_MS;
  let url: string | null = null;
  let selector: string | null = null;
  let carried: { grant: GrantRecord; signIn: SignInRecord } | null = null;
  if (kind === "open") {
    const page = urlOf(body.url);
    if (!page) return json({ error: "invalid_url" }, 400);
    if (!(await workingOrigins(storage, tenant, member)).includes(page.origin)) {
      return json({ error: "origin_not_allowed" }, 403);
    }
    url = page.href;
  } else if (kind === "read") {
    const part = selectorOf(body.selector);
    if (part === undefined) return json({ error: "invalid_selector" }, 400);
    selector = part;
    if ((await workingOrigins(storage, tenant, member)).length === 0) return json({ error: "origin_not_allowed" }, 403);
  } else {
    const found = await grantToCarry(storage, tenant, body.grantId, { taskId, attemptId, member, outpostId: outpost.id },
      nowMs);
    if (found instanceof Response) return found;
    carried = found;
    expiresMs = Math.min(expiresMs, Date.parse(found.grant.expiresAt));
  }
  const open = (await stepsOf(storage, tenant)).filter((step) => step.outpostId === outpost.id &&
    (step.state === "queued" || step.state === "taken" || step.state === "reported") &&
    nowMs < Date.parse(step.expiresAt));
  if (open.length >= MAX_OPEN_STEPS) return json({ error: "too_many_steps" }, 409);
  await pruneSteps(storage, nowMs);
  const seq = await nextStepSeq(storage);
  const step: StepRecord = { id: crypto.randomUUID(), tenant, kind, url, selector, grantId: carried?.grant.id ?? null,
    signInId: carried?.signIn.id ?? null, site: carried?.signIn.site ?? null, outpostId: outpost.id, taskId, attemptId,
    member, queuedAt: new Date(nowMs).toISOString(), seq, expiresAt: new Date(expiresMs).toISOString(), takenAt: null,
    reportedAt: null, settledAt: null, state: "queued", outcome: null, code: null, text: null, requestId: null,
    revision: null, action: null };
  await storage.put({ [keys.step(step.id)]: step, [keys.stepSeq]: seq,
    ...(carried ? { [keys.grant(carried.grant.id)]: { ...carried.grant, stepId: step.id } satisfies GrantRecord } : {}) });
  return json({ step: workerView(step, nowMs) });
}

/// The grant a `sign_in` step would carry, with its sign-in, or the refusal. A grant of another attempt or another
/// member reads as one that does not exist, so a worker learns nothing of grants that are not its own.
async function grantToCarry(storage: DurableObjectStorage, tenant: string, grantId: unknown,
  bound: { taskId: string; attemptId: string; member: string; outpostId: string }, nowMs: number):
  Promise<{ grant: GrantRecord; signIn: SignInRecord } | Response> {
  const grant = typeof grantId === "string" && UUID.test(grantId)
    ? await storage.get<GrantRecord>(keys.grant(grantId)) : undefined;
  if (!grant || grant.tenant !== tenant || grant.taskId !== bound.taskId || grant.attemptId !== bound.attemptId ||
      grant.member !== bound.member) {
    return json({ error: "grant_not_found" }, 404);
  }
  if (grant.outpostId !== bound.outpostId) return json({ error: "wrong_outpost" }, 403);
  if (grant.usedAt !== null) return json({ error: "grant_used" }, 409);
  if (!(nowMs < Date.parse(grant.expiresAt))) return json({ error: "grant_expired" }, 409);
  if (grant.stepId !== undefined) return json({ error: "grant_queued" }, 409);
  const signIn = await liveSignIn(storage, tenant, grant.signInId);
  const refused = unusable(signIn, grant.member);
  if (refused || !signIn) return json({ error: refused?.error ?? "sign_in_not_found" }, refused?.status ?? 404);
  return { grant, signIn };
}

/// Deletes the steps that ran out of time ten minutes before, ended or not: long enough for a worker to read how its
/// step went, and no longer, since what a read brought back is the shop's own data. Their history is in the audit log,
/// and a landed outcome in the task's events.
async function pruneSteps(storage: DurableObjectStorage, nowMs: number): Promise<void> {
  const dead: string[] = [];
  for (const [key, step] of await storage.list<StepRecord>({ prefix: keys.steps })) {
    if (Date.parse(step.expiresAt) + GRANT_KEEP_MS < nowMs) dead.push(key);
  }
  for (let i = 0; i < dead.length; i += STORAGE_BATCH) await storage.delete(dead.slice(i, i + STORAGE_BATCH));
}

/// The outpost's steps waiting to be handed out, oldest first, five at most: their ids and the attempt each is for,
/// which the Worker checks before any is handed out. Writes nothing.
async function pendingSteps(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const outpost = await authenticated(storage, tenant, body.outpostId, body.credentialHash);
  if (!outpost) return json(UNAUTHORIZED, 401);
  const nowMs = Date.now();
  const waiting = (await stepsOf(storage, tenant)).filter((step) => step.outpostId === outpost.id &&
    step.state === "queued" && nowMs < Date.parse(step.expiresAt)).slice(0, MAX_FETCH_STEPS);
  return json({ steps: waiting.map((step) => ({ stepId: step.id, kind: step.kind, taskId: step.taskId,
    attemptId: step.attemptId })) });
}

/// Up to five step ids, or null.
function stepIdsOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= MAX_FETCH_STEPS &&
    value.every((id): id is string => typeof id === "string") ? value : null;
}

/// Up to five `{ stepId, code }`, or null.
function stepRefusalsOf(value: unknown): { stepId: string; code: string }[] | null {
  if (!Array.isArray(value) || value.length > MAX_FETCH_STEPS) return null;
  const refusals: { stepId: string; code: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.stepId !== "string" || typeof entry.code !== "string" ||
        !CODE.test(entry.code)) {
      return null;
    }
    refusals.push({ stepId: entry.stepId, code: entry.code });
  }
  return refusals;
}

/// What a step may still do as it is handed out: the origins its outpost may be on for it now, or why it may no longer
/// run. They are read from the sign-ins again, since one may have been removed or broken since the step was queued;
/// and a `sign_in` step's grant must still be unused and on time.
async function allowedNow(storage: DurableObjectStorage, tenant: string, step: StepRecord, nowMs: number):
  Promise<{ origins: string[] } | { code: string }> {
  if (step.kind === "submit") {
    // A write's browser may be on its page's origin alone, and only while that is still an origin of the write's
    // sign-in, working and naming the step's member.
    const signIn = await liveSignIn(storage, tenant, step.signInId);
    const refused = unusable(signIn, step.member);
    if (refused || !signIn) return { code: refused?.error ?? "sign_in_not_found" };
    const origin = step.url !== null ? new URL(step.url).origin : null;
    return origin !== null && signIn.origins.includes(origin) ? { origins: [origin] } : { code: "origin_not_allowed" };
  }
  if (step.kind === "sign_in") {
    const grant = step.grantId !== null ? await storage.get<GrantRecord>(keys.grant(step.grantId)) : undefined;
    if (!grant || grant.tenant !== tenant) return { code: "grant_not_found" };
    if (grant.usedAt !== null) return { code: "grant_used" };
    if (!(nowMs < Date.parse(grant.expiresAt))) return { code: "grant_expired" };
    const signIn = await liveSignIn(storage, tenant, grant.signInId);
    const refused = unusable(signIn, step.member);
    if (refused || !signIn) return { code: refused?.error ?? "sign_in_not_found" };
    return { origins: signIn.origins };
  }
  const origins = await workingOrigins(storage, tenant, step.member);
  if (origins.length === 0 || (step.url !== null && !origins.includes(new URL(step.url).origin))) {
    return { code: "origin_not_allowed" };
  }
  return { origins };
}

/// Hands out the steps the Worker let through, once each, and refuses those it could not (the switches, consent, or
/// an attempt that ended). Only steps still waiting for this outpost and on time are touched, so one that another fetch
/// took, or that ran out of time meanwhile, is left as it is. A step handed out is read against the sign-ins again
/// (`allowedNow`), and refused if it may no longer run. Nothing here awaits anything but this object's own storage, so
/// no request comes between the reads and the one write.
async function takeSteps(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const outpost = await authenticated(storage, tenant, body.outpostId, body.credentialHash);
  if (!outpost) return json(UNAUTHORIZED, 401);
  const take = stepIdsOf(body.take);
  const refuse = stepRefusalsOf(body.refuse);
  if (!take || !refuse) return json({ error: "invalid_request" }, 400);
  const nowMs = Date.now();
  const at = new Date(nowMs).toISOString();
  const writes: Record<string, StepRecord> = {};
  const taken: { step: OutpostStep; binding: StepBinding; revision?: number }[] = [];
  const refused: { code: string; binding: StepBinding }[] = [];
  const waiting = async (stepId: string) => {
    const step = await stepOf(storage, tenant, stepId);
    return step && step.outpostId === outpost.id && step.state === "queued" && nowMs < Date.parse(step.expiresAt) &&
      writes[keys.step(step.id)] === undefined ? step : null;
  };
  const refuseStep = (step: StepRecord, code: string) => {
    writes[keys.step(step.id)] = refusedStep(step, code, at);
    refused.push({ code, binding: bindingOfStep(step) });
  };
  for (const { stepId, code } of refuse) {
    const step = await waiting(stepId);
    if (step) refuseStep(step, code);
  }
  for (const stepId of take) {
    const step = await waiting(stepId);
    if (!step) continue;
    const allowed = await allowedNow(storage, tenant, step, nowMs);
    if ("code" in allowed) {
      refuseStep(step, allowed.code);
      continue;
    }
    const handed: StepRecord = { ...step, state: "taken", takenAt: at };
    writes[keys.step(step.id)] = handed;
    taken.push({ step: handedStep(handed, allowed.origins), binding: bindingOfStep(step),
      ...(typeof step.revision === "number" ? { revision: step.revision } : {}) });
  }
  await putAll(storage, writes);
  return json({ taken, refused });
}

/// The step an authenticated outpost reports, if it may report it now, or the refusal. The binding goes with every
/// refusal about a step that exists, for the Worker's audit entry; the Worker never passes it to the outpost.
async function reportable(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>, nowMs: number):
  Promise<StepRecord | Response> {
  const outpost = await authenticated(storage, tenant, body.outpostId, body.credentialHash);
  if (!outpost) return json(UNAUTHORIZED, 401);
  const step = await stepOf(storage, tenant, body.stepId);
  if (!step) return json({ error: "step_not_found" }, 404);
  const binding = bindingOfStep(step);
  if (step.outpostId !== outpost.id) return json({ error: "wrong_outpost", binding }, 403);
  // Never handed out (waiting, or refused before it was): the outpost cannot have run it.
  if (step.takenAt === null) return json({ error: "step_not_fetched", binding }, 409);
  if (step.state !== "taken") return json({ error: "step_reported", binding }, 409);
  if (!(nowMs < Date.parse(step.expiresAt))) return json({ error: "step_expired", binding }, 409);
  return step;
}

/// What a report says happened, as its step's kind allows it, or null: `done` with the page's text for a read and with
/// nothing for the other kinds, or `failed` with a code from STEP_FAILURES and no text.
function outcomeOf(kind: StepKind, body: Record<string, unknown>):
  { outcome: "done" | "failed"; code: string | null; text: string | null } | null {
  if (body.outcome === "done" && body.code === undefined) {
    if (kind !== "read") return body.text === undefined ? { outcome: "done", code: null, text: null } : null;
    return typeof body.text === "string" && readTextFits(body.text) ? { outcome: "done", code: null, text: body.text }
      : null;
  }
  if (body.outcome === "failed" && body.text === undefined && isStepFailure(body.code)) {
    return { outcome: "failed", code: body.code, text: null };
  }
  return null;
}

/// Whether `text` holds the password of any of the shop's live sign-ins. Each is unsealed here, inside the vault, and
/// compared here, so no password leaves for this check. A seal that cannot be opened counts as held: a read is withheld
/// rather than let through unchecked.
async function holdsPassword(storage: DurableObjectStorage, vaultKeys: SignInVaultKeys, tenant: string, text: string):
  Promise<boolean> {
  const signIns = await liveSignIns(storage, tenant);
  if (signIns.length === 0) return false;
  const key = vaultKeys.CRED_KEY;
  if (!key) return true;
  for (const signIn of signIns) {
    try {
      if (text.includes(await openSecret(signIn.sealed, key, vaultKeys.CRED_KEY_PREVIOUS))) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/// The outpost's report of how a step it took went: once, from that outpost, within the step's time. It is held as
/// `reported` until the Worker has landed it in the attempt's events (`settleStep`), and from here a second report is
/// refused, whatever comes next. A read whose text holds the password of one of the shop's sign-ins is held as failed,
/// `text_withheld`, and the text is kept nowhere: whatever the page or the outpost did, no password reaches the task's
/// events, the log or the worker.
async function reportStep(storage: DurableObjectStorage, vaultKeys: SignInVaultKeys, tenant: string,
  body: Record<string, unknown>): Promise<Response> {
  const step = await reportable(storage, tenant, body, Date.now());
  if (step instanceof Response) return step;
  const said = outcomeOf(step.kind, body);
  if (!said) return json({ error: "invalid_report", binding: bindingOfStep(step) }, 400);
  // Unsealing lets other requests in, so the step is read and checked again after it, before anything is written.
  const withheld = said.text !== null && (await holdsPassword(storage, vaultKeys, tenant, said.text));
  const nowMs = Date.now();
  const again = await reportable(storage, tenant, body, nowMs);
  if (again instanceof Response) return again;
  const outcome = withheld ? "failed" : said.outcome;
  const held: StepRecord = { ...again, state: "reported", reportedAt: new Date(nowMs).toISOString(), outcome,
    ...(withheld ? { code: "text_withheld", text: null } : { code: said.code, text: said.text }) };
  await storage.put(keys.step(held.id), held);
  return json({ binding: bindingOfStep(held), step: { stepId: held.id, kind: held.kind, url: held.url,
    selector: held.selector, site: held.site, action: held.action ?? null, queuedAt: held.queuedAt, outcome,
    code: held.code, text: held.text } satisfies ReportedStep });
}

/// The Worker's word on a reported step: landed in the attempt's events, so it stands as the outpost said; or, with a
/// `code` (the switches, consent, an attempt that ended, a task that could not be written), not allowed to stand, so it
/// reads refused with that code and what it read is dropped.
async function settleStep(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const step = await stepOf(storage, tenant, body.stepId);
  if (!step) return json({ error: "step_not_found" }, 404);
  if (step.state !== "reported" || step.outcome === null) return json({ error: "step_not_reported" }, 409);
  if (body.code !== undefined && (typeof body.code !== "string" || !CODE.test(body.code))) {
    return json({ error: "invalid_request" }, 400);
  }
  const at = new Date().toISOString();
  const settled: StepRecord = typeof body.code === "string" ? refusedStep(step, body.code, at)
    : { ...step, state: step.outcome, settledAt: at };
  await storage.put(keys.step(step.id), settled);
  return json({ step: { stepId: step.id, state: settled.state } });
}

/// A write step for an approved request (browser-writes.ts, `queueSubmitStep`). The request, its revision and the write's
/// sign-in, page and action are what the Worker read from the task object's approved request, never the worker's word;
/// the member, the task and the attempt are the control plane's. In order: the outpost (the shop's, and online); the
/// sign-in (live, naming the member, working) and the page on one of its origins; no other step waiting or running for the
/// same request, so a request is in one step at a time; and the outpost's room for another step. The values are not
/// here: the outpost gets them from the approved write as the begin gate moves it, and only then.
async function queueSubmit(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const { member, taskId, attemptId, requestId, revision, action, site } = body;
  if (typeof member !== "string" || member.length === 0 || member.length > MAX_MEMBER ||
      typeof taskId !== "string" || !TASK_REF.test(taskId) || typeof attemptId !== "string" ||
      !TASK_REF.test(attemptId) || typeof requestId !== "string" || !UUID.test(requestId) ||
      typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 ||
      typeof action !== "string" || !CODE.test(action) || typeof site !== "string" || siteOf(site) !== site) {
    return json({ error: "invalid_request" }, 400);
  }
  const page = urlOf(body.url);
  if (!page) return json({ error: "invalid_request" }, 400);
  const outpost = await outpostOf(storage, tenant, body.outpostId);
  if (!outpost) return json(OUTPOST_NOT_FOUND, 404);
  const nowMs = Date.now();
  if (outpostStatus(outpost.lastHeartbeatAt, nowMs) !== "online") return json({ error: "outpost_asleep" }, 409);
  const signIn = await liveSignIn(storage, tenant, body.signInId);
  const refused = unusable(signIn, member);
  if (refused || !signIn) return json({ error: refused?.error ?? "sign_in_not_found" }, refused?.status ?? 404);
  if (!signIn.origins.includes(page.origin)) return json({ error: "origin_not_allowed" }, 403);
  const steps = await stepsOf(storage, tenant);
  const live = (step: StepRecord) => (step.state === "queued" || step.state === "taken" || step.state === "reported") &&
    nowMs < Date.parse(step.expiresAt);
  if (steps.some((step) => step.requestId === requestId && live(step))) return json({ error: "request_queued" }, 409);
  if (steps.filter((step) => step.outpostId === outpost.id && live(step)).length >= MAX_OPEN_STEPS) {
    return json({ error: "too_many_steps" }, 409);
  }
  await pruneSteps(storage, nowMs);
  const seq = await nextStepSeq(storage);
  const step: StepRecord = { id: crypto.randomUUID(), tenant, kind: "submit", url: page.href, selector: null,
    grantId: null, signInId: signIn.id, site, outpostId: outpost.id, taskId, attemptId, member,
    queuedAt: new Date(nowMs).toISOString(), seq, expiresAt: new Date(nowMs + STEP_TTL_MS).toISOString(), takenAt: null,
    reportedAt: null, settledAt: null, state: "queued", outcome: null, code: null, text: null, requestId, revision,
    action };
  await storage.put({ [keys.step(step.id)]: step, [keys.stepSeq]: seq });
  return json({ step: workerView(step, nowMs) });
}

/// The Worker's word that a write step it has just taken could not be begun, or begun and handed out, so the outpost
/// never had it: it is refused with `code`. Only a write step that was taken and not reported can be refused this way.
async function refuseTaken(storage: DurableObjectStorage, tenant: string, body: Record<string, unknown>):
  Promise<Response> {
  const step = await stepOf(storage, tenant, body.stepId);
  if (!step) return json({ error: "step_not_found" }, 404);
  if (typeof body.code !== "string" || !CODE.test(body.code)) return json({ error: "invalid_request" }, 400);
  if (step.kind !== "submit" || step.state !== "taken") return json({ error: "step_not_taken" }, 409);
  const refused = refusedStep(step, body.code, new Date().toISOString());
  await storage.put(keys.step(step.id), refused);
  return json({ step: { stepId: step.id, state: refused.state } });
}

/// `GET /browser-steps/view?stepId=&taskId=&attemptId=`: a step as the worker that queued it sees it. A step of another
/// attempt reads as not found.
async function viewStep(storage: DurableObjectStorage, tenant: string, url: URL): Promise<Response> {
  const step = await stepOf(storage, tenant, url.searchParams.get("stepId"));
  if (!step || step.taskId !== url.searchParams.get("taskId") || step.attemptId !== url.searchParams.get("attemptId")) {
    return json({ error: "step_not_found" }, 404);
  }
  return json({ step: workerView(step, Date.now()) });
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
function namedIds(ids: { signInId?: unknown; outpostId?: unknown; grantId?: unknown }): AuditSubject {
  return {
    ...(typeof ids.signInId === "string" && UUID.test(ids.signInId) ? { signInId: ids.signInId } : {}),
    ...(typeof ids.outpostId === "string" && UUID.test(ids.outpostId) ? { outpostId: ids.outpostId } : {}),
    ...(typeof ids.grantId === "string" && UUID.test(ids.grantId) ? { grantId: ids.grantId } : {}),
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

/// One of the shop's site sign-ins as a worker sees it (job-flow.ts, `signIns`): enough to choose one by its site and ask
/// for a grant, and nothing a worker has no use for: never the account, nor who else may use it.
export type WorkerSignIn = { signInId: string; site: string; origins: string[]; state: "working" | "broken" };

/// The worker's list of sign-ins (job-flow.ts, `signIns`), once the port has read the switches and consent and the
/// attempt's own heartbeat: the shop's live sign-ins this attempt's member is named on, oldest first. A broken one is
/// listed as broken, since a grant for it is refused until the owner types a new password. Nothing is written to the
/// audit log: a list changes nothing and reaches no site.
export async function signInsFor(env: VaultEnv, attempt: AttemptRef):
  Promise<{ ok: true; value: { signIns: WorkerSignIn[] } } | { ok: false; error: string }> {
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, attempt.tenant, "GET", "/sign-ins"));
  } catch {
    answer = null;
  }
  if (!answer || answer.status !== 200 || !Array.isArray(answer.body.signIns)) {
    return { ok: false, error: "vault_unavailable" };
  }
  const signIns = (answer.body.signIns as unknown[]).filter((view): view is SignInView =>
    isRecord(view) && Array.isArray(view.members) && view.members.includes(attempt.member))
    .map((view) => ({ signInId: view.id, site: view.site, origins: [...view.origins], state: view.state }));
  return { ok: true, value: { signIns } };
}

/// The worker's browser step (job-flow.ts, `browserStep`), once the port has read the switches and consent and the
/// attempt's own heartbeat. Only the fields a step can have are passed on, with the attempt's own member, task and
/// attempt. Writes `browser_step.queued`, queued or refused, under the attempt, with ids only: never the page, the
/// selector, or anything else the worker wrote.
export async function queueBrowserStep(env: VaultEnv, attempt: AttemptRef, step: unknown):
  Promise<{ ok: true; value: BrowserStepView } | { ok: false; error: string }> {
  const { tenant, taskId, attemptId, member } = attempt;
  const asked = isRecord(step) ? step : {};
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, tenant, "POST", "/browser-steps", { kind: asked.kind,
      outpostId: asked.outpostId, url: asked.url, selector: asked.selector, grantId: asked.grantId, member, taskId,
      attemptId }));
  } catch {
    answer = null;
  }
  if (!answer) return { ok: false, error: "vault_unavailable" };
  const actor: AuditActor = { kind: "worker", attemptId };
  if (answer.status !== 200 || !isRecord(answer.body.step)) {
    const error = refusalOf(answer.body);
    await appendAudit(env, tenant, { actor, action: "browser_step.queued", subject: {
      ...namedIds({ outpostId: asked.outpostId, grantId: asked.grantId }), taskId, attemptId }, outcome: "refused",
    reason: error });
    return { ok: false, error };
  }
  const queued = answer.body.step as BrowserStepView;
  await appendAudit(env, tenant, { actor, action: "browser_step.queued", subject: { stepId: queued.stepId,
    ...namedIds({ outpostId: queued.outpostId, signInId: queued.signInId,
      grantId: queued.kind === "sign_in" ? asked.grantId : undefined }), taskId, attemptId }, outcome: "ok" });
  return { ok: true, value: queued };
}

/// How one of the attempt's browser steps stands (job-flow.ts, `browserStepOutcome`), once the port has read the
/// switches, consent and the attempt's own heartbeat. Another attempt's step reads as not found. A read changes
/// nothing, so it is not written to the audit log.
export async function readBrowserStep(env: VaultEnv, attempt: AttemptRef, stepId: unknown):
  Promise<{ ok: true; value: BrowserStepView } | { ok: false; error: string }> {
  if (typeof stepId !== "string" || !UUID.test(stepId)) return { ok: false, error: "step_not_found" };
  const query = new URLSearchParams({ stepId, taskId: attempt.taskId, attemptId: attempt.attemptId });
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, attempt.tenant, "GET", `/browser-steps/view?${query.toString()}`));
  } catch {
    answer = null;
  }
  if (!answer) return { ok: false, error: "vault_unavailable" };
  if (answer.status !== 200 || !isRecord(answer.body.step)) return { ok: false, error: refusalOf(answer.body) };
  return { ok: true, value: answer.body.step as BrowserStepView };
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
