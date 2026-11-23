import { describe, expect, it } from "vitest";
import { checkApprovalToken, mintApprovalToken } from "../src/approval-link";
import {
  isValidLinePushProposal,
  lineReplyText,
  lineRetryKey,
  lineTextEvents,
  lineTextEventsWithReply,
  openLineCredentials,
  pushLineMessage,
  pushLineMessages,
  replyLineMessages,
  sealableLineCredentials,
  verifyLineSignature,
} from "../src/connectors/line";

// Manut AI pilot, LINE connector and approval link, as pure functions. Every
// LINE answer here is a synthetic fixture shaped after LINE's reference
// (cited in src/connectors/line.ts); nothing reaches api.line.me.

const SECRET = "fixture-line-channel-secret";
const BOT = `U${"b".repeat(32)}`;
const CUSTOMER = `U${"c".repeat(32)}`;
const RETRY_KEY = "123e4567-e89b-42d3-a456-426614174000";
const LINK_SECRET = "fixture-approval-link-secret-0123456789";

async function lineSign(raw: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("LINE webhook signature", () => {
  it("accepts the Base64 HMAC of the exact bytes and nothing else", async () => {
    const raw = '{"destination":"x","events":[]}';
    const good = await lineSign(raw);
    expect(await verifyLineSignature(SECRET, bytes(raw), good)).toBe(true);
    // Tampered body, other secret, missing secret, missing or malformed header.
    expect(await verifyLineSignature(SECRET, bytes(`${raw} `), good)).toBe(false);
    expect(await verifyLineSignature("another-channel-secret", bytes(raw), good)).toBe(false);
    expect(await verifyLineSignature(undefined, bytes(raw), good)).toBe(false);
    expect(await verifyLineSignature(SECRET, bytes(raw), null)).toBe(false);
    expect(await verifyLineSignature(SECRET, bytes(raw), "not-base64")).toBe(false);
    // Hex, Linear's encoding, is not LINE's.
    const hex = [...atob(good)].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    expect(await verifyLineSignature(SECRET, bytes(raw), hex)).toBe(false);
  });
});

describe("LINE webhook events", () => {
  const text = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "message",
    mode: "active",
    timestamp: 1_700_000_000_000,
    source: { type: "user", userId: CUSTOMER },
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    replyToken: "reply-token-never-kept",
    message: { type: "text", id: "444573844083572737", quoteToken: "q", text: "สวัสดีค่ะ มีของไหม" },
    ...extra,
  });

  it("keeps text messages from users and drops everything else", () => {
    const events = lineTextEvents({
      destination: BOT,
      events: [
        text("01FZ74A0TDDPYRVKNK77XKC3ZR"),
        text("01FZ74A0TDDPYRVKNK77XKC3Z1", { source: { type: "group", groupId: "Cxyz", userId: CUSTOMER } }),
        text("01FZ74A0TDDPYRVKNK77XKC3Z2", { message: { type: "sticker", id: "1", packageId: "1", stickerId: "1" } }),
        { type: "follow", source: { type: "user", userId: CUSTOMER }, webhookEventId: "01FZ74ASS536FW97EX38NKCZQK" },
        text("01FZ74A0TDDPYRVKNK77XKC3Z3", { source: { type: "user", userId: "not-a-line-user" } }),
        text("bad id with spaces"),
      ],
    }, BOT);
    expect(events).toEqual([
      { webhookEventId: "01FZ74A0TDDPYRVKNK77XKC3ZR", lineUserId: CUSTOMER, text: "สวัสดีค่ะ มีของไหม" },
    ]);
  });

  it("files nothing from a delivery addressed to another bot", () => {
    expect(lineTextEvents({ destination: `U${"a".repeat(32)}`, events: [text("01FZ74A0TDDPYRVKNK77XKC3ZR")] }, BOT))
      .toEqual([]);
    expect(lineTextEvents({ destination: BOT, events: [] }, BOT)).toEqual([]);
    expect(lineTextEvents(null, BOT)).toEqual([]);
  });
});

describe("LINE credentials envelope", () => {
  it("round-trips both secrets and refuses anything else", () => {
    const sealed = sealableLineCredentials({ channelAccessToken: "token", channelSecret: SECRET });
    expect(openLineCredentials(sealed)).toEqual({ channelAccessToken: "token", channelSecret: SECRET });
    expect(openLineCredentials("bare-refresh-token")).toBeNull();
    expect(openLineCredentials(JSON.stringify({ v: 2, channelAccessToken: "t", channelSecret: "s" }))).toBeNull();
    expect(openLineCredentials(JSON.stringify({ v: 1, channelAccessToken: "t" }))).toBeNull();
  });
});

