import { sourceWorker as SELF } from "./source-worker";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

// TEST-ONLY Apple keypair. The public half lives in wrangler.test.json
// (TEST_JWKS_JSON); this private half mints test identity tokens. Neither
// half is a production credential, and production never reads TEST_JWKS_JSON.
const TEST_PRIVATE_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "XkiBzVCEinLxSV5HTHlIk_dP5ebqKbf50G0GUVfMdIQ",
  y: "RZYriukHp_ncrsqWDuh0NRFJZR4vQ2ZP7JlWgYLlH_I",
  d: "ANC5uOvB1qXRq2oYPy7NUTVUDVnqYXCjB1FOkLPRmps",
};

const OPERATOR = { authorization: "Bearer test-key" };
const NONCE = "client-nonce-value";

let counter = 3000;
const freshID = () => `auth-task-${Date.now()}-${counter++}`;

function base64Url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function mintIdentity(claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    TEST_PRIVATE_JWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: "test-key-1", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  // Keep this legacy DER test fixture; production JWTs use raw R||S.
  const raw = new Uint8Array(signature);
  const half = raw.length / 2;
  const der = derEncode(raw.slice(0, half), raw.slice(half));
  return `${header}.${payload}.${base64Url(der)}`;
}

function derEncode(r: Uint8Array, s: Uint8Array): Uint8Array {
  const strip = (part: Uint8Array) => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const cut = part.slice(i);
    return cut[0]! >= 128 ? new Uint8Array([0, ...cut]) : cut;
  };
  const rEnc = strip(r);
  const sEnc = strip(s);
  const out = new Uint8Array(2 + 2 + rEnc.length + 2 + sEnc.length);
  out[0] = 0x30;
  out[1] = out.length - 2;
  out[2] = 0x02;
  out[3] = rEnc.length;
  out.set(rEnc, 4);
  out[4 + rEnc.length] = 0x02;
  out[5 + rEnc.length] = sEnc.length;
  out.set(sEnc, 6 + rEnc.length);
  return out;
}

async function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://appleid.apple.com",
    aud: "test-client",
    sub: "test-sub-1",
    iat: now - 60,
    exp: now + 600,
    nonce: await sha256Hex(NONCE),
    ...overrides,
  };
}

async function exchange(identityToken: string, nonce: string = NONCE, deviceId = "device-1") {
  return SELF.fetch("https://test/v1/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "apple", identityToken, nonce, deviceId }),
  });
}

function draft(id: string) {
  return {
    id,
    title: "t",
    objective: "o",
    state: "draft",
    location: "cloud",
    funding: "cloudBYOK",
    criteria: [],
    updatedAt: new Date().toISOString(),
  };
}

