import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { sha256Hex } from "../src/auth";
import worker, { type Env } from "../src/index";
import { sessionIndexKey } from "../src/session-index";
import { sourceWorker } from "./source-worker";

const bindings = env as unknown as Env;

/// Installs a synthetic opaque access record in the actual isolated AUTH object.
/// Task/connector fixtures verify normal tenant access without an operator bypass;
/// auth.test.ts independently exercises real synthetic Apple issuance and refresh.
export async function tenantSession(tenant: string, consent = true): Promise<{ authorization: string }> {
  const token = `synthetic-session-${crypto.randomUUID()}`;
  const hash = await sha256Hex(token);
  const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
  await runInDurableObject(auth, async (_instance, state) => {
    const generation = await state.storage.get<number>(`wiped:${tenant}`) ?? 0;
    const refreshHash = `synthetic-unused-refresh-${crypto.randomUUID()}`;
    // With its row in the tenant's index, as every session the auth object mints has (session-index.ts).
    await state.storage.put({
      [`sat:${hash}`]: { tenant, deviceId: "fixture", exp: Date.now() / 1000 + 3600, refreshHash, wipeGeneration: generation },
      [sessionIndexKey(tenant, refreshHash)]: { accessHash: hash, generation },
    });
  });
  const headers = { authorization: `Bearer ${token}` };
  if (consent) {
    const response = await sourceWorker.fetch("https://test/v1/consent/cloud", { method: "PUT",
      headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    if (response.status !== 200) throw new Error(`fixture_consent_failed_${response.status}`);
  }
  return headers;
}

/// Unit fixture context only: SELF bypasses the local Access entry HTTP router.
/// scripts/admin-access-contract.mjs separately proves native ctx.access through
/// Miniflare.dispatchFetch. Real Access configuration/authentication remains owed.
export async function adminFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  Object.defineProperty(context, "access", { value: { aud: bindings.ADMIN_ACCESS_AUD,
    getIdentity: async () => undefined }, configurable: true });
  const response = await worker.fetch(new Request(input, init), bindings, context);
  await waitOnExecutionContext(context);
  return response;
}

/// Internal-state fixtures model trusted stored provenance. Public PUTs are tested
/// separately and cannot supply human/check evidence to this private object path.
export async function trustedTaskPut(id: string, body: unknown, tenant: string) {
  const task = bindings.TASK.get(bindings.TASK.idFromName(id));
  return task.fetch(new Request("https://task/", { method: "PUT", headers: {
    "content-type": "application/json", "x-task-id": id, "x-tenant": tenant,
  }, body: JSON.stringify(body) }));
}
