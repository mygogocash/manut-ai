import { describe, expect, it } from "vitest";
import {
  DECISION_LIMIT,
  DECISION_TTL_MS,
  type DecisionBinding,
  DecisionChallenges,
  answerOption,
  decisionChallenge,
  fromBase64Url,
  toBase64Url,
} from "../src/index";
import { DEVICE_ID, OTHER_DEVICE_ID, refusal, seededRandom } from "./support";
import { FLAG, RP, assertion, newAuthenticator } from "./passkey";

/// The one-use challenge a passkey signs to Allow one ask, ported from GoSpark's
/// `RemoteDecisionChallenges` and its tests ("a verified signature is consumed once and bound to
/// the device and command", "expired, tampered, and revoked signing grants cannot approve"): it
/// lasts 60 seconds, is spent by any answer, right or wrong, and is bound to the device, the
/// request, its revision and the choice.

const T0 = 1_790_000_000_000;
const ALLOW: DecisionBinding = { deviceId: DEVICE_ID, requestId: "req-42", revision: 3, optionId: "yes_once" };

/// Issues a challenge and builds the phone's answer to it, signed by `signer` (by default the
/// device's own passkey), for the binding `answerFor` (by default the one issued).
async function scenario(options: { answerFor?: Partial<DecisionBinding>; shape?: Parameters<typeof assertion>[2] } = {}) {
  const vault = new DecisionChallenges({ random: seededRandom(9) });
  const device = await newAuthenticator();
  const issued = await vault.issue(ALLOW, T0);
  const claimed = { ...ALLOW, ...options.answerFor };
  // The phone signs the challenge the Mac sent, which it can recompute from what it shows.
  const signed = await assertion(device, issued.challenge, options.shape ?? {});
  const answer = { challengeId: issued.id, requestId: claimed.requestId, revision: claimed.revision, optionId: claimed.optionId, ...signed };
  const context = (overrides: { deviceId?: string; now?: number } = {}) => ({
    deviceId: overrides.deviceId ?? DEVICE_ID,
    passkey: device.passkey,
    rp: RP,
    now: overrides.now ?? T0 + 1_000,
  });
  return { vault, device, issued, answer, context };
}

