import { afterEach, describe, expect, it, vi } from "vitest";
import { macCodeSource, macEmailCode } from "../src/approval-link";
import { normalizeEmail, sha256Hex } from "../src/auth";
import {
  ADDRESS_DAILY_CODES, ALL_DAILY_CODES, CODE_DAY_KEY, CODE_KEY_PREFIX, CODE_TTL_SECONDS, codeDayOf, codeEmail,
  codeRequestAddress, codeSource, countCodeDay, DAILY_CODES, DAY_SECONDS, emailAccount, emailExchange, emailSignIn,
  emailTenant, MAX_WRONG_TRIES, purgeAt, readCodeDay, readCodeRecord, RESEND_SECONDS, sendCode, sixDigitCode,
  SOURCE_DAILY_CODES, tryCode, type CodeDay, type CodeRecord, type EmailSignInEnv,
} from "../src/email-code";
import { deliver, senderFor, senderOf, testOutbox } from "../src/email-sender";

// The rules of signing in by email (email-code.ts) and its sender port (email-sender.ts), without storage: a code of six
// digits with no bias; one send a minute to an address, ten a day to it from one source and thirty from all of them;
// twenty a day from one source and three hundred in all; ten minutes per code, five tries, the HMACs a code and a source
// are kept as, the one rule for an address, and when the route counts as configured. The routes are in
// auth-email.test.ts.

const SECRET = "test-approval-link-secret-0123456789abcdef";
const T0 = 1_790_000_000;
const MAC = "fixture-mac";
/// Sources' tags, shaped as `macCodeSource` makes them.
const tag = (name: string) => name.padEnd(43, "x");
const HERE = tag("here");
const THERE = tag("there");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a code", () => {
  it("is six digits", () => {
    for (let i = 0; i < 2_000; i++) expect(sixDigitCode()).toMatch(/^\d{6}$/);
  });

  it("throws away a draw that would favour the low codes, and pads the rest", () => {
    // 4,294,000,000 is the largest multiple of a million a 32-bit number reaches: it and everything above it are drawn
    // again, and everything below it gives each code the same chance.
    const draws = [2 ** 32 - 1, 4_294_000_000, 4_293_999_999, 7];
    const fill = vi.fn((bytes: Uint32Array) => { bytes[0] = draws.shift()!; });
    expect(sixDigitCode(fill)).toBe("999999");
    expect(fill).toHaveBeenCalledTimes(3);
    expect(sixDigitCode(fill)).toBe("000007");
  });

  it("is kept as an HMAC under the link secret in its own domain, never as the code or its plain hash", async () => {
    const account = await emailAccount("mint@baanmali.example");
    const mac = await macEmailCode(SECRET, account, "123456");
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mac).toBe(await macEmailCode(SECRET, account, "123456"));
    // The same HMAC made by hand: the domain tag, then the account and the code.
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]);
    const sign = async (text: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key,
      new TextEncoder().encode(text))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(mac).toBe(await sign(`manut-ai/email-code/v1.${JSON.stringify([1, account, "123456"])}`));
    // Not without the domain, nor under another kind's, nor a plain hash a million tries would undo.
    expect(mac).not.toBe(await sign(JSON.stringify([1, account, "123456"])));
    expect(mac).not.toBe(await sign(`manut-ai/pilot-invite/v1.${JSON.stringify([1, account, "123456"])}`));
    expect(mac).not.toContain("123456");
    expect(await sha256Hex("123456")).not.toBe(mac);
    // One code is good for one address, under one secret.
    expect(await macEmailCode(SECRET, await emailAccount("fon@baanmali.example"), "123456")).not.toBe(mac);
    expect(await macEmailCode(SECRET, account, "123457")).not.toBe(mac);
    expect(await macEmailCode(`${SECRET}-other`, account, "123456")).not.toBe(mac);
    await expect(macEmailCode(undefined, account, "123456")).rejects.toThrow("approval_link_secret_unset");
    await expect(macEmailCode("too-short", account, "123456")).rejects.toThrow("approval_link_secret_unset");
  });
});

