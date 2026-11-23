import { describe, expect, it } from "vitest";
import { codeAnswers, morningBriefMessage, ownerCardMessage, type BriefCounts } from "../src/owner-line-messages";
import { briefDay, formatLinkCode, LINK_CODE_DIGITS, linkCodeAttempt } from "../src/owner-line-rules";

// Owner messages on LINE (docs/pilot-api.md), as pure functions: how an owner's typed code is read, which day a
// morning brief covers, and the exact messages Manut AI's account sends. Nothing here calls LINE.

const APPROVAL_URL = "https://web.manut.test/approve/eyJ0ZXN0IjoxfQ.signature";

/// The Flex Message fields this code may use, each read from LINE's reference
/// (https://developers.line.biz/en/reference/messaging-api/#flex-message and the
/// component sections it links): a field outside these lists would be a guess.
const ALLOWED: Record<string, { keys: string[]; values?: Record<string, string[]> }> = {
  flex: { keys: ["type", "altText", "contents"] },
  bubble: { keys: ["type", "header", "body", "footer"] },
  box: { keys: ["type", "layout", "contents", "spacing"], values: { layout: ["vertical", "horizontal", "baseline"],
    spacing: ["none", "xs", "sm", "md", "lg", "xl", "xxl"] } },
  text: { keys: ["type", "text", "wrap", "size", "weight", "color"], values: { size: ["xxs", "xs", "sm", "md", "lg",
    "xl", "xxl", "3xl", "4xl", "5xl"], weight: ["regular", "bold"] } },
  separator: { keys: ["type"] },
  button: { keys: ["type", "style", "action"], values: { style: ["primary", "secondary", "link"] } },
  uri: { keys: ["type", "label", "uri"] },
};

type Node = Record<string, unknown>;

function nodes(value: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(value)) value.forEach((item) => nodes(item, found));
  else if (value !== null && typeof value === "object") {
    found.push(value as Node);
    Object.values(value).forEach((item) => nodes(item, found));
  }
  return found;
}

function expectDocumentedShape(message: unknown) {
  for (const node of nodes(message)) {
    const rule = ALLOWED[String(node.type)];
    expect(rule, `component type ${String(node.type)}`).toBeDefined();
    for (const key of Object.keys(node)) expect(rule!.keys, `${String(node.type)}.${key}`).toContain(key);
    for (const [key, allowed] of Object.entries(rule!.values ?? {})) {
      if (key in node) expect(allowed, `${String(node.type)}.${key}`).toContain(node[key]);
    }
    if (node.type === "text") expect(String(node.text).length).toBeGreaterThan(0);
    if (node.type === "uri") expect(String(node.label).length).toBeLessThanOrEqual(40);
    if (node.type === "box") expect(Array.isArray(node.contents)).toBe(true);
  }
  const flex = message as { altText: string };
  expect(flex.altText.length).toBeGreaterThan(0);
  expect(flex.altText.length).toBeLessThanOrEqual(1500);
  // "The maximum size of JSON data that defines a bubble is 30 KB."
  expect(new TextEncoder().encode(JSON.stringify((message as { contents: unknown }).contents)).length)
    .toBeLessThan(30 * 1024);
}

const texts = (message: unknown) => nodes(message).filter((node) => node.type === "text").map((node) => String(node.text));
const actions = (message: unknown) => nodes(message).filter((node) => node.type === "uri" || "data" in node);

describe("link codes as owners type them", () => {
  it("reads eight digits however they are spaced, in Thai or full-width digits too", () => {
    expect(LINK_CODE_DIGITS).toBe(8);
    expect(linkCodeAttempt("12345678")).toBe("12345678");
    expect(linkCodeAttempt(" 1234 5678 ")).toBe("12345678");
    expect(linkCodeAttempt("1234-5678")).toBe("12345678");
    expect(linkCodeAttempt("๑๒๓๔ ๕๖๗๘")).toBe("12345678");
    expect(linkCodeAttempt("１２３４ ５６７８")).toBe("12345678");
  });

  it("treats anything else as ordinary chat, never as a code", () => {
    for (const text of ["hello", "1234567", "123456789", "1234 567a", "", "   ", "ราคาเท่าไหร่", "12345678 please",
      "1234.5678"]) {
      expect(linkCodeAttempt(text)).toBeNull();
    }
  });

  it("shows a code in two groups of four", () => {
    expect(formatLinkCode("12345678")).toBe("1234 5678");
  });
});

describe("the brief's day", () => {
  it("is the Bangkok date the run falls on, and covers the whole Bangkok day before it", () => {
    // 08:00 in Bangkok on 8 December is 01:00 UTC.
    expect(briefDay(Date.parse("2026-12-08T01:00:00Z"))).toEqual({
      date: "2026-12-08",
      fromMs: Date.parse("2026-12-06T17:00:00Z"),
      toMs: Date.parse("2026-12-07T17:00:00Z"),
    });
    // 23:59 in Bangkok is still that day; one minute later is the next.
    expect(briefDay(Date.parse("2026-12-08T16:59:00Z")).date).toBe("2026-12-08");
    expect(briefDay(Date.parse("2026-12-08T17:00:00Z")).date).toBe("2026-12-09");
  });
});

