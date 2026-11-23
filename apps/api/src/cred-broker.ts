/// Broker-only path from a connection id back to its provider secret. Only
/// future connector code holding the binding calls this, with the tenant
/// from a verified session; the store re-checks tenancy before unsealing.
/// No worker route exposes it, so secrets never cross into client traffic,
/// logs, or model context through here.

type BrokerEnv = {
  CRED: DurableObjectNamespace;
};

export async function readConnectionSecret(
  env: BrokerEnv,
  id: string,
  tenant: string,
): Promise<string> {
  const stub = env.CRED.get(env.CRED.idFromName(`t:${tenant || "operator"}`));
  const response = await stub.fetch(
    new Request("https://cred/use", {
      method: "POST",
      headers: { "content-type": "application/json", "x-tenant": tenant },
      body: JSON.stringify({ id }),
    }),
  );
  if (!response.ok) throw new Error(`broker_${response.status}`);
  const payload = (await response.json()) as { refreshToken?: string };
  if (!payload.refreshToken) throw new Error("broker_empty");
  return payload.refreshToken;
}