/// Sends `count` codes a minute apart from `start`, each asked from the source `from(i)`, and the record they leave.
function sends(count: number, from: (i: number) => string, start = T0, record: CodeRecord | null = null): CodeRecord {
  for (let i = 0; i < count; i++) {
    const decided = sendCode(record, MAC, start + i * 60, from(i));
    expect(decided.ok).toBe(true);
    record = (decided as { record: CodeRecord }).record;
  }
  return record!;
}

describe("sending a code", () => {
  it("sends one a minute to an address, and a new one replaces the one before", () => {
    const first = sendCode(null, MAC, T0, HERE);
    expect(first).toEqual({ ok: true,
      record: { code: { mac: MAC, exp: T0 + CODE_TTL_SECONDS, wrong: 0 }, sent: [{ at: T0, from: HERE }] } });
    const record = (first as { record: CodeRecord }).record;
    // The minute is the address's, wherever the next ask comes from.
    for (const from of [HERE, THERE]) {
      expect(sendCode(record, "next", T0 + 0.5, from)).toEqual({ ok: false, retryAfter: 60 });
      expect(sendCode(record, "next", T0 + 59, from)).toEqual({ ok: false, retryAfter: 1 });
      expect(sendCode(record, "next", T0 + 59.9, from)).toEqual({ ok: false, retryAfter: 1 });
    }
    expect(sendCode(record, "next", T0 + RESEND_SECONDS, THERE)).toEqual({ ok: true,
      record: { code: { mac: "next", exp: T0 + 60 + CODE_TTL_SECONDS, wrong: 0 },
        sent: [{ at: T0, from: HERE }, { at: T0 + 60, from: THERE }] } });
  });

  it("sends ten in any 24 hours asked from one source, then that source waits until the oldest of them is a day old",
    () => {
      expect(DAILY_CODES).toBe(10);
      const record = sends(DAILY_CODES, () => HERE);
      expect(sendCode(record, MAC, T0 + 600, HERE)).toEqual({ ok: false, retryAfter: DAY_SECONDS - 600 });
      expect(sendCode(record, MAC, T0 + DAY_SECONDS - 1, HERE)).toEqual({ ok: false, retryAfter: 1 });
      // A stranger's ten from their own network leave the address's owner asking from theirs.
      expect(sendCode(record, MAC, T0 + 600, THERE).ok).toBe(true);
      // At a day, the oldest send no longer counts, and it is dropped from the record.
      const next = sendCode(record, MAC, T0 + DAY_SECONDS, HERE);
      expect(next.ok).toBe(true);
      expect((next as { record: CodeRecord }).record.sent).toHaveLength(DAILY_CODES);
      expect((next as { record: CodeRecord }).record.sent[0]).toEqual({ at: T0 + 60, from: HERE });
    });

  it("sends an address thirty in any 24 hours from every source together, then waits for the oldest of them", () => {
    expect(ADDRESS_DAILY_CODES).toBe(30);
    // Ten from each of three sources: none is past its own ten, and the address is at its thirty.
    const record = sends(ADDRESS_DAILY_CODES, (i) => tag(`source-${i % 3}`));
    const last = T0 + (ADDRESS_DAILY_CODES - 1) * 60;
    expect(sendCode(record, MAC, last + 60, tag("a-fourth-source"))).toEqual({ ok: false,
      retryAfter: DAY_SECONDS - ADDRESS_DAILY_CODES * 60 });
    // When the oldest is a day old, one more may go, from anywhere.
    expect(sendCode(record, MAC, T0 + DAY_SECONDS, tag("a-fourth-source")).ok).toBe(true);
  });

  it("waits for the longest of the limits that hold", () => {
    // Ten from here, the last a moment ago: the minute is shorter than here's day, and here's day is what it waits for.
    const record = sends(DAILY_CODES, () => HERE);
    const justAfter = T0 + (DAILY_CODES - 1) * 60 + 1;
    expect(sendCode(record, MAC, justAfter, HERE)).toEqual({ ok: false, retryAfter: DAY_SECONDS - (justAfter - T0) });
    expect(sendCode(record, MAC, justAfter, THERE)).toEqual({ ok: false, retryAfter: 59 });
  });

  it("answers the same whatever the address, since nothing here can know it", () => {
    // The rules read only the record, the time and the source's tag: two addresses with the same history get the same
    // answers, whoever knows either.
    const one = sends(DAILY_CODES, () => HERE);
    const other = sends(DAILY_CODES, () => HERE);
    for (const at of [T0 + 600, T0 + 3600, T0 + DAY_SECONDS - 1]) {
      expect(sendCode(one, MAC, at, HERE)).toEqual(sendCode(other, MAC, at, HERE));
    }
  });
});

