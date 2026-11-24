import { afterEach, describe, expect, it, vi } from "vitest";
import { macEmailCode } from "../src/approval-link";
import { normalizeEmail, sha256Hex } from "../src/auth";
import {
  CODE_TTL_SECONDS, codeEmail, codeRequestAddress, DAILY_CODES, DAY_SECONDS, emailAccount, emailExchange, emailSignIn,
  emailTenant, MAX_WRONG_TRIES, purgeAt, readCodeRecord, RESEND_SECONDS, sendCode, sixDigitCode, tryCode,
  type CodeRecord, type EmailSignInEnv,
} from "../src/email-code";
import { deliver, senderFor, senderOf, testOutbox } from "../src/email-sender";

// The rules of signing in by email (email-code.ts) and its sender port (email-sender.ts), without storage: a code of six
// digits with no bias, one send a minute and ten a day per address, ten minutes per code, five tries, the HMAC it is
// kept as, the one rule for an address, and when the route counts as configured. The routes are in auth-email.test.ts.

const SECRET = "test-approval-link-secret-0123456789abcdef";
const T0 = 1_790_000_000;
const MAC = "fixture-mac";

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

describe("sending a code", () => {
  it("sends one a minute to an address, and a new one replaces the one before", () => {
    const first = sendCode(null, MAC, T0);
    expect(first).toEqual({ ok: true, record: { code: { mac: MAC, exp: T0 + CODE_TTL_SECONDS, wrong: 0 }, sent: [T0] } });
    const record = (first as { record: CodeRecord }).record;
    expect(sendCode(record, "next", T0 + 0.5)).toEqual({ ok: false, retryAfter: 60 });
    expect(sendCode(record, "next", T0 + 59)).toEqual({ ok: false, retryAfter: 1 });
    expect(sendCode(record, "next", T0 + 59.9)).toEqual({ ok: false, retryAfter: 1 });
    expect(sendCode(record, "next", T0 + RESEND_SECONDS)).toEqual({ ok: true,
      record: { code: { mac: "next", exp: T0 + 60 + CODE_TTL_SECONDS, wrong: 0 }, sent: [T0, T0 + 60] } });
  });

  it("sends ten in any 24 hours, then waits until the oldest is a day old", () => {
    let record: CodeRecord | null = null;
    for (let i = 0; i < DAILY_CODES; i++) {
      const decided = sendCode(record, MAC, T0 + i * 60);
      expect(decided.ok).toBe(true);
      record = (decided as { record: CodeRecord }).record;
    }
    expect(DAILY_CODES).toBe(10);
    expect(sendCode(record, MAC, T0 + 600)).toEqual({ ok: false, retryAfter: DAY_SECONDS - 600 });
    expect(sendCode(record, MAC, T0 + DAY_SECONDS - 1)).toEqual({ ok: false, retryAfter: 1 });
    // At a day, the oldest send no longer counts, and it is dropped from the record.
    const next = sendCode(record, MAC, T0 + DAY_SECONDS);
    expect(next.ok).toBe(true);
    expect((next as { record: CodeRecord }).record.sent).toHaveLength(DAILY_CODES);
    expect((next as { record: CodeRecord }).record.sent[0]).toBe(T0 + 60);
  });
});

describe("trying a code", () => {
  const live = (wrong = 0): CodeRecord => ({ code: { mac: MAC, exp: T0 + CODE_TTL_SECONDS, wrong }, sent: [T0] });
  const right = (mac: string) => mac === MAC;
  const wrongly = () => false;

  it("uses the right code up, keeping only the sends", () => {
    expect(tryCode(live(), right, T0 + 1)).toEqual({ kind: "right", record: { sent: [T0] } });
    expect(tryCode({ sent: [T0] }, right, T0 + 2)).toEqual({ kind: "ended" });
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
    expect(record).toEqual({ sent: [T0] });
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
  it("reads only what the rules wrote, so anything else holds no code", () => {
    expect(readCodeRecord({ code: { mac: MAC, exp: T0, wrong: 2 }, sent: [T0] }))
      .toEqual({ code: { mac: MAC, exp: T0, wrong: 2 }, sent: [T0] });
    expect(readCodeRecord({ sent: [] })).toEqual({ sent: [] });
    for (const value of [undefined, null, "record", [], { sent: "x" }, { sent: [-1] }, { sent: [T0], code: "123456" },
      { sent: [T0], code: { mac: MAC, exp: T0, wrong: -1 } }, { sent: [T0], code: { mac: 7, exp: T0, wrong: 0 } },
      { sent: [T0], code: { mac: MAC, exp: Number.NaN, wrong: 0 } }]) {
      expect(readCodeRecord(value)).toBeNull();
    }
  });

  it("is kept a day after its last send, when that send no longer counts", () => {
    expect(purgeAt({ code: { mac: MAC, exp: T0 + 600, wrong: 0 }, sent: [T0 - 100, T0] })).toBe(T0 + DAY_SECONDS);
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
    TEST_EMAIL_OUTBOX: "on" };

  it("is on only with the switch, a sender and the secret", () => {
    expect(emailSignIn(on)).not.toBeNull();
    for (const off of [
      { ...on, EMAIL_SIGN_IN: undefined }, { ...on, EMAIL_SIGN_IN: "off" }, { ...on, EMAIL_SIGN_IN: "1" },
      { ...on, EMAIL_SIGN_IN: "true" }, { ...on, EMAIL_SIGN_IN: "ON" },
      { ...on, APPROVAL_LINK_SECRET: undefined }, { ...on, APPROVAL_LINK_SECRET: "short" },
      { ...on, TEST_EMAIL_OUTBOX: undefined }, { ...on, TEST_EMAIL_OUTBOX: "1" },
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

  it("sends to the test outbox whenever the test switch is on, even beside a binding", async () => {
    const email = binding(async () => ({ messageId: "fixture-message" }));
    const before = testOutbox().length;
    await senderFor({ EMAIL: email, EMAIL_FROM_ADDRESS: "codes@manut.test", TEST_EMAIL_OUTBOX: "on" })!
      .send(codeEmail("outbox@baanmali.example", "654321"));
    expect(email.send).not.toHaveBeenCalled();
    expect(testOutbox().length).toBe(before + 1);
    expect(testOutbox().at(-1)).toMatchObject({ to: "outbox@baanmali.example",
      from: { email: "codes@manut.test", name: "Manut AI" } });
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