describe("line.message.push proposal shape", () => {
  it("takes exactly one LINE user and exactly one text of 1 to 5,000 characters", () => {
    const ok = { payload: { text: "ได้ค่ะ" }, recipients: [CUSTOMER], targetResourceId: BOT };
    expect(isValidLinePushProposal(ok)).toBe(true);
    expect(isValidLinePushProposal({ ...ok, payload: { text: "x".repeat(5000) } })).toBe(true);
    expect(isValidLinePushProposal({ ...ok, payload: { text: "x".repeat(5001) } })).toBe(false);
    expect(isValidLinePushProposal({ ...ok, payload: { text: "" } })).toBe(false);
    expect(isValidLinePushProposal({ ...ok, payload: { text: "hi", quickReply: {} } })).toBe(false);
    expect(isValidLinePushProposal({ ...ok, recipients: [] })).toBe(false);
    expect(isValidLinePushProposal({ ...ok, recipients: [CUSTOMER, `U${"d".repeat(32)}`] })).toBe(false);
    expect(isValidLinePushProposal({ ...ok, recipients: ["customer@example.com"] })).toBe(false);
    expect(isValidLinePushProposal({ ...ok, targetResourceId: "project-1" })).toBe(false);
    expect(lineReplyText({ text: "ok" })).toBe("ok");
    expect(lineReplyText(["ok"])).toBeNull();
  });
});