describe("the day's codes across every address", () => {
  const today = (sent: number, from: Record<string, number> = {}): CodeDay => ({ day: codeDayOf(T0), sent, from });
  /// Seconds from T0 until the next midnight in Bangkok.
  const toMidnight = (codeDayOf(T0) + 1) * DAY_SECONDS - 7 * 3600 - T0;

  it("is Bangkok's day, which starts at midnight there", () => {
    // 2026-11-24T16:59:59Z is 23:59:59 in Bangkok, and a second later the next day has begun there.
    const lastSecond = Date.UTC(2026, 10, 24, 16, 59, 59) / 1000;
    expect(codeDayOf(lastSecond + 1)).toBe(codeDayOf(lastSecond) + 1);
    expect(codeDayOf(Date.UTC(2026, 10, 24, 0, 0, 0) / 1000)).toBe(codeDayOf(lastSecond));
    expect(toMidnight).toBeGreaterThan(0);
    expect(toMidnight).toBeLessThanOrEqual(DAY_SECONDS);
  });

  it("counts every code sent today, and each source's", () => {
    const first = countCodeDay(readCodeDay(undefined, T0), HERE, T0);
    expect(first).toEqual({ ok: true, today: { day: codeDayOf(T0), sent: 1, from: { [HERE]: 1 } } });
    const second = countCodeDay((first as { today: CodeDay }).today, THERE, T0 + 1);
    expect(second).toEqual({ ok: true, today: { day: codeDayOf(T0), sent: 2, from: { [HERE]: 1, [THERE]: 1 } } });
  });

  it("sends a source twenty a day across every address, then it waits until midnight in Bangkok", () => {
    expect(SOURCE_DAILY_CODES).toBe(20);
    const day = today(SOURCE_DAILY_CODES, { [HERE]: SOURCE_DAILY_CODES });
    expect(countCodeDay(day, HERE, T0)).toEqual({ ok: false, status: 429, error: "too_many_codes",
      retryAfter: toMidnight });
    expect(countCodeDay(day, THERE, T0).ok).toBe(true);
  });

  it("pauses every code once three hundred went out today, until midnight in Bangkok", () => {
    expect(ALL_DAILY_CODES).toBe(300);
    expect(countCodeDay(today(ALL_DAILY_CODES - 1), HERE, T0).ok).toBe(true);
    for (const from of [HERE, THERE]) {
      expect(countCodeDay(today(ALL_DAILY_CODES), from, T0)).toEqual({ ok: false, status: 503, error: "codes_paused",
        retryAfter: toMidnight });
    }
    // The next day starts again.
    const tomorrow = T0 + toMidnight;
    expect(readCodeDay(today(ALL_DAILY_CODES), tomorrow)).toEqual({ day: codeDayOf(T0) + 1, sent: 0, from: {} });
    expect(countCodeDay(readCodeDay(today(ALL_DAILY_CODES), tomorrow), HERE, tomorrow).ok).toBe(true);
  });

  it("reads only what the rules wrote, and starts the day again from anything else", () => {
    const stored = { day: codeDayOf(T0), sent: 3, from: { [HERE]: 2, [THERE]: 1 } };
    expect(readCodeDay(stored, T0)).toEqual(stored);
    for (const value of [undefined, null, "day", { ...stored, day: codeDayOf(T0) - 1 }, { ...stored, sent: -1 },
      { ...stored, sent: 1.5 }, { ...stored, from: [] }, { ...stored, from: { [HERE]: -1 } },
      { ...stored, from: { "not a tag": 1 } }, { ...stored, from: { toString: 1 } }]) {
      expect(readCodeDay(value, T0)).toEqual({ day: codeDayOf(T0), sent: 0, from: {} });
    }
  });

  it("never mistakes a name an object has for a source's count", () => {
    for (const from of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(countCodeDay(today(0), from, T0)).toMatchObject({ ok: true, today: { sent: 1 } });
    }
  });

  it("is kept under a key the alarm never reads as an address's record", () => {
    expect(CODE_DAY_KEY.startsWith(CODE_KEY_PREFIX)).toBe(false);
  });
});

