/// Signing in by email (docs/pilot-api.md, "Signing in by email"; docs/sign-in-options.md): a code of six digits is sent
/// to an address, and giving it back signs the person in with that address as their identity. The rules live here as
/// pure functions over the one record kept per address, so they are tested without storage; the auth object applies
/// them inside its storage transactions (auth-object.ts), and sending is a port (email-sender.ts).
///
/// It is built and switched off: both routes answer `email_not_configured` until EMAIL_SIGN_IN is "on", a sender is
/// bound and APPROVAL_LINK_SECRET can sign. No Wrangler environment turns it on; that is the owner's call.
///
/// What is kept, in the auth object, under `email-code:<account>`, where the account is the SHA-256 of the address: the
/// live code's HMAC (approval-link.ts), never the code; when it stops working and its wrong tries; and when each code of
/// the last day was sent, and from which source, as a tag no one can read back to an address. Never the address. The
/// alarm deletes a record a day after its last send. Beside the addresses' records, one more, `email-sends:day`: how
/// many codes went out today across every address, and how many from each source.

import { usableSecret } from "./approval-link";
import { normalizeEmail, sha256Hex } from "./auth";
import { senderFor, type CodeEmail, type EmailSender, type SenderEnv } from "./email-sender";
import { hasExactly } from "./people";

/// A code works for ten minutes from when it was sent.
export const CODE_TTL_SECONDS = 600;
/// An address gets at most one code a minute, so asking again cannot flood a mailbox...
export const RESEND_SECONDS = 60;
/// ...at most ten in any 24 hours asked from one source, an IPv4 address or an IPv6 /64 (relay.ts, `relaySourceGroup`;
/// docs/decisions.md): enough for a person on a few devices who mistypes a few times, and with five tries a code, at most
/// fifty guesses a day from one source at one address's codes...
export const DAILY_CODES = 10;
/// ...and at most thirty in any 24 hours from every source together (docs/decisions.md, 24 Nov 2026). Counted per
/// source, a stranger's ten asks from their own network no longer stop the address's owner asking from theirs; filling
/// an address's day now takes three sources, and the ceiling still bounds what one mailbox is sent.
export const ADDRESS_DAILY_CODES = 30;
/// Across every address, one source has at most twenty codes sent a day, so a script on one network cannot spend the
/// day's codes for everyone, and all sources together at most three hundred (docs/decisions.md, 24 Nov 2026). The pilot
/// needs a few dozen on its busiest day. The plan includes about 3,000 emails a month, about a hundred a day, then $0.35
/// a thousand (docs/sign-in-options.md), so a day at the cap costs about seven US cents more, and the sending domain is
/// never used for more than that, whoever asks.
export const SOURCE_DAILY_CODES = 20;
export const ALL_DAILY_CODES = 300;
export const DAY_SECONDS = 24 * 3600;
/// The day the shared counts are for is Bangkok's, which is UTC+7 all year, so they start again at midnight where the
/// shops are.
const BANGKOK_SECONDS = 7 * 3600;
/// Five wrong tries end a code, and the person asks for a new one.
export const MAX_WRONG_TRIES = 5;

/// An email identity's tenant is this prefix and the SHA-256 of the address, so it can never equal an Apple one
/// (`apple:<sub>`), a shop (`pilot:<uuid>`) or another address's, and the address itself never names anything.
export const EMAIL_TENANT_PREFIX = "email:";
export const CODE_KEY_PREFIX = "email-code:";
/// The day's record, `CodeDay`. Its key does not start with `CODE_KEY_PREFIX`, so the alarm never reads it as an
/// address's record.
export const CODE_DAY_KEY = "email-sends:day";
/// The most a source group (relay.ts) takes: an IPv6 /64 is at most 25 characters and an IPv4 address 15.
const SOURCE_GROUP_MAX = 64;
/// A source's tag (approval-link.ts, `macCodeSource`): an HMAC-SHA256 in base64url.
const SOURCE_TAG = /^[A-Za-z0-9_-]{43}$/;

