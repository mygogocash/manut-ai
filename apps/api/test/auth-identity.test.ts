import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { appleIdentity, signIn } from "./people-fixtures";
import { sourceWorker as SELF } from "./source-worker";

// The email Apple verified, kept on the session (docs/people.md, "What a helper signs in with"). The tenant stays the
// Apple subject; the email is only what an email invite is checked against. These go through the lifted auth's real
// exchange and refresh with identity tokens signed by the committed test key, the auth's test-token path.

const bindings = env as unknown as Env;

/// What AUTH's own check of an access token answers: the tenant, and the verified email when the session has one.
async function verify(accessToken: string): Promise<{ ok: boolean; tenant?: string; email?: string }> {
  const response = await bindings.AUTH.get(bindings.AUTH.idFromName("auth")).fetch(new Request("https://auth/verify", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: accessToken }) }));
  return (await response.json()) as { ok: boolean; tenant?: string; email?: string };
}

async function exchange(claims: Record<string, unknown>) {
  const response = await SELF.fetch("https://api.manut.test/v1/auth/exchange", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken: await appleIdentity(claims), nonce: "people-nonce",
      deviceId: "identity-device" }) });
  expect(response.status).toBe(200);
  return (await response.json()) as { accessToken: string; refreshToken: string; tenant: string };
}

describe("the email a session keeps", () => {
  it("keeps the email Apple verified, lower-cased, and the subject as the tenant", async () => {
    const sub = `identity-${crypto.randomUUID()}`;
    const session = await exchange({ sub, email: " Mint@BaanMali.Example ", email_verified: true });
    expect(session.tenant).toBe(`apple:${sub}`);
    expect(await verify(session.accessToken)).toEqual({ ok: true, tenant: `apple:${sub}`, email: "mint@baanmali.example" });
  });

  it("takes Apple's string form of email_verified too", async () => {
    const session = await exchange({ sub: `identity-${crypto.randomUUID()}`, email: "beam@baanmali.example",
      email_verified: "true" });
    expect((await verify(session.accessToken)).email).toBe("beam@baanmali.example");
  });

  it("keeps no email Apple did not verify, and none that is not an address", async () => {
    for (const claims of [
      { email: "fon@baanmali.example" },
      { email: "fon@baanmali.example", email_verified: false },
      { email: "fon@baanmali.example", email_verified: "false" },
      { email: "not an address", email_verified: true },
      { email: 42, email_verified: true },
    ]) {
      const session = await exchange({ sub: `identity-${crypto.randomUUID()}`, ...claims });
      const verified = await verify(session.accessToken);
      expect(verified.ok).toBe(true);
      expect(verified).not.toHaveProperty("email");
    }
  });

  it("keeps the email through a refresh", async () => {
    const signedIn = await signIn("pim@baanmali.example");
    const refreshed = await SELF.fetch("https://api.manut.test/v1/auth/refresh", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: signedIn.refreshToken, deviceId: signedIn.deviceId }) });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { accessToken: string };
    expect(await verify(next.accessToken)).toEqual({ ok: true, tenant: signedIn.tenant, email: "pim@baanmali.example" });
  });
});