describe("where an ask came from", () => {
  it("is the source group the Worker names, or nothing", () => {
    expect(codeSource("2001:db8:aaaa:bbbb::/64")).toBe("2001:db8:aaaa:bbbb::/64");
    expect(codeSource("192.0.2.17")).toBe("192.0.2.17");
    for (const value of [null, undefined, "", "x".repeat(65)]) expect(codeSource(value)).toBeNull();
  });

  it("is kept as an HMAC under the link secret in its own domain, one for each address and one for none", async () => {
    const account = await emailAccount("mint@baanmali.example");
    const group = "2001:db8:aaaa:bbbb::/64";
    const forAddress = await macCodeSource(SECRET, group, account);
    const forDay = await macCodeSource(SECRET, group);
    for (const mac of [forAddress, forDay]) {
      expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(mac).not.toContain("2001");
    }
    expect(forAddress).toBe(await macCodeSource(SECRET, group, account));
    expect(forDay).toBe(await macCodeSource(SECRET, group));
    // The same HMAC made by hand: the domain tag, then the account (or none) and the group.
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" },
      false, ["sign"]);
    const sign = async (text: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key,
      new TextEncoder().encode(text))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(forAddress).toBe(await sign(`manut-ai/email-code-source/v1.${JSON.stringify([1, account, group])}`));
    expect(forDay).toBe(await sign(`manut-ai/email-code-source/v1.${JSON.stringify([1, null, group])}`));
    // Two addresses' records never share a source's tag, nor does the day's record with either; nor do two sources.
    expect(await macCodeSource(SECRET, group, await emailAccount("fon@baanmali.example"))).not.toBe(forAddress);
    expect(forDay).not.toBe(forAddress);
    expect(await macCodeSource(SECRET, "2001:db8:aaaa:bbbc::/64", account)).not.toBe(forAddress);
    // Nor is one a code's MAC, nor made without the secret.
    expect(await macEmailCode(SECRET, account, group)).not.toBe(forAddress);
    expect(await sha256Hex(group)).not.toBe(forDay);
    expect(await macCodeSource(`${SECRET}-other`, group, account)).not.toBe(forAddress);
    await expect(macCodeSource(undefined, group)).rejects.toThrow("approval_link_secret_unset");
    await expect(macCodeSource("too-short", group)).rejects.toThrow("approval_link_secret_unset");
  });
});

describe("trying a code", () => {
  const SENT = [{ at: T0, from: HERE }];
  const live = (wrong = 0): CodeRecord => ({ code: { mac: MAC, exp: T0 + CODE_TTL_SECONDS, wrong }, sent: SENT });
  const right = (mac: string) => mac === MAC;
  const wrongly = () => false;

  it("uses the right code up, keeping only the sends", () => {
    expect(tryCode(live(), right, T0 + 1)).toEqual({ kind: "right", record: { sent: SENT } });
    expect(tryCode({ sent: SENT }, right, T0 + 2)).toEqual({ kind: "ended" });
  });

  it("ends a code at its fifth wrong try, after which even the right code is refused", () => {
    expect(MAX_WRONG_TRIES).toBe(5);
    let record: CodeRecord = live();
    const left: number[] = [];
    for (let i = 0; i < MAX_WRONG_TRIES; i++) {
      const tried = tryCode(record, wrongly, T0 + 1);
      expect(tried.kind).toBe("wrong");
      left.push((tried as { triesLeft: number }).triesLeft);
      record = (tried as { record: CodeRecord }).record;
    }
    expect(left).toEqual([4, 3, 2, 1, 0]);
    expect(record).toEqual({ sent: SENT });
    expect(tryCode(record, right, T0 + 2)).toEqual({ kind: "ended" });
  });

  it("works for ten minutes from the send", () => {
    expect(tryCode(live(), right, T0 + CODE_TTL_SECONDS - 0.001).kind).toBe("right");
    expect(tryCode(live(), right, T0 + CODE_TTL_SECONDS)).toEqual({ kind: "ended" });
  });

  it("never compares a try with a code that ended, or with none", () => {
    const matches = vi.fn(right);
    expect(tryCode(null, matches, T0)).toEqual({ kind: "ended" });
    expect(tryCode({ sent: [] }, matches, T0)).toEqual({ kind: "ended" });
    expect(tryCode(live(), matches, T0 + CODE_TTL_SECONDS + 1)).toEqual({ kind: "ended" });
    expect(matches).not.toHaveBeenCalled();
  });
});