describe("decision challenges", () => {
  it("are bound to the device, request, revision and choice, and the phone can recompute them", async () => {
    const vault = new DecisionChallenges({ random: seededRandom(9) });
    const issued = await vault.issue(ALLOW, T0);
    expect(issued.id).toBe(toBase64Url(issued.nonce));
    expect(issued.nonce).toEqual(Uint8Array.from({ length: 32 }, (_, i) => 9 + i));
    expect(issued.expiresAt).toBe(T0 + DECISION_TTL_MS);
    expect(await decisionChallenge(issued.nonce, ALLOW)).toEqual(issued.challenge);
    const others: Partial<DecisionBinding>[] = [
      { deviceId: OTHER_DEVICE_ID },
      { requestId: "req-43" },
      { revision: 4 },
      { optionId: "no" },
    ];
    for (const change of others) {
      expect(await decisionChallenge(issued.nonce, { ...ALLOW, ...change })).not.toEqual(issued.challenge);
    }
    // Fields cannot run into each other: moving a character from one id to the next changes it.
    const shifted = await decisionChallenge(issued.nonce, { ...ALLOW, requestId: "req-42y", optionId: "es_once" });
    expect(shifted).not.toEqual(issued.challenge);
  });

  it("an answer with the device's passkey and Face ID is accepted once", async () => {
    const { vault, answer, context } = await scenario();
    expect(await vault.verify(answer, context())).toEqual({ ok: true, binding: ALLOW, signCount: 0 });
    expect(await vault.verify(answer, context())).toEqual({ ok: false, refused: "unknown" });
    expect(vault.size).toBe(0);
  });

  it("a challenge used twice at the same moment is accepted once", async () => {
    const { vault, answer, context } = await scenario();
    const results = await Promise.all([vault.verify(answer, context()), vault.verify(answer, context())]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, refused: "unknown" });
  });

  it("a challenge used after its 60 seconds is refused", async () => {
    const late = await scenario();
    expect(await late.vault.verify(late.answer, late.context({ now: T0 + DECISION_TTL_MS }))).toEqual({ ok: false, refused: "expired" });
    const justInTime = await scenario();
    expect((await justInTime.vault.verify(justInTime.answer, justInTime.context({ now: T0 + DECISION_TTL_MS - 1 }))).ok).toBe(true);
  });

  it("an answer for another request, another revision or another choice is refused, and spends the challenge", async () => {
    const cases: [Partial<DecisionBinding>, string][] = [
      [{ requestId: "req-43" }, "other_request"],
      [{ revision: 4 }, "other_revision"],
      [{ optionId: "always" }, "other_choice"],
    ];
    for (const [answerFor, refused] of cases) {
      const { vault, answer, context } = await scenario({ answerFor });
      expect(await vault.verify(answer, context()), refused).toEqual({ ok: false, refused });
      const honest = { ...answer, requestId: ALLOW.requestId, revision: ALLOW.revision, optionId: ALLOW.optionId };
      expect(await vault.verify(honest, context())).toEqual({ ok: false, refused: "unknown" });
    }
  });

  it("an answer from another device is refused, whether it brings this device's signature or its own", async () => {
    const relayed = await scenario();
    expect(await relayed.vault.verify(relayed.answer, relayed.context({ deviceId: OTHER_DEVICE_ID }))).toEqual({ ok: false, refused: "other_device" });

    // Another paired phone signs this device's challenge with its own passkey and sends it as this
    // device: the Mac checks it against this device's passkey, so it fails.
    const { vault, issued, answer, context } = await scenario();
    const otherPhone = await newAuthenticator(0xc1);
    const forged = { ...answer, ...(await assertion(otherPhone, issued.challenge)) };
    expect(await vault.verify(forged, context())).toEqual({ ok: false, refused: "bad_signature" });
  });

  it("a passkey answer without Face ID or the passcode does not Allow, and spends the challenge", async () => {
    const { vault, answer, context } = await scenario({ shape: { flags: FLAG.UP } });
    expect(await vault.verify(answer, context())).toEqual({ ok: false, refused: "no_verification" });
    expect(await vault.verify(answer, context())).toEqual({ ok: false, refused: "unknown" });
  });

  it("a passkey answer with the wrong origin, RP id or challenge, or a broken signature, is refused", async () => {
    const cases: [Parameters<typeof assertion>[2], string][] = [
      [{ origin: "https://dev.manut.xyz" }, "wrong_origin"],
      [{ rpId: "dev.manut.xyz" }, "wrong_rp"],
      [{ challenge: new Uint8Array(32) }, "wrong_challenge"],
    ];
    for (const [shape, refused] of cases) {
      const { vault, answer, context } = await scenario({ shape });
      expect(await vault.verify(answer, context()), refused).toEqual({ ok: false, refused });
    }
    const { vault, answer, context } = await scenario();
    const signature = answer.signature.slice();
    signature[12] = (signature[12] ?? 0) ^ 0x10;
    expect(await vault.verify({ ...answer, signature }, context())).toEqual({ ok: false, refused: "bad_signature" });
  });

  it("an answer whose fields are not bytes is refused, not thrown, and spends the challenge", async () => {
    const { vault, answer, context } = await scenario();
    const garbled = { ...answer, signature: "MEUCIQ" as unknown as Uint8Array };
    expect(await vault.verify(garbled, context())).toEqual({ ok: false, refused: "malformed" });
    expect(await vault.verify(answer, context())).toEqual({ ok: false, refused: "unknown" });
  });

  it("a challenge the Mac never issued, or one from another Mac, is refused", async () => {
    const { answer, context } = await scenario();
    const fresh = new DecisionChallenges();
    expect(await fresh.verify(answer, context())).toEqual({ ok: false, refused: "unknown" });
    expect(await fresh.verify({ ...answer, challengeId: 42 as unknown as string }, context())).toEqual({ ok: false, refused: "unknown" });
  });

  it("Unpair drops every challenge waiting for that device, and only that device's", async () => {
    const vault = new DecisionChallenges({ random: seededRandom(9) });
    const device = await newAuthenticator();
    const mine = [await vault.issue(ALLOW, T0), await vault.issue({ ...ALLOW, requestId: "req-43" }, T0)];
    const theirs = await vault.issue({ ...ALLOW, deviceId: OTHER_DEVICE_ID }, T0);
    expect(vault.revoke(DEVICE_ID)).toBe(2);
    expect(vault.size).toBe(1);
    expect(vault.revoke(DEVICE_ID)).toBe(0);
    const context = { deviceId: DEVICE_ID, passkey: device.passkey, rp: RP, now: T0 + 1 };
    for (const issued of mine) {
      const answer = { challengeId: issued.id, requestId: ALLOW.requestId, revision: ALLOW.revision, optionId: ALLOW.optionId, ...(await assertion(device, issued.challenge)) };
      expect(await vault.verify(answer, context)).toEqual({ ok: false, refused: "unknown" });
    }
    // The other device's challenge still answers.
    const other = await newAuthenticator(0xc5);
    const answer = { challengeId: theirs.id, requestId: ALLOW.requestId, revision: ALLOW.revision, optionId: ALLOW.optionId, ...(await assertion(other, theirs.challenge)) };
    expect((await vault.verify(answer, { deviceId: OTHER_DEVICE_ID, passkey: other.passkey, rp: RP, now: T0 + 1 })).ok).toBe(true);
  });

  it("at most sixteen wait at once; an expired one makes room", async () => {
    expect(DECISION_LIMIT).toBe(16);
    const vault = new DecisionChallenges();
    for (let i = 0; i < DECISION_LIMIT; i++) await vault.issue({ ...ALLOW, requestId: `req-${i}` }, T0);
    expect(await refusal(() => vault.issue(ALLOW, T0 + 1))).toBe("busy");
    expect((await vault.issue(ALLOW, T0 + DECISION_TTL_MS)).expiresAt).toBe(T0 + 2 * DECISION_TTL_MS);
    expect(vault.size).toBe(1);
  });

  it("refuses a binding it cannot bind", async () => {
    const vault = new DecisionChallenges();
    const bad: DecisionBinding[] = [
      { ...ALLOW, deviceId: DEVICE_ID.toLowerCase() },
      { ...ALLOW, requestId: "" },
      { ...ALLOW, optionId: "" },
      { ...ALLOW, revision: 0 },
      { ...ALLOW, revision: 1.5 },
      { ...ALLOW, revision: 2 ** 32 },
      { ...ALLOW, requestId: "x".repeat(1_025) },
    ];
    for (const binding of bad) expect(await refusal(() => vault.issue(binding, T0)), JSON.stringify(binding).slice(0, 80)).toBe("invalid");
    expect(await refusal(() => decisionChallenge(new Uint8Array(31), ALLOW))).toBe("invalid");
    expect(fromBase64Url((await vault.issue(ALLOW, T0)).id)).toHaveLength(32);
  });
});