/// A code as the person types it: exactly six digits. Anything else is not a try at all.
const CODE_SHAPE = /^\d{6}$/;

/// The longest device id an exchange takes, as Apple's exchange does.
const DEVICE_ID_MAX = 128;

export type EmailSignInEnv = SenderEnv & {
  /// The switch: only exactly "on" turns email sign-in on. Unset in every Wrangler environment.
  EMAIL_SIGN_IN?: string;
  /// The secret a code's HMAC is made with, in a domain of its own (approval-link.ts). No new secret is needed.
  APPROVAL_LINK_SECRET?: string;
};

/// The sender when email sign-in is on: EMAIL_SIGN_IN is exactly "on", a sender is bound, and the secret that keeps a
/// code can sign. Null otherwise, and both routes answer that as `email_not_configured`, as Apple's exchange answers
/// `identity_not_configured` without a client id.
export function emailSignIn(env: EmailSignInEnv): EmailSender | null {
  if (env.EMAIL_SIGN_IN !== "on" || !usableSecret(env.APPROVAL_LINK_SECRET)) return null;
  return senderFor(env);
}

/// The account an address is known by: the SHA-256 of its normalized form, in hex. Storage keys and the tenant use it,
/// never the address.
export function emailAccount(address: string): Promise<string> {
  return sha256Hex(address);
}

export function emailTenant(account: string): string {
  return `${EMAIL_TENANT_PREFIX}${account}`;
}

export function codeKey(account: string): string {
  return `${CODE_KEY_PREFIX}${account}`;
}

/// The address a code request names, normalized as Apple's verified email is (auth.ts), when the body is exactly
/// `{ email }`. Null for anything else, which the route answers `invalid_request`.
export function codeRequestAddress(body: unknown): string | null {
  if (!isRecord(body) || !hasExactly(body, ["email"])) return null;
  return normalizeEmail(body.email) ?? null;
}

/// What an exchange by email names, when the body is exactly `{ provider: "email", email, code, deviceId }` with an
/// address, six digits and a device id. Null for anything else: a code that is not six digits cannot be right, so it is
/// refused as a request and never counts as a wrong try.
export function emailExchange(body: unknown): { address: string; code: string; deviceId: string } | null {
  if (!isRecord(body) || !hasExactly(body, ["provider", "email", "code", "deviceId"]) || body.provider !== "email") {
    return null;
  }
  const address = normalizeEmail(body.email);
  if (!address || typeof body.code !== "string" || !CODE_SHAPE.test(body.code)) return null;
  const deviceId = body.deviceId;
  if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > DEVICE_ID_MAX) return null;
  return { address, code: body.code, deviceId };
}

/// The largest multiple of a million that a 32-bit number can reach. A random 32-bit number below it, taken modulo a
/// million, gives every code from 000000 to 999999 the same chance; one at or above it would favour the low codes,
/// because 2^32 is not a multiple of a million, so it is thrown away and another drawn (about 1 in 4,400 draws).
const UNBIASED_LIMIT = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;

/// Six random digits from `crypto.getRandomValues`, with no modulo bias. `fill` is the random source; only a test
/// passes another, to show what is thrown away.
export function sixDigitCode(fill: (bytes: Uint32Array) => void = (bytes) => crypto.getRandomValues(bytes)): string {
  const draw = new Uint32Array(1);
  for (;;) {
    fill(draw);
    const value = draw[0]!;
    if (value < UNBIASED_LIMIT) return String(value % 1_000_000).padStart(6, "0");
  }
}

/// The source group (relay.ts, `relaySourceGroup`) the Worker says an ask came from, or null when it gave none it could
/// read. The auth object refuses an ask without one: every ask is counted against where it came from.
export function codeSource(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= SOURCE_GROUP_MAX ? value : null;
}

