import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

// "Nothing is authorized when no secret is configured" is a security
// property, and wrangler.test.json always sets CLOUD_API_KEY, so the rest of
// the suite never runs without one. These tests call the Worker directly with
// the key removed. Only the operator path closes: device sessions from
// AuthObject stay valid without it, and they are covered in auth.test.ts.

const bindings = env as unknown as Env;

const ROUTES: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/v1/tasks/x" },
  {
    method: "PUT",
    path: "/v1/tasks/x",
    body: {
      id: "x",
      title: "t",
      objective: "o",
      state: "draft",
      location: "cloud",
      funding: "cloudBYOK",
      criteria: [],
      updatedAt: new Date().toISOString(),
    },
  },
  {
    method: "POST",
    path: "/v1/tasks",
    body: {
      id: "fail-closed-task",
      title: "t",
      objective: "o",
      state: "draft",
      location: "cloud",
      funding: "cloudBYOK",
      criteria: [],
      updatedAt: new Date().toISOString(),
    },
  },
  { method: "GET", path: "/v1/connections?tenant=operator-dev" },
  { method: "GET", path: "/v1/consent/cloud?tenant=operator-dev" },
  { method: "GET", path: "/v1/admin/flags" },
];

async function send(
  target: Env,
  route: { method: string; path: string; body?: unknown },
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "idempotency-key": "fail-closed" };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  const ctx = createExecutionContext();
  if (route.path.startsWith("/v1/admin/")) Object.defineProperty(ctx, "access", {
    value: { aud: bindings.ADMIN_ACCESS_AUD, getIdentity: async () => undefined }, configurable: true,
  });
  const response = await worker.fetch(
    new Request(`https://test${route.path}`, {
      method: route.method,
      headers,
      ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
    }),
    target,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("operator key fails closed", () => {
  for (const [label, missing] of [
    ["unset", { ...bindings, CLOUD_API_KEY: undefined }],
    ["empty", { ...bindings, CLOUD_API_KEY: "" }],
  ] as const) {
    it(`authorizes no bearer when the key is ${label}`, async () => {
      const target = missing as unknown as Env;
      for (const route of ROUTES) {
        for (const bearer of [undefined, "test-key", "", "undefined", "anything"]) {
          const response = await send(target, route, bearer);
          expect({ route: `${route.method} ${route.path}`, bearer, status: response.status }).toEqual({
            route: `${route.method} ${route.path}`,
            bearer,
            status: route.path.startsWith("/v1/admin/") ? 403 : 401,
          });
          expect(((await response.json()) as { error?: string }).error)
            .toBe(route.path.startsWith("/v1/admin/") ? "forbidden" : "unauthorized");
        }
      }
    });

    it(`still serves health when the key is ${label}`, async () => {
      const response = await send(missing as unknown as Env, { method: "GET", path: "/v1/health" });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { ok?: boolean }).ok).toBe(true);
    });
  }

  it("authorizes the same call once the key is configured", async () => {
    // Control: the harness itself works, so the 401s above come from the
    // missing key and not from calling the Worker this way.
    const response = await send(bindings, { method: "GET", path: "/v1/admin/flags" }, "test-key");
    expect(response.status).toBe(200);
  });
});
