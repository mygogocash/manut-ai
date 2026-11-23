/// Browser control's routes (docs/browser-control.md; the contract is docs/pilot-api.md, "Vault sign-ins and
/// outposts"). The records live in the shop's vault object (sign-in-vault.ts).
///
/// - The operator's side of the shop's site sign-ins and outposts, after the admin gate's exact ADMIN_METHODS entries
///   (index.ts).
/// - The outposts' own routes under `/v1/outposts/`, which need the outpost's credential as a bearer token and
///   nothing else: neither an operator's key nor an owner's session opens them.
///
/// Every change is written to the shop's audit log with ids only, after it has happened (`appendAudit`): the record
/// lives in the vault object and the log in the TenantObject, so the entry is best effort and never holds the change
/// up. No entry, and no answer here, holds a password.

import { appendAudit, type AuditAction } from "./audit-log";
import { sha256Hex } from "./auth";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { operatorIdentity } from "./pilot";
import { base64url } from "./relay";
import { vaultAnswer, vaultCall, type OutpostView, type SignInView, type VaultEnv } from "./sign-in-vault";

const MAX_BODY_BYTES = 16 * 1024;
/// An outpost's credential: `mo1_` and 32 random bytes in base64url. Checked before anything is read or woken, so a
/// request that does not even carry one costs the vault nothing.
const OUTPOST_CREDENTIAL = /^mo1_[A-Za-z0-9_-]{43}$/;

/// The operator's writes, the vault path each one is, and what the log calls it.
const OPERATOR_WRITES: Readonly<Record<string, { path: string; action: AuditAction }>> = {
  "POST /v1/admin/vault/sign-ins": { path: "/sign-ins", action: "signin.created" },
  "POST /v1/admin/vault/sign-ins/password": { path: "/sign-ins/password", action: "signin.password_replaced" },
  "POST /v1/admin/vault/sign-ins/remove": { path: "/sign-ins/remove", action: "signin.removed" },
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// `/v1/admin/vault/*` and `/v1/admin/outposts`, after the admin gate, which already required both credentials and an
/// exact method. Answers null for any other path.
export async function vaultAdminRoute(
  request: Request,
  url: URL,
  env: VaultEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/vault/") && url.pathname !== "/v1/admin/outposts") return null;
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /v1/admin/vault/sign-ins") return listSignIns(env, url);
  if (route === "GET /v1/admin/outposts") return listOutposts(env, url);
  if (route === "POST /v1/admin/outposts") return registerOutpost(request, env, ctx);
  const write = OPERATOR_WRITES[route];
  if (write) return operatorWrite(request, env, ctx, write);
  return json({ error: "not_found" }, 404);
}

/// `/v1/outposts/*`, the outposts' own routes. Answers null for any other path, and for a method or path under it that
/// is not a route, so those answer the Worker's final not_found like any path that does not exist.
export async function outpostRoute(request: Request, url: URL, env: VaultEnv): Promise<Response | null> {
  const route = `${request.method} ${url.pathname}`;
  if (route === "POST /v1/outposts/heartbeat") return outpostHeartbeat(request, env);
  return null;
}

/// The outpost's credential from `Authorization: Bearer`, or null when there is none of the right shape.
function presentedCredential(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const credential = header.slice("Bearer ".length);
  return OUTPOST_CREDENTIAL.test(credential) ? credential : null;
}

/// An outpost's request, read: its credential first, so a request without one is refused before its body is read,
/// then `{ tenant, ... }`. Answers the refusal to send, or the tenant, the rest of the body and the credential's digest.
async function outpostRequest(request: Request): Promise<Response |
  { tenant: string; fields: Record<string, unknown>; credentialHash: string }> {
  const credential = presentedCredential(request);
  if (!credential) return json({ error: "unauthorized" }, 401);
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value)) return json({ error: "invalid_request" }, 400);
  const { tenant, ...fields } = parsed.value;
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  return { tenant, fields, credentialHash: await sha256Hex(credential) };
}

