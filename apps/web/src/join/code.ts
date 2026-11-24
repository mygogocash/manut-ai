import { CODE_LENGTH } from "../api/email";
import type { JoinStrings } from "./strings";

/// The join page's small rules, outside React so they are tested on their own: reading a typed or pasted code, hiding an
/// address, saying a wait, and naming this visit's device.

/// The code a text holds. A run of exactly six digits is the code wherever it sits in what was pasted ("Your code is
/// 482915."), so a paste of the whole line works; otherwise the first six digits are, which is what typing one digit at a
/// time makes. Full-width digits ("４８２９１５") and Thai digits ("๔๘๒๙๑๕"), which a Thai keyboard can type, count as the
/// digits they are, and a space or a dash between them ("482 915") is dropped. The desktop's sign-in reads a code the
/// same way (apps/desktop/src/settings/emailFlow.ts, `codeFrom`).
export function codeFrom(text: string): string {
  const plain = text.normalize("NFKC").replace(/[๐-๙]/g, (digit) => String(digit.charCodeAt(0) - 0x0e50));
  for (const run of plain.matchAll(/\d+/g)) if (run[0].length === CODE_LENGTH) return run[0];
  return plain.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/// An address partly hidden, as the canvas shows it on the code step ("f•••@baanmali.example"): the first character of
/// the name and the whole domain, so someone looking over a shoulder does not read it.
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const first = Array.from(address.slice(0, at))[0] ?? "";
  return `${first}•••${address.slice(at)}`;
}

/// A short wait as a clock, as the canvas counts it down: "1:00", "0:42". Rounded up, so a button is never offered early.
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/// A wait as a person says it: whole minutes up to two hours, and whole hours after, rounded up so it is never shorter
/// than it is. A day's limit on codes can ask for many hours.
export function waitWords(seconds: number, words: Pick<JoinStrings, "minutes" | "hours">): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes < 120 ? words.minutes(minutes) : words.hours(Math.ceil(minutes / 60));
}

/// How long until a new code may be asked for, as the page shows it: a clock under an hour, and words beyond.
export function waitText(seconds: number, words: Pick<JoinStrings, "minutes" | "hours">): string {
  return seconds < 3600 ? clock(seconds) : waitWords(seconds, words);
}

/// The device id this visit's sign-in names (1 to 128 characters, as the exchange takes): new each time the page opens and
/// kept nowhere, as the session it names is kept nowhere.
export function visitDeviceId(): string {
  const random = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `web-${random}`;
}
