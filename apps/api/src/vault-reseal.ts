/// The operator's re-seal of one shop's vault, after a rotation of the vault's key (reseal.ts).
///
/// Rotating is two Wrangler secrets: `CRED_KEY` set to a new key, and the old one moved to `CRED_KEY_PREVIOUS`, so
/// every secret still opens. Then, for each shop, `POST /v1/admin/vault/reseal` seals the shop's connection secrets and
/// its site sign-ins' passwords again under the new key. Once every shop answers `remaining` 0 for both, nothing needs
/// the previous key and `CRED_KEY_PREVIOUS` can be deleted; until then it must stay, or what still needs it stops
/// opening. The steps are in docs/pilot-api.md, "Re-sealing the vault after a key rotation".

import { appendAudit } from "./audit-log";
import { readJsonBody } from "./body";
import { isValidTenant } from "./companies";
import { hasExactly } from "./people";
import { operatorIdentity } from "./pilot";
import type { ResealCount } from "./reseal";
import { vaultAnswer, vaultCall, type VaultEnv } from "./sign-in-vault";
import { credStub } from "./tenant-data";

const MAX_BODY_BYTES = 4 * 1024;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/// A store's answer to a re-seal, or null when it gave none the Worker understands.
function countOf(answer: { status: number; body: Record<string, unknown> } | null): ResealCount | null {
  if (!answer || answer.status !== 200) return null;
  const { resealed, current, unreadable, remaining } = answer.body;
  return typeof resealed === "number" && typeof current === "number" && typeof remaining === "number" &&
      Array.isArray(unreadable) && unreadable.every((id) => typeof id === "string")
    ? { resealed, current, unreadable: unreadable as string[], remaining }
    : null;
}

/// `POST /v1/admin/vault/reseal` with exactly `{ tenant }`, behind the admin gate (index.ts): the shop's connection
/// secrets and its site sign-ins sealed again under the current key. It answers `{ connections, signIns }`, each a
/// `ResealCount`. A vault with no key answers 503 `vault_not_configured`; one that did not answer, 503
/// `vault_unavailable`. `vault.resealed` goes to the shop's audit log, by the operator, with no ids: it names the shop's
/// whole vault, and the counts are in the answer. Answers null for any other method or path.
export async function vaultResealRoute(request: Request, url: URL, env: VaultEnv, ctx: ExecutionContext):
  Promise<Response | null> {
  if (request.method !== "POST" || url.pathname !== "/v1/admin/vault/reseal") return null;
  const parsed = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
  if (!parsed.ok) return json({ error: parsed.error }, parsed.status);
  if (!isRecord(parsed.value) || !hasExactly(parsed.value, ["tenant"])) return json({ error: "invalid_request" }, 400);
  const tenant = parsed.value.tenant;
  if (!isValidTenant(tenant)) return json({ error: "tenant_required" }, 400);
  const [connections, signIns] = await Promise.all([
    credStub(env, tenant).fetch(new Request("https://cred/connections/reseal", { method: "POST",
      headers: { "x-tenant": tenant, "content-type": "application/json" }, body: "{}" }))
      .then(vaultAnswer).catch(() => null),
    vaultCall(env, tenant, "POST", "/sign-ins/reseal", {}).then(vaultAnswer).catch(() => null),
  ]);
  // Both stores share the one key, so an unconfigured key says so for both.
  if ([connections, signIns].some((answer) => answer?.body.error === "vault_not_configured")) {
    return json({ error: "vault_not_configured" }, 503);
  }
  const counts = { connections: countOf(connections), signIns: countOf(signIns) };
  if (!counts.connections || !counts.signIns) return json({ error: "vault_unavailable" }, 503);
  await appendAudit(env, tenant, { actor: { kind: "operator", email: await operatorIdentity(ctx) },
    action: "vault.resealed", subject: {}, outcome: "ok" });
  return json(counts);
}
