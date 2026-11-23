import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

type AdminEnv = Env & { ADMIN_ACCESS_AUD?: string };
const bindings = env as unknown as AdminEnv;
const AUDIENCE = "test-admin-audience";
const adminRoutes = [
  ["/v1/admin/flags", "GET"], ["/v1/admin/flags", "PUT"],
  ["/v1/admin/prune", "POST"], ["/v1/admin/entitlements", "GET"],
  ["/v1/admin/entitlements", "PUT"], ["/v1/admin/connections", "POST"],
] as const;

function fixture() {
  let authCalls = 0;
  let taskWrites = 0;
  let indexed = 0;
  const target: AdminEnv = { ...bindings, ADMIN_ACCESS_AUD: AUDIENCE,
    AUTH: { idFromName: (name: string) => bindings.AUTH.idFromName(name), get: () => ({ fetch: async (request: Request) => {
      authCalls++;
      if (new URL(request.url).pathname === "/verify") return Response.json({ ok: true, tenant: "apple:fixture" });
      return Response.json({ officeCloud: true });
    } }) } as unknown as DurableObjectNamespace,
    TENANT: { idFromName: (name: string) => bindings.TENANT.idFromName(name), get: () => ({ fetch: async (request: Request) => {
      if (new URL(request.url).pathname === "/index") indexed++;
      return Response.json({ cloudWork: true });
    } }) } as unknown as DurableObjectNamespace,
    TASK: { idFromName: (name: string) => bindings.TASK.idFromName(name), get: () => ({ fetch: async (request: Request) => {
      if (request.method !== "GET") taskWrites++;
      return Response.json({ id: "fixture-task", tenantId: "apple:fixture" });
    } }) } as unknown as DurableObjectNamespace,
  };
  return { target, authCalls: () => authCalls, taskWrites: () => taskWrites, indexed: () => indexed };
}

async function send(request: Request, target: AdminEnv, audience?: string) {
  const context = createExecutionContext();
  if (audience !== undefined) Object.defineProperty(context, "access", {
    value: { aud: audience, getIdentity: async () => undefined }, configurable: true,
  });
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

function input(path: string, method: string, bearer = "test-key") {
  let pulls = 0;
  const body = ["POST", "PUT"].includes(method) ? new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); },
  }, { highWaterMark: 0 }) : undefined;
  return { request: new Request(`https://test${path}`, { method, headers: {
    authorization: `Bearer ${bearer}`, "content-type": "application/json", "cf-access-jwt-assertion": "forged.fixture.jwt",
  }, ...(body ? { body } : {}) }), pulls: () => pulls };
}

describe("operator and trusted evidence boundaries", () => {
  it.each(adminRoutes)("refuses %s without matching platform Access before reading or AUTH", async (path, method) => {
    for (const audience of [undefined, "another-application"]) {
      const counter = fixture();
      const request = input(path, method);
      expect((await send(request.request, counter.target, audience)).status).toBe(403);
      expect(request.pulls()).toBe(0);
      expect(counter.authCalls()).toBe(0);
    }
  });

  it.each([undefined, "", "   "])("fails closed with an unset/empty configured audience (%s)", async (audience) => {
    const counter = fixture();
    if (audience === undefined) delete counter.target.ADMIN_ACCESS_AUD;
    else counter.target.ADMIN_ACCESS_AUD = audience;
    expect((await send(input("/v1/admin/flags", "GET").request, counter.target, AUDIENCE)).status).toBe(403);
    expect(counter.authCalls()).toBe(0);
  });

  it.each(["fixture-session", "wrong-key", ""])("requires the operator bearer even with matching Access (%s)", async (bearer) => {
    const counter = fixture();
    expect((await send(input("/v1/admin/flags", "GET", bearer).request, counter.target, AUDIENCE)).status).toBe(403);
    expect(counter.authCalls()).toBe(0);
  });

  it.each([
    ["/v1/tasks/fixture-task", "GET"], ["/v1/tasks/fixture-task", "PUT"],
    ["/v1/tasks", "POST"], ["/v1/connections", "GET"], ["/v1/connections", "POST"],
    ["/v1/consent/cloud", "GET"], ["/v1/companies", "POST"],
  ] as const)("never promotes the operator key on tenant route %s", async (path, method) => {
    const counter = fixture();
    const request = input(path, method);
    expect((await send(request.request, counter.target, AUDIENCE)).status).toBe(401);
    expect(request.pulls()).toBe(0);
    expect(counter.authCalls()).toBe(0);
    expect(counter.taskWrites()).toBe(0);
    expect(counter.indexed()).toBe(0);
  });

  it.each([["/v1/admin/unknown", "POST"], ["/v1/admin/flags", "DELETE"],
    ["/v1/admin/connections", "GET"]] as const)("denies unknown admin methods/routes %s", async (path, method) => {
    const counter = fixture();
    const request = input(path, method);
    expect((await send(request.request, counter.target, AUDIENCE)).status).toBe(404);
    expect(request.pulls()).toBe(0);
    expect(counter.authCalls()).toBe(0);
  });

  it.each(["human", "check:unit-suite"])("rejects client provenance %s on POST and PUT before task/index writes", async (by) => {
    for (const method of ["POST", "PUT"]) {
      const counter = fixture();
      const body = { id: "fixture-task", title: "Fixture", objective: "Fixture", state: "completed",
        location: "cloud", funding: "cloudBYOK", criteria: [{ id: "criterion", text: "Fixture", satisfied: true, by }] };
      const response = await send(new Request(`https://test/v1/tasks${method === "PUT" ? "/fixture-task" : ""}`, {
        method, headers: { authorization: "Bearer fixture-session", "content-type": "application/json",
          "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body),
      }), counter.target);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "client_provenance_forbidden" });
      expect(counter.taskWrites()).toBe(0);
      expect(counter.indexed()).toBe(0);
    }
  });

  it("provisions real vault/index objects through a matching simulated admin context", async () => {
    const workspace = `workspace-${crypto.randomUUID()}`;
    const tenant = `apple:admin-${crypto.randomUUID()}`;
    const headers = { authorization: "Bearer test-key", "content-type": "application/json" };
    expect((await send(new Request("https://test/v1/admin/flags", { headers }), bindings, AUDIENCE)).status).toBe(200);
    const response = await send(new Request("https://test/v1/admin/connections", { method: "POST", headers,
      body: JSON.stringify({ tenantId: tenant, provider: "linear", accountId: workspace,
        scopes: ["read"], resourceIds: ["project-fixture"], refreshToken: "synthetic-linear-token" }),
    }), bindings, AUDIENCE);
    expect(response.status).toBe(200);
    const created = await response.json() as { id: string };
    const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    const indexed = await auth.fetch(`https://auth/inbound-routes?provider=linear&account=${encodeURIComponent(workspace)}`);
    expect(await indexed.json()).toMatchObject({ routes: [{ tenant, connectionId: created.id }] });
  });
});