describe("LINE push", () => {
  type Seen = { url: string; init: RequestInit };
  function stub(answer: () => Response | Promise<Response>) {
    const seen: Seen[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      return answer();
    };
    return { seen, fetchImpl };
  }
  const push = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, input = {}) =>
    pushLineMessage(fetchImpl, "channel-token", { to: CUSTOMER, text: "ได้ค่ะ", retryKey: RETRY_KEY, ...input });

  it("sends one text with the retry key and confirms an accepted push", async () => {
    const { seen, fetchImpl } = stub(() => Response.json({ sentMessages: [{ id: "461230966842064897", quoteToken: "q" }] },
      { headers: { "x-line-request-id": "req-1" } }));
    const result = await push(fetchImpl);
    expect(result).toEqual({
      outcome: "confirmed",
      receipt: { providerOperationId: "461230966842064897", requestId: "req-1", sentMessageIds: ["461230966842064897"],
        alreadyAccepted: false },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.line.me/v2/bot/message/push");
    const headers = new Headers(seen[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer channel-token");
    expect(headers.get("x-line-retry-key")).toBe(RETRY_KEY);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ to: CUSTOMER, messages: [{ type: "text", text: "ได้ค่ะ" }] });
  });

  it("confirms a 409 that says this retry key was already accepted", async () => {
    const { fetchImpl } = stub(() => Response.json(
      { message: "The retry key is already accepted", sentMessages: [{ id: "461230966842064897" }] },
      { status: 409, headers: { "x-line-request-id": "req-2", "x-line-accepted-request-id": "req-1" } },
    ));
    expect(await push(fetchImpl)).toEqual({
      outcome: "confirmed",
      receipt: { providerOperationId: "461230966842064897", requestId: "req-2", acceptedRequestId: "req-1",
        sentMessageIds: ["461230966842064897"], alreadyAccepted: true },
    });
  });

  it("holds a 409 without LINE's accepted-request header as unknown", async () => {
    const { fetchImpl } = stub(() => Response.json({ message: "conflict" }, { status: 409 }));
    expect(await push(fetchImpl)).toMatchObject({ outcome: "unknown" });
  });

  it.each([400, 401, 403, 429])("fails a %s, which LINE documents as nothing sent", async (status) => {
    const { fetchImpl } = stub(() => Response.json({ message: "refused" }, { status }));
    expect(await push(fetchImpl)).toEqual({ outcome: "failed", reason: `provider_${status}` });
  });

  it("holds server errors and lost connections as unknown", async () => {
    expect(await push(stub(() => Response.json({}, { status: 500 })).fetchImpl)).toMatchObject({ outcome: "unknown" });
    expect(await push(stub(() => { throw new Error("socket hang up"); }).fetchImpl))
      .toEqual({ outcome: "unknown", reason: "provider_unreachable" });
  });

  it("fails an unsendable push without calling LINE", async () => {
    const { seen, fetchImpl } = stub(() => Response.json({}));
    for (const input of [{ to: "nobody" }, { text: "" }, { text: "x".repeat(5001) }, { retryKey: "not-a-uuid" }]) {
      expect(await push(fetchImpl, input)).toEqual({ outcome: "failed", reason: "invalid_payload" });
    }
    expect(seen).toHaveLength(0);
  });
});

// Manut AI's own LINE account (owner-line.ts) sends Flex Messages and answers a link code through the reply token.
// The same push rules apply to any message objects; a reply has no retry key, because LINE takes none on reply.
describe("LINE messages beyond one text", () => {
  type Seen = { url: string; init: RequestInit };
  function stub(answer: () => Response | Promise<Response>) {
    const seen: Seen[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, init: init ?? {} });
      return answer();
    };
    return { seen, fetchImpl };
  }
  const flex = { type: "flex", altText: "A card", contents: { type: "bubble" } };

  it("pushes any message objects with the retry key, classified as a text push is", async () => {
    const accepted = stub(() => Response.json({ sentMessages: [{ id: "461230966842064897" }] },
      { headers: { "x-line-request-id": "req-1" } }));
    expect(await pushLineMessages(accepted.fetchImpl, "manut-token", { to: CUSTOMER, messages: [flex], retryKey: RETRY_KEY }))
      .toMatchObject({ outcome: "confirmed", receipt: { providerOperationId: "461230966842064897", alreadyAccepted: false } });
    expect(accepted.seen[0]!.url).toBe("https://api.line.me/v2/bot/message/push");
    expect(new Headers(accepted.seen[0]!.init.headers).get("x-line-retry-key")).toBe(RETRY_KEY);
    expect(JSON.parse(String(accepted.seen[0]!.init.body))).toEqual({ to: CUSTOMER, messages: [flex] });

    const repeated = stub(() => Response.json({ message: "The retry key is already accepted" },
      { status: 409, headers: { "x-line-accepted-request-id": "req-1" } }));
    expect(await pushLineMessages(repeated.fetchImpl, "manut-token", { to: CUSTOMER, messages: [flex], retryKey: RETRY_KEY }))
      .toMatchObject({ outcome: "confirmed", receipt: { alreadyAccepted: true, acceptedRequestId: "req-1" } });
    const refused = stub(() => Response.json({ message: "You have reached your monthly limit." }, { status: 429 }));
    expect(await pushLineMessages(refused.fetchImpl, "manut-token", { to: CUSTOMER, messages: [flex], retryKey: RETRY_KEY }))
      .toEqual({ outcome: "failed", reason: "provider_429" });
    const lost = stub(() => { throw new Error("socket hang up"); });
    expect(await pushLineMessages(lost.fetchImpl, "manut-token", { to: CUSTOMER, messages: [flex], retryKey: RETRY_KEY }))
      .toEqual({ outcome: "unknown", reason: "provider_unreachable" });
  });

  it("refuses no messages, more than five, or a message without a type, without calling LINE", async () => {
    const { seen, fetchImpl } = stub(() => Response.json({}));
    for (const messages of [[], [flex, flex, flex, flex, flex, flex], [{ altText: "no type" }], ["text"]]) {
      expect(await pushLineMessages(fetchImpl, "manut-token", { to: CUSTOMER, messages: messages as Record<string, unknown>[],
        retryKey: RETRY_KEY })).toEqual({ outcome: "failed", reason: "invalid_payload" });
    }
    expect(seen).toHaveLength(0);
  });

  it("answers through the reply token, with no retry key, and reports a refusal without throwing", async () => {
    const answered = stub(() => Response.json({ sentMessages: [{ id: "1" }] }));
    const text = { type: "text", text: "Linked." };
    expect(await replyLineMessages(answered.fetchImpl, "manut-token", { replyToken: "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA",
      messages: [text] })).toEqual({ ok: true });
    expect(answered.seen[0]!.url).toBe("https://api.line.me/v2/bot/message/reply");
    const headers = new Headers(answered.seen[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer manut-token");
    expect(headers.has("x-line-retry-key")).toBe(false);
    expect(JSON.parse(String(answered.seen[0]!.init.body))).toEqual({ replyToken: "nHuyWiB7yP5Zw52FIkcQobQuGDXCTA",
      messages: [text] });

    const used = stub(() => Response.json({ message: "Invalid reply token" }, { status: 400 }));
    expect(await replyLineMessages(used.fetchImpl, "manut-token", { replyToken: "used", messages: [text] }))
      .toEqual({ ok: false, reason: "provider_400" });
    const lost = stub(() => { throw new Error("timeout"); });
    expect(await replyLineMessages(lost.fetchImpl, "manut-token", { replyToken: "t", messages: [text] }))
      .toEqual({ ok: false, reason: "provider_unreachable" });
    const nothing = stub(() => Response.json({}));
    expect(await replyLineMessages(nothing.fetchImpl, "manut-token", { replyToken: "", messages: [text] }))
      .toEqual({ ok: false, reason: "invalid_payload" });
    expect(nothing.seen).toHaveLength(0);
  });

  it("derives one retry key per purpose: a UUID LINE accepts, the same every time, different per purpose", async () => {
    const card = await lineRetryKey("owner-card", "pilot:shop", RETRY_KEY);
    expect(card).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await lineRetryKey("owner-card", "pilot:shop", RETRY_KEY)).toBe(card);
    // Never the action's own key, which the shop's channel already uses for the customer's reply.
    expect(card).not.toBe(RETRY_KEY);
    expect(await lineRetryKey("owner-card", "pilot:other", RETRY_KEY)).not.toBe(card);
    expect(await lineRetryKey("owner-brief", "pilot:shop", "2026-11-24")).not.toBe(card);
    // Parts are kept apart, so moving a separator never gives another purpose's key.
    expect(await lineRetryKey("a:b", "c")).not.toBe(await lineRetryKey("a", "b:c"));
  });
});

