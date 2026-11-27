import type { OwnerCard, ReplyAction } from "./types";

/// The rules of owner messages on LINE for practice mode and the console, the same as the API's
/// (`apps/api/src/owner-line-rules.ts` and `owner-line-store.ts`, and docs/pilot-api.md, "Owner messages on LINE"),
/// so the console shows in practice what it shows against the real backend. The two apps share no code, so a change
/// to a rule there is made here as well.

/// A link code is eight digits, works once, for 30 minutes.
export const LINK_CODE_DIGITS = 8;
export const LINK_CODE_TTL_MS = 30 * 60 * 1000;
/// Wrong codes one LINE user may send in an hour before no code from them is checked until the hour is over.
export const GUESS_LIMIT = 5;
export const GUESS_WINDOW_MS = 60 * 60 * 1000;
/// A card still being pushed after this was cut off, and may be pushed again.
export const CLAIM_LEASE_MS = 2 * 60 * 1000;

/// Thai digits (๐ to ๙) and full-width digits read as the ASCII digits they stand for.
function asciiDigits(text: string): string {
  return text.replace(/[๐-๙０-９]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0xff10 ? code - 0xff10 : code - 0x0e50);
  });
}

/// The code a message holds, as eight ASCII digits, or null for a message that is not a code. Spaces and hyphens are
/// ignored and nothing else may be in the message.
export function linkCodeAttempt(text: string): string | null {
  const plain = asciiDigits(text).replace(/[\s-]/g, "");
  return new RegExp(`^[0-9]{${LINK_CODE_DIGITS}}$`).test(plain) ? plain : null;
}

/// "1234 5678": two groups of four, easier to read aloud.
export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/// Whether the operator may push a reply's card again: the reply still waits for the owner, and its card may not
/// have arrived (refused, not answered, or cut off while being pushed). The API refuses the rest.
export function canRetryOwnerCard(card: OwnerCard, replyState: ReplyAction["state"], now: number): boolean {
  if (replyState !== "proposed") return false;
  if (card.state === "failed" || card.state === "unknown") return true;
  return card.state === "sending" && now - Date.parse(card.lastTriedAt) >= CLAIM_LEASE_MS;
}
