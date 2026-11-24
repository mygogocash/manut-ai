import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import { AuthObject } from "../src/auth-object";
import { CODE_TTL_SECONDS, DAILY_CODES, DAY_SECONDS } from "../src/email-code";
import { testOutbox } from "../src/email-sender";
import worker, { type Env } from "../src/index";
import {
  accept, appleIdentity, asSession, invite, inviteToken, joinHelper, setFlags, setupShop, signIn, stubLine,
} from "./people-fixtures";
import { sourceWorker as SELF } from "./source-worker";

// Signing in by a code sent by email (email-code.ts; docs/pilot-api.md, "Signing in by email"), through the real Worker
// and auth object. wrangler.test.json switches it on with the test outbox as the sender, so the tests read each code
// from the email it went out in, as a person would; no deploy config may do that (.github/scripts/check-dev-deploys.mjs).
// The rules alone are in email-code.test.ts, and the limiter in ingress-rate-limits.test.ts.

const bindings = env as unknown as Env;
const API = "https://api.manut.test";
const APPLE_NONCE = "people-nonce";

afterEach(() => {
  vi.restoreAllMocks();
});

type Session = { accessToken: string; refreshToken: string; csrf: string; expiresIn: number; tenant: string };

const address = (name = "mint") => `${name}-${crypto.randomUUID()}@baanmali.example`;

function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}

const askCode = (email: string) => post("/v1/auth/email/code", { email });

const signInWith = (email: string, code: string, deviceId = `device-${crypto.randomUUID()}`) =>
  post("/v1/auth/exchange", { provider: "email", email, code, deviceId });

/// The code in the newest email the outbox holds for `email`, read as the person reads it.
function codeFor(email: string): string {
  const sent = testOutbox().filter((one) => one.to === email.trim().toLowerCase());
  const code = /sign-in code is (\d{6})\./.exec(sent.at(-1)?.text ?? "")?.[1];
  if (!code) throw new Error("no code in the outbox for that address");
  return code;
}

const sentTo = (email: string) => testOutbox().filter((one) => one.to === email).length;

/// Six digits that are not `code`.
const otherThan = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

/// Asks for a code and signs in with it.
async function codeSignIn(email: string, deviceId = `device-${crypto.randomUUID()}`): Promise<Session> {
  expect((await askCode(email)).status).toBe(200);
  const response = await signInWith(email, codeFor(email), deviceId);
  expect(response.status).toBe(200);
  return (await response.json()) as Session;
}

/// A Sign in with Apple exchange through the same route, for comparing with.
async function appleSignIn(claims: Record<string, unknown>, deviceId = "apple-device"): Promise<Session> {
  const response = await post("/v1/auth/exchange", { provider: "apple", identityToken: await appleIdentity(claims),
    nonce: APPLE_NONCE, deviceId });
  expect(response.status).toBe(200);
  return (await response.json()) as Session;
}

const auth = () => bindings.AUTH.get(bindings.AUTH.idFromName("auth"));

