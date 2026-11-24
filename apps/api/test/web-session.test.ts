import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeKey, emailAccount } from "../src/email-code";
import { testOutbox } from "../src/email-sender";
import worker, { type Env } from "../src/index";
import { ACCESS_COOKIE, SHOP_COOKIE_PREFIX, SIGN_IN_COOKIE, shopCookieName } from "../src/web-session";
import {
  accept,
  admin,
  asSession,
  auditEntries,
  bindings,
  call,
  invite,
  inviteToken,
  linkAccount,
  ownerConsents,
  plantRequest,
  proposeReply,
  setFlags,
  setupShop,
  shopConsents,
  shopTask,
  storedRequest,
  stubLine,
  type Shop,
  type SignedIn,
} from "./people-fixtures";
import { sourceWorker } from "./source-worker";

// The owner's web app's session (web-session.ts; docs/pilot-api.md, "The web app's session"), through the real Worker and
// objects. A person signs in with a code from the test outbox, and a browser stand-in keeps the cookies the answers set,
// as a browser does, and sends them back with the app's header and this origin. The global fetch counts LINE pushes and
// answers everything else 599, so nothing leaves the test.

const API = "https://api.manut.test";
const HEX64 = /[0-9a-f]{64}/;

let line: ReturnType<typeof stubLine>;

beforeEach(async () => {
  expect((await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true })).status).toBe(200);
  line = stubLine((impl) => vi.spyOn(globalThis, "fetch").mockImplementation(impl));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const address = (name = "fon") => `${name}-${crypto.randomUUID()}@baanmali.example`;

/// The code in the newest email the outbox holds for `email`.
function codeFor(email: string): string {
  const sent = testOutbox().filter((one) => one.to === email);
  const code = /sign-in code is (\d{6})\./.exec(sent.at(-1)?.text ?? "")?.[1];
  if (!code) throw new Error("no code in the outbox for that address");
  return code;
}

/// Forgets when `email` was last sent a code, so a test may ask again within the minute the API makes an address wait:
/// one person here signs in on two devices, a lifted one and the web's, a moment apart.
async function forgetSends(email: string): Promise<void> {
  const key = codeKey(await emailAccount(email));
  await runInDurableObject(bindings.AUTH.get(bindings.AUTH.idFromName("auth")), async (_instance, state) => {
    await state.storage.delete(key);
  });
}

async function askCode(email: string): Promise<string> {
  await forgetSends(email);
  const asked = await sourceWorker.fetch(`${API}/v1/auth/email/code`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }) });
  expect(asked.status).toBe(200);
  return codeFor(email);
}