describe("the record kept per address", () => {
  const SENT = [{ at: T0, from: HERE }];

  it("reads only what the rules wrote, so anything else holds no code", () => {
    expect(readCodeRecord({ code: { mac: MAC, exp: T0, wrong: 2 }, sent: SENT }))
      .toEqual({ code: { mac: MAC, exp: T0, wrong: 2 }, sent: SENT });
    expect(readCodeRecord({ sent: [] })).toEqual({ sent: [] });
    // Nothing but a send's time and its source's tag is read back.
    expect(readCodeRecord({ sent: [{ at: T0, from: HERE, address: "mint@baanmali.example" }] })).toEqual({ sent: SENT });
    for (const value of [undefined, null, "record", [], { sent: "x" }, { sent: [-1] }, { sent: [T0] },
      { sent: [{ at: -1, from: HERE }] }, { sent: [{ at: T0 }] }, { sent: [{ at: T0, from: "192.0.2.17" }] },
      { sent: [{ at: T0, from: 7 }] }, { sent: SENT, code: "123456" },
      { sent: SENT, code: { mac: MAC, exp: T0, wrong: -1 } }, { sent: SENT, code: { mac: 7, exp: T0, wrong: 0 } },
      { sent: SENT, code: { mac: MAC, exp: Number.NaN, wrong: 0 } }]) {
      expect(readCodeRecord(value)).toBeNull();
    }
  });

  it("is kept a day after its last send, when that send no longer counts", () => {
    expect(purgeAt({ code: { mac: MAC, exp: T0 + 600, wrong: 0 },
      sent: [{ at: T0 - 100, from: THERE }, { at: T0, from: HERE }] })).toBe(T0 + DAY_SECONDS);
    expect(purgeAt({ sent: [] })).toBe(DAY_SECONDS);
  });
});

describe("the address and the identity", () => {
  it("normalizes an address by the one rule Apple's verified email follows", () => {
    expect(normalizeEmail(" Mint@BaanMali.Example ")).toBe("mint@baanmali.example");
    for (const value of [42, null, "", "not an address", "a@b@c", "two words@baanmali.example", `${"a".repeat(250)}@b.co`]) {
      expect(normalizeEmail(value)).toBeUndefined();
    }
    expect(codeRequestAddress({ email: " Mint@BaanMali.Example " })).toBe("mint@baanmali.example");
    for (const body of [null, [], {}, { email: "not an address" }, { email: "mint@baanmali.example", shop: "x" },
      { address: "mint@baanmali.example" }]) {
      expect(codeRequestAddress(body)).toBeNull();
    }
  });

  it("takes exactly a provider, an address, six digits and a device id to sign in", () => {
    const good = { provider: "email", email: "Mint@BaanMali.Example", code: "012345", deviceId: "device-1" };
    expect(emailExchange(good)).toEqual({ address: "mint@baanmali.example", code: "012345", deviceId: "device-1" });
    for (const body of [
      { ...good, provider: "apple" }, { ...good, code: "12345" }, { ...good, code: "1234567" }, { ...good, code: "12 345" },
      { ...good, code: 12345 }, { ...good, code: "١٢٣٤٥٦" }, { ...good, deviceId: "" }, { ...good, deviceId: "d".repeat(129) },
      { ...good, email: "nobody" }, { ...good, tenant: "email:x" }, { provider: "email", email: good.email, code: good.code },
    ]) {
      expect(emailExchange(body)).toBeNull();
    }
  });

  it("names an email identity's tenant by the address's hash, never by the address, and never as an Apple one", async () => {
    const account = await emailAccount("mint@baanmali.example");
    const tenant = emailTenant(account);
    expect(tenant).toBe(`email:${await sha256Hex("mint@baanmali.example")}`);
    expect(tenant).toMatch(/^email:[0-9a-f]{64}$/);
    expect(tenant).not.toContain("mint");
    // An Apple tenant is `apple:<sub>`, whatever the subject says, so the two never meet.
    expect(`apple:${tenant}`).not.toBe(tenant);
    expect(tenant.startsWith("apple:")).toBe(false);
  });
});

