// serve.ts, the only code that turns a phone's request into something the Mac does: the six requests each reach the
// right store action and nothing else, everything else is refused by name, and an Allow reaches the store only through a
// one-use challenge the phone's passkey answered for that device, that ask, the revision it saw and Allow once.
import { DecisionChallenges, type StoredPasskey, decisionChallenge, fromBase64Url, toBase64Url, verifyPasskeyRegistration } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import { DEFAULT_GRANT, type Grant, REQUEST_TABLE, STAYS_ON_MACHINE } from "./levels";
import type { SourceApproval } from "./project";
import { REQUESTS, type ServeDeps, Server } from "./serve";
import { FakeChats } from "./testkit/chats";
import { RP } from "./testkit/harness";
import { TestAuthenticator } from "./testkit/phone";

const PHONE = "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F";
const OTHER = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

/** The choice an answer's challenge is bound to, computed here straight from the wire's description (serve.ts) rather
 *  than from the package, so the two are checked against each other: `answer:` and the base64url SHA-256 of
 *  "manut-remote-v1 answer", a zero byte, and the answer as JSON (`["text", <text>]`, or `["answers", [[<id>, <text or
 *  null>], ...]]` in the order the ask lists its questions). */
async function optionFor(answer: string | [string, string | null][]): Promise<string> {
  const json = JSON.stringify(typeof answer === "string" ? ["text", answer] : ["answers", answer]);
  const bytes = new TextEncoder().encode(`manut-remote-v1 answer\u0000${json}`);
  return `answer:${toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

async function stored(authenticator: TestAuthenticator): Promise<StoredPasskey> {
  const challenge = new Uint8Array(32).fill(9);
  const result = await verifyPasskeyRegistration(await authenticator.create(RP, challenge), { challenge, rp: RP });
  if (!result.ok) throw new Error(result.refused);
  return result.passkey;
}

const secondApproval: SourceApproval = {
  kind: "approval",
  id: "req-2",
  ts: 1_800_000_300,
  open: true,
  title: "Refund an order",
  command: "refund --order 1042 --amount 129000",
  choices: ["once", "deny"],
};

/** A Mac's server over chats a test controls, with two paired phones at Answer, as every phone paired before item 108b
 *  is. Both have opened "buddy" (so they were shown its asks at revision 1), unless `open` is false. `levels` holds what
 *  each phone's record says it may do; a phone missing from it has a record this Mac cannot read. */
async function setup(options: { open?: boolean; notify?: ServeDeps["notify"] } = {}) {
  const chats = new FakeChats();
  chats.update("buddy", (items) => [...items, secondApproval]);
  const authenticators = new Map([
    [PHONE, new TestAuthenticator(0xa1)],
    [OTHER, new TestAuthenticator(0xb2)],
  ]);
  const passkeys = new Map<string, StoredPasskey>();
  for (const [id, a] of authenticators) passkeys.set(id, await stored(a));
  const paired = new Set([PHONE, OTHER]);
  const levels = new Map<string, Grant>([
    [PHONE, DEFAULT_GRANT],
    [OTHER, DEFAULT_GRANT],
  ]);
  const pushed: { device: string; message: Record<string, unknown> }[] = [];
  let now = 1_800_000_000_000;
  let onSeen: (() => void) | null = null;
  const challenges = new DecisionChallenges();
  /** A new server over the same chats and phones, as after the app started again. */
  const start = () =>
    new Server({
      chats,
      actions: chats.actions,
      challenges,
      phones: {
        has: (id) => paired.has(id),
        passkey: (id) => passkeys.get(id),
        grant: (id) => levels.get(id),
        seen: async (id, _at, signCount) => {
          onSeen?.();
          const known = passkeys.get(id);
          if (known && signCount !== undefined) passkeys.set(id, { ...known, signCount });
        },
      },
      rp: RP,
      now: () => now,
      push: (device, message) => pushed.push({ device, message }),
      ...(options.notify ? { notify: options.notify } : {}),
    });
  let server = start();
  if (options.open !== false) {
    for (const device of [PHONE, OTHER]) await server.handle(device, encode({ t: "open", id: 0, chat: "buddy" }));
  }
  let id = 0;
  const send = async (device: string, message: Record<string, unknown>) => (await server.handle(device, encode({ ...message, id: ++id })))[0]!;
  /** Both steps of Allow once from `device`; `change` alters the second step before it is sent. */
  const allow = async (
    device: string,
    params: { chat: string; ask: string; revision: number },
    change: { answerAs?: string; sign?: { optionId?: string; origin?: string; flags?: number; signCount?: number }; step2?: Record<string, unknown>; before?: () => void } = {},
  ) => {
    const challenge = await send(device, { t: "allow", ...params });
    if (challenge.t !== "challenge") return challenge;
    change.before?.();
    const authenticator = authenticators.get(change.answerAs ?? device)!;
    const signed = await decisionChallenge(fromBase64Url(String(challenge.nonce)), {
      deviceId: change.answerAs ?? device,
      requestId: JSON.stringify([params.chat, params.ask]),
      revision: params.revision,
      optionId: change.sign?.optionId ?? "once",
    });
    const shape = { ...(change.sign?.origin ? { origin: change.sign.origin } : {}), ...(change.sign?.flags !== undefined ? { flags: change.sign.flags } : {}), ...(change.sign?.signCount !== undefined ? { signCount: change.sign.signCount } : {}) };
    const passkey = await authenticator.get(RP, signed, shape);
    const answer = {
      challengeId: String(challenge.nonce),
      credentialId: toBase64Url(passkey.credentialId),
      clientDataJSON: toBase64Url(passkey.clientDataJSON),
      authenticatorData: toBase64Url(passkey.authenticatorData),
      signature: toBase64Url(passkey.signature),
    };
    return send(device, { t: "allow", ...params, option: "once", answer, ...change.step2 });
  };
  /** Both steps of answering a question from `device`: `given` is `{ answer }` or `{ answers }`, and `signFor` is the
   *  answer the passkey signs (what the phone's screen showed), by default the one sent. */
  const answer = async (
    device: string,
    params: { chat: string; ask: string; revision: number },
    given: { answer?: unknown; answers?: unknown },
    change: {
      answerAs?: string;
      signFor?: string | [string, string | null][];
      sign?: { origin?: string; flags?: number };
      step2?: Record<string, unknown>;
      before?: () => void;
    } = {},
  ) => {
    const challenge = await send(device, { t: "reply", ...params, ...given });
    if (challenge.t !== "challenge") return challenge;
    change.before?.();
    const shown = change.signFor ?? (typeof given.answer === "string" ? given.answer : Object.entries(given.answers as Record<string, string | null>));
    const signed = await decisionChallenge(fromBase64Url(String(challenge.nonce)), {
      deviceId: change.answerAs ?? device,
      requestId: JSON.stringify([params.chat, params.ask]),
      revision: params.revision,
      optionId: await optionFor(shown),
    });
    const passkey = await authenticators.get(change.answerAs ?? device)!.get(RP, signed, change.sign ?? {});
    const proof = {
      challengeId: String(challenge.nonce),
      credentialId: toBase64Url(passkey.credentialId),
      clientDataJSON: toBase64Url(passkey.clientDataJSON),
      authenticatorData: toBase64Url(passkey.authenticatorData),
      signature: toBase64Url(passkey.signature),
    };
    return send(device, { t: "reply", ...params, ...given, passkey: proof, ...change.step2 });
  };
  return {
    chats,
    get server() {
      return server;
    },
    restart: () => (server = start()),
    challenges,
    paired,
    levels,
    pushed,
    send,
    allow,
    answer,
    authenticators,
    advance: (ms: number) => (now += ms),
    whenSeen: (run: () => void) => (onSeen = run),
  };
}

describe("notify, the seventh request (item 78d)", () => {
  it("hands only the speaking device's push address on, needs no passkey, and touches nothing of the Mac's", async () => {
    const asked: [string, string | null][] = [];
    const s = await setup({ notify: (device, endpoint) => (asked.push([device, endpoint]), endpoint === "https://bad.example/x" ? "push_address" : null) });
    expect(await s.send(PHONE, { t: "notify", endpoint: "https://fcm.googleapis.com/fcm/send/a" })).toMatchObject({ t: "done" });
    // A device id in the request is not read: who asks is the channel's device.
    expect(await s.send(OTHER, { t: "notify", endpoint: null, device: PHONE })).toMatchObject({ t: "done" });
    expect(await s.send(PHONE, { t: "notify", endpoint: "https://bad.example/x" })).toMatchObject({ t: "refused", request: "notify", reason: "push_address" });
    expect(asked).toEqual([
      [PHONE, "https://fcm.googleapis.com/fcm/send/a"],
      [OTHER, null],
      [PHONE, "https://bad.example/x"],
    ]);
    for (const endpoint of [42, {}, undefined]) {
      expect(await s.send(PHONE, { t: "notify", endpoint })).toMatchObject({ t: "refused", reason: "malformed" });
    }
    expect(asked).toHaveLength(3);
    // A phone unpaired is answered by nothing.
    s.paired.delete(PHONE);
    expect(await s.send(PHONE, { t: "notify", endpoint: null })).toMatchObject({ t: "refused", reason: "unknown_device" });
    expect(asked).toHaveLength(3);
    expect(s.chats.done).toEqual([]);
    expect(s.challenges.size).toBe(0);
  });

  it("is not offered by a Mac that keeps no push addresses", async () => {
    const s = await setup();
    expect(await s.send(PHONE, { t: "notify", endpoint: null })).toMatchObject({ t: "refused", reason: "not_offered" });
  });
});

describe("the six requests", () => {
  it("each reaches the right store action, and nothing else does", async () => {
    const s = await setup();
    expect(await s.send(PHONE, { t: "list" })).toMatchObject({
      t: "chats",
      chats: [
        { chat: "buddy", state: "needs_you" },
        { chat: "kit", state: "done" },
      ],
    });
    const opened = await s.send(PHONE, { t: "open", chat: "buddy" });
    expect(opened).toMatchObject({ t: "chat", view: { chat: "buddy", state: "needs_you", step: "Reading the price list" } });
    expect(await s.send(PHONE, { t: "catchup", chat: "buddy", cursor: opened.cursor })).toMatchObject({ t: "events", events: [] });
    expect(s.chats.done).toEqual([]);

    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toEqual({ t: "done", id: 5 });
    expect(s.chats.done).toEqual([{ action: "allowOnce", chat: "buddy", ask: "req-1", by: PHONE }]);
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-2", revision: 1, no: true })).toMatchObject({ t: "done" });
    expect(s.chats.done.at(-1)).toEqual({ action: "decline", chat: "buddy", ask: "req-2", by: PHONE });
    expect(await s.answer(PHONE, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Friday" })).toMatchObject({ t: "done" });
    expect(s.chats.done.at(-1)).toEqual({ action: "answer", chat: "buddy", ask: "q-1", by: PHONE, answer: "Friday" });
    expect(await s.send(PHONE, { t: "stop", chat: "buddy" })).toMatchObject({ t: "done" });
    expect(s.chats.done.at(-1)).toEqual({ action: "stop", chat: "buddy" });
    expect(s.chats.done).toHaveLength(4);
  });

  it("refuses everything else by name, and does nothing for it", async () => {
    const s = await setup();
    for (const name of STAYS_ON_MACHINE) {
      expect(await s.send(PHONE, { t: name, chat: "buddy", ask: "req-1" })).toMatchObject({ t: "refused", request: name, reason: "stays_on_mac" });
    }
    for (const name of ["send", "start", "status", "diff", "files", "delete", "push", "__proto__", "constructor", "toString", "LIST"]) {
      expect(await s.send(PHONE, { t: name, chat: "buddy" })).toMatchObject({ t: "refused", reason: "unknown_request" });
    }
    // Not JSON, not an object, no number id, no name: malformed, naming nothing.
    for (const raw of ["not json", "[]", "null", JSON.stringify({ t: "list" }), JSON.stringify({ t: "list", id: "1" }), JSON.stringify({ id: 3 })]) {
      expect((await s.server.handle(PHONE, encode(raw)))[0]).toMatchObject({ t: "refused", reason: "malformed" });
    }
    expect(await s.send(PHONE, { t: "open", chat: "nope" })).toMatchObject({ reason: "no_chat" });
    expect(s.chats.done).toEqual([]);
  });

  it("never allows always, for the session, or a folder from a phone, whatever it sends", async () => {
    const s = await setup();
    for (const option of ["always", "session"]) {
      expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1, option })).toMatchObject({ reason: "stays_on_mac" });
      expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 }, { step2: { option } })).toMatchObject({ reason: "stays_on_mac" });
    }
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1, option: "deny" })).toMatchObject({ reason: "not_offered" });
    expect(s.chats.done).toEqual([]);
  });
});

describe("Allow once", () => {
  it("is refused with no challenge, and with one that was spent by a wrong answer", async () => {
    const s = await setup();
    const at = { chat: "buddy", ask: "req-1", revision: 1 };
    const madeUp = { challengeId: toBase64Url(new Uint8Array(32).fill(4)), credentialId: "AA", clientDataJSON: "AA", authenticatorData: "AA", signature: "AA" };
    expect(await s.send(PHONE, { t: "allow", ...at, option: "once", answer: madeUp })).toMatchObject({ reason: "unknown" });
    // A wrong answer (a bad signature) spends the challenge; the right answer to it afterwards finds nothing.
    const first = await s.send(PHONE, { t: "allow", ...at });
    const signed = await decisionChallenge(fromBase64Url(String(first.nonce)), { deviceId: PHONE, requestId: JSON.stringify(["buddy", "req-1"]), revision: 1, optionId: "once" });
    const passkey = await s.authenticators.get(PHONE)!.get(RP, signed);
    const answer = {
      challengeId: String(first.nonce),
      credentialId: toBase64Url(passkey.credentialId),
      clientDataJSON: toBase64Url(passkey.clientDataJSON),
      authenticatorData: toBase64Url(passkey.authenticatorData),
      signature: toBase64Url(passkey.signature),
    };
    expect(await s.send(PHONE, { t: "allow", ...at, option: "once", answer: { ...answer, signature: toBase64Url(new Uint8Array(70)) } })).toMatchObject({ reason: "bad_signature" });
    expect(await s.send(PHONE, { t: "allow", ...at, option: "once", answer })).toMatchObject({ reason: "unknown" });
    expect(s.chats.done).toEqual([]);
  });

  it("is refused 60 seconds after its challenge", async () => {
    const s = await setup();
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 }, { before: () => s.advance(60_000) })).toMatchObject({ reason: "expired" });
    expect(s.chats.done).toEqual([]);
  });

  it("is refused for another device's challenge, another ask's, another revision's and another choice's", async () => {
    const s = await setup();
    // Issued to the other phone, answered (with the other phone's own passkey) on this phone's session.
    const theirs = await s.send(OTHER, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 });
    const signed = await decisionChallenge(fromBase64Url(String(theirs.nonce)), { deviceId: OTHER, requestId: JSON.stringify(["buddy", "req-1"]), revision: 1, optionId: "once" });
    const passkey = await s.authenticators.get(OTHER)!.get(RP, signed);
    const answer = (nonce: unknown) => ({
      challengeId: String(nonce),
      credentialId: toBase64Url(passkey.credentialId),
      clientDataJSON: toBase64Url(passkey.clientDataJSON),
      authenticatorData: toBase64Url(passkey.authenticatorData),
      signature: toBase64Url(passkey.signature),
    });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1, option: "once", answer: answer(theirs.nonce) })).toMatchObject({ reason: "other_device" });
    // Issued for req-1, sent as req-2's.
    const forOne = await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-2", revision: 1, option: "once", answer: answer(forOne.nonce) })).toMatchObject({ reason: "other_request" });
    // Issued for revision 1, sent as revision 2's.
    const forRevision = await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 2, option: "once", answer: answer(forRevision.nonce) })).toMatchObject({ reason: "other_revision" });
    // The passkey signed the challenge as computed for another choice: it is not the one issued.
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 }, { sign: { optionId: "always" } })).toMatchObject({ reason: "wrong_challenge" });
    expect(s.chats.done).toEqual([]);
  });

  it("is refused from another site, without Face ID, and with a counter that did not move", async () => {
    const s = await setup();
    const at = { chat: "buddy", ask: "req-1", revision: 1 };
    expect(await s.allow(PHONE, at, { sign: { origin: "https://evil.example" } })).toMatchObject({ reason: "wrong_origin" });
    expect(await s.allow(PHONE, at, { sign: { flags: 0x01 } })).toMatchObject({ reason: "no_verification" });
    expect(await s.allow(PHONE, at, { sign: { signCount: 5 } })).toMatchObject({ t: "done" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-2", revision: 1, no: true })).toMatchObject({ t: "done" });
    s.chats.update("buddy", (items) => [...items, { ...secondApproval, id: "req-3" }]);
    s.server.publish();
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-3", revision: 1 }, { sign: { signCount: 5 } })).toMatchObject({ reason: "counter" });
    expect(s.chats.done.map((d) => d.action)).toEqual(["allowOnce", "decline"]);
  });

  it("is refused for an ask that changed, closed, needs an app update, or does not offer Allow once", async () => {
    const s = await setup();
    // The phone saw revision 1; the ask now shows something else, which is revision 2.
    await s.send(PHONE, { t: "open", chat: "buddy" });
    s.chats.update("buddy", (items) => items.map((i) => (i.kind === "approval" && i.id === "req-1" ? { ...i, command: "line broadcast --to everyone" } : i)));
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "changed" });
    // It changes again between the challenge and the answer: what is allowed must be what the person saw.
    expect(
      await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 2 }, {
        before: () => s.chats.update("buddy", (items) => items.map((i) => (i.kind === "approval" && i.id === "req-1" ? { ...i, cwd: "/tmp" } : i))),
      }),
    ).toMatchObject({ reason: "changed" });
    s.chats.update("buddy", (items) => [
      ...items,
      { ...secondApproval, id: "old", outdated: true },
      { ...secondApproval, id: "shut", open: false },
      { ...secondApproval, id: "only-no", choices: ["deny"] },
    ]);
    // The phones watching hear of the new asks, as the store's change would tell them.
    s.server.publish();
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "old", revision: 1 })).toMatchObject({ reason: "needs_update" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "old", revision: 1, no: true })).toMatchObject({ reason: "needs_update" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "shut", revision: 1 })).toMatchObject({ reason: "ask_closed" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "only-no", revision: 1 })).toMatchObject({ reason: "not_offered" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "q-1", revision: 1 })).toMatchObject({ reason: "no_ask" });
    expect(s.chats.done).toEqual([]);
  });

  it("binds to the command itself: two commands that mask to the same view get different challenges, and an Allow for one is refused for the other (item 117)", async () => {
    const s = await setup();
    const withKey = (key: string) =>
      s.chats.update("buddy", (items) => items.map((i) => (i.kind === "approval" && i.id === "req-1" ? { ...i, command: `API_KEY=${key} pnpm deploy` } : i)));
    const shown = async () => {
      const opened = await s.send(PHONE, { t: "open", chat: "buddy" });
      return (opened.view as { asks: { id: string; command: string; revision: number }[] }).asks.find((a) => a.id === "req-1")!;
    };
    withKey("abc123");
    const first = await shown();
    expect(first.command).toBe("API_KEY=•••• pnpm deploy");
    const issued = await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: first.revision });
    expect(issued).toMatchObject({ t: "challenge", revision: first.revision });
    // Another command that masks to the same words is another revision, so its challenge is other bytes for one nonce.
    withKey("xyz789");
    const second = await shown();
    expect(second.command).toBe(first.command);
    expect(second.revision).toBe(first.revision + 1);
    const nonce = fromBase64Url(String(issued.nonce));
    const bound = (revision: number) => decisionChallenge(nonce, { deviceId: PHONE, requestId: JSON.stringify(["buddy", "req-1"]), revision, optionId: "once" });
    expect(toBase64Url(await bound(second.revision))).not.toBe(toBase64Url(await bound(first.revision)));
    // The Allow the person gave the first is refused for the second, before a challenge and after Face ID alike.
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: first.revision })).toMatchObject({ t: "refused", reason: "changed" });
    expect(
      await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: second.revision }, { before: () => withKey("abc123") }),
    ).toMatchObject({ t: "refused", reason: "changed" });
    expect(s.chats.done).toEqual([]);
  });

  it("has at most sixteen challenges waiting", async () => {
    const s = await setup();
    for (let i = 0; i < 16; i++) expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "challenge" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "busy" });
  });

  it("acts on nothing once the phone was unpaired, or the switch turned off, while its answer was checked", async () => {
    const s = await setup();
    s.whenSeen(() => s.paired.delete(PHONE));
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "unknown_device" });
    expect(await s.send(PHONE, { t: "list" })).toMatchObject({ reason: "unknown_device" });
    s.whenSeen(() => s.server.clear());
    expect(await s.allow(OTHER, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "unknown_device" });
    expect(s.chats.done).toEqual([]);
  });

  it("says when the runtime did not take it", async () => {
    const s = await setup();
    s.chats.answerWith = "Not taken";
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "not_taken" });
    expect(await s.send(PHONE, { t: "stop", chat: "buddy" })).toMatchObject({ reason: "not_taken" });
  });
});

describe("No and Stop", () => {
  it("need no challenge, but check the ask and the revision", async () => {
    const s = await setup();
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "malformed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-1", revision: 2, no: true })).toMatchObject({ reason: "changed" });
    expect(await s.send(PHONE, { t: "stop", chat: "kit" })).toMatchObject({ reason: "no_turn" });
    // A passkey sent with a No changes nothing: No stays free, and goes through with or without one.
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-1", revision: 1, no: true, passkey: { challengeId: "x" } })).toMatchObject({ t: "done" });
    expect(s.chats.done).toEqual([{ action: "decline", chat: "buddy", ask: "req-1", by: PHONE }]);
  });
});

describe("Answering a question", () => {
  const q1 = { chat: "buddy", ask: "q-1", revision: 1 };
  /** An interview with two questions, listed a then b, which the phones watching hear of. */
  const interview = (s: Awaited<ReturnType<typeof setup>>) => {
    s.chats.update("buddy", (items) => [
      ...items,
      { kind: "clarify", id: "q-2", ts: 1, open: true, question: "Two things", questions: [{ id: "a", question: "First" }, { id: "b", question: "Second" }] },
    ]);
    s.server.publish();
  };

  it("reaches the store only through a one-use challenge the phone's passkey answered, for a typed answer and a picked choice alike", async () => {
    const s = await setup();
    // Step one alone does nothing: it is answered with a challenge bound to the device, the ask, its revision and the
    // exact answer.
    const first = await s.send(PHONE, { t: "reply", ...q1, answer: "Friday" });
    expect(first).toMatchObject({ t: "challenge", chat: "buddy", ask: "q-1", revision: 1, option: await optionFor("Friday") });
    expect(s.chats.done).toEqual([]);
    // A picked choice ("Friday" is one) and typed text each need Face ID.
    expect(await s.answer(PHONE, q1, { answer: "Friday" })).toMatchObject({ t: "done" });
    s.chats.update("buddy", (items) => [...items, { kind: "clarify", id: "q-3", ts: 2, open: true, question: "When" }]);
    s.server.publish();
    expect(await s.answer(PHONE, { ...q1, ask: "q-3" }, { answer: "Sunday at ten, and refund everyone" })).toMatchObject({ t: "done" });
    expect(s.chats.done).toEqual([
      { action: "answer", chat: "buddy", ask: "q-1", by: PHONE, answer: "Friday" },
      { action: "answer", chat: "buddy", ask: "q-3", by: PHONE, answer: "Sunday at ten, and refund everyone" },
    ]);
  });

  it("binds an interview's answers in the order the ask lists its questions, whatever order the phone sends them in", async () => {
    const s = await setup();
    interview(s);
    const q2 = { chat: "buddy", ask: "q-2", revision: 1 };
    const challenge = await s.send(PHONE, { t: "reply", ...q2, answers: { b: null, a: "yes" } });
    expect(challenge).toMatchObject({ t: "challenge", option: await optionFor([["a", "yes"], ["b", null]]) });
    expect(await s.answer(PHONE, q2, { answers: { b: null, a: "yes" } }, { signFor: [["a", "yes"], ["b", null]] })).toMatchObject({ t: "done" });
    expect(s.chats.done).toEqual([{ action: "answer", chat: "buddy", ask: "q-2", by: PHONE, answer: { a: "yes", b: null } }]);
  });

  it("checks the answer's shape before any challenge", async () => {
    const s = await setup();
    interview(s);
    const q2 = { chat: "buddy", ask: "q-2", revision: 1 };
    const malformed: { given: Record<string, unknown>; at?: typeof q1 }[] = [
      { given: { answer: "" } },
      { given: { answer: "x".repeat(8_001) } },
      { given: { answer: 4 } },
      { given: { answer: null } },
      { given: { answer: ["Friday"] } },
      { given: { answers: { x: "Friday" } } },
      { given: { no: true } },
      { given: {} },
      // An interview takes an answer, or null, for exactly each of its questions.
      { given: { answers: { a: "yes" } }, at: q2 },
      { given: { answers: { a: "yes", c: "no" } }, at: q2 },
      { given: { answers: { a: "yes", b: null, c: null } }, at: q2 },
      { given: { answers: { a: "yes", b: 3 } }, at: q2 },
      { given: { answers: { a: "yes", b: "" } }, at: q2 },
      { given: { answers: ["yes", null] }, at: q2 },
      { given: { answer: "yes" }, at: q2 },
    ];
    for (const { given, at } of malformed) {
      expect(await s.send(PHONE, { t: "reply", ...(at ?? q1), ...given }), JSON.stringify(given)).toMatchObject({ t: "refused", reason: "malformed" });
    }
    expect(s.challenges.size).toBe(0);
    expect(s.chats.done).toEqual([]);
  });

  it("is refused for another answer than the challenged one, another device, ask or revision, a late or spent challenge, and without Face ID", async () => {
    const s = await setup();
    // Step two names another answer than step one: the challenge was issued for "Friday".
    expect(await s.answer(PHONE, q1, { answer: "Friday" }, { step2: { answer: "Saturday" }, signFor: "Saturday" })).toMatchObject({ reason: "other_choice" });
    // The passkey signed another answer than the one sent and challenged.
    expect(await s.answer(PHONE, q1, { answer: "Friday" }, { signFor: "Saturday" })).toMatchObject({ reason: "wrong_challenge" });
    // An interview's answer changed between the steps.
    interview(s);
    const q2 = { chat: "buddy", ask: "q-2", revision: 1 };
    expect(
      await s.answer(PHONE, q2, { answers: { a: "yes", b: null } }, { step2: { answers: { a: "yes", b: "and delete the shop" } }, signFor: [["a", "yes"], ["b", "and delete the shop"]] }),
    ).toMatchObject({ reason: "other_choice" });
    // Without Face ID or the passcode, and from another site.
    expect(await s.answer(PHONE, q1, { answer: "Friday" }, { sign: { flags: 0x01 } })).toMatchObject({ reason: "no_verification" });
    expect(await s.answer(PHONE, q1, { answer: "Friday" }, { sign: { origin: "https://evil.example" } })).toMatchObject({ reason: "wrong_origin" });
    // Late.
    expect(await s.answer(PHONE, q1, { answer: "Friday" }, { before: () => s.advance(60_000) })).toMatchObject({ reason: "expired" });
    // Issued to the other phone, answered with the other phone's passkey on this phone's session.
    const theirs = await s.send(OTHER, { t: "reply", ...q1, answer: "Friday" });
    const signed = await decisionChallenge(fromBase64Url(String(theirs.nonce)), { deviceId: OTHER, requestId: JSON.stringify(["buddy", "q-1"]), revision: 1, optionId: await optionFor("Friday") });
    const passkey = await s.authenticators.get(OTHER)!.get(RP, signed);
    const proof = (nonce: unknown) => ({
      challengeId: String(nonce),
      credentialId: toBase64Url(passkey.credentialId),
      clientDataJSON: toBase64Url(passkey.clientDataJSON),
      authenticatorData: toBase64Url(passkey.authenticatorData),
      signature: toBase64Url(passkey.signature),
    });
    expect(await s.send(PHONE, { t: "reply", ...q1, answer: "Friday", passkey: proof(theirs.nonce) })).toMatchObject({ reason: "other_device" });
    // Issued for another revision, and for another ask (an Allow's challenge used for an answer).
    const forRevision = await s.send(PHONE, { t: "reply", ...q1, answer: "Friday" });
    s.chats.update("buddy", (items) => items.map((i) => (i.kind === "clarify" && i.id === "q-1" ? { ...i, question: "Which day, really" } : i)));
    s.server.publish();
    expect(await s.send(PHONE, { t: "reply", ...q1, revision: 2, answer: "Friday", passkey: proof(forRevision.nonce) })).toMatchObject({ reason: "other_revision" });
    const forAllow = await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 });
    expect(await s.send(PHONE, { t: "reply", ...q1, revision: 2, answer: "Friday", passkey: proof(forAllow.nonce) })).toMatchObject({ reason: "other_request" });
    // A made-up challenge, a spent one and a malformed passkey answer.
    expect(await s.send(PHONE, { t: "reply", ...q1, revision: 2, answer: "Friday", passkey: proof(toBase64Url(new Uint8Array(32).fill(4))) })).toMatchObject({ reason: "unknown" });
    expect(await s.send(PHONE, { t: "reply", ...q1, revision: 2, answer: "Friday", passkey: proof(theirs.nonce) })).toMatchObject({ reason: "unknown" });
    for (const bad of [null, "x", [], { challengeId: "x" }, { ...proof("x"), signature: 5 }]) {
      expect(await s.send(PHONE, { t: "reply", ...q1, revision: 2, answer: "Friday", passkey: bad }), JSON.stringify(bad)).toMatchObject({ reason: "malformed" });
    }
    expect(s.chats.done).toEqual([]);
  });

  it("is refused for a question that changed or closed while the person looked at Face ID, and once the phone was unpaired", async () => {
    const s = await setup();
    const reword = () => s.chats.update("buddy", (items) => items.map((i) => (i.kind === "clarify" && i.id === "q-1" ? { ...i, question: "Which day should we refund" } : i)));
    expect(await s.answer(PHONE, q1, { answer: "Friday" }, { before: reword })).toMatchObject({ reason: "changed" });
    // The phone is shown the reworded question, revision 2.
    s.server.publish();
    const close = () => s.chats.update("buddy", (items) => items.map((i) => (i.kind === "clarify" && i.id === "q-1" ? { ...i, open: false, answered: true } : i)));
    expect(await s.answer(PHONE, { ...q1, revision: 2 }, { answer: "Friday" }, { before: close })).toMatchObject({ reason: "ask_closed" });
    s.chats.update("buddy", (items) => [...items, { kind: "clarify", id: "q-4", ts: 3, open: true, question: "When" }]);
    s.server.publish();
    s.whenSeen(() => s.paired.delete(PHONE));
    expect(await s.answer(PHONE, { ...q1, ask: "q-4" }, { answer: "Friday" })).toMatchObject({ reason: "unknown_device" });
    expect(s.chats.done).toEqual([]);
  });

  it("stores the passkey's counter, and refuses one that did not move", async () => {
    const s = await setup();
    const phone = s.authenticators.get(PHONE)!;
    phone.signCount = 5;
    expect(await s.answer(PHONE, q1, { answer: "Friday" })).toMatchObject({ t: "done" });
    s.chats.update("buddy", (items) => [...items, { kind: "clarify", id: "q-5", ts: 4, open: true, question: "When" }]);
    s.server.publish();
    phone.signCount = 5;
    expect(await s.answer(PHONE, { ...q1, ask: "q-5" }, { answer: "Friday" })).toMatchObject({ reason: "counter" });
    expect(s.chats.done.map((d) => d.ask)).toEqual(["q-1"]);
  });
});

describe("watching a chat", () => {
  it("sends each change of an open chat, numbered, to every phone watching it, and catches a phone up from its cursor", async () => {
    const s = await setup();
    const opened = await s.send(PHONE, { t: "open", chat: "buddy" });
    await s.send(OTHER, { t: "open", chat: "buddy" });
    s.chats.update("buddy", (items) => [...items, { kind: "message", id: "m3", role: "assistant", text: "Sent", ts: 1_800_000_400 }], { working: false, step: null });
    s.server.publish();
    const events = s.pushed.filter((p) => p.device === PHONE).map((p) => p.message);
    expect(events.map((e) => (e.event as { k: string }).k)).toEqual(["state", "message"]);
    expect(s.pushed.filter((p) => p.device === OTHER)).toHaveLength(2);
    expect(events.map((e) => (e.cursor as { seq: number }).seq)).toEqual([1, 2]);
    // A phone that held the snapshot's cursor gets both; one that held the first event's gets the second.
    const caught = await s.send(PHONE, { t: "catchup", chat: "buddy", cursor: opened.cursor });
    expect((caught.events as unknown[]).length).toBe(2);
    const partial = await s.send(PHONE, { t: "catchup", chat: "buddy", cursor: events[0]!.cursor });
    expect((partial.events as unknown[]).length).toBe(1);
    // A cursor from a journal this Mac no longer has is answered with the whole chat.
    expect(await s.send(PHONE, { t: "catchup", chat: "buddy", cursor: { journal: "gone", seq: 1 } })).toMatchObject({ t: "chat" });
    // When the last phone stops watching, the journal closes, and an old cursor gets the whole chat again.
    s.server.left(PHONE);
    s.server.left(OTHER);
    expect(s.server.journal.isOpen("buddy")).toBe(false);
    expect(await s.send(PHONE, { t: "catchup", chat: "buddy", cursor: events[1]!.cursor })).toMatchObject({ t: "chat" });
  });
});

describe("the revision a phone was shown", () => {
  const changeAll = (s: Awaited<ReturnType<typeof setup>>) =>
    s.chats.update("buddy", (items) =>
      items.map((i) =>
        i.kind === "approval" && i.id === "req-1"
          ? { ...i, command: "line broadcast --to everyone --text 'Free gift'" }
          : i.kind === "approval" && i.id === "req-2"
            ? { ...i, title: "Refund every order" }
            : i.kind === "clarify" && i.id === "q-1"
              ? { ...i, question: "Which day should we refund everyone" }
              : i,
      ),
    );

  it("still binds after the phone left and came back: an ask that changed while it was away is refused at the revision it saw", async () => {
    const s = await setup();
    // Both phones leave (their streams closed), so no one watches; the asks change; the phone comes back and answers
    // what it was shown before, revision 1.
    s.server.left(PHONE);
    s.server.left(OTHER);
    changeAll(s);
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "refused", reason: "changed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-2", revision: 1, no: true })).toMatchObject({ t: "refused", reason: "changed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" })).toMatchObject({ t: "refused", reason: "changed" });
    // Opened again, it is shown revision 2, and that is what it can answer.
    const opened = await s.send(PHONE, { t: "open", chat: "buddy" });
    expect((opened.view as { asks: { id: string; revision: number }[] }).asks.find((a) => a.id === "req-1")?.revision).toBe(2);
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 2 })).toMatchObject({ t: "done" });
    expect(s.chats.done).toEqual([{ action: "allowOnce", chat: "buddy", ask: "req-1", by: PHONE }]);
  });

  it("still binds when the phone left between the challenge and its answer, and the ask changed meanwhile", async () => {
    const s = await setup();
    const away = () => {
      s.server.left(PHONE);
      s.server.left(OTHER);
      changeAll(s);
    };
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 }, { before: away })).toMatchObject({ reason: "changed" });
    const t = await setup();
    const awayToo = () => {
      t.server.left(PHONE);
      t.server.left(OTHER);
      changeAll(t);
    };
    expect(await t.answer(PHONE, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Friday" }, { before: awayToo })).toMatchObject({ reason: "changed" });
    expect([...s.chats.done, ...t.chats.done]).toEqual([]);
  });

  it("is refused for a revision this Mac never showed the phone: a chat it never opened, or a Mac started again", async () => {
    const s = await setup({ open: false });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "changed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" })).toMatchObject({ reason: "changed" });
    await s.send(PHONE, { t: "open", chat: "buddy" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "challenge" });
    // The other phone never opened the chat: what this one was shown counts for this one only.
    expect(await s.send(OTHER, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "changed" });
    // The Mac starts again (a new server, as after a relaunch), and the ask changed meanwhile: the phone's revision 1 is
    // not the new server's revision 1.
    const r = await setup();
    changeAll(r);
    r.restart();
    expect(await r.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "changed" });
    expect(await r.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" })).toMatchObject({ reason: "changed" });
    expect([...s.chats.done, ...r.chats.done]).toEqual([]);
  });

  it("is kept when nothing changed: a phone that left and came back answers the revision it saw", async () => {
    const s = await setup();
    s.server.left(PHONE);
    s.server.left(OTHER);
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "done" });
    expect(await s.answer(PHONE, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Friday" })).toMatchObject({ t: "done" });
  });
});

describe("levels (item 108b)", () => {
  const WATCH: Grant = { level: "watch", terminal: false, manage: false };
  const EVERYTHING: Grant = { level: "work", terminal: true, manage: true };
  /** The store actions that settle something on the Mac's behalf from a phone: an Allow or an answer. */
  const settled = (s: Awaited<ReturnType<typeof setup>>) => s.chats.done.filter((d) => d.action === "allowOnce" || d.action === "answer");

  it("serves the seven requests it served before and no more, each of them a request of the table", async () => {
    expect([...REQUESTS].sort()).toEqual(["allow", "catchup", "list", "notify", "open", "reply", "stop"]);
    for (const name of REQUESTS) expect(REQUEST_TABLE.has(name), name).toBe(true);
    // Every other name of the table is refused as before, at every level, until a later phase serves it.
    const s = await setup();
    for (const grant of [WATCH, DEFAULT_GRANT, EVERYTHING]) {
      s.levels.set(PHONE, grant);
      for (const name of [...REQUEST_TABLE.keys()].filter((n) => !(REQUESTS as readonly string[]).includes(n))) {
        expect(await s.send(PHONE, { t: name, chat: "buddy" }), `${grant.level} ${name}`).toMatchObject({ t: "refused", request: name, reason: "unknown_request" });
      }
    }
    expect(s.chats.done).toEqual([]);
  });

  it("lets a Watch phone list, open, catch up, say No, stop and give its push address", async () => {
    const asked: string[] = [];
    const s = await setup({ notify: (device) => (asked.push(device), null) });
    s.levels.set(PHONE, WATCH);
    expect(await s.send(PHONE, { t: "list" })).toMatchObject({ t: "chats" });
    const opened = await s.send(PHONE, { t: "open", chat: "buddy" });
    expect(opened).toMatchObject({ t: "chat", view: { chat: "buddy" } });
    expect(await s.send(PHONE, { t: "catchup", chat: "buddy", cursor: opened.cursor })).toMatchObject({ t: "events" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-2", revision: 1, no: true })).toMatchObject({ t: "done" });
    expect(await s.send(PHONE, { t: "stop", chat: "buddy" })).toMatchObject({ t: "done" });
    expect(await s.send(PHONE, { t: "notify", endpoint: null })).toMatchObject({ t: "done" });
    expect(s.chats.done).toEqual([
      { action: "decline", chat: "buddy", ask: "req-2", by: PHONE },
      { action: "stop", chat: "buddy" },
    ]);
    expect(asked).toEqual([PHONE]);
  });

  it("refuses a Watch phone Allow once and an answer, whole: no challenge, nothing settled", async () => {
    const s = await setup();
    s.levels.set(PHONE, WATCH);
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 })).toEqual({ t: "refused", id: expect.any(Number), request: "allow", reason: "level" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" })).toMatchObject({ t: "refused", request: "reply", reason: "level" });
    // Not as a No either: one that also carries an answer is an answer.
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, no: true, answer: "Friday" })).toMatchObject({ reason: "level" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-1", revision: 1, no: true, answers: { a: "yes" } })).toMatchObject({ reason: "level" });
    // A No to a question is no answer at all.
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, no: true })).toMatchObject({ reason: "malformed" });
    // A step two sent straight away, with a passkey answer, is refused before it is read.
    const madeUp = { challengeId: toBase64Url(new Uint8Array(32).fill(4)), credentialId: "AA", clientDataJSON: "AA", authenticatorData: "AA", signature: "AA" };
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1, option: "once", answer: madeUp })).toMatchObject({ reason: "level" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday", passkey: madeUp })).toMatchObject({ reason: "level" });
    // The whole two steps, as a phone would make them: refused at the first.
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "level" });
    expect(await s.answer(PHONE, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Friday" })).toMatchObject({ reason: "level" });
    expect(s.challenges.size).toBe(0);
    expect(s.chats.done).toEqual([]);
    // The other phone, still at Answer, is not held back by it.
    expect(await s.allow(OTHER, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "done" });
    expect(settled(s)).toEqual([{ action: "allowOnce", chat: "buddy", ask: "req-1", by: OTHER }]);
  });

  it("lets an Answer phone do exactly what a phone did before, and Work with every permission no more", async () => {
    for (const grant of [DEFAULT_GRANT, EVERYTHING]) {
      const s = await setup();
      s.levels.set(PHONE, grant);
      expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "done" });
      expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-2", revision: 1, no: true })).toMatchObject({ t: "done" });
      expect(await s.answer(PHONE, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Friday" })).toMatchObject({ t: "done" });
      expect(await s.send(PHONE, { t: "stop", chat: "buddy" })).toMatchObject({ t: "done" });
      expect(s.chats.done.map((d) => d.action), grant.level).toEqual(["allowOnce", "decline", "answer", "stop"]);
      for (const name of ["start", "send", "term_open", "update", "set_level", "always", "dial"]) {
        expect((await s.send(PHONE, { t: name, chat: "buddy" })).t, `${grant.level} ${name}`).toBe("refused");
      }
      expect(s.chats.done).toHaveLength(4);
    }
  });

  it("reads no level a request names: only the record's, by the channel's device id", async () => {
    const s = await setup();
    s.levels.set(PHONE, WATCH);
    for (const claim of [{ level: "answer" }, { level: "work", terminal: true, manage: true }, { grant: EVERYTHING }, { device: OTHER }, { deviceId: OTHER }]) {
      expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1, ...claim }), JSON.stringify(claim)).toMatchObject({ reason: "level" });
      expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday", ...claim }), JSON.stringify(claim)).toMatchObject({ reason: "level" });
    }
    // And a phone at Answer is not narrowed by naming Watch.
    expect(await s.send(OTHER, { t: "allow", chat: "buddy", ask: "req-1", revision: 1, level: "watch" })).toMatchObject({ t: "challenge" });
    expect(settled(s)).toEqual([]);
  });

  it("refuses everything to a phone whose record holds no level this Mac can read", async () => {
    const s = await setup();
    s.levels.delete(PHONE);
    for (const request of [{ t: "list" }, { t: "open", chat: "buddy" }, { t: "stop", chat: "buddy" }, { t: "reply", chat: "buddy", ask: "req-2", revision: 1, no: true }, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 }]) {
      expect(await s.send(PHONE, request), request.t).toMatchObject({ t: "refused", reason: "unknown_device" });
    }
    expect(s.challenges.size).toBe(0);
    expect(s.chats.done).toEqual([]);
  });

  it("refuses every name that stays on the machine at every level", async () => {
    const s = await setup();
    for (const grant of [WATCH, DEFAULT_GRANT, EVERYTHING]) {
      s.levels.set(PHONE, grant);
      for (const name of STAYS_ON_MACHINE) {
        expect(await s.send(PHONE, { t: name, chat: "buddy", ask: "req-1" }), `${grant.level} ${name}`).toMatchObject({ t: "refused", request: name, reason: "stays_on_mac" });
      }
    }
    expect(s.chats.done).toEqual([]);
  });

  it("applies a level at once to the phone's next request, a step two included", async () => {
    const s = await setup();
    const challenge = await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1 });
    expect(challenge).toMatchObject({ t: "challenge" });
    s.levels.set(PHONE, WATCH);
    const signed = await decisionChallenge(fromBase64Url(String(challenge.nonce)), { deviceId: PHONE, requestId: JSON.stringify(["buddy", "req-1"]), revision: 1, optionId: "once" });
    const passkey = await s.authenticators.get(PHONE)!.get(RP, signed);
    const answer = { challengeId: String(challenge.nonce), credentialId: toBase64Url(passkey.credentialId), clientDataJSON: toBase64Url(passkey.clientDataJSON), authenticatorData: toBase64Url(passkey.authenticatorData), signature: toBase64Url(passkey.signature) };
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "req-1", revision: 1, option: "once", answer })).toMatchObject({ reason: "level" });
    expect(s.chats.done).toEqual([]);
    // Given Answer again, it allows as before.
    s.levels.set(PHONE, DEFAULT_GRANT);
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ t: "done" });
  });

  it("acts on nothing once the phone was narrowed while its passkey answer was checked", async () => {
    const s = await setup();
    s.whenSeen(() => s.levels.set(PHONE, WATCH));
    expect(await s.allow(PHONE, { chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "level" });
    s.levels.set(PHONE, DEFAULT_GRANT);
    expect(await s.answer(PHONE, { chat: "buddy", ask: "q-1", revision: 1 }, { answer: "Friday" })).toMatchObject({ reason: "level" });
    expect(s.chats.done).toEqual([]);
  });
});