/// One code sent: when, and where it was asked from, as the source's tag for this address
/// (approval-link.ts, `macCodeSource`), never the source itself.
export type Send = { at: number; from: string };

/// The one record kept per address. Times are seconds since the epoch, as the auth object's sessions count them.
export type CodeRecord = {
  /// The live code, while there is one: its HMAC, when it stops working, and how many wrong tries it has had.
  code?: { mac: string; exp: number; wrong: number };
  /// Each code of the last 24 hours, oldest first: the newest decides the minute, those from one source that source's
  /// day, and all of them the address's day.
  sent: Send[];
};

/// A stored record, or null for none and for anything this code did not write: a record that cannot be read holds no
/// code anyone can use, and asking for a code starts it again. No record kept only the times of its sends: the switch
/// was never on anywhere before sends kept their source.
export function readCodeRecord(value: unknown): CodeRecord | null {
  if (!isRecord(value) || !Array.isArray(value.sent) || !value.sent.every(isSend)) return null;
  const sent = value.sent.map((one: Send) => ({ at: one.at, from: one.from }));
  if (value.code === undefined) return { sent };
  const code = value.code;
  if (!isRecord(code) || typeof code.mac !== "string" || !isTime(code.exp) || !Number.isSafeInteger(code.wrong) ||
      (code.wrong as number) < 0) return null;
  return { code: { mac: code.mac, exp: code.exp, wrong: code.wrong as number }, sent };
}

export type SendDecision = { ok: true; record: CodeRecord } | { ok: false; retryAfter: number };

/// Whether a new code may be sent to this address `now`, asked from the source whose tag for it is `from`, and the record
/// that keeps it if so. A new code replaces the one before it, which stops working. `retryAfter` is the whole seconds
/// until one may be sent, after every limit that holds: a minute after the address's last send; once this source had
/// ten sent to it in 24 hours, until the oldest of those is a day old; and once the address had thirty from every source,
/// until the oldest of those is. Nothing here depends on whether anyone knows the address.
export function sendCode(record: CodeRecord | null, mac: string, now: number, from: string): SendDecision {
  const sent = (record?.sent ?? []).filter((one) => one.at > now - DAY_SECONDS);
  const fromThere = sent.filter((one) => one.from === from);
  const newest = sent.at(-1);
  // Each limit's wait, in seconds, or nothing: the newest send is under a minute old, or as many sends as the limit
  // allows are under a day old, and the one that must age out first is that many from the newest.
  const waits = [
    newest === undefined ? 0 : newest.at + RESEND_SECONDS - now,
    fromThere.length < DAILY_CODES ? 0 : fromThere[fromThere.length - DAILY_CODES]!.at + DAY_SECONDS - now,
    sent.length < ADDRESS_DAILY_CODES ? 0 : sent[sent.length - ADDRESS_DAILY_CODES]!.at + DAY_SECONDS - now,
  ];
  const wait = Math.max(...waits);
  if (wait > 0) return { ok: false, retryAfter: Math.max(1, Math.ceil(wait)) };
  return { ok: true, record: { code: { mac, exp: now + CODE_TTL_SECONDS, wrong: 0 }, sent: [...sent, { at: now, from }] } };
}

/// The codes sent on one Bangkok day across every address: how many, and how many from each source, by the source's tag
/// for no one address (approval-link.ts, `macCodeSource`). One record, changed in the same storage transaction as the
/// address's, so a code is counted exactly when it is sent. It holds counts and tags only, at most one tag a send, and the
/// next day's first send replaces it.
export type CodeDay = { day: number; sent: number; from: Record<string, number> };

/// The Bangkok day `now` falls on, counted from the epoch.
export function codeDayOf(now: number): number {
  return Math.floor((now + BANGKOK_SECONDS) / DAY_SECONDS);
}

