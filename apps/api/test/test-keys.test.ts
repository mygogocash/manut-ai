import { createExecutionContext, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthObject } from "../src/auth-object";
import worker, { type Env } from "../src/index";
import { TEST_ORIGIN, testWorker } from "../src/test-origin";
import { appleIdentity } from "./people-fixtures";

// The test-only settings work only on a test Worker, whose PUBLIC_API_ORIGIN is an https origin under `.test`
// (test-origin.ts; the security review of 24 Nov 2026). The test Apple key's private half is committed, so with
// TEST_JWKS_JSON honoured anywhere real anyone could sign in as anyone; the deploy check cannot see a secret of that name.

const bindings = env as unknown as Env;
const NONCE = "people-nonce";

afterEach(() => {
  vi.restoreAllMocks();
});

/// The test config with some settings changed, `undefined` removing one, as an environment that never set it.
function envWith(changes: Record<string, unknown>): Env {
  const target = { ...bindings } as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  return target as unknown as Env;
}

/// An Apple exchange with a token the committed test key signed, through the Worker with `target`'s settings.
async function exchange(target: Env): Promise<Response> {
  const body = JSON.stringify({ provider: "apple", identityToken: await appleIdentity({}), nonce: NONCE,
    deviceId: `device-${crypto.randomUUID()}` });
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  const context = createExecutionContext();
  const response = await worker.fetch(new Request("https://api.manut.test/v1/auth/exchange", { method: "POST", body,
    headers: { "content-type": "application/json", "content-length": String(body.length),
      "cf-connecting-ip": `2001:db8:${groups.join(":")}` } }), target, context);
  await waitOnExecutionContext(context);
  return response;
}

/// The same exchange straight at an auth object with `target`'s settings, past the Worker's own check.
async function exchangeAtObject(target: Env): Promise<[number, unknown]> {
  const stub = bindings.AUTH.get(bindings.AUTH.idFromName(`test-keys-${crypto.randomUUID()}`));
  const body = JSON.stringify({ provider: "apple", identityToken: await appleIdentity({}), nonce: NONCE,
    deviceId: "device-object" });
  return runInDurableObject(stub, async (_instance, state) => {
    const response = await new AuthObject(state, target).fetch(new Request("https://auth/exchange", { method: "POST",
      headers: { "content-type": "application/json" }, body }));
    return [response.status, await response.json()];
  });
}

const REAL = ["https://dev.manut.xyz", "http://api.manut.test", "https://api.manut.test/", "https://api.manut.test:8443",
  "https://api.manut.test.evil.example", "https://API.MANUT.TEST", ""];

describe("a test Worker", () => {
  it("is one whose public origin is an https origin under .test, and nothing else", () => {
    expect(testWorker({ PUBLIC_API_ORIGIN: "https://api.manut.test" })).toBe(true);
    expect(testWorker({ PUBLIC_API_ORIGIN: "https://google.test" })).toBe(true);
    for (const origin of REAL) expect([origin, testWorker({ PUBLIC_API_ORIGIN: origin })]).toEqual([origin, false]);
    expect(testWorker({})).toBe(false);
    // The test config is one, and Google's fake host is checked by the same rule.
    expect(testWorker(bindings)).toBe(true);
    expect(TEST_ORIGIN.test("https://google.test")).toBe(true);
  });
});

describe("the test Apple key", () => {
  it("signs someone in on a test Worker", async () => {
    const response = await exchange(bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tenant: expect.stringMatching(/^apple:/) });
  });

  it("signs no one in anywhere else, at the Worker or at the auth object, and asks Apple nothing", async () => {
    const outbound = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "unexpected_outbound_call" }, { status: 599 }));
    for (const origin of [...REAL, undefined]) {
      const target = envWith({ PUBLIC_API_ORIGIN: origin });
      const response = await exchange(target);
      expect([origin, response.status, await response.json()]).toEqual([origin, 401, { error: "invalid_identity" }]);
      expect([origin, ...(await exchangeAtObject(target))]).toEqual([origin, 401, { error: "invalid_identity" }]);
    }
    // Without Apple's client id, the key alone does not even make Apple sign-in configured.
    expect(await exchangeAtObject(envWith({ PUBLIC_API_ORIGIN: "https://dev.manut.xyz", APPLE_CLIENT_ID: undefined })))
      .toEqual([400, { error: "identity_not_configured" }]);
    expect(outbound).not.toHaveBeenCalled();
  });
});