describe("off unless configured", () => {
  const on: EmailSignInEnv = { EMAIL_SIGN_IN: "on", APPROVAL_LINK_SECRET: SECRET, EMAIL_FROM_ADDRESS: "codes@manut.test",
    TEST_EMAIL_OUTBOX: "on", PUBLIC_API_ORIGIN: "https://api.manut.test" };

  it("is on only with the switch, a sender and the secret", () => {
    expect(emailSignIn(on)).not.toBeNull();
    for (const off of [
      { ...on, EMAIL_SIGN_IN: undefined }, { ...on, EMAIL_SIGN_IN: "off" }, { ...on, EMAIL_SIGN_IN: "1" },
      { ...on, EMAIL_SIGN_IN: "true" }, { ...on, EMAIL_SIGN_IN: "ON" },
      { ...on, APPROVAL_LINK_SECRET: undefined }, { ...on, APPROVAL_LINK_SECRET: "short" },
      { ...on, TEST_EMAIL_OUTBOX: undefined }, { ...on, TEST_EMAIL_OUTBOX: "1" },
      // The test outbox works only on a test Worker, whose public origin is under .test (test-origin.ts); with no binding
      // beside it, a real environment that set it by mistake has no sender at all.
      { ...on, PUBLIC_API_ORIGIN: undefined }, { ...on, PUBLIC_API_ORIGIN: "https://dev.manut.xyz" },
      { ...on, PUBLIC_API_ORIGIN: "http://api.manut.test" }, { ...on, PUBLIC_API_ORIGIN: "https://api.manut.test.example" },
      { ...on, EMAIL_FROM_ADDRESS: undefined }, { ...on, EMAIL_FROM_ADDRESS: "codes" },
      { ...on, EMAIL_FROM_NAME: "Manut AI\nBcc: someone@example.com" }, { ...on, EMAIL_FROM_NAME: "  " },
    ]) {
      expect(emailSignIn(off as EmailSignInEnv)).toBeNull();
    }
  });
});