describe("the owner's approval card", () => {
  const input = {
    shopName: "Baan Somtam",
    customerName: "Somchai",
    customerMessage: "พรุ่งนี้เปิดกี่โมงคะ",
    replyText: "เปิด 9 โมงค่ะ",
    approvalUrl: APPROVAL_URL,
  };

  it("is one Flex bubble with plain alt text, both texts, and one button that opens the approval page", () => {
    const card = ownerCardMessage(input);
    expectDocumentedShape(card);
    expect(card.type).toBe("flex");
    expect(card.contents.type).toBe("bubble");
    expect(card.altText).toBe("Baan Somtam: Nam drafted a reply to Somchai. It waits for your OK.");
    expect(texts(card)).toEqual(expect.arrayContaining(["Baan Somtam", "Somchai wrote", "พรุ่งนี้เปิดกี่โมงคะ",
      "Nam's reply", "เปิด 9 โมงค่ะ"]));
    // The card approves nothing itself: its only action opens the page that shows the exact action.
    expect(actions(card)).toEqual([{ type: "uri", label: "Open to approve or decline", uri: APPROVAL_URL }]);
    expect(JSON.stringify(card)).not.toContain("postback");
  });

  it("clips long texts so the bubble stays far below LINE's limit, and says the page has the rest", () => {
    const card = ownerCardMessage({ ...input, customerMessage: "ก".repeat(5000), replyText: "ข".repeat(5000) });
    expectDocumentedShape(card);
    const clipped = texts(card).filter((text) => text.startsWith("ก") || text.startsWith("ข"));
    expect(clipped).toHaveLength(2);
    for (const text of clipped) {
      expect([...text].length).toBeLessThanOrEqual(501);
      expect(text.endsWith("…")).toBe(true);
    }
    expect(texts(card)).toContain("The page shows the full text.");
  });

  it("never clips inside an emoji, and never sends an empty text", () => {
    const card = ownerCardMessage({ ...input, customerMessage: "😀".repeat(600), customerName: "a customer" });
    const message = texts(card).find((text) => text.startsWith("😀"))!;
    expect([...message.slice(0, -1)].every((char) => char === "😀")).toBe(true);
    const gone = ownerCardMessage({ ...input, customerMessage: "" });
    expectDocumentedShape(gone);
    expect(texts(gone)).toContain("The message is no longer stored.");
  });
});

describe("the morning brief", () => {
  const zero: BriefCounts = { messages: 0, repliesSent: 0, repliesWaiting: 0, payments: 0 };

  it("is no message at all on a day with nothing to say", () => {
    expect(morningBriefMessage({ shopName: "Baan Somtam", counts: zero, waitingUrl: null })).toBeNull();
  });

  it("says yesterday's counts in one short message", () => {
    const brief = morningBriefMessage({ shopName: "Baan Somtam",
      counts: { messages: 12, repliesSent: 9, repliesWaiting: 0, payments: 2 }, waitingUrl: null })!;
    expectDocumentedShape(brief);
    expect(brief.altText).toBe("Baan Somtam yesterday: 12 customer messages, 9 replies sent, 2 payments recorded.");
    expect(texts(brief)).toEqual(["Good morning", "Baan Somtam, yesterday", "12 customer messages", "9 replies sent",
      "2 payments recorded"]);
    expect(actions(brief)).toEqual([]);
  });

  it("writes one and none the way people say them", () => {
    const brief = morningBriefMessage({ shopName: "Baan Somtam",
      counts: { messages: 1, repliesSent: 1, repliesWaiting: 0, payments: 0 }, waitingUrl: null })!;
    expect(texts(brief).slice(2)).toEqual(["1 customer message", "1 reply sent", "No payments recorded"]);
  });

  it("links the reply that has waited longest when replies wait, on a day with nothing else", () => {
    const one = morningBriefMessage({ shopName: "Baan Somtam", counts: { ...zero, repliesWaiting: 1 },
      waitingUrl: APPROVAL_URL })!;
    expectDocumentedShape(one);
    expect(one.altText).toBe("Baan Somtam yesterday: no customer messages, no replies sent, no payments recorded. " +
      "1 reply is waiting for your OK.");
    expect(texts(one)).toContain("1 reply is waiting for your OK");
    expect(actions(one)).toEqual([{ type: "uri", label: "Open the waiting reply", uri: APPROVAL_URL }]);

    const three = morningBriefMessage({ shopName: "Baan Somtam", counts: { ...zero, repliesWaiting: 3 },
      waitingUrl: APPROVAL_URL })!;
    expect(texts(three)).toEqual(expect.arrayContaining(["3 replies are waiting for your OK",
      "This opens the one waiting longest. Each has its own card in this chat."]));
    expect(actions(three)).toEqual([{ type: "uri", label: "Open the reply waiting longest", uri: APPROVAL_URL }]);
  });

  it("still says replies wait when no link can be made", () => {
    const brief = morningBriefMessage({ shopName: "Baan Somtam", counts: { ...zero, repliesWaiting: 2 },
      waitingUrl: null })!;
    expectDocumentedShape(brief);
    expect(texts(brief)).toContain("Each has its own card in this chat.");
    expect(actions(brief)).toEqual([]);
  });
});

describe("answers to a link code", () => {
  it("are plain texts, and a wrong code's answer never names a shop or says why", () => {
    expect(codeAnswers.linked("Baan Somtam")).toEqual({ type: "text", text: "Done. You are linked to Baan Somtam. " +
      "Replies that wait for your OK will come here, with a short summary each morning at 08:00." });
    expect(codeAnswers.wrong).toEqual({ type: "text",
      text: "That code did not work. Each code works once, for 30 minutes. Please ask Manut AI for a new one." });
    expect(codeAnswers.limited).toEqual({ type: "text",
      text: "Too many tries. Please wait an hour, then send the newest code from Manut AI." });
  });
});