describe("text events answered at once", () => {
  it("keeps each text's reply token, for an answer sent straight away and never stored", () => {
    const event = (id: string, replyToken?: unknown) => ({
      type: "message",
      source: { type: "user", userId: CUSTOMER },
      webhookEventId: id,
      ...(replyToken === undefined ? {} : { replyToken }),
      message: { type: "text", id: "1", text: "1234 5678" },
    });
    expect(lineTextEventsWithReply({ destination: BOT, events: [event("01A", "token-1"), event("01B"),
      event("01C", 42)] }, BOT)).toEqual([
      { webhookEventId: "01A", lineUserId: CUSTOMER, text: "1234 5678", replyToken: "token-1" },
      { webhookEventId: "01B", lineUserId: CUSTOMER, text: "1234 5678", replyToken: null },
      { webhookEventId: "01C", lineUserId: CUSTOMER, text: "1234 5678", replyToken: null },
    ]);
    // The shop's customers' reply tokens are still never kept.
    expect(lineTextEvents({ destination: BOT, events: [event("01A", "token-1")] }, BOT)).toEqual([
      { webhookEventId: "01A", lineUserId: CUSTOMER, text: "1234 5678" },
    ]);
    expect(lineTextEventsWithReply({ destination: `U${"a".repeat(32)}`, events: [event("01A", "t")] }, BOT)).toEqual([]);
  });
});

describe("approval link", () => {
  const claim = { tenant: "pilot:shop", taskId: "pilot-task-1", actionId: RETRY_KEY, expiresAtMs: 2_000_000_000_000 };

  it("names exactly what it was minted for, deterministically", async () => {
    const token = await mintApprovalToken(LINK_SECRET, claim);
    expect(await mintApprovalToken(LINK_SECRET, claim)).toBe(token);
    expect(await checkApprovalToken(LINK_SECRET, token, 1_000)).toEqual({ ok: true, claim });
  });

  it("answers expired only for a genuine link past its time", async () => {
    const token = await mintApprovalToken(LINK_SECRET, claim);
    expect(await checkApprovalToken(LINK_SECRET, token, claim.expiresAtMs)).toEqual({ ok: false, error: "link_expired" });
    const forgedExpired = await mintApprovalToken("another-secret-of-sufficient-length-00", { ...claim, expiresAtMs: 1 });
    expect(await checkApprovalToken(LINK_SECRET, forgedExpired, 1_000)).toEqual({ ok: false, error: "link_invalid" });
  });

  it("refuses forged, tampered and re-spelled links", async () => {
    const token = await mintApprovalToken(LINK_SECRET, claim);
    const [payload, mac] = token.split(".") as [string, string];
    const other = await mintApprovalToken(LINK_SECRET, { ...claim, actionId: "another-action" });
    const swapped = `${other.split(".")[0]}.${mac}`;
    const flipped = `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    for (const bad of [swapped, flipped, `${payload}.`, "garbage", "", `${payload}=.${mac}`]) {
      expect(await checkApprovalToken(LINK_SECRET, bad, 1_000)).toEqual({ ok: false, error: "link_invalid" });
    }
    expect(await checkApprovalToken("another-secret-of-sufficient-length-00", token, 1_000))
      .toEqual({ ok: false, error: "link_invalid" });
  });

  it("refuses to mint or accept anything under an unset or short secret", async () => {
    await expect(mintApprovalToken(undefined, claim)).rejects.toThrow();
    await expect(mintApprovalToken("short", claim)).rejects.toThrow();
    const token = await mintApprovalToken(LINK_SECRET, claim);
    expect(await checkApprovalToken(undefined, token, 1_000)).toEqual({ ok: false, error: "link_invalid" });
  });
});