function authCall(stub: DurableObjectStub, path: string, body: unknown, headers: Record<string, string> = {}) {
  return stub.fetch(new Request(`https://auth${path}`, { method: "POST",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
}

async function verify(accessToken: string): Promise<{ ok: boolean; tenant?: string; email?: string }> {
  return (await (await authCall(auth(), "/verify", { token: accessToken })).json()) as { ok: boolean };
}

/// The test config with some settings changed, `undefined` removing one, as an environment that never set it.
function envWith(changes: Record<string, unknown>): Env {
  const target = { ...bindings } as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  return target as unknown as Env;
}

/// Whether `text` holds `code` as a number of its own: six digits with no digit on either side, so a timestamp or a
/// token that happens to run through the same digits does not count.
const holds = (text: string, code: string) => new RegExp(`(^|[^0-9])${code}([^0-9]|$)`).test(text);

describe("asking for a code", () => {
  it("sends six digits to the address from the owner's sender, and answers only that it did", async () => {
    const email = address();
    const response = await askCode(`  ${email.toUpperCase()} `);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true, expiresIn: 600, resendIn: 60 });
    const sent = testOutbox().filter((one) => one.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: { email: "codes@manut.test", name: "Manut AI" },
      subject: "Your Manut AI sign-in code" });
    expect(codeFor(email)).toMatch(/^\d{6}$/);
  });

  it("takes exactly { email } in the body and reads nothing from the URL", async () => {
    for (const body of [{}, { email: "not an address" }, { email: address(), shop: "pilot:x" }, [address()], "x", null]) {
      const response = await post("/v1/auth/email/code", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    const queried = await SELF.fetch(`${API}/v1/auth/email/code?email=${encodeURIComponent(address())}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(queried.status).toBe(400);
    expect((await SELF.fetch(`${API}/v1/auth/email/code`)).status).toBe(404);
  });
});

describe("signing in with the code", () => {
  it("gives Apple's session in every way: the same answer, tokens, records, lifetimes and refresh, keeping the address",
    async () => {
      const email = address();
      const session = await codeSignIn(email, "device-email");
      const apple = await appleSignIn({ email: address("apple"), email_verified: true });
      expect(Object.keys(session).sort()).toEqual(Object.keys(apple).sort());
      expect(session.expiresIn).toBe(apple.expiresIn);
      for (const token of [session.accessToken, session.refreshToken, session.csrf]) expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(await verify(session.accessToken)).toEqual({ ok: true, tenant: session.tenant, email });

      // The stored records are Apple's, field for field and lifetime for lifetime, with the address as the email.
      const kept = await runInDurableObject(auth(), async (_instance, state) => {
        const read = async (prefix: string, token: string) =>
          (await state.storage.get<Record<string, number | string>>(`${prefix}:${await sha256Hex(token)}`))!;
        return { email: { sat: await read("sat", session.accessToken), srt: await read("srt", session.refreshToken) },
          apple: { sat: await read("sat", apple.accessToken), srt: await read("srt", apple.refreshToken) } };
      });
      for (const kind of ["sat", "srt"] as const) {
        expect(Object.keys(kept.email[kind]).sort()).toEqual(Object.keys(kept.apple[kind]).sort());
        expect(kept.email[kind].email).toBe(email);
        expect(kept.email[kind].tenant).toBe(session.tenant);
      }
      const lifetimes = (records: typeof kept.email) => [
        Math.round((records.sat.exp as number) - (records.srt.born as number)),
        Math.round((records.srt.exp as number) - (records.srt.born as number)),
        records.sat.wipeGeneration, records.srt.wipeGeneration];
      expect(lifetimes(kept.email)).toEqual(lifetimes(kept.apple));
      expect(lifetimes(kept.email)).toEqual([3600, 30 * 24 * 3600, 0, 0]);

      // Refresh rotates it as it rotates Apple's, and the address rides along.
      const refreshed = await post("/v1/auth/refresh", { refreshToken: session.refreshToken, deviceId: "device-email" });
      expect(refreshed.status).toBe(200);
      const next = (await refreshed.json()) as Session;
      expect(Object.keys(next).sort()).toEqual(Object.keys(session).sort());
      expect(next.tenant).toBe(session.tenant);
      expect(await verify(next.accessToken)).toEqual({ ok: true, tenant: session.tenant, email });
      expect((await verify(session.accessToken)).ok).toBe(false);
      expect(await (await authCall(auth(), "/csrf-check", { token: next.accessToken, csrf: next.csrf })).json())
        .toEqual({ ok: true });

      // Signing out ends it, as for Apple.
      const out = await SELF.fetch(`${API}/v1/auth/session`, { method: "DELETE",
        headers: { authorization: `Bearer ${next.accessToken}` } });
      expect(await out.json()).toEqual({ revoked: true });
      expect((await verify(next.accessToken)).ok).toBe(false);
    });

  it("signs in exactly one of several devices racing with one code", async () => {
    const email = address();
    expect((await askCode(email)).status).toBe(200);
    const code = codeFor(email);
    const answers = await Promise.all(Array.from({ length: 5 }, (_, i) => signInWith(email, code, `race-${i}`)));
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401, 401, 401, 401]);
    for (const answer of answers.filter((one) => one.status === 401)) {
      expect(await answer.json()).toEqual({ error: "code_ended" });
    }
    const tenant = `email:${await sha256Hex(email)}`;
    const sessions = await runInDurableObject(auth(), async (_instance, state) =>
      [...(await state.storage.list<{ tenant: string }>({ prefix: "sat:" })).values()]
        .filter((session) => session.tenant === tenant).length);
    expect(sessions).toBe(1);
  });

  it("ends a code at its fifth wrong try, and a new code works a minute after the last", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const email = address();
    expect((await askCode(email)).status).toBe(200);
    const code = codeFor(email);
    const left: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await signInWith(email, otherThan(code));
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string; triesLeft: number };
      expect(body.error).toBe("wrong_code");
      left.push(body.triesLeft);
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    const ended = await signInWith(email, code);
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: "code_ended" });
    clock.mockReturnValue(now + 60_000);
    expect((await askCode(email)).status).toBe(200);
    expect((await signInWith(email, codeFor(email))).status).toBe(200);
  });

  it("refuses a code that is not six digits without counting it as a try", async () => {
    const email = address();
    expect((await askCode(email)).status).toBe(200);
    for (const code of ["12345", "1234567", "12 345", "abcdef", 123456]) {
      const response = await post("/v1/auth/exchange", { provider: "email", email, code, deviceId: "device-shape" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_request" });
    }
    for (const body of [{ provider: "email", email, code: codeFor(email) },
      { provider: "email", email, code: codeFor(email), deviceId: "d", tenant: "email:x" }]) {
      expect((await post("/v1/auth/exchange", body)).status).toBe(400);
    }
    const wrong = await signInWith(email, otherThan(codeFor(email)));
    expect(await wrong.json()).toEqual({ error: "wrong_code", triesLeft: 4 });
  });

  it("takes a code for ten minutes from the send", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const [inTime, late] = [address(), address()];
    expect((await askCode(inTime)).status).toBe(200);
    expect((await askCode(late)).status).toBe(200);
    clock.mockReturnValue(now + CODE_TTL_SECONDS * 1000 - 1);
    expect((await signInWith(inTime, codeFor(inTime))).status).toBe(200);
    clock.mockReturnValue(now + CODE_TTL_SECONDS * 1000);
    const response = await signInWith(late, codeFor(late));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "code_ended" });
  });
});

describe("how often a code is sent", () => {
  it("sends an address one code a minute, and a new one replaces the one before", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const email = address();
    expect((await askCode(email)).status).toBe(200);
    const first = codeFor(email);
    clock.mockReturnValue(now + 30_000);
    const again = await askCode(email);
    expect(again.status).toBe(429);
    expect(again.headers.get("retry-after")).toBe("30");
    expect(await again.json()).toEqual({ error: "too_many_codes", retryAfter: 30 });
    expect(sentTo(email)).toBe(1);
    clock.mockReturnValue(now + 60_000);
    expect((await askCode(email)).status).toBe(200);
    expect(sentTo(email)).toBe(2);
    const second = codeFor(email);
    if (second !== first) {
      expect(await (await signInWith(email, first)).json()).toEqual({ error: "wrong_code", triesLeft: 4 });
    }
    expect((await signInWith(email, second)).status).toBe(200);
  });

  it("sends an address ten codes in any 24 hours, then waits until the first is a day old", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    const email = address();
    for (let i = 0; i < DAILY_CODES; i++) {
      clock.mockReturnValue(now + i * 60_000);
      expect((await askCode(email)).status).toBe(200);
    }
    clock.mockReturnValue(now + DAILY_CODES * 60_000);
    const capped = await askCode(email);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: "too_many_codes", retryAfter: DAY_SECONDS - DAILY_CODES * 60 });
    clock.mockReturnValue(now + DAY_SECONDS * 1000);
    expect((await askCode(email)).status).toBe(200);
    expect(sentTo(email)).toBe(DAILY_CODES + 1);
  });

  it("keeps an address's record a day after its last code, then the alarm deletes it", async () => {
    const stub = bindings.AUTH.get(bindings.AUTH.idFromName(`email-alarm-${crypto.randomUUID()}`));
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const email = address();
    expect((await authCall(stub, "/email-code", { email })).status).toBe(200);
    const key = `email-code:${await sha256Hex(email)}`;
    const read = () => runInDurableObject(stub, async (_instance, state) =>
      ({ record: await state.storage.get(key), alarm: await state.storage.getAlarm() }));
    const before = await read();
    expect(before.record).toMatchObject({ code: { wrong: 0 }, sent: [now / 1000] });
    expect(before.alarm! - (now + DAY_SECONDS * 1000)).toBeGreaterThanOrEqual(0);
    expect(before.alarm! - (now + DAY_SECONDS * 1000)).toBeLessThanOrEqual(1);
    clock.mockReturnValue(now + DAY_SECONDS * 1000 - 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await read()).record).toBeDefined();
    clock.mockReturnValue(now + DAY_SECONDS * 1000 + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await read()).toEqual({ record: undefined, alarm: null });
  });
});

describe("off unless configured", () => {
  /// The Worker with `target`'s settings, and an AUTH that only counts the calls that reach it.
  function counting(target: Env) {
    let calls = 0;
    const AUTH = { idFromName: (name: string) => bindings.AUTH.idFromName(name),
      get: () => ({ fetch: async () => { calls++; return Response.json({ fixture: true }); } }) };
    return { env: { ...target, AUTH } as unknown as Env, calls: () => calls };
  }

  async function send(target: Env, path: string, body: unknown): Promise<Response> {
    const text = JSON.stringify(body);
    const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
    const context = createExecutionContext();
    const response = await worker.fetch(new Request(`${API}${path}`, { method: "POST", body: text,
      headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(text).length),
        "cf-connecting-ip": `2001:db8:${groups.join(":")}` } }), target, context);
    await waitOnExecutionContext(context);
    return response;
  }

  const OFF: Record<string, unknown>[] = [
    { EMAIL_SIGN_IN: undefined }, { EMAIL_SIGN_IN: "off" }, { EMAIL_SIGN_IN: "1" },
    { TEST_EMAIL_OUTBOX: undefined }, { EMAIL_FROM_ADDRESS: undefined }, { APPROVAL_LINK_SECRET: undefined },
  ];

  it("answers both routes email_not_configured, and wakes nothing, until it is on with a sender and the secret",
    async () => {
      const outbox = testOutbox().length;
      for (const changes of OFF) {
        const target = counting(envWith(changes));
        for (const [path, body] of [["/v1/auth/email/code", { email: address() }],
          ["/v1/auth/exchange", { provider: "email", email: address(), code: "123456", deviceId: "device-off" }]] as const) {
          const response = await send(target.env, path, body);
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ error: "email_not_configured" });
        }
        // A body that is not the route's is refused as it always was, and Apple's exchange still reaches AUTH.
        expect(await (await send(target.env, "/v1/auth/email/code", { address: "x" })).json())
          .toEqual({ error: "invalid_request" });
        expect(target.calls()).toBe(0);
        const apple = await send(target.env, "/v1/auth/exchange", { provider: "apple",
          identityToken: await appleIdentity({}), nonce: APPLE_NONCE, deviceId: "device-off" });
        expect(await apple.json()).toEqual({ fixture: true });
        expect(target.calls()).toBe(1);
      }
      expect(testOutbox().length).toBe(outbox);
    });

  it("is off in the auth object too, which checks for itself and keeps nothing", async () => {
    const stub = bindings.AUTH.get(bindings.AUTH.idFromName(`email-off-${crypto.randomUUID()}`));
    for (const changes of OFF) {
      const answers = await runInDurableObject(stub, async (_instance, state) => {
        const object = new AuthObject(state, envWith(changes));
        const ask = await object.fetch(new Request("https://auth/email-code", { method: "POST",
          body: JSON.stringify({ email: address() }) }));
        const exchange = await object.fetch(new Request("https://auth/exchange", { method: "POST",
          body: JSON.stringify({ provider: "email", email: address(), code: "123456", deviceId: "device-off" }) }));
        return { ask: [ask.status, await ask.json()], exchange: [exchange.status, await exchange.json()],
          kept: (await state.storage.list()).size };
      });
      expect(answers).toEqual({ ask: [400, { error: "email_not_configured" }],
        exchange: [400, { error: "email_not_configured" }], kept: 0 });
    }
  });
});

describe("what an answer tells", () => {
  beforeEach(async () => {
    expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
    stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
  });

  it("answers an address Manut AI and a shop know exactly as one nobody knows", async () => {
    const known = address("fon");
    await signIn(known);
    const shop = await setupShop();
    expect((await invite(shop, "Fon", { kind: "email", address: known })).status).toBe(200);
    const unknown = address("nobody");
    const idleKnown = address("pim");
    await signIn(idleKnown);
    const idleUnknown = address("idle");
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const seen = async (response: Response) => [response.status, response.headers.get("content-type"),
      response.headers.get("retry-after"), await response.text()];
    // Asking, asking again too soon, a wrong code, and a try when no code was asked for.
    expect(await seen(await askCode(known))).toEqual(await seen(await askCode(unknown)));
    expect(await seen(await askCode(known))).toEqual(await seen(await askCode(unknown)));
    expect(await seen(await signInWith(known, otherThan(codeFor(known)))))
      .toEqual(await seen(await signInWith(unknown, otherThan(codeFor(unknown)))));
    expect(await seen(await signInWith(idleKnown, "123456"))).toEqual(await seen(await signInWith(idleUnknown, "123456")));
  });

  it("lets an email invite match the address a code signed in", async () => {
    const shop = await setupShop();
    const email = address("mint");
    const made = await invite(shop, "Mint", { kind: "email", address: email });
    expect(made.status).toBe(200);
    const session = await codeSignIn(` ${email.toUpperCase()} `);
    const joined = await accept({ headers: { authorization: `Bearer ${session.accessToken}` } },
      inviteToken(made.body.inviteUrl));
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ answer: "joined", shop: { id: shop.tenant }, helper: { name: "Mint" } });
  });

  it("keeps Apple and email two identities, while a shop knows its helper by the address it invited", async () => {
    const shop = await setupShop();
    const helper = await joinHelper(shop, "Mint");
    const session = await codeSignIn(helper.email);
    expect(session.tenant).toBe(`email:${await sha256Hex(helper.email)}`);
    expect(session.tenant).not.toBe(helper.person.tenant);
    const headers = { authorization: `Bearer ${session.accessToken}` };
    // The email identity's own list of shops is its own: the shop Mint joined with Apple is not on it.
    const listed = await asSession<{ shops: { id: string }[] }>(headers, "GET", "/v1/shops");
    expect(listed.status).toBe(200);
    expect(listed.body.shops.map((one) => one.id)).not.toContain(shop.tenant);
    // The shop knows Mint by the invited address, so the email sign-in opens it as the same helper: a new device to the
    // owner, and removing Mint ends both.
    const opened = await asSession<{ helper: { id: string } }>(headers, "POST", "/v1/people/session", { shop: shop.tenant });
    expect(opened.status).toBe(200);
    expect(opened.body.helper.id).toBe(helper.id);
  });
});

describe("the identity", () => {
  it("is email: and the address's SHA-256 however the address is typed, and never an Apple tenant", async () => {
    const email = address();
    const session = await codeSignIn(` ${email.toUpperCase()} `);
    expect(session.tenant).toBe(`email:${await sha256Hex(email)}`);
    expect(session.tenant).not.toContain("mint");
    // An Apple subject that spells an email tenant still signs in as an Apple one.
    expect((await appleSignIn({ sub: session.tenant })).tenant).toBe(`apple:${session.tenant}`);
  });

  it("goes with a tenant wipe: its sessions end and its record goes, and the address can sign in again", async () => {
    const email = address();
    const session = await codeSignIn(email, "device-wiped");
    const wiped = await authCall(auth(), "/tenant-wipe", { tenant: session.tenant }, { "x-wipe": "1" });
    expect(wiped.status).toBe(200);
    expect((await verify(session.accessToken)).ok).toBe(false);
    expect((await post("/v1/auth/refresh", { refreshToken: session.refreshToken, deviceId: "device-wiped" })).status)
      .toBe(401);
    const key = `email-code:${await sha256Hex(email)}`;
    expect(await runInDurableObject(auth(), (_instance, state) => state.storage.get(key))).toBeUndefined();
    const again = await codeSignIn(email);
    expect(again.tenant).toBe(session.tenant);
    expect((await verify(again.accessToken)).ok).toBe(true);
  });
});

describe("where the code never is", () => {
  it("is in no answer, no stored record and no log line: only in the email", async () => {
    const logged: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    const email = address();
    const account = await sha256Hex(email);
    const answers: string[] = [];
    const keep = async (response: Response) => {
      answers.push(`${response.status} ${JSON.stringify([...response.headers])} ${await response.clone().text()}`);
      return response;
    };
    await keep(await askCode(email));
    const code = codeFor(email);
    // While the code is live, its record holds an HMAC of it and nothing a million tries would undo.
    const live = await runInDurableObject(auth(), (_instance, state) =>
      state.storage.get<{ code: { mac: string } }>(`email-code:${account}`));
    expect(live!.code.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(live!.code.mac).not.toBe(await sha256Hex(code));
    await keep(await signInWith(email, otherThan(code)));
    const session = (await (await keep(await signInWith(email, code, "device-1"))).json()) as Session;
    await keep(await post("/v1/auth/refresh", { refreshToken: session.refreshToken, deviceId: "device-1" }));
    await keep(await askCode(email));
    await keep(await signInWith(email, code));
    expect(answers.map((answer) => answer.slice(0, 3))).toEqual(["200", "401", "200", "200", "429", "401"]);
    for (const answer of answers) expect(holds(answer, code)).toBe(false);
    const stored = await runInDurableObject(auth(), async (_instance, state) => [...(await state.storage.list()).entries()]);
    expect(holds(JSON.stringify(stored), code)).toBe(false);
    // No key names the address: the record is keyed, and the tenant named, by its hash.
    const local = email.split("@")[0]!;
    for (const [key] of stored) expect(key).not.toContain(local);
    expect(stored.find(([key]) => key === `email-code:${account}`)?.[1]).not.toHaveProperty("code");
    expect(JSON.stringify(logged)).not.toContain(code);
    expect(JSON.stringify(logged)).not.toContain(local);
  });

  it("answers a send the email service refuses as one it took, and logs only the service's error code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const email = address();
    const handed: { to: string; text: string }[] = [];
    const refusing = { send: async (message: { to: string; text: string }) => {
      handed.push(message);
      throw Object.assign(new Error(`recipient ${email} is suppressed`), { code: "E_RECIPIENT_SUPPRESSED" });
    } };
    const stub = bindings.AUTH.get(bindings.AUTH.idFromName(`email-refused-${crypto.randomUUID()}`));
    const answer = await runInDurableObject(stub, async (_instance, state) => {
      const object = new AuthObject(state, envWith({ TEST_EMAIL_OUTBOX: undefined, EMAIL: refusing }));
      const response = await object.fetch(new Request("https://auth/email-code", { method: "POST",
        body: JSON.stringify({ email }) }));
      return [response.status, await response.text()];
    });
    expect(answer).toEqual([200, JSON.stringify({ sent: true, expiresIn: 600, resendIn: 60 })]);
    await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    expect(logged.mock.calls).toEqual([["email code not sent", "E_RECIPIENT_SUPPRESSED"]]);
    // Cloudflare's binding was handed the email, with the code in its body only.
    expect(handed).toHaveLength(1);
    expect(handed[0]).toMatchObject({ to: email, from: { email: "codes@manut.test", name: "Manut AI" },
      subject: "Your Manut AI sign-in code" });
    const code = /sign-in code is (\d{6})\./.exec(handed[0]!.text)![1]!;
    expect(JSON.stringify(logged.mock.calls)).not.toContain(code);
    expect(holds(answer[1] as string, code)).toBe(false);
  });
});
