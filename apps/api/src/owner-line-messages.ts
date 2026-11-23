/// The messages Manut AI's own LINE account sends a shop's owner
/// (docs/pilot-api.md, "Owner messages on LINE"): the approval card for one
/// reply, the morning brief, and the answers to a link code. Pure functions,
/// so the exact JSON LINE receives is tested without any call.
///
/// Every component and field below is one LINE's reference documents
/// (https://developers.line.biz/en/reference/messaging-api/#flex-message):
/// a Flex Message is `{ type: "flex", altText, contents }`, its container a
/// `bubble` with `header`, `body` and `footer` boxes; a `box` has a `layout` and
/// `contents`; `text`, `separator` and `button` components with a `uri` action
/// make the rest. The types allow nothing else, and the tests walk every node
/// against the same list. Words are plain and short, in English for now.

import { GUESS_WINDOW_MS, LINK_CODE_TTL_MS } from "./owner-line-rules";

type FlexText = {
  type: "text";
  text: string;
  wrap?: boolean;
  size?: "xs" | "sm" | "md" | "lg";
  weight?: "regular" | "bold";
  color?: string;
};
type FlexSeparator = { type: "separator" };
/// The only action a message from Manut AI carries: opening a page. A card
/// never carries a postback or anything else that could decide by itself.
type UriAction = { type: "uri"; label: string; uri: string };
type FlexButton = { type: "button"; style: "primary"; action: UriAction };
type FlexBox = {
  type: "box";
  layout: "vertical";
  spacing?: "sm" | "md";
  contents: (FlexText | FlexSeparator | FlexButton)[];
};
export type FlexMessage = {
  type: "flex";
  altText: string;
  contents: { type: "bubble"; header: FlexBox; body: FlexBox; footer?: FlexBox };
};
export type TextMessage = { type: "text"; text: string };

/// "Max character limit: 1500" for a Flex Message's `altText`.
const ALT_TEXT_MAX = 1500;
/// "Flex Message - Button | Required | 40" (the action label's limit).
const BUTTON_LABEL_MAX = 40;
/// How much of a customer's message and of the draft a card carries. LINE caps
/// a bubble's JSON at 30 KB; two clipped Thai texts take about 3 KB of it. The
/// approval page always shows both in full.
const CARD_TEXT_MAX = 500;
/// The pilot's one team member, as the owner's approval page names it.
const MEMBER_NAME = "Nam";
const QUIET = "#888888";

/// At most `max` characters, counted as people see them (code points), so an
/// emoji is never cut in half; clipped text ends in an ellipsis.
function clip(text: string, max: number): { text: string; clipped: boolean } {
  const chars = [...text];
  return chars.length <= max ? { text, clipped: false } : { text: `${chars.slice(0, max).join("")}…`, clipped: true };
}

function quiet(text: string): FlexText {
  return { type: "text", text, size: "sm", color: QUIET, wrap: true };
}

function plain(text: string): FlexText {
  return { type: "text", text, wrap: true };
}

function bold(text: string): FlexText {
  return { type: "text", text, weight: "bold", wrap: true };
}

function button(label: string, uri: string): FlexBox {
  return {
    type: "box",
    layout: "vertical",
    contents: [{ type: "button", style: "primary", action: { type: "uri", label: clip(label, BUTTON_LABEL_MAX).text, uri } }],
  };
}

function altText(text: string): string {
  return clip(text, ALT_TEXT_MAX - 1).text;
}

export type CardInput = {
  shopName: string;
  /// The LINE display name when known, otherwise "a customer".
  customerName: string;
  /// Empty once the message has aged out of retention; the reply still shows.
  customerMessage: string;
  replyText: string;
  /// The owner's signed approval page for this one reply (approval-link.ts).
  approvalUrl: string;
};

/// One reply waiting for the owner: who wrote what, what Nam would answer, and
/// one button that opens the signed approval page. The decision happens on that
/// page, which shows the exact action and settles once; the card itself can
/// decide nothing.
export function ownerCardMessage(input: CardInput): FlexMessage {
  const message = input.customerMessage ? clip(input.customerMessage, CARD_TEXT_MAX) : null;
  const reply = clip(input.replyText, CARD_TEXT_MAX);
  const body: FlexBox["contents"] = [
    quiet(`${input.customerName} wrote`),
    plain(message ? message.text : "The message is no longer stored."),
    { type: "separator" },
    quiet(`${MEMBER_NAME}'s reply`),
    plain(reply.text),
  ];
  if (message?.clipped || reply.clipped) body.push(quiet("The page shows the full text."));
  return {
    type: "flex",
    altText: altText(`${input.shopName}: ${MEMBER_NAME} drafted a reply to ${input.customerName}. It waits for your OK.`),
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", contents: [quiet(input.shopName), bold(`${MEMBER_NAME} drafted a reply for you to check`)] },
      body: { type: "box", layout: "vertical", spacing: "md", contents: body },
      footer: button("Open to approve or decline", input.approvalUrl),
    },
  };
}