describe("the sender port", () => {
  function binding(send: (message: unknown) => Promise<{ messageId: string }>) {
    return { send: vi.fn(send) } as unknown as SendEmail & { send: ReturnType<typeof vi.fn> };
  }

  it("comes from the owner's address, under the product's name until they name it", () => {
    expect(senderOf({ EMAIL_FROM_ADDRESS: " Codes@Manut.Test " })).toEqual({ email: "codes@manut.test", name: "Manut AI" });
    expect(senderOf({ EMAIL_FROM_ADDRESS: "codes@manut.test", EMAIL_FROM_NAME: " Baan Mali " }))
      .toEqual({ email: "codes@manut.test", name: "Baan Mali" });
    expect(senderOf({})).toBeNull();
    expect(senderOf({ EMAIL_FROM_ADDRESS: "codes@manut.test", EMAIL_FROM_NAME: "x".repeat(65) })).toBeNull();
  });

  it("hands Cloudflare's binding exactly the call its docs name", async () => {
    const email = binding(async () => ({ messageId: "fixture-message" }));
    const sender = senderFor({ EMAIL: email, EMAIL_FROM_ADDRESS: "codes@manut.test", EMAIL_FROM_NAME: "Manut AI" });
    await sender!.send(codeEmail("mint@baanmali.example", "123456"));
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(email.send.mock.calls[0]![0]).toEqual({ to: "mint@baanmali.example",
      from: { email: "codes@manut.test", name: "Manut AI" }, subject: "Your Manut AI sign-in code",
      text: codeEmail("mint@baanmali.example", "123456").text });
    expect(senderFor({ EMAIL: email })).toBeNull();
  });

  it("sends to the test outbox whenever the test switch is on in a test Worker, even beside a binding", async () => {
    const email = binding(async () => ({ messageId: "fixture-message" }));
    const before = testOutbox().length;
    await senderFor({ EMAIL: email, EMAIL_FROM_ADDRESS: "codes@manut.test", TEST_EMAIL_OUTBOX: "on",
      PUBLIC_API_ORIGIN: "https://api.manut.test" })!.send(codeEmail("outbox@baanmali.example", "654321"));
    expect(email.send).not.toHaveBeenCalled();
    expect(testOutbox().length).toBe(before + 1);
    expect(testOutbox().at(-1)).toMatchObject({ to: "outbox@baanmali.example",
      from: { email: "codes@manut.test", name: "Manut AI" } });
  });

  it("ignores the test switch anywhere but a test Worker, so a code set to go there is sent for real", async () => {
    const email = binding(async () => ({ messageId: "fixture-message" }));
    const before = testOutbox().length;
    for (const origin of [undefined, "https://dev.manut.xyz", "http://api.manut.test", "https://api.manut.test:8443"]) {
      await senderFor({ EMAIL: email, EMAIL_FROM_ADDRESS: "codes@manut.test", TEST_EMAIL_OUTBOX: "on",
        ...(origin === undefined ? {} : { PUBLIC_API_ORIGIN: origin }) })!.send(codeEmail("real@baanmali.example", "654321"));
    }
    expect(email.send).toHaveBeenCalledTimes(4);
    expect(testOutbox().length).toBe(before);
  });

  it("keeps a refused send to itself: the log names the service's error code, never the address or the code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusal = Object.assign(new Error("recipient mint@baanmali.example is suppressed (code 123456)"),
      { code: "E_RECIPIENT_SUPPRESSED" });
    const sender = senderFor({ EMAIL: binding(async () => { throw refusal; }), EMAIL_FROM_ADDRESS: "codes@manut.test" })!;
    await expect(deliver(sender, codeEmail("mint@baanmali.example", "123456"))).resolves.toBeUndefined();
    expect(logged.mock.calls).toEqual([["email code not sent", "E_RECIPIENT_SUPPRESSED"]]);
    // A failure that is not one of the service's codes is logged as unknown, whatever it carries.
    const odd = senderFor({ EMAIL: binding(async () => { throw Object.assign(new Error("x"), { code: "mint@baanmali.example" }); }),
      EMAIL_FROM_ADDRESS: "codes@manut.test" })!;
    await deliver(odd, codeEmail("mint@baanmali.example", "123456"));
    await deliver(senderFor({ EMAIL: binding(async () => { throw "123456"; }), EMAIL_FROM_ADDRESS: "codes@manut.test" })!,
      codeEmail("mint@baanmali.example", "123456"));
    expect(logged.mock.calls.slice(1)).toEqual([["email code not sent", "unknown"], ["email code not sent", "unknown"]]);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/123456|mint@/);
  });
});

describe("the email", () => {
  it("is plain English with the code in the body only, ten minutes, and that it can be ignored", () => {
    const email = codeEmail("mint@baanmali.example", "042917");
    expect(email.to).toBe("mint@baanmali.example");
    expect(email.subject).toBe("Your Manut AI sign-in code");
    expect(email.subject).not.toMatch(/\d/);
    expect(email.text).toContain("Your Manut AI sign-in code is 042917.");
    expect(email.text).toContain("It works for 10 minutes.");
    expect(email.text).toContain("If you did not ask for a code, you can ignore this email.");
    expect(CODE_TTL_SECONDS).toBe(600);
  });
});