/// An answer to a question steers the agent as much as an Allow, so its challenge is bound to the exact words: the
/// choice is `answer:` and a digest of the answer, which the phone recomputes from what it shows.
describe("answer options", () => {
  it("are the digest the README lays out, recomputed here straight from Web Crypto", async () => {
    const expected = async (json: string) => {
      const bytes = new TextEncoder().encode(`manut-remote-v1 answer\u0000${json}`);
      return `answer:${toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
    };
    expect(await answerOption("Friday")).toBe(await expected('["text","Friday"]'));
    expect(await answerOption([["a", "yes"], ["b", null]])).toBe(await expected('["answers",[["a","yes"],["b",null]]]'));
    expect(await answerOption("Friday")).toMatch(/^answer:[A-Za-z0-9_-]{43}$/);
  });

  it("differ for any other words, form or order, so a challenge for one answer never covers another", async () => {
    const answers: Parameters<typeof answerOption>[0][] = [
      "Friday",
      "friday",
      "Friday ",
      "Saturday",
      "",
      [["a", "Friday"]],
      [["a", "yes"], ["b", null]],
      [["b", null], ["a", "yes"]],
      [["a", "yes"], ["b", ""]],
      [["a", "yes"], ["b", "null"]],
      [["a", "yes,b"], ["", null]],
      [],
    ];
    const options = await Promise.all(answers.map((a) => answerOption(a)));
    expect(new Set(options).size).toBe(answers.length);
    // Bound into the challenge, an answer's option is one more choice: another answer's challenge is a different one.
    const nonce = new Uint8Array(32).fill(7);
    const binding = { deviceId: DEVICE_ID, requestId: '["buddy","q-1"]', revision: 1 };
    expect(await decisionChallenge(nonce, { ...binding, optionId: options[0]! })).not.toEqual(await decisionChallenge(nonce, { ...binding, optionId: options[3]! }));
  });
});