/// `email` signed in on another device through the lifted exchange, as the desktop signs in: what links their account
/// to a shop, or joins one.
async function lifted(email: string): Promise<SignedIn> {
  const deviceId = `device-${crypto.randomUUID()}`;
  const response = await sourceWorker.fetch(`${API}/v1/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "email", email, code: await askCode(email), deviceId }) });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { tenant: string; accessToken: string; refreshToken: string };
  return { ...body, deviceId, headers: { authorization: `Bearer ${body.accessToken}` } };
}

/// A POST from the app's page straight to the Worker with `env`, from `ip` when given (the limiter's key), else from a /64
/// of its own, since the limiter counts a whole IPv6 /64 as one source.
async function direct(path: string, body: unknown, env: Env = bindings,
  ip = `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 8).match(/.{4}/g)!.join(":")}::1`): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`${API}${path}`, { method: "POST", headers: { "x-manut-web": "1", origin: API,
    "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }), env, context);
  await waitOnExecutionContext(context);
  return response;
}

type Sent = { status: number; body: Record<string, unknown>; cookies: string[]; text: string };

/// A browser holding this origin's cookies. It keeps what each answer sets and drops what an answer clears, and sends
/// every request as the app's page does: the app's header, this origin, and its cookies.
class Browser {
  readonly jar = new Map<string, string>();

  async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Sent> {
    const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await call(path, { method, headers: { "x-manut-web": "1", origin: API,
      ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookies = response.headers.getSetCookie();
    for (const line of cookies) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      const name = pair!.slice(0, at);
      const value = pair!.slice(at + 1);
      if (/Max-Age=0(;|$)/.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, cookies, text };
  }

  async signIn(email: string): Promise<Sent> {
    return this.send("POST", "/v1/web/sign-in", { email, code: await askCode(email) });
  }

  shops(): Promise<Sent> {
    return this.send("POST", "/v1/web/shops", {});
  }

  approvals(shop: string, state = "open"): Promise<Sent> {
    return this.send("GET", `/v1/web/approvals?shop=${encodeURIComponent(shop)}&state=${state}`);
  }

  decide(shop: string, requestId: string, optionId: string, seenRevision = 1): Promise<Sent> {
    return this.send("POST", `/v1/web/approvals/${encodeURIComponent(requestId)}/decision`, { shop, optionId, seenRevision });
  }

  /// The shop sessions the browser holds, by shop cookie.
  shopCookies(): string[] {
    return [...this.jar.keys()].filter((name) => name.startsWith(SHOP_COOKIE_PREFIX));
  }
}

/// A person who owns `owned` (their account linked by the operator) and helps at `helped` (joined by an email invite),
/// signed in by email in a fresh browser.
async function ownerAndHelper(): Promise<{ email: string; owned: Shop; helped: Shop; browser: Browser; helperId: string;
  accountId: string }> {
  const email = address();
  const person = await lifted(email);
  const owned = await setupShop("Baan Mali");
  const accountId = await linkAccount(owned, person);
  const helped = await setupShop("Khao Soi Nimman");
  const made = await invite(helped, "Fon", { kind: "email", address: email });
  expect(made.status).toBe(200);
  const joined = await accept(person, inviteToken(made.body.inviteUrl));
  expect(joined.status).toBe(200);
  const helperId = (joined.body.helper as { id: string }).id;
  const browser = new Browser();
  expect((await browser.signIn(email)).status).toBe(200);
  return { email, owned, helped, browser, helperId, accountId };
}

async function devicesOf(shop: Shop): Promise<{ owner: number | null; helpers: number[] }> {
  const people = await admin<{ owner: { account: { devices: number } | null }; helpers: { devices: number }[] }>("GET",
    `/v1/admin/people?tenant=${encodeURIComponent(shop.tenant)}`);
  return { owner: people.body.owner.account?.devices ?? null, helpers: people.body.helpers.map((helper) => helper.devices) };
}

describe("only the app's page reaches these routes", () => {
  const routes: [string, string, unknown?][] = [
    ["POST", "/v1/web/sign-in", { email: "fon@baanmali.example", code: "123456" }],
    ["POST", "/v1/web/shops", {}],
    ["POST", "/v1/web/sign-out", {}],
    ["GET", "/v1/web/approvals?shop=pilot%3Ax&state=open"],
    ["POST", "/v1/web/approvals/req-1/decision", { shop: "pilot:x", optionId: "approve", seenRevision: 1 }],
  ];

  it("refuses a request without the app's header, from another origin, from another site, or a change naming no origin", async () => {
    const browser = new Browser();
    for (const [method, path, body] of routes) {
      expect((await browser.send(method, path, body, { "x-manut-web": "" })).body).toEqual({ error: "csrf_required" });
      expect((await browser.send(method, path, body, { origin: "https://evil.example" })).body)
        .toEqual({ error: "origin_forbidden" });
      expect((await browser.send(method, path, body, { "sec-fetch-site": "same-site" })).status).toBe(403);
      if (method === "POST") {
        // A change that names no origin is not one a browser's page made.
        const response = await call(path, { method, headers: { "x-manut-web": "1", "content-type": "application/json" },
          body: JSON.stringify(body) });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "origin_forbidden" });
      }
    }
  });

  it("answers an unknown web path 404, and a wrong method 405 after the browser checks", async () => {
    const browser = new Browser();
    expect((await browser.send("GET", "/v1/web/everything")).status).toBe(404);
    expect((await browser.send("GET", "/v1/web/sign-in")).status).toBe(405);
    expect((await browser.send("GET", "/v1/web/shops")).status).toBe(405);
    expect((await browser.send("POST", "/v1/web/approvals?shop=pilot%3Ax&state=open", {})).status).toBe(405);
  });

  it("is limited per address: signing in counts in the exchange's bucket", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await direct("/v1/web/sign-in", { email: "x", code: "1" }, bindings, "198.51.100.77");
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("signing in", () => {
  it("keeps the sign-in in cookies the page cannot read, and answers no token", async () => {
    const browser = new Browser();
    const signedIn = await browser.signIn(address());
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual({ signedIn: true });
    expect(signedIn.text).not.toMatch(HEX64);
    expect(signedIn.cookies).toHaveLength(2);
    for (const cookie of signedIn.cookies) {
      expect(cookie).toMatch(/; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
      expect(cookie.startsWith("__Host-")).toBe(true);
    }
    expect(signedIn.cookies.find((cookie) => cookie.startsWith(`${ACCESS_COOKIE}=`))).toMatch(/^[^=]+=[0-9a-f]{64}; Max-Age=3540;/);
    expect(signedIn.cookies.find((cookie) => cookie.startsWith(`${SIGN_IN_COOKIE}=`)))
      .toMatch(/^[^=]+=web-[0-9a-f-]{36}\.[0-9a-f]{64}; Max-Age=2592000;/);
  });

  it("answers the exchange's refusals as it does, and sets nothing", async () => {
    const browser = new Browser();
    const email = address();
    const code = await askCode(email);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    const refused = await browser.send("POST", "/v1/web/sign-in", { email, code: wrong });
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ error: "wrong_code", triesLeft: 4 });
    expect(refused.cookies).toEqual([]);
    // The page never names a device, and nothing but the two fields is read.
    expect((await browser.send("POST", "/v1/web/sign-in", { email, code, deviceId: "web-mine" })).body)
      .toEqual({ error: "invalid_request" });
    expect((await browser.send("POST", "/v1/web/sign-in", { email, code: "12345" })).body).toEqual({ error: "invalid_request" });
    expect(browser.jar.size).toBe(0);
  });

  it("says on opening, to someone signed out, whether signing in by email is on", async () => {
    const off = { ...bindings } as Record<string, unknown>;
    delete off.EMAIL_SIGN_IN;
    const response = await direct("/v1/web/shops", {}, off as unknown as Env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "signed_out", emailSignIn: false });
  });

  it("answers email_not_configured while signing in by email is off, as the exchange does", async () => {
    const off = { ...bindings } as Record<string, unknown>;
    delete off.EMAIL_SIGN_IN;
    const response = await direct("/v1/web/sign-in", { email: address(), code: "123456" }, off as unknown as Env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "email_not_configured" });
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("the person's shops", () => {
  it("lists every shop with a session ready, opened once and kept, never shown", async () => {
    const { owned, helped, browser, helperId, accountId } = await ownerAndHelper();
    const before = { owned: await devicesOf(owned), helped: await devicesOf(helped) };
    const first = await browser.shops();
    expect(first.status).toBe(200);
    expect(first.body.shops).toEqual([
      { id: owned.tenant, name: "Baan Mali", ownerName: "Fon", role: "owner", you: accountId, ready: true },
      { id: helped.tenant, name: "Khao Soi Nimman", ownerName: "Fon", role: "helper", you: helperId, ready: true },
    ]);
    expect(first.text).not.toMatch(/m[oh]s1\./);
    expect(browser.shopCookies().sort()).toEqual([await shopCookieName(owned.tenant), await shopCookieName(helped.tenant)].sort());
    expect((await devicesOf(owned)).owner).toBe(before.owned.owner! + 1);
    expect((await devicesOf(helped)).helpers).toEqual(before.helped.helpers.map((count) => count + 1));

    // Opening the app again keeps the sessions it has: no new device for either shop.
    const again = await browser.shops();
    expect(again.status).toBe(200);
    expect(again.body.shops).toEqual(first.body.shops);
    expect(again.cookies.filter((cookie) => cookie.startsWith(SHOP_COOKIE_PREFIX))).toEqual([]);
    expect((await devicesOf(owned)).owner).toBe(before.owned.owner! + 1);
    expect((await devicesOf(helped)).helpers).toEqual(before.helped.helpers.map((count) => count + 1));
  });

  it("refreshes the sign-in when its hour has gone, and answers signed_out when there is none or it ended", async () => {
    const { browser } = await ownerAndHelper();
    browser.jar.delete(ACCESS_COOKIE);
    const refreshedFrom = browser.jar.get(SIGN_IN_COOKIE);
    const listed = await browser.shops();
    expect(listed.status).toBe(200);
    expect(browser.jar.get(ACCESS_COOKIE)).toMatch(/^[0-9a-f]{64}$/);
    expect(browser.jar.get(SIGN_IN_COOKIE)).not.toBe(refreshedFrom);

    // A refresh token the lifted auth no longer holds: signed out, and no cookie cleared, since another tab's refresh
    // may have set the one that works.
    browser.jar.delete(ACCESS_COOKIE);
    browser.jar.set(SIGN_IN_COOKIE, refreshedFrom!);
    const ended = await browser.shops();
    expect(ended.status).toBe(401);
    expect(ended.body).toEqual({ error: "signed_out", emailSignIn: true });
    expect(ended.cookies).toEqual([]);

    expect((await new Browser().shops()).body).toEqual({ error: "signed_out", emailSignIn: true });
  });

  it("clears the session of a shop the person has left, and opens one for a shop they joined", async () => {
    const { email, owned, helped, browser, helperId } = await ownerAndHelper();
    expect((await browser.shops()).status).toBe(200);
    const removed = await admin("POST", "/v1/admin/people/remove", { tenant: helped.tenant, helperId });
    expect(removed.status).toBe(200);
    const third = await setupShop("Sabai Tea");
    const made = await invite(third, "Fon", { kind: "email", address: email });
    expect((await accept(await lifted(email), inviteToken(made.body.inviteUrl))).status).toBe(200);
    const listed = await browser.shops();
    expect((listed.body.shops as { id: string }[]).map((shop) => shop.id)).toEqual([owned.tenant, third.tenant]);
    expect(listed.cookies).toContain(`${await shopCookieName(helped.tenant)}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`);
    expect(browser.shopCookies().sort()).toEqual([await shopCookieName(owned.tenant), await shopCookieName(third.tenant)].sort());
  });
});

describe("approvals through the shop's own session", () => {
  it("lists a shop's approvals as GET /v1/approvals answers that shop's session", async () => {
    const { owned, helped, browser } = await ownerAndHelper();
    await browser.shops();
    const reply = await proposeReply(owned, "สวัสดีค่ะ ของออกจากคลังแล้วค่ะ");
    const listed = await browser.approvals(owned.tenant);
    expect(listed.status).toBe(200);
    const approvals = listed.body.approvals as { record: { request: { id: string; kind: string; detail: { text: string } } } }[];
    expect(approvals.map((one) => one.record.request.id)).toEqual([reply.actionId]);
    expect(approvals[0]!.record.request.kind).toBe("reply");
    expect(approvals[0]!.record.request.detail.text).toBe("สวัสดีค่ะ ของออกจากคลังแล้วค่ะ");
    // The other shop's list holds none of this shop's requests.
    expect(((await browser.approvals(helped.tenant)).body.approvals as unknown[])).toEqual([]);
  });

  it("refuses a query naming anything but the shop, the state and the limit, and a shop it holds no session for", async () => {
    const { owned, browser } = await ownerAndHelper();
    await browser.shops();
    for (const query of [`shop=${encodeURIComponent(owned.tenant)}&state=open&role=owner`,
      `shop=${encodeURIComponent(owned.tenant)}&state=open&tenant=x`, "state=open",
      `shop=${encodeURIComponent(owned.tenant)}&shop=pilot%3Aother&state=open`]) {
      expect((await browser.send("GET", `/v1/web/approvals?${query}`)).body).toEqual({ error: "invalid_request" });
    }
    const elsewhere = await setupShop("Not theirs");
    expect((await browser.approvals(elsewhere.tenant)).body).toEqual({ error: "session_ended", shop: elsewhere.tenant });
    expect((await browser.approvals(owned.tenant, "everything")).body).toEqual({ error: "invalid_state" });
  });

  it("says a session ended elsewhere and clears its cookie, and keeps a removal's own answer", async () => {
    const { owned, helped, browser, helperId } = await ownerAndHelper();
    await browser.shops();
    const name = await shopCookieName(owned.tenant);
    const token = browser.jar.get(name)!.split("~")[1]!;
    expect((await asSession({ authorization: `Bearer ${token}` }, "POST", "/v1/shops/session/end", {})).status).toBe(200);
    const ended = await browser.approvals(owned.tenant);
    expect(ended.status).toBe(401);
    expect(ended.body).toEqual({ error: "session_ended", shop: owned.tenant });
    expect(browser.jar.has(name)).toBe(false);
    // Reading the shops again opens a new session for it.
    expect((await browser.shops()).status).toBe(200);
    expect((await browser.approvals(owned.tenant)).status).toBe(200);

    expect((await admin("POST", "/v1/admin/people/remove", { tenant: helped.tenant, helperId })).status).toBe(200);
    const removed = await browser.approvals(helped.tenant);
    expect(removed.status).toBe(401);
    expect(removed.body.error).toBe("removed");
    expect(removed.body.shop).toBe(helped.tenant);
    expect(typeof removed.body.removedAt).toBe("string");
    expect(browser.jar.has(await shopCookieName(helped.tenant))).toBe(false);
  });

  it("decides as the session's role and account, once, through approval-core", async () => {
    const { owned, helped, browser, helperId, accountId } = await ownerAndHelper();
    await browser.shops();
    const reply = await proposeReply(owned, "ขอบคุณค่ะ");
    await ownerConsents(reply);
    const approved = await browser.decide(owned.tenant, reply.actionId, "approve");
    expect(approved.status).toBe(200);
    expect((approved.body.result as { ok: boolean }).ok).toBe(true);
    expect(approved.body.action).toBe("confirmed");
    expect(line.pushes()).toBe(1);
    const stored = await storedRequest(owned.tenant, reply.taskId, reply.actionId);
    expect(stored.record.status).toBe("decided");
    if (stored.record.status === "decided") {
      expect(stored.record.decision.decidedBy).toBe(accountId);
      expect(stored.record.decision.role).toBe("owner");
    }
    // A second answer is approval-core's: already decided, with who and when, and nothing sent twice.
    const again = await browser.decide(owned.tenant, reply.actionId, "decline");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("already_decided");
    expect(((again.body.result as { decision: { decidedBy: string } }).decision).decidedBy).toBe(accountId);
    expect(line.pushes()).toBe(1);

    // As a helper: a command is the owner's, a reply the helper's.
    await shopConsents(helped.tenant);
    const task = await shopTask(helped.tenant);
    const command = await plantRequest(helped.tenant, task, "command");
    const refused = await browser.decide(helped.tenant, command, "decline");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("not_permitted");
    const message = await plantRequest(helped.tenant, task, "reply");
    const declined = await browser.decide(helped.tenant, message, "decline");
    expect(declined.status).toBe(200);
    const decided = await storedRequest(helped.tenant, task, message);
    if (decided.record.status === "decided") expect(decided.record.decision.decidedBy).toBe(helperId);
    expect(decided.record.status).toBe("decided");
    const log = await auditEntries(helped.tenant);
    expect(log.some((entry) => entry.action === "approval.decided" && entry.actor.id === helperId)).toBe(true);
  });

  it("refuses a body naming a role or anything else, and a request of another shop", async () => {
    const { owned, helped, browser } = await ownerAndHelper();
    await browser.shops();
    const reply = await proposeReply(owned, "ok");
    const path = `/v1/web/approvals/${encodeURIComponent(reply.actionId)}/decision`;
    expect((await browser.send("POST", path, { shop: owned.tenant, optionId: "approve", seenRevision: 1, role: "owner" })).body)
      .toEqual({ error: "invalid_request" });
    expect((await browser.send("POST", path, { optionId: "approve", seenRevision: 1 })).body).toEqual({ error: "invalid_request" });
    // The helper's session of the other shop never reaches this shop's request.
    const other = await browser.decide(helped.tenant, reply.actionId, "decline");
    expect(other.status).toBe(404);
    expect(other.body.error).toBe("not_found");
    expect((await storedRequest(owned.tenant, reply.taskId, reply.actionId)).record.status).toBe("pending");
  });
});

describe("signing out", () => {
  it("ends every session the browser holds and clears every cookie", async () => {
    const { owned, helped, browser } = await ownerAndHelper();
    await browser.shops();
    const held = new Map(browser.jar);
    const out = await browser.send("POST", "/v1/web/sign-out", {});
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ signedOut: true, shopsEnded: 2 });
    expect(browser.jar.size).toBe(0);
    // A browser that kept the old cookies holds nothing that works.
    const stale = new Browser();
    for (const [name, value] of held) stale.jar.set(name, value);
    expect((await stale.approvals(owned.tenant)).body).toEqual({ error: "session_ended", shop: owned.tenant });
    expect((await stale.approvals(helped.tenant)).body).toEqual({ error: "session_ended", shop: helped.tenant });
    stale.jar.delete(ACCESS_COOKIE);
    expect((await stale.shops()).body).toEqual({ error: "signed_out", emailSignIn: true });
    expect((await new Browser().send("POST", "/v1/web/sign-out", {})).body).toEqual({ signedOut: true, shopsEnded: 0 });
  });

  it("ends the last person's sessions when another signs in on the same browser", async () => {
    const { owned, browser } = await ownerAndHelper();
    await browser.shops();
    const ownedCookie = await shopCookieName(owned.tenant);
    const token = browser.jar.get(ownedCookie)!.split("~")[1]!;
    const signedIn = await browser.signIn(address("dao"));
    expect(signedIn.status).toBe(200);
    expect(browser.shopCookies()).toEqual([]);
    expect((await asSession({ authorization: `Bearer ${token}` }, "GET", "/v1/approvals?state=open")).status).toBe(401);
    expect((await browser.shops()).body).toEqual({ shops: [] });
  });
});
