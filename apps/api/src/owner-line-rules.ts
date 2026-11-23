/// The rules of owner messages on LINE (docs/pilot-api.md, "Owner messages on
/// LINE"), as constants and pure functions, so the routes, the stored records
/// and the words the owner reads all state the same numbers. The web app's
/// practice-mode fake keeps a copy of these rules (apps/web/src/api/fake.ts).

import { bangkokDay } from "./pilot-gate";

/// A link code is eight digits: short enough to type on a phone's number pad,
/// and with a hundred million possibilities, guessing one inside its half hour
/// at five tries an hour per LINE user is hopeless (owner-line-store.ts).
export const LINK_CODE_DIGITS = 8;
/// How long a link code works after the operator asks for it.
export const LINK_CODE_TTL_MS = 30 * 60 * 1000;
/// Wrong codes one LINE user may send in `GUESS_WINDOW_MS` before every code
/// from them, right or wrong, is refused until the window ends.
export const GUESS_LIMIT = 5;
export const GUESS_WINDOW_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
/// Bangkok keeps UTC+7 all year (pilot-gate.ts).
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/// Thai digits (๐ to ๙) and full-width digits (０ to ９), which some phone
/// keyboards type, read as the ASCII digits they stand for.
function asciiDigits(text: string): string {
  return text.replace(/[๐-๙０-９]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0xff10 ? code - 0xff10 : code - 0x0e50);
  });
}

/// The code an owner's message holds, as eight ASCII digits, or null for any
/// message that is not a code: spaces (any kind) and hyphens are ignored, and
/// nothing else may be in the message. Ordinary chat is never read as a guess,
/// so it neither counts against the guess limit nor gets an answer.
export function linkCodeAttempt(text: string): string | null {
  const plain = asciiDigits(text).replace(/[\s-]/g, "");
  return new RegExp(`^[0-9]{${LINK_CODE_DIGITS}}$`).test(plain) ? plain : null;
}

/// A code as the console shows it: two groups of four, easier to read aloud.
export function formatLinkCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/// The morning brief a run sends: `date` is the Bangkok date it is sent on
/// (one brief per shop per date), and [`fromMs`, `toMs`) is the whole Bangkok
/// day before it, which the brief's counts cover.
export function briefDay(nowMs: number): { date: string; fromMs: number; toMs: number } {
  const today = bangkokDay(nowMs);
  return {
    date: new Date(today * DAY_MS).toISOString().slice(0, 10),
    fromMs: (today - 1) * DAY_MS - BANGKOK_OFFSET_MS,
    toMs: today * DAY_MS - BANGKOK_OFFSET_MS,
  };
}