/// Today's record, or a fresh one when the stored record is another day's or not one this code wrote.
export function readCodeDay(value: unknown, now: number): CodeDay {
  const day = codeDayOf(now);
  if (!isRecord(value) || value.day !== day || !isCount(value.sent) || !isRecord(value.from) ||
      !Object.entries(value.from).every(([tag, count]) => SOURCE_TAG.test(tag) && isCount(count))) {
    return { day, sent: 0, from: {} };
  }
  return { day, sent: value.sent, from: { ...(value.from as Record<string, number>) } };
}

export type DayDecision =
  | { ok: true; today: CodeDay }
  | { ok: false; status: 429; error: "too_many_codes"; retryAfter: number }
  | { ok: false; status: 503; error: "codes_paused"; retryAfter: number };

/// Whether one more code may go out today, asked from the source whose day tag is `from`, and the day's record that
/// counts it if so. Past the day's codes from every source, codes are paused for everyone (503 `codes_paused`); past this
/// source's, it waits (429 `too_many_codes`, as an address's limits answer). Either lasts until midnight in Bangkok, and
/// neither depends on the address asked for.
export function countCodeDay(today: CodeDay, from: string, now: number): DayDecision {
  const retryAfter = Math.max(1, Math.ceil((today.day + 1) * DAY_SECONDS - BANGKOK_SECONDS - now));
  if (today.sent >= ALL_DAILY_CODES) return { ok: false, status: 503, error: "codes_paused", retryAfter };
  const fromThere = Object.hasOwn(today.from, from) ? today.from[from] ?? 0 : 0;
  if (fromThere >= SOURCE_DAILY_CODES) return { ok: false, status: 429, error: "too_many_codes", retryAfter };
  return { ok: true, today: { day: today.day, sent: today.sent + 1, from: { ...today.from, [from]: fromThere + 1 } } };
}

export type TryOutcome =
  /// The right code, which is used up: the record keeps only its sends, for the limits.
  | { kind: "right"; record: CodeRecord }
  /// A wrong code. `triesLeft` is how many more this code takes; at 0 it has ended, and the record no longer holds it.
  | { kind: "wrong"; triesLeft: number; record: CodeRecord }
  /// No code to try: none was sent, it was used, ten minutes passed, or wrong tries ended it.
  | { kind: "ended" };

/// One try at the address's code `now`. `matches` compares the stored HMAC with the try's in constant time; it is asked
/// only while a code is live, so a try at an ended code tells nothing about it.
export function tryCode(record: CodeRecord | null, matches: (mac: string) => boolean, now: number): TryOutcome {
  const code = record?.code;
  if (!record || !code || code.exp <= now) return { kind: "ended" };
  if (matches(code.mac)) return { kind: "right", record: { sent: record.sent } };
  const wrong = code.wrong + 1;
  const triesLeft = Math.max(0, MAX_WRONG_TRIES - wrong);
  const kept: CodeRecord = triesLeft > 0 ? { code: { ...code, wrong }, sent: record.sent } : { sent: record.sent };
  return { kind: "wrong", triesLeft, record: kept };
}

/// When a record holds nothing that matters any more, so the alarm may delete it: a day after its last send, when that
/// send no longer counts and any code it carried ran out long before.
export function purgeAt(record: CodeRecord): number {
  return Math.max(record.code?.exp ?? 0, (record.sent.at(-1)?.at ?? 0) + DAY_SECONDS);
}

/// The email a code goes out in: plain, in English, with the code only in the body, so a lock screen showing the
/// subject does not show it. Thai waits for the owner's writer.
export function codeEmail(to: string, code: string): CodeEmail {
  const minutes = CODE_TTL_SECONDS / 60;
  return {
    to,
    subject: "Your Manut AI sign-in code",
    text: [
      `Your Manut AI sign-in code is ${code}.`,
      "",
      `It works for ${minutes} minutes. Do not share it with anyone.`,
      "",
      "If you did not ask for a code, you can ignore this email.",
    ].join("\n"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSend(value: unknown): value is Send {
  return isRecord(value) && isTime(value.at) && typeof value.from === "string" && SOURCE_TAG.test(value.from);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