/// `POST /v1/outposts/heartbeat` with `{ tenant, outpostId }`: the outpost is awake. Answers it as the operator lists
/// it. Not written to the audit log: a beat changes nothing but its time.
async function outpostHeartbeat(request: Request, env: VaultEnv): Promise<Response> {
  const read = await outpostRequest(request);
  if (read instanceof Response) return read;
  try {
    const answer = await vaultAnswer(await vaultCall(env, read.tenant, "POST", "/outposts/heartbeat",
      { outpostId: read.fields.outpostId, credentialHash: read.credentialHash }));
    if (answer) return json(answer.body, answer.status);
  } catch {
    // Answered below.
  }
  return json({ error: "vault_unavailable" }, 503);
}

/// `GET /v1/admin/outposts?tenant=`: the shop's outposts, oldest first, each `online` or `asleep` as of now. Never a
/// credential or its digest.
async function listOutposts(env: VaultEnv, url: URL): Promise<Response> {
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  try {
    const answer = await vaultAnswer(await vaultCall(env, tenant, "GET", "/outposts"));
    if (!answer || answer.status !== 200) return json({ error: "vault_unavailable" }, 503);
    return json({ tenant, outposts: answer.body.outposts as OutpostView[] });
  } catch {
    return json({ error: "vault_unavailable" }, 503);
  }
}

/// `POST /v1/admin/outposts` with `{ tenant, name, kind }`: registers an outpost and answers its credential, this once.
/// The credential is minted here and only its digest goes to the vault, so it is kept nowhere: an outpost that loses
/// it is registered again.
async function registerOutpost(request: Request, env: VaultEnv, ctx: ExecutionContext): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  if (!isValidTenant(body.tenant)) return json({ error: "tenant_required" }, 400);
  const tenant = body.tenant;
  const credential = `mo1_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, tenant, "POST", "/outposts",
      { name: body.name, kind: body.kind, credentialHash: await sha256Hex(credential) }));
  } catch {
    answer = null;
  }
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  if (answer.status !== 200 || !isRecord(answer.body.outpost)) return json(answer.body, answer.status);
  const outpost = answer.body.outpost as OutpostView;
  await appendAudit(env, tenant, { actor: { kind: "operator", email: await operatorIdentity(ctx) },
    action: "outpost.registered", subject: { outpostId: outpost.id }, outcome: "ok" });
  return json({ outpost, credential });
}

/// `GET /v1/admin/vault/sign-ins?tenant=`: the shop's live sign-ins, oldest first, each saying only that its password
/// is set.
async function listSignIns(env: VaultEnv, url: URL): Promise<Response> {
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  try {
    const answer = await vaultAnswer(await vaultCall(env, tenant, "GET", "/sign-ins"));
    if (!answer || answer.status !== 200) return json({ error: "vault_unavailable" }, 503);
    return json({ tenant, signIns: answer.body.signIns as SignInView[] });
  } catch {
    return json({ error: "vault_unavailable" }, 503);
  }
}

/// `POST /v1/admin/vault/sign-ins{,/password,/remove}` with `{ tenant, ... }`: the operator's change, recorded under
/// the operator's Access identity (none for a service token). Answers what the vault answers: the sign-in's public view
/// on success, or the refusal with its status.
async function operatorWrite(request: Request, env: VaultEnv, ctx: ExecutionContext,
  write: { path: string; action: AuditAction }): Promise<Response> {
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  const body = parsed.value;
  if (!isRecord(body)) return json({ error: "invalid_request" }, 400);
  const { tenant, ...fields } = body;
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  let answer: Awaited<ReturnType<typeof vaultAnswer>>;
  try {
    answer = await vaultAnswer(await vaultCall(env, tenant, "POST", write.path, fields));
  } catch {
    answer = null;
  }
  if (!answer) return json({ error: "vault_unavailable" }, 503);
  if (answer.status === 200) {
    const signInId = isRecord(answer.body.signIn) ? answer.body.signIn.id : answer.body.signInId;
    if (typeof signInId === "string") {
      await appendAudit(env, tenant, { actor: { kind: "operator", email: await operatorIdentity(ctx) },
        action: write.action, subject: { signInId }, outcome: "ok" });
    }
  }
  return json(answer.body, answer.status);
}
