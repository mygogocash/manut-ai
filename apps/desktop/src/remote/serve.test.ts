// serve.ts, the only code that turns a phone's request into something the Mac does: the six requests each reach the
// right store action and nothing else, everything else is refused by name, and an Allow reaches the store only through a
// one-use challenge the phone's passkey answered for that device, that ask, the revision it saw and Allow once.
import { DecisionChallenges, type StoredPasskey, decisionChallenge, fromBase64Url, toBase64Url, verifyPasskeyRegistration } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import type { SourceApproval } from "./project";
import { Server, STAYS_ON_MAC } from "./serve";
import { FakeChats } from "./testkit/chats";
import { RP } from "./testkit/harness";
import { TestAuthenticator } from "./testkit/phone";

const PHONE = "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F";
const OTHER = "E621E1F8-C36C-495A-93FC-0C247A3E6E5F";
const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

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

async function setup() {
  const chats = new FakeChats();
  chats.update("buddy", (items) => [...items, secondApproval]);
  const authenticators = new Map([
    [PHONE, new TestAuthenticator(0xa1)],
    [OTHER, new TestAuthenticator(0xb2)],
  ]);
  const passkeys = new Map<string, StoredPasskey>();
  for (const [id, a] of authenticators) passkeys.set(id, await stored(a));
  const paired = new Set([PHONE, OTHER]);
  const pushed: { device: string; message: Record<string, unknown> }[] = [];
  let now = 1_800_000_000_000;
  let onSeen: (() => void) | null = null;
  const challenges = new DecisionChallenges();
  const server = new Server({
    chats,
    actions: chats.actions,
    challenges,
    phones: {
      has: (id) => paired.has(id),
      passkey: (id) => passkeys.get(id),
      seen: async (id, _at, signCount) => {
        onSeen?.();
        const known = passkeys.get(id);
        if (known && signCount !== undefined) passkeys.set(id, { ...known, signCount });
      },
    },
    rp: RP,
    now: () => now,
    push: (device, message) => pushed.push({ device, message }),
  });
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
  return {
    chats,
    server,
    challenges,
    paired,
    pushed,
    send,
    allow,
    authenticators,
    advance: (ms: number) => (now += ms),
    whenSeen: (run: () => void) => (onSeen = run),
  };
}

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
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" })).toMatchObject({ t: "done" });
    expect(s.chats.done.at(-1)).toEqual({ action: "answer", chat: "buddy", ask: "q-1", by: PHONE, answer: "Friday" });
    expect(await s.send(PHONE, { t: "stop", chat: "buddy" })).toMatchObject({ t: "done" });
    expect(s.chats.done.at(-1)).toEqual({ action: "stop", chat: "buddy" });
    expect(s.chats.done).toHaveLength(4);
  });

  it("refuses everything else by name, and does nothing for it", async () => {
    const s = await setup();
    for (const name of STAYS_ON_MAC) {
      expect(await s.send(PHONE, { t: name, chat: "buddy", ask: "req-1" })).toMatchObject({ t: "refused", request: name, reason: "stays_on_mac" });
    }
    for (const name of ["send", "mode", "diff", "files", "delete", "push", "__proto__", "constructor", "toString", "LIST"]) {
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
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "old", revision: 1 })).toMatchObject({ reason: "needs_update" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "old", revision: 1, no: true })).toMatchObject({ reason: "needs_update" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "shut", revision: 1 })).toMatchObject({ reason: "ask_closed" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "only-no", revision: 1 })).toMatchObject({ reason: "not_offered" });
    expect(await s.send(PHONE, { t: "allow", chat: "buddy", ask: "q-1", revision: 1 })).toMatchObject({ reason: "no_ask" });
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

describe("No, answers and Stop", () => {
  it("need no challenge, but check the ask, the revision and the answer's shape", async () => {
    const s = await setup();
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-1", revision: 1 })).toMatchObject({ reason: "malformed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "req-1", revision: 2, no: true })).toMatchObject({ reason: "changed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "" })).toMatchObject({ reason: "malformed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "x".repeat(8_001) })).toMatchObject({ reason: "malformed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: 4 })).toMatchObject({ reason: "malformed" });
    // An interview takes an answer, or null, for exactly each of its questions.
    s.chats.update("buddy", (items) => [
      ...items,
      { kind: "clarify", id: "q-2", ts: 1, open: true, question: "Two things", questions: [{ id: "a", question: "First" }, { id: "b", question: "Second" }] },
    ]);
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-2", revision: 1, answers: { a: "yes" } })).toMatchObject({ reason: "malformed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-2", revision: 1, answers: { a: "yes", c: "no" } })).toMatchObject({ reason: "malformed" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-2", revision: 1, answers: { a: "yes", b: null } })).toMatchObject({ t: "done" });
    expect(await s.send(PHONE, { t: "reply", chat: "buddy", ask: "q-2", revision: 1, answers: { a: "yes", b: null } })).toMatchObject({ reason: "ask_closed" });
    expect(await s.send(PHONE, { t: "stop", chat: "kit" })).toMatchObject({ reason: "no_turn" });
    expect(s.chats.done).toEqual([{ action: "answer", chat: "buddy", ask: "q-2", by: PHONE, answer: { a: "yes", b: null } }]);
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