describe("device sessions", () => {
  it("restores the same verified subject on repeat native login without name or email", async () => {
    const sub = `native-repeat-${freshID()}`;
    const first = await exchange(await mintIdentity(await validClaims({ sub, email: "native@privaterelay.appleid.com" })));
    const second = await exchange(await mintIdentity(await validClaims({ sub })));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = await first.json() as { tenant: string; accessToken: string };
    const b = await second.json() as { tenant: string; accessToken: string };
    expect(a.tenant).toBe(`apple:${sub}`);
    expect(b.tenant).toBe(a.tenant);
    expect(b.accessToken).not.toBe(a.accessToken);
  });

  it("never joins Apple accounts by matching email addresses", async () => {
    const firstSub = `native-email-a-${freshID()}`;
    const secondSub = `native-email-b-${freshID()}`;
    const email = "shared@example.test";
    const first = await exchange(await mintIdentity(await validClaims({ sub: firstSub, email, email_verified: true })));
    const second = await exchange(await mintIdentity(await validClaims({ sub: secondSub, email, email_verified: true })));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = await first.json() as { tenant: string };
    const b = await second.json() as { tenant: string };
    expect(a.tenant).toBe(`apple:${firstSub}`);
    expect(b.tenant).toBe(`apple:${secondSub}`);
    expect(a.tenant).not.toBe(b.tenant);
  });

  it("rejects malformed, expired, misissued, and misaudienced tokens", async () => {
    const bad = await exchange("not.a.token");
    expect(bad.status).toBe(401);

    const now = Math.floor(Date.now() / 1000);
    const expired = await exchange(
      await mintIdentity({ ...(await validClaims()), exp: now - 10 }),
    );
    expect(expired.status).toBe(401);

    const wrongIss = await exchange(await mintIdentity({ ...(await validClaims()), iss: "https://evil.example" }));
    expect(wrongIss.status).toBe(401);

    const wrongAud = await exchange(await mintIdentity({ ...(await validClaims()), aud: "someone-else" }));
    expect(wrongAud.status).toBe(401);

    const wrongNonce = await exchange(await mintIdentity({ ...(await validClaims()), nonce: "nope" }), "other");
    expect(wrongNonce.status).toBe(401);
  });

  it("refuses a raw nonce claim", async () => {
    const response = await exchange(await mintIdentity({ ...(await validClaims()), nonce: "plain" }), "plain");
    expect(response.status).toBe(401);
  });

  it("atomically consumes an identity token across concurrent devices and later replay", async () => {
    const identity = await mintIdentity(await validClaims({ sub: `replay-${freshID()}` }));
    const responses = await Promise.all([exchange(identity, NONCE, "replay-device-a"), exchange(identity, NONCE, "replay-device-b")]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 401]);
    expect((await exchange(identity, NONCE, "replay-device-c")).status).toBe(401);
  });

  it("keeps a consumed digest through token expiry and cleans expired records", async () => {
    const claims = await validClaims({ sub: `expiry-${freshID()}` });
    const identity = await mintIdentity(claims);
    const namespace = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
    const auth = namespace.get(namespace.idFromName(`expiry-fixture-${freshID()}`));
    const signedIn = await auth.fetch("https://auth/exchange", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "apple", identityToken: identity, nonce: NONCE, deviceId: "expiry-device" }),
    });
    expect(signedIn.status).toBe(200);
    const bytes = await sha256Hex(identity);
    const stored = await runInDurableObject(auth, async (_instance, state) => ({
      expiry: await state.storage.get<number>(`used:${bytes}`), alarm: await state.storage.getAlarm(),
    }));
    expect(stored.expiry).toBe(claims.exp);
    expect(stored.alarm).toBe(claims.exp * 1_000);
    await runInDurableObject(auth, async (_instance, state) => {
      await state.storage.put("used:expired-fixture", Math.floor(Date.now() / 1_000) - 60);
    });
    expect(await runDurableObjectAlarm(auth)).toBe(true);
    const after = await runInDurableObject(auth, async (_instance, state) => ({
      expired: await state.storage.get("used:expired-fixture"), live: await state.storage.get<number>(`used:${bytes}`),
      alarm: await state.storage.getAlarm(),
    }));
    expect(after.expired).toBeUndefined();
    expect(after.live).toBe(claims.exp);
    expect(after.alarm).toBe(claims.exp * 1_000);
  });

  it("refuses an identity that expires between verification and issuance", async () => {
    const started = Date.now();
    const expiry = Math.floor(started / 1_000) + 60;
    const identity = await mintIdentity(await validClaims({ sub: `late-${freshID()}`, exp: expiry }));
    const namespace = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
    const auth = namespace.get(namespace.idFromName(`late-fixture-${freshID()}`));
    const realDigest = crypto.subtle.digest.bind(crypto.subtle);
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, bytes) => {
      const result = await realDigest(algorithm, bytes);
      if (new TextDecoder().decode(bytes) === NONCE) clock.mockReturnValue((expiry + 1) * 1_000);
      return result;
    });
    try {
      const response = await auth.fetch("https://auth/exchange", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "apple", identityToken: identity, nonce: NONCE, deviceId: "late-device" }),
      });
      expect(response.status).toBe(401);
      expect(await runInDurableObject(auth, async (_instance, state) => (await state.storage.list({ prefix: "sat:" })).size))
        .toBe(0);
    } finally {
      digest.mockRestore();
      clock.mockRestore();
    }
  });

  it("cleans multiple storage pages while retaining live and unknown consumption records", async () => {
    const namespace = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
    const auth = namespace.get(namespace.idFromName(`expiry-pages-${freshID()}`));
    const expiry = Math.floor(Date.now() / 1_000) - 60;
    const next = expiry + 660;
    await runInDurableObject(auth, async (_instance, state) => {
      for (let offset = 0; offset < 257; offset += 128) {
        const rows = Object.fromEntries(Array.from({ length: Math.min(128, 257 - offset) }, (_, index) =>
          [`used:expired-${String(offset + index).padStart(3, "0")}`, expiry]));
        await state.storage.put(rows);
      }
      await state.storage.put({ "used:a-live": next + 60, "used:z-live": next, "used:unknown": "corrupt-fixture" });
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    expect(await runDurableObjectAlarm(auth)).toBe(true);
    const after = await runInDurableObject(auth, async (_instance, state) => ({
      rows: [...(await state.storage.list({ prefix: "used:" })).entries()], alarm: await state.storage.getAlarm(),
    }));
    expect(after.rows).toEqual([["used:a-live", next + 60], ["used:unknown", "corrupt-fixture"], ["used:z-live", next]]);
    expect(after.alarm).toBe(next * 1_000);
  });

  it("mints a session bound to the verified subject", async () => {
    const response = await exchange(await mintIdentity(await validClaims()));
    expect(response.status).toBe(200);
    const session = (await response.json()) as {
      accessToken?: string;
      refreshToken?: string;
      tenant?: string;
    };
    expect(session.tenant).toBe("apple:test-sub-1");
    expect(typeof session.accessToken).toBe("string");
    expect(typeof session.refreshToken).toBe("string");

    // The session authorizes task work, and the task carries its tenant.
    // Cloud work needs explicit consent first: the gate from OFF-I04.
    const consent = await SELF.fetch("https://test/v1/consent/cloud", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ enabled: true }),
    });
    expect(consent.status).toBe(200);
    const id = freshID();
    const created = await SELF.fetch("https://test/v1/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
        "idempotency-key": "sess-create-1",
      },
      body: JSON.stringify(draft(id)),
    });
    expect(created.status).toBe(200);
    const doc = (await created.json()) as { tenantId?: string };
    expect(doc.tenantId).toBe("apple:test-sub-1");
  });

  it("isolates tenants without leaking existence", async () => {
    const first = (await (
      await exchange(await mintIdentity(await validClaims()))
    ).json()) as { accessToken: string };
    const second = (await (
      await exchange(
        await mintIdentity({ ...(await validClaims()), sub: "test-sub-2" }),
        NONCE,
        "device-2",
      )
    ).json()) as { accessToken: string };

    const id = freshID();
    for (const token of [first.accessToken, second.accessToken]) {
      const consent = await SELF.fetch("https://test/v1/consent/cloud", {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ enabled: true }),
      });
      expect(consent.status).toBe(200);
    }
    const created = await SELF.fetch("https://test/v1/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${first.accessToken}`,
        "idempotency-key": "tenant-create-1",
      },
      body: JSON.stringify(draft(id)),
    });
    expect(created.status).toBe(200);

    const other = { authorization: `Bearer ${second.accessToken}` };
    expect((await SELF.fetch(`https://test/v1/tasks/${id}`, { headers: other })).status).toBe(404);
    expect(
      (
        await SELF.fetch(`https://test/v1/tasks/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...other },
          body: JSON.stringify(draft(id)),
        })
      ).status,
    ).toBe(404);
    expect((await SELF.fetch(`https://test/v1/tasks/${id}/events?after=0`, { headers: other })).status).toBe(
      404,
    );
  });

  it("stamps PUT tenancy from the session and indexes PUT-created tasks", async () => {
    const first = (await (
      await exchange(await mintIdentity({ ...(await validClaims()), sub: "put-tenant-1" }), NONCE, "put-device-1")
    ).json()) as { accessToken: string };
    const second = (await (
      await exchange(await mintIdentity({ ...(await validClaims()), sub: "put-tenant-2" }), NONCE, "put-device-2")
    ).json()) as { accessToken: string };
    for (const token of [first.accessToken, second.accessToken]) {
      expect(
        (
          await SELF.fetch("https://test/v1/consent/cloud", {
            method: "PUT",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({ enabled: true }),
          })
        ).status,
      ).toBe(200);
    }
    const own = { authorization: `Bearer ${first.accessToken}` };
    const other = { authorization: `Bearer ${second.accessToken}` };

    // POST-created task: a session PUT omitting tenantId must not clear it,
    // and a spoofed tenantId must not stick.
    const id = freshID();
    expect(
      (
        await SELF.fetch("https://test/v1/tasks", {
          method: "POST",
          headers: { "content-type": "application/json", ...own, "idempotency-key": `put-stamp-${id}` },
          body: JSON.stringify(draft(id)),
        })
      ).status,
    ).toBe(200);
    const stripped = await SELF.fetch(`https://test/v1/tasks/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...own },
      body: JSON.stringify(draft(id)),
    });
    expect(stripped.status).toBe(200);
    expect(((await stripped.json()) as { tenantId?: string }).tenantId).toBe("apple:put-tenant-1");
    const spoofed = await SELF.fetch(`https://test/v1/tasks/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...own },
      body: JSON.stringify({ ...draft(id), tenantId: "apple:put-tenant-2" }),
    });
    expect(spoofed.status).toBe(200);
    expect(((await spoofed.json()) as { tenantId?: string }).tenantId).toBe("apple:put-tenant-1");
    const reread = (await (
      await SELF.fetch(`https://test/v1/tasks/${id}`, { headers: own })
    ).json()) as { tenantId?: string };
    expect(reread.tenantId).toBe("apple:put-tenant-1");

    // PUT-created task (no prior POST): gated like POST, then indexed so
    // export and tenant deletion can find it.
    const viaPut = freshID();
    expect(
      (
        await SELF.fetch(`https://test/v1/tasks/${viaPut}`, {
          method: "PUT",
          headers: { "content-type": "application/json", ...own },
          body: JSON.stringify(draft(viaPut)),
        })
      ).status,
    ).toBe(200);
    const exported = (await (
      await SELF.fetch("https://test/v1/tenant/export", { headers: own })
    ).json()) as { tasks?: { task?: { id?: string } }[] };
    expect((exported.tasks ?? []).some((entry) => entry.task?.id === viaPut)).toBe(true);
    expect((await SELF.fetch(`https://test/v1/tasks/${viaPut}`, { headers: other })).status).toBe(404);

    // No consent, no PUT: a fresh session without consent is rejected.
    const noconsent = (await (
      await exchange(await mintIdentity({ ...(await validClaims()), sub: "put-tenant-3" }), NONCE, "put-device-3")
    ).json()) as { accessToken: string };
    const deniedId = freshID();
    expect(
      (
        await SELF.fetch(`https://test/v1/tasks/${deniedId}`, {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${noconsent.accessToken}` },
          body: JSON.stringify(draft(deniedId)),
        })
      ).status,
    ).toBe(403);
  });

  it("rotates refresh tokens and kills revoked sessions", async () => {
    const session = (await (
      await exchange(await mintIdentity(await validClaims()), NONCE, "device-9")
    ).json()) as { accessToken: string; refreshToken: string };
    const rotated = await SELF.fetch("https://test/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: "device-9" }),
    });
    expect(rotated.status).toBe(200);
    const next = (await rotated.json()) as { accessToken: string; refreshToken: string };

    // The old pair is dead on both sides.
    expect(
      (await SELF.fetch("https://test/v1/tasks/x", { headers: { authorization: `Bearer ${session.accessToken}` } }))
        .status,
    ).toBe(401);
    const reuse = await SELF.fetch("https://test/v1/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: "device-9" }),
    });
    expect(reuse.status).toBe(401);

    // Revoking the new access token ends the session too.
    const revoked = await SELF.fetch("https://test/v1/auth/session", {
      method: "DELETE",
      headers: { authorization: `Bearer ${next.accessToken}` },
    });
    expect(revoked.status).toBe(200);
    expect(
      (await SELF.fetch("https://test/v1/tasks/x", { headers: { authorization: `Bearer ${next.accessToken}` } }))
        .status,
    ).toBe(401);
  });

  it.each(["missing", "expired"])("wiping a tenant kills its refresh grant after %s access cleanup", async (cleanup) => {
    const subject = `wipe-${freshID()}`;
    const response = await exchange(await mintIdentity(await validClaims({ sub: subject })), NONCE, "wipe-device");
    expect(response.status).toBe(200);
    const session = await response.json() as { accessToken: string; refreshToken: string; tenant: string };
    const namespace = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
    const auth = namespace.get(namespace.idFromName("auth"));
    const accessHash = await sha256Hex(session.accessToken);
    await runInDurableObject(auth, async (_instance, state) => {
      if (cleanup === "missing") await state.storage.delete(`sat:${accessHash}`);
      else {
        const record = await state.storage.get<Record<string, unknown>>(`sat:${accessHash}`);
        await state.storage.put(`sat:${accessHash}`, { ...record, exp: Date.now() / 1_000 - 60 });
      }
    });
    if (cleanup === "expired") {
      expect((await SELF.fetch("https://test/v1/tasks/expired-fixture", {
        headers: { authorization: `Bearer ${session.accessToken}` },
      })).status).toBe(401);
    }
    expect((await auth.fetch("https://auth/tenant-wipe", { method: "POST",
      headers: { "content-type": "application/json", "x-wipe": "1" }, body: JSON.stringify({ tenant: session.tenant }),
    })).status).toBe(200);
    expect((await SELF.fetch("https://test/v1/auth/refresh", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: "wipe-device" }),
    })).status).toBe(401);
  });

  it("expires the refresh record together with its verified access record", async () => {
    const response = await exchange(await mintIdentity(await validClaims({ sub: `expiry-${freshID()}` })));
    expect(response.status).toBe(200);
    const session = await response.json() as { accessToken: string; refreshToken: string };
    const namespace = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
    const auth = namespace.get(namespace.idFromName("auth"));
    const accessHash = await sha256Hex(session.accessToken);
    const refreshHash = await sha256Hex(session.refreshToken);
    await runInDurableObject(auth, async (_instance, state) => {
      const record = await state.storage.get<Record<string, unknown>>(`sat:${accessHash}`);
      await state.storage.put(`sat:${accessHash}`, { ...record, exp: Date.now() / 1_000 - 60 });
    });
    expect((await SELF.fetch("https://test/v1/tasks/expired-fixture", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    })).status).toBe(401);
    expect(await runInDurableObject(auth, (_instance, state) => state.storage.get(`srt:${refreshHash}`))).toBeUndefined();
  });

  it("denies older records after a wipe and permits a fresh sign-in without affecting another tenant", async () => {
    const response = await exchange(await mintIdentity(await validClaims({ sub: `wipe-boundary-${freshID()}` })));
    expect(response.status).toBe(200);
    const session = await response.json() as { accessToken: string; refreshToken: string; tenant: string };
    const otherResponse = await exchange(await mintIdentity(await validClaims({ sub: `other-${freshID()}` })), NONCE, "other-device");
    expect(otherResponse.status).toBe(200);
    const other = await otherResponse.json() as { refreshToken: string };
    const namespace = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
    const auth = namespace.get(namespace.idFromName("auth"));
    const accessHash = await sha256Hex(session.accessToken);
    const refreshHash = await sha256Hex(session.refreshToken);
    const rows = await runInDurableObject(auth, async (_instance, state) => ({
      [`sat:${accessHash}`]: await state.storage.get(`sat:${accessHash}`),
      [`srt:${refreshHash}`]: await state.storage.get(`srt:${refreshHash}`),
    }));
    expect((await auth.fetch("https://auth/tenant-wipe", { method: "POST",
      headers: { "content-type": "application/json", "x-wipe": "1" }, body: JSON.stringify({ tenant: session.tenant }),
    })).status).toBe(200);
    // An older in-flight write must not revive the credentials after the tombstone.
    await runInDurableObject(auth, (_instance, state) => state.storage.put(rows));
    expect((await SELF.fetch("https://test/v1/tasks/old-fixture", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    })).status).toBe(401);
    expect((await SELF.fetch("https://test/v1/auth/refresh", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: "device-1" }),
    })).status).toBe(401);
    const fresh = await exchange(await mintIdentity(await validClaims({ sub: session.tenant.slice("apple:".length) })));
    expect(fresh.status).toBe(200);
    const signedIn = await fresh.json() as { accessToken: string; refreshToken: string };
    expect((await SELF.fetch("https://test/v1/auth/refresh", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: signedIn.refreshToken, deviceId: "device-1" }),
    })).status).toBe(200);
    expect((await SELF.fetch("https://test/v1/auth/refresh", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: other.refreshToken, deviceId: "other-device" }),
    })).status).toBe(200);
  });

  it("leaves no usable refresh pair when rotation races a tenant wipe", async () => {
    const response = await exchange(await mintIdentity(await validClaims({ sub: `race-wipe-${freshID()}` })), NONCE, "race-device");
    expect(response.status).toBe(200);
    const session = await response.json() as { accessToken: string; refreshToken: string; tenant: string };
    const namespace = (env as unknown as { AUTH: DurableObjectNamespace }).AUTH;
    const auth = namespace.get(namespace.idFromName("auth"));
    const [rotated, wiped] = await Promise.all([
      SELF.fetch("https://test/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: "race-device" }) }),
      auth.fetch("https://auth/tenant-wipe", { method: "POST",
        headers: { "content-type": "application/json", "x-wipe": "1" }, body: JSON.stringify({ tenant: session.tenant }) }),
    ]);
    expect(wiped.status).toBe(200);
    expect([200, 401]).toContain(rotated.status);
    const pairs = [session];
    if (rotated.status === 200) pairs.push(await rotated.json() as typeof session);
    for (const pair of pairs) {
      expect((await SELF.fetch("https://test/v1/tasks/race-fixture", {
        headers: { authorization: `Bearer ${pair.accessToken}` },
      })).status).toBe(401);
      expect((await SELF.fetch("https://test/v1/auth/refresh", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: pair.refreshToken, deviceId: "race-device" }) })).status).toBe(401);
    }
  });

  it("refuses the operator key on tenant task routes", async () => {
    const id = freshID();
    const created = await SELF.fetch("https://test/v1/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", ...OPERATOR, "idempotency-key": "op-create-1" },
      body: JSON.stringify(draft(id)),
    });
    expect(created.status).toBe(401);
    expect(await created.json()).toEqual({ error: "unauthorized" });
  });
});

beforeAll(() => {
  expect(TEST_PRIVATE_JWK.d).toBeDefined();
});
