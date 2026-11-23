/// Browser control's routes (docs/browser-control.md; the contract is docs/pilot-api.md, "Vault sign-ins and
/// outposts"): the operator's side of the shop's site sign-ins, after the admin gate's exact ADMIN_METHODS entries
/// (index.ts). The records live in the shop's vault object (sign-in-vault.ts).
///
/// Every change is written to the shop's audit log with ids only, after it has happened (`appendAudit`): the record
/// lives in the vault object and the log in the TenantObject, so the entry is best effort and never holds the change
/// up. No entry, and no answer here, holds a password.

import { appendAudit, type AuditAction } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { operatorIdentity } from "./pilot";
import { vaultAnswer, vaultCall, type SignInView, type VaultEnv } from "./sign-in-vault";

const MAX_BODY_BYTES = 16 * 1024;

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

/// `/v1/admin/vault/*`, after the admin gate, which already required both credentials and an exact method. Answers
/// null for any other path.
export async function vaultAdminRoute(
  request: Request,
  url: URL,
  env: VaultEnv,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/v1/admin/vault/")) return null;
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /v1/admin/vault/sign-ins") return listSignIns(env, url);
  const write = OPERATOR_WRITES[route];
  if (write) return operatorWrite(request, env, ctx, write);
  return json({ error: "not_found" }, 404);
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