/// Yesterday's counts for one shop, and the replies waiting for the owner now.
export type BriefCounts = { messages: number; repliesSent: number; repliesWaiting: number; payments: number };

/// "12 customer messages", "1 reply sent", "no payments recorded".
function counted(n: number, one: string, many: string, after = ""): string {
  const tail = after ? ` ${after}` : "";
  if (n === 0) return `no ${many}${tail}`;
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}${tail}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/// Whether a day has anything to say: something happened yesterday, or a reply
/// is waiting now.
export function briefHasNews(counts: BriefCounts): boolean {
  return counts.messages + counts.repliesSent + counts.repliesWaiting + counts.payments > 0;
}

/// The morning brief: yesterday's customer messages, replies sent and payments
/// recorded, and how many replies wait for the owner now, with a button to the
/// one that has waited longest (it expires first; each waiting reply also has
/// its own card in the chat). Null on a day with nothing to say: the brief is
/// then not sent at all (docs/pilot-api.md says why).
export function morningBriefMessage(input: {
  shopName: string;
  counts: BriefCounts;
  /// The approval page of the reply waiting longest, or null when none waits or no link can be made.
  waitingUrl: string | null;
}): FlexMessage | null {
  const { counts } = input;
  if (!briefHasNews(counts)) return null;
  const parts = [
    counted(counts.messages, "customer message", "customer messages"),
    counted(counts.repliesSent, "reply", "replies", "sent"),
    counted(counts.payments, "payment", "payments", "recorded"),
  ];
  const waiting = counts.repliesWaiting === 1
    ? "1 reply is waiting for your OK"
    : `${counts.repliesWaiting.toLocaleString("en-US")} replies are waiting for your OK`;
  const body: FlexBox["contents"] = parts.map((part) => plain(sentence(part)));
  if (counts.repliesWaiting > 0) {
    body.push({ type: "separator" }, bold(waiting));
    if (!input.waitingUrl) body.push(quiet("Each has its own card in this chat."));
    else if (counts.repliesWaiting > 1) body.push(quiet("This opens the one waiting longest. Each has its own card in this chat."));
  }
  const summary = `${input.shopName} yesterday: ${parts.join(", ")}.${counts.repliesWaiting > 0 ? ` ${waiting}.` : ""}`;
  return {
    type: "flex",
    altText: altText(summary),
    contents: {
      type: "bubble",
      header: { type: "box", layout: "vertical", contents: [bold("Good morning"), quiet(`${input.shopName}, yesterday`)] },
      body: { type: "box", layout: "vertical", spacing: "sm", contents: body },
      ...(counts.repliesWaiting > 0 && input.waitingUrl
        ? { footer: button(counts.repliesWaiting === 1 ? "Open the waiting reply" : "Open the reply waiting longest",
          input.waitingUrl) }
        : {}),
    },
  };
}

const minutes = Math.round(LINK_CODE_TTL_MS / 60_000);
const hours = Math.round(GUESS_WINDOW_MS / 3_600_000);

/// What an owner's code gets back, through the reply token. A wrong, used or
/// expired code all get the same words, so an answer never tells anyone
/// whether a code exists, or existed, for some shop.
export const codeAnswers = {
  linked: (shopName: string): TextMessage => ({
    type: "text",
    text: `Done. You are linked to ${shopName}. Replies that wait for your OK will come here, with a short summary ` +
      "each morning at 08:00.",
  }),
  wrong: {
    type: "text",
    text: `That code did not work. Each code works once, for ${minutes} minutes. Please ask Manut AI for a new one.`,
  } satisfies TextMessage,
  limited: {
    type: "text",
    text: `Too many tries. Please wait ${hours === 1 ? "an hour" : `${hours} hours`}, then send the newest code from Manut AI.`,
  } satisfies TextMessage,
};
