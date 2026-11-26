import { describe, expect, it } from "vitest";
import { checkApprovalToken, mintApprovalToken } from "../src/approval-link";
import {
  isValidLinePushProposal,
  lineReplyText,
  lineTextEvents,
  openLineCredentials,
  pushLineMessage,
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
