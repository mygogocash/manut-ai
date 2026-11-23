import { adminFetch } from "./authenticated-fixtures";
import {
  createExecutionContext,
  createScheduledController,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { lineRetryKey } from "../src/connectors/line";
import { runMorningBriefs } from "../src/owner-line";
import { briefDay } from "../src/owner-line-rules";
import { bangkokDay } from "../src/pilot-gate";
import { credStub } from "../src/tenant-data";

// Owner messages on LINE (docs/pilot-api.md) through the real Worker and objects: Manut AI's own LINE account,
// linking a shop's owner with a one-time code, the approval card for each proposed reply, and the morning brief.
//
// Every delivery is signed here with fixture channel secrets, and every call to api.line.me is answered by a stub on
// the global fetch, which the Worker uses. Nothing reaches LINE.

const bindings = env as unknown as Env;
const OPERATOR = { authorization: "Bearer test-key", "content-type": "application/json" };
const API = "https://api.manut.test";
const WEB = "https://web.manut.test";
const SHOP_SECRET = "fixture-line-channel-secret-0001";
const SHOP_TOKEN = "fixture-line-channel-access-token";
const SHOP_BOT = `U${"b".repeat(32)}`;
const CUSTOMER = `U${"c".repeat(32)}`;
const MANUT_SECRET = "fixture-manut-line-channel-secret";
const MANUT_TOKEN = "fixture-manut-line-access-token";
const MANUT_CHANNEL = "2000000999";
const MANUT_BOT = `U${"e".repeat(32)}`;
const PUSH = "https://api.line.me/v2/bot/message/push";
const REPLY = "https://api.line.me/v2/bot/message/reply";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const WRONG = "That code did not work. Each code works once, for 30 minutes. Please ask Manut AI for a new one.";
const LIMITED = "Too many tries. Please wait an hour, then send the newest code from Manut AI.";

/// A LINE user id nobody else in this file uses, so one test's guesses never count against another's.
const lineUser = () => `U${crypto.randomUUID().replaceAll("-", "")}`;
let eventCounter = 0;
const eventId = () => `01K${Date.now().toString(36).toUpperCase()}${(eventCounter++).toString().padStart(6, "0")}`;

function sourceIp(): string {
  const groups = crypto.randomUUID().replaceAll("-", "").slice(0, 24).match(/.{4}/g)!;
  return `2001:db8:${groups.join(":")}`;
}

async function call(path: string, init: RequestInit = {}, target: Env = bindings): Promise<Response> {
  const request = new Request(`${API}${path}`, init);
  request.headers.set("cf-connecting-ip", sourceIp());
  const context = createExecutionContext();
  const response = await worker.fetch(request, target, context);
  await waitOnExecutionContext(context);
  return response;
}

async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown) {
  const response = await adminFetch(`${API}${path}`, {
    method,
    headers: OPERATOR,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function setFlags(flags: Record<string, boolean>) {
  expect((await admin("PUT", "/v1/admin/flags", flags)).status).toBe(200);
}

type LineCall = { url: string; headers: Headers; body: Record<string, unknown> };
let lineCalls: LineCall[] = [];
let manutPush: () => Response;
const accepted = () => Response.json({ sentMessages: [{ id: "461230966842064897" }] },
  { headers: { "x-line-request-id": "fixture-request" } });

beforeEach(async () => {
  await setFlags({ officeInbound: true, officeCloud: true, officeExternalWrites: true, ownerLine: true });
  lineCalls = [];
  manutPush = accepted;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    lineCalls.push({ url, headers, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (url === PUSH) return headers.get("authorization") === `Bearer ${MANUT_TOKEN}` ? manutPush() : accepted();
    if (url === REPLY) return Response.json({ sentMessages: [{ id: "1" }] });
    if (url.startsWith("https://api.line.me/v2/bot/profile/")) return Response.json({ displayName: "Somchai" });
    return Response.json({ error: "unexpected_outbound_call" }, { status: 599 });
  });
  expect((await setAccount()).status).toBe(200);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setAccount(secret = MANUT_SECRET) {
  return admin<Record<string, unknown>>("POST", "/v1/admin/pilot/owner-line/account", {
    channelId: MANUT_CHANNEL, botUserId: MANUT_BOT, channelSecret: secret, channelAccessToken: MANUT_TOKEN,
    basicId: "@manutai",
  });
}

/// Everything Manut AI's account pushed, optionally to one owner.
const manutPushes = (to?: string) => lineCalls.filter((entry) => entry.url === PUSH &&
  entry.headers.get("authorization") === `Bearer ${MANUT_TOKEN}` && (to === undefined || entry.body.to === to));
const briefsTo = (to: string) => manutPushes(to).filter((entry) =>
  String((entry.body.messages as { altText?: string }[])[0]?.altText ?? "").includes("yesterday"));
const cardsTo = (to: string) => manutPushes(to).filter((entry) =>
  String((entry.body.messages as { altText?: string }[])[0]?.altText ?? "").includes("drafted a reply"));
const replies = () => lineCalls.filter((entry) => entry.url === REPLY);
const replyTexts = () => replies().map((entry) => (entry.body.messages as { text: string }[])[0]!.text);

async function lineSign(raw: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function textEvent(text: string, userId: string, replyToken = `reply-${crypto.randomUUID().slice(0, 8)}`) {
  return {
    type: "message",
    mode: "active",
    timestamp: Date.now(),
    source: { type: "user", userId },
    webhookEventId: eventId(),
    deliveryContext: { isRedelivery: false },
    replyToken,
    message: { type: "text", id: `${Date.now()}`, quoteToken: "fixture-quote", text },
  };
}

/// One signed delivery to Manut AI's webhook.
async function toManut(payload: unknown, options: { secret?: string; signature?: string | null; target?: Env } = {}) {
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signature = options.signature === undefined ? await lineSign(raw, options.secret ?? MANUT_SECRET) : options.signature;
  if (signature !== null) headers["x-line-signature"] = signature;
  return call("/v1/inbound/owner-line", { method: "POST", headers, body: raw }, options.target);
}

/// An owner writes `text` in the chat with Manut AI's account.
async function ownerSays(owner: string, text: string) {
  const response = await toManut({ destination: MANUT_BOT, events: [textEvent(text, owner)] });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
}

type Shop = { tenant: string; connectionId: string };

async function newShop(connect = true): Promise<Shop> {
  const created = await admin<{ tenant: string }>("POST", "/v1/admin/pilot/shops", { name: "Baan Somtam", ownerName: "Khun Ploy" });
  expect(created.status).toBe(200);
  const tenant = created.body.tenant;
  if (!connect) return { tenant, connectionId: "" };
  const connected = await admin<{ connectionId: string }>("POST", "/v1/admin/pilot/line-connections", {
    tenant, channelId: "2000000001", botUserId: SHOP_BOT, channelSecret: SHOP_SECRET, channelAccessToken: SHOP_TOKEN,
  });
  expect(connected.status).toBe(200);
  return { tenant, connectionId: connected.body.connectionId };
}

async function linkCode(tenant: string) {
  return admin<{ code: string; expiresAt: string; error?: string }>("POST", "/v1/admin/pilot/owner-line/link-codes", { tenant });
}

/// Links a new owner to the shop through a real code, and answers the owner's LINE user id.
async function linkOwner(shop: Shop): Promise<string> {
  const owner = lineUser();
  const minted = await linkCode(shop.tenant);
  expect(minted.status).toBe(200);
  await ownerSays(owner, minted.body.code);
  return owner;
}

type ShopRow = { tenant: string; ownerLinkedAt?: string };

async function shopRow(tenant: string): Promise<ShopRow | undefined> {
  const listed = await admin<{ shops: ShopRow[] }>("GET", "/v1/admin/pilot/shops");
  expect(listed.status).toBe(200);
  return listed.body.shops.find((entry) => entry.tenant === tenant);
}

type Exported = { pilot: { shop: Record<string, unknown>; replies: Record<string, unknown>[]; briefs: Record<string, unknown>[] } };

async function exported(tenant: string) {
  return admin<Exported>("GET", `/v1/admin/pilot/export?tenant=${encodeURIComponent(tenant)}`);
}

async function customerWrites(shop: Shop, text: string) {
  const raw = JSON.stringify({ destination: SHOP_BOT, events: [textEvent(text, CUSTOMER)] });
  const response = await call(`/v1/inbound/line/${shop.connectionId}`, { method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": await lineSign(raw, SHOP_SECRET) }, body: raw });
  expect(response.status).toBe(200);
  const listed = await admin<{ messages: { id: string; text: string }[] }>("GET",
    `/v1/admin/pilot/messages?tenant=${encodeURIComponent(shop.tenant)}`);
  return listed.body.messages.find((message) => message.text === text)!;
}

type Proposed = { taskId: string; actionId: string; approvalUrl: string; expiresAt: string };

async function propose(shop: Shop, text: string, reply: string) {
  const message = await customerWrites(shop, text);
  const proposed = await admin<Proposed>("POST", "/v1/admin/pilot/replies", { tenant: shop.tenant, messageId: message.id,
    text: reply });
  expect(proposed.status).toBe(200);
  return proposed.body;
}

type OwnerCard = { state: string; attempts: number; lastTriedAt: string; sentAt?: string; reason?: string };

async function cardOf(shop: Shop, actionId: string): Promise<OwnerCard | undefined> {
  const listed = await admin<{ actions: { actionId: string; ownerCard?: OwnerCard }[] }>("GET",
    `/v1/admin/pilot/actions?tenant=${encodeURIComponent(shop.tenant)}`);
  return listed.body.actions.find((action) => action.actionId === actionId)?.ownerCard;
}

function retryCard(shop: Shop, actionId: string) {
  return admin<{ ownerCard?: OwnerCard; error?: string }>("POST", "/v1/admin/pilot/owner-line/cards",
    { tenant: shop.tenant, actionId });
}

async function linkPost(approvalUrl: string, leaf: "consent" | "decision", body: unknown) {
  const token = approvalUrl.slice(`${WEB}/approve/`.length);
  const response = await call(`/v1/pilot/approvals/${token}/${leaf}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(response.status).toBe(200);
}

/// 08:00 in Bangkok tomorrow, so the brief's "yesterday" is today, when this test's records were made.
function tomorrowMorning(minutesLate = 0): number {
  return (bangkokDay(Date.now()) + 1) * DAY_MS - 7 * HOUR_MS + 8 * HOUR_MS + minutesLate * 60_000;
}

const flagsOn = async () => ({ ownerLine: true });

describe("Manut AI's own LINE account", () => {
  it("keeps its secrets sealed in the vault and never answers them back", async () => {
    const set = await setAccount();
    expect(set.body).toEqual({ channelId: MANUT_CHANNEL, botUserId: MANUT_BOT, basicId: "@manutai",
      webhookUrl: `${API}/v1/inbound/owner-line`, connectedAt: expect.any(String) });
    const status = await admin("GET", "/v1/admin/pilot/owner-line");
    expect(status).toEqual({ status: 200, body: { enabled: true, account: set.body } });
    for (const answer of [set.body, status.body]) {
      expect(JSON.stringify(answer)).not.toContain(MANUT_SECRET);
      expect(JSON.stringify(answer)).not.toContain(MANUT_TOKEN);
    }
    // The vault holds the pair sealed, like a shop's: its listing shows metadata only.
    const vault = credStub(bindings, "manut:owner-line");
    const listed = await vault.fetch(new Request("https://cred/connections?tenant=manut%3Aowner-line",
      { headers: { "x-tenant": "manut:owner-line" } }));
    const text = await listed.text();
    expect(text).toContain(MANUT_BOT);
    expect(text).not.toContain(MANUT_SECRET);
    expect(text).not.toContain(MANUT_TOKEN);
  });

  it("refuses an account it could not use, and keeps the one it has", async () => {
    for (const body of [
      { channelId: MANUT_CHANNEL, botUserId: MANUT_BOT, channelSecret: MANUT_SECRET },
      { channelId: MANUT_CHANNEL, botUserId: "manut-bot", channelSecret: MANUT_SECRET, channelAccessToken: MANUT_TOKEN },
      { channelId: MANUT_CHANNEL, botUserId: MANUT_BOT, channelSecret: MANUT_SECRET, channelAccessToken: MANUT_TOKEN,
        basicId: "manut ai" },
    ]) {
      expect(await admin("POST", "/v1/admin/pilot/owner-line/account", body)).toEqual({ status: 400,
        body: { error: "invalid_request" } });
    }
    expect((await admin<{ account: unknown }>("GET", "/v1/admin/pilot/owner-line")).body.account).not.toBeNull();
  });

  it("revokes the old account when a new one is set, so the old secret signs nothing", async () => {
    expect((await setAccount("a-rotated-manut-channel-secret")).status).toBe(200);
    const payload = { destination: MANUT_BOT, events: [] };
    expect((await toManut(payload)).status).toBe(401);
    expect((await toManut(payload, { secret: "a-rotated-manut-channel-secret" })).status).toBe(200);
  });

  it("answers only through the admin gate, on its exact methods", async () => {
    const keyless = await adminFetch(`${API}/v1/admin/pilot/owner-line`, { headers: { authorization: "Bearer wrong" } });
    expect(keyless.status).toBe(403);
    for (const [method, path] of [["GET", "/v1/admin/pilot/owner-line/account"], ["PUT", "/v1/admin/pilot/owner-line"],
      ["GET", "/v1/admin/pilot/owner-line/link-codes"], ["POST", "/v1/admin/pilot/owner-line/link-codes/x"]] as const) {
      expect((await admin(method, path, method === "GET" ? undefined : {})).status).toBe(404);
    }
  });
});

describe("linking an owner", () => {
  it("links whoever sends the code, and answers through the reply token", async () => {
    const shop = await newShop();
    const minted = await linkCode(shop.tenant);
    expect(minted.status).toBe(200);
    expect(minted.body.code).toMatch(/^[0-9]{8}$/);
    expect(Date.parse(minted.body.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(Date.parse(minted.body.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    const owner = lineUser();
    await ownerSays(owner, `${minted.body.code.slice(0, 4)} ${minted.body.code.slice(4)}`);

    expect(replies()).toHaveLength(1);
    expect(replies()[0]!.headers.get("authorization")).toBe(`Bearer ${MANUT_TOKEN}`);
    expect(replies()[0]!.body.replyToken).toMatch(/^reply-/);
    expect(replyTexts()).toEqual(["Done. You are linked to Baan Somtam. Replies that wait for your OK will come here, " +
      "with a short summary each morning at 08:00."]);
    const row = await shopRow(shop.tenant);
    expect(typeof row?.ownerLinkedAt).toBe("string");
    // The console learns that the owner is linked, never who they are on LINE.
    expect(JSON.stringify(row)).not.toContain(owner);
    expect((await exported(shop.tenant)).body.pilot.shop).toMatchObject({ ownerLineUserId: owner,
      ownerLinkedAt: row!.ownerLinkedAt });
  });

  it("keeps only a keyed hash of a code", async () => {
    const shop = await newShop();
    const { code } = (await linkCode(shop.tenant)).body;
    const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    const stored = await runInDurableObject(auth, async (_instance, state) =>
      JSON.stringify([...(await state.storage.list()).entries()]));
    expect(stored).toContain(encodeURIComponent(shop.tenant));
    expect(stored).not.toContain(code);
  });

  it("gives a used, replaced, expired or unknown code the same polite answer, and links nobody", async () => {
    const shop = await newShop();
    const first = lineUser();
    const { code } = (await linkCode(shop.tenant)).body;
    await ownerSays(first, code);
    // Used: another LINE user sends the same code.
    const second = lineUser();
    await ownerSays(second, code);
    // Replaced: a newer code for a shop retires the one before it.
    const other = await newShop();
    const old = (await linkCode(other.tenant)).body.code;
    const fresh = (await linkCode(other.tenant)).body.code;
    expect(fresh).not.toBe(old);
    await ownerSays(lineUser(), old);
    // Expired: the code's half hour has passed.
    const third = await newShop();
    const late = (await linkCode(third.tenant)).body.code;
    const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    await runInDurableObject(auth, async (_instance, state) => {
      for (const [key, value] of await state.storage.list<Record<string, unknown>>({ prefix: "owner-link-code:" })) {
        if (value.tenant === third.tenant) await state.storage.put(key, { ...value, expiresAtMs: Date.now() - 1 });
      }
    });
    await ownerSays(lineUser(), late);
    // Unknown: a code nobody issued.
    await ownerSays(lineUser(), code === "00000000" ? "00000001" : "00000000");

    expect(replyTexts()).toEqual([expect.stringContaining("Done."), WRONG, WRONG, WRONG, WRONG]);
    expect((await exported(shop.tenant)).body.pilot.shop.ownerLineUserId).toBe(first);
    expect((await shopRow(other.tenant))?.ownerLinkedAt).toBeUndefined();
    expect((await shopRow(third.tenant))?.ownerLinkedAt).toBeUndefined();
  });

  it("stops taking codes from a LINE user after five wrong ones, the right code included", async () => {
    const shop = await newShop();
    const { code } = (await linkCode(shop.tenant)).body;
    const guesser = lineUser();
    for (let i = 0; i < 5; i++) await ownerSays(guesser, `9999999${i}` === code ? "88888888" : `9999999${i}`);
    await ownerSays(guesser, code);
    expect(replyTexts()).toEqual([WRONG, WRONG, WRONG, WRONG, WRONG, LIMITED]);
    expect((await shopRow(shop.tenant))?.ownerLinkedAt).toBeUndefined();
    // The limit is the guesser's alone: the shop's owner can still use the code.
    await ownerSays(lineUser(), code);
    expect(replyTexts().at(-1)).toContain("Done.");
  });

  it("answers no ordinary chat and keeps nothing of it", async () => {
    const owner = lineUser();
    await ownerSays(owner, "สวัสดีค่ะ");
    await ownerSays(owner, "1234");
    expect(replies()).toEqual([]);
    const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    const stored = await runInDurableObject(auth, async (_instance, state) =>
      JSON.stringify([...(await state.storage.list()).entries()]));
    expect(stored).not.toContain(owner);
  });

  it("unlinks, and a code issued before unlinking stops working", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    const pending = (await linkCode(shop.tenant)).body.code;
    expect(await admin("POST", "/v1/admin/pilot/owner-line/unlink", { tenant: shop.tenant }))
      .toEqual({ status: 200, body: { unlinked: true } });
    expect((await shopRow(shop.tenant))?.ownerLinkedAt).toBeUndefined();
    expect((await exported(shop.tenant)).body.pilot.shop.ownerLineUserId).toBeUndefined();
    await ownerSays(owner, pending);
    expect(replyTexts().at(-1)).toBe(WRONG);
    expect(await admin("POST", "/v1/admin/pilot/owner-line/unlink", { tenant: shop.tenant }))
      .toEqual({ status: 200, body: { unlinked: false } });
  });

  it("issues codes only while owner messages are on, for a shop that exists", async () => {
    const shop = await newShop();
    await setFlags({ ownerLine: false });
    expect(await linkCode(shop.tenant)).toEqual({ status: 403, body: { error: "feature_disabled", feature: "ownerLine" } });
    await setFlags({ ownerLine: true });
    expect((await linkCode("pilot:never-a-shop")).status).toBe(404);
    expect((await linkCode("")).status).toBe(400);
  });
});

describe("Manut AI's webhook", () => {
  it("answers an empty 404 while owner messages are off, before reading anything", async () => {
    const shop = await newShop();
    const { code } = (await linkCode(shop.tenant)).body;
    await setFlags({ ownerLine: false });
    const closed = await toManut({ destination: MANUT_BOT, events: [textEvent(code, lineUser())] });
    expect(closed.status).toBe(404);
    expect(await closed.text()).toBe("");
    expect(replies()).toEqual([]);
    expect((await shopRow(shop.tenant))?.ownerLinkedAt).toBeUndefined();
  });

  it("refuses bad signatures, and takes nothing addressed to another bot", async () => {
    const shop = await newShop();
    const { code } = (await linkCode(shop.tenant)).body;
    const payload = { destination: MANUT_BOT, events: [textEvent(code, lineUser())] };
    for (const refused of [await toManut(payload, { secret: SHOP_SECRET }), await toManut(payload, { signature: null }),
      await toManut(payload, { signature: "not-a-signature" })]) {
      expect(refused.status).toBe(401);
      expect(await refused.text()).toBe("");
    }
    expect((await toManut({ destination: SHOP_BOT, events: [textEvent(code, lineUser())] })).status).toBe(200);
    expect(replies()).toEqual([]);
    expect((await shopRow(shop.tenant))?.ownerLinkedAt).toBeUndefined();
  });

  it("counts against the LINE webhook limit before anything is read", async () => {
    const keys: string[] = [];
    const limited: Env = { ...bindings, LINE_INBOUND_LIMITER: { limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    } } as RateLimit };
    const response = await toManut({ destination: MANUT_BOT, events: [] }, { target: limited });
    expect(response.status).toBe(429);
    expect(keys).toHaveLength(1);
  });
});

describe("approval cards", () => {
  it("pushes one card to the linked owner when a reply is proposed, and records it on the reply", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    const proposed = await propose(shop, "พรุ่งนี้เปิดกี่โมงคะ", "เปิด 9 โมงค่ะ");

    const cards = cardsTo(owner);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.headers.get("x-line-retry-key")).toBe(await lineRetryKey("owner-card", shop.tenant, proposed.actionId));
    const [message] = card.body.messages as { type: string; altText: string }[];
    expect(message).toMatchObject({ type: "flex", altText: "Baan Somtam: Nam drafted a reply to Somchai. It waits for your OK." });
    const json = JSON.stringify(message);
    expect(json).toContain("พรุ่งนี้เปิดกี่โมงคะ");
    expect(json).toContain("เปิด 9 โมงค่ะ");
    // One way in, and it is the signed approval page that settles once.
    expect(json.match(/"uri":"[^"]*"/g)).toEqual([`"uri":"${proposed.approvalUrl}"`]);
    expect(json).not.toContain("postback");
    expect(await cardOf(shop, proposed.actionId)).toEqual({ state: "sent", attempts: 1,
      lastTriedAt: expect.any(String), sentAt: expect.any(String) });
  });

  it("pushes nothing while the owner is not linked, or while owner messages are off", async () => {
    const unlinked = await newShop();
    const quiet = await propose(unlinked, "มีสีอื่นไหม", "มีสีขาวค่ะ");
    expect(await cardOf(unlinked, quiet.actionId)).toBeUndefined();
    const shop = await newShop();
    const owner = await linkOwner(shop);
    await setFlags({ ownerLine: false });
    const off = await propose(shop, "ส่งฟรีไหม", "ส่งฟรีค่ะ");
    expect(await cardOf(shop, off.actionId)).toBeUndefined();
    expect(manutPushes()).toEqual([]);
    expect(cardsTo(owner)).toEqual([]);
  });

  it("never fails a proposal: a refused card is recorded, and the operator's retry sends it once", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    manutPush = () => Response.json({ message: "You have reached your monthly limit." }, { status: 429 });
    const proposed = await propose(shop, "ขอเลขพัสดุค่ะ", "ส่งให้แล้วค่ะ");
    expect(await cardOf(shop, proposed.actionId)).toMatchObject({ state: "failed", attempts: 1, reason: "provider_429" });

    manutPush = accepted;
    const retried = await retryCard(shop, proposed.actionId);
    expect(retried.status).toBe(200);
    expect(retried.body.ownerCard).toMatchObject({ state: "sent", attempts: 2, sentAt: expect.any(String) });
    expect(retried.body.ownerCard).not.toHaveProperty("reason");
    // A card already sent is answered as it stands, and pushed no more.
    expect((await retryCard(shop, proposed.actionId)).body.ownerCard).toMatchObject({ state: "sent", attempts: 2 });
    const keys = cardsTo(owner).map((entry) => entry.headers.get("x-line-retry-key"));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("retries a card LINE never answered under the same key, so LINE never shows it twice", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    manutPush = () => Response.json({ message: "server error" }, { status: 500 });
    const proposed = await propose(shop, "จองได้ไหม", "ได้ค่ะ");
    expect(await cardOf(shop, proposed.actionId)).toMatchObject({ state: "unknown", reason: "provider_500" });
    manutPush = () => Response.json({ message: "The retry key is already accepted" },
      { status: 409, headers: { "x-line-accepted-request-id": "fixture-request" } });
    expect((await retryCard(shop, proposed.actionId)).body.ownerCard).toMatchObject({ state: "sent", attempts: 2 });
    expect(new Set(cardsTo(owner).map((entry) => entry.headers.get("x-line-retry-key"))).size).toBe(1);
  });

  it("refuses a retry that could not help", async () => {
    const shop = await newShop();
    await linkOwner(shop);
    manutPush = () => Response.json({}, { status: 400 });
    const declined = await propose(shop, "ลดได้ไหม", "ลดไม่ได้ค่ะ");
    await linkPost(declined.approvalUrl, "decision", { approve: false });
    expect(await retryCard(shop, declined.actionId)).toEqual({ status: 409, body: { error: "reply_not_waiting" } });
    expect(await retryCard(shop, crypto.randomUUID())).toEqual({ status: 404, body: { error: "reply_not_found" } });
    const waiting = await propose(shop, "มีไซส์ L ไหม", "มีค่ะ");
    await setFlags({ ownerLine: false });
    expect(await retryCard(shop, waiting.actionId)).toEqual({ status: 403,
      body: { error: "feature_disabled", feature: "ownerLine" } });
    await setFlags({ ownerLine: true });
    expect((await admin("POST", "/v1/admin/pilot/owner-line/unlink", { tenant: shop.tenant })).status).toBe(200);
    expect(await retryCard(shop, waiting.actionId)).toEqual({ status: 409, body: { error: "owner_not_linked" } });
  });
});

describe("the morning brief", () => {
  it("sends a linked owner of a live shop yesterday's counts once, with the reply waiting longest", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    const sent = await propose(shop, "เปิดกี่โมง", "9 โมงค่ะ");
    await linkPost(sent.approvalUrl, "consent", { cloudWork: true });
    await linkPost(sent.approvalUrl, "decision", { approve: true });
    const waiting = await propose(shop, "มีสีแดงไหม", "มีค่ะ");
    await customerWrites(shop, "ขอบคุณค่ะ");
    expect((await admin("POST", "/v1/admin/pilot/payments", { tenant: shop.tenant, orderRef: "SP-1", amountSatang: 45000,
      promptPayId: "0812345678" })).status).toBe(200);

    const morning = tomorrowMorning();
    await runMorningBriefs(bindings, flagsOn, morning);
    const briefs = briefsTo(owner);
    expect(briefs).toHaveLength(1);
    const brief = briefs[0]!;
    expect(brief.headers.get("x-line-retry-key")).toBe(await lineRetryKey("owner-brief", shop.tenant,
      briefDay(morning).date));
    const [message] = brief.body.messages as { altText: string }[];
    expect(message!.altText).toBe("Baan Somtam yesterday: 3 customer messages, 1 reply sent, 1 payment recorded. " +
      "1 reply is waiting for your OK.");
    expect(JSON.stringify(message).match(/"uri":"[^"]*"/g)).toEqual([`"uri":"${waiting.approvalUrl}"`]);

    // Once a day, however many runs arrive.
    await runMorningBriefs(bindings, flagsOn, morning);
    await runMorningBriefs(bindings, flagsOn, tomorrowMorning(30));
    expect(briefsTo(owner)).toHaveLength(1);
    expect((await exported(shop.tenant)).body.pilot.briefs).toEqual([expect.objectContaining({
      date: briefDay(morning).date, state: "sent",
      counts: { messages: 3, repliesSent: 1, repliesWaiting: 1, payments: 1 } })]);
  });

  it("retries an unanswered brief at 08:30 under the same key, and never sends a second", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    await customerWrites(shop, "สวัสดีค่ะ");
    manutPush = () => Response.json({}, { status: 503 });
    await runMorningBriefs(bindings, flagsOn, tomorrowMorning());
    manutPush = () => Response.json({ message: "The retry key is already accepted" },
      { status: 409, headers: { "x-line-accepted-request-id": "fixture-request" } });
    await runMorningBriefs(bindings, flagsOn, tomorrowMorning(30));
    await runMorningBriefs(bindings, flagsOn, tomorrowMorning(30));
    const keys = briefsTo(owner).map((entry) => entry.headers.get("x-line-retry-key"));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect((await exported(shop.tenant)).body.pilot.briefs).toEqual([expect.objectContaining({ state: "sent" })]);
  });

  it("sends nothing on a day with nothing to say, and records that it was skipped", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    await runMorningBriefs(bindings, flagsOn, tomorrowMorning());
    expect(briefsTo(owner)).toEqual([]);
    expect((await exported(shop.tenant)).body.pilot.briefs).toEqual([expect.objectContaining({ state: "skipped",
      counts: { messages: 0, repliesSent: 0, repliesWaiting: 0, payments: 0 } })]);
  });

  it("sends nothing while owner messages are off, nor for a shop that is not live", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    await customerWrites(shop, "มีของไหม");
    await setFlags({ ownerLine: false });
    const context = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: tomorrowMorning(), cron: "0 1 * * *" }),
      bindings, context);
    await waitOnExecutionContext(context);
    expect(briefsTo(owner)).toEqual([]);
    expect((await exported(shop.tenant)).body.pilot.briefs).toEqual([]);

    await setFlags({ ownerLine: true });
    const notLive = await newShop(false);
    const notLiveOwner = await linkOwner(notLive);
    await runMorningBriefs(bindings, flagsOn, tomorrowMorning());
    expect(briefsTo(notLiveOwner)).toEqual([]);
    expect((await exported(notLive.tenant)).body.pilot.briefs).toEqual([]);
  });

  it("runs from the Worker's cron trigger", async () => {
    const shop = await newShop();
    const owner = await linkOwner(shop);
    await customerWrites(shop, "ราคาเท่าไหร่คะ");
    const context = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: tomorrowMorning(), cron: "0 1 * * *" }),
      bindings, context);
    await waitOnExecutionContext(context);
    expect(briefsTo(owner)).toHaveLength(1);
  });
});

describe("export and deletion", () => {
  it("exports the owner's link, cards and briefs with the shop, and deleting it forgets its live code", async () => {
    const shop = await newShop(false);
    const owner = await linkOwner(shop);
    const pending = (await linkCode(shop.tenant)).body.code;
    const before = (await exported(shop.tenant)).body;
    expect(before.pilot.shop).toMatchObject({ ownerLineUserId: owner, ownerLinkedAt: expect.any(String) });
    expect(before.pilot.briefs).toEqual([]);

    // Never live (no LINE connection, no consent), so the operator deletes it alone.
    const deleted = await admin("POST", "/v1/admin/pilot/deletions", { tenant: shop.tenant, confirmName: "Baan Somtam" });
    expect(deleted.status).toBe(200);
    const auth = bindings.AUTH.get(bindings.AUTH.idFromName("auth"));
    const stored = await runInDurableObject(auth, async (_instance, state) =>
      JSON.stringify([...(await state.storage.list({ prefix: "owner-link" })).entries()]));
    // Neither the code (which names the shop) nor the shop's pointer to it is left, in either spelling.
    expect(stored).not.toContain(shop.tenant.slice("pilot:".length));
    await ownerSays(lineUser(), pending);
    expect(replyTexts().at(-1)).toBe(WRONG);
    expect((await linkCode(shop.tenant)).status).toBe(404);
  });
});
