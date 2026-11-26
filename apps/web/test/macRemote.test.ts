// The Your Mac tab's state (src/app/mac/remote.ts) against a Mac a test answers by hand: what each of the four
// answers sends and needs, the challenge checked against the screen before any prompt, catch-up by the journal's
// cursors, the greyed view and its 15 minutes, and Forget this Mac. The desktop's real Mac answers this same code through
// the real relay in apps/api/test/remote-phone.test.ts.
import { decisionChallenge, fromBase64Url, importSharedSecret, toBase64Url } from "@manut/remote-channel";
import { describe, expect, it } from "vitest";
import type { PairResult } from "../src/app/mac/pair";
import { PasskeyCancelled } from "../src/app/mac/passkeys";
import { answerOption } from "../src/app/mac/decision";
import { CLEAR_MS, MacRemote, type MacBackend, type MacView, noteFor } from "../src/app/mac/remote";
import type { MacLink, Message, SessionEnd } from "../src/app/mac/session";
import { memoryVault, type PairedMac } from "../src/app/mac/vault";
import type { ChatView } from "../src/app/mac/wire";
import { ManualClock, StandInPasskeys, settle } from "./macKit";

const DEVICE = "0B6A2C1E-4D5F-4A6B-8C7D-9E0F1A2B3C4D";

/// A Mac's session a test answers: every request it was sent, and an answer chosen by `answer`.
class FakeLink implements MacLink {
  readonly sent: Message[] = [];
  onEvent: ((message: Message) => void) | null = null;
  onEnd: ((end: SessionEnd) => void) | null = null;
  closed = false;
  answer: (message: Message) => Message | null | Promise<Message | null>;

  constructor(answer: (message: Message) => Message | null | Promise<Message | null>) {
    this.answer = answer;
  }

  async request(message: Message): Promise<Message | null> {
    if (this.closed) return null;
    this.sent.push(message);
    return this.answer(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onEnd?.({ why: "closed" });
  }

  /// The relay or the Mac ends the session.
  drop(why: SessionEnd["why"]): void {
    if (this.closed) return;
    this.closed = true;
    this.onEnd?.({ why } as SessionEnd);
  }

  push(chat: string, event: unknown, seq: number, journal = "j1"): void {
    this.onEvent?.({ t: "event", chat, event, cursor: { journal, seq } });
  }
}

const BUDDY: ChatView = {
  chat: "buddy",
  title: "Shop launch plan",
  state: "needs_you",
  step: "Reading the price list",
  messages: [{ id: "m1", role: "user", text: "Send the sale to everyone", ts: 1 }],
  asks: [
    { kind: "approval", id: "req-1", revision: 2, open: true, ts: 2, title: "Send a LINE broadcast", command: "line broadcast --to all", cwd: "/Users/owner/shop", offers: ["once", "deny"] },
    { kind: "question", id: "q-1", revision: 1, open: true, ts: 3, question: "Which day should the sale start", choices: ["Friday", "Saturday"] },
    { kind: "question", id: "q-2", revision: 1, open: true, ts: 4, question: "Two things", questions: [{ id: "a", question: "Which day" }, { id: "b", question: "Which time" }] },
  ],
};

/// The Mac as a test plays it: the list, one chat, and whatever else `more` answers.
function macAnswers(more: (message: Message) => Message | null = () => null) {
  return (message: Message): Message | null => {
    if (message.t === "list") return { t: "chats", chats: [{ chat: "buddy", title: BUDDY.title, state: "needs_you", updatedAt: 5 }, { chat: "kit", title: "Kit", state: "done", updatedAt: 1 }] };
    if (message.t === "open" || message.t === "catchup") return more(message) ?? { t: "chat", view: BUDDY, cursor: { journal: "j1", seq: 0 } };
    return more(message);
  };
}

async function setup(options: { relay?: "on" | "off" | "unknown"; paired?: boolean; answer?: (message: Message) => Message | null } = {}) {
  const clock = new ManualClock();
  const vault = memoryVault();
  const passkeys = new StandInPasskeys();
  const links: FakeLink[] = [];
  let refuseConnect: SessionEnd | null = null;
  const mac: PairedMac = {
    hostId: "H".repeat(43),
    deviceId: DEVICE,
    doorToken: new Uint8Array(32),
    k: await importSharedSecret(new Uint8Array(32).fill(7)),
    credentialId: passkeys.credentialId,
    rpId: "phone.manut.test",
    pairedAt: 0,
  };
  if (options.paired !== false) await vault.save(mac);
  const backend: MacBackend = {
    relay: async () => options.relay ?? "on",
    vault,
    passkeys,
    now: () => clock.now,
    timers: clock,
    pair: async (): Promise<PairResult> => ({ ok: true, mac }),
    connect: async () => {
      if (refuseConnect) return { ok: false, end: refuseConnect };
      const link = new FakeLink(options.answer ?? macAnswers());
      links.push(link);
      return { ok: true, link };
    },
  };
  const remote = new MacRemote(backend);
  return {
    remote,
    clock,
    vault,
    passkeys,
    links,
    mac,
    refuse: (end: SessionEnd | null) => (refuseConnect = end),
    link: () => links.at(-1)!,
  };
}

const paired = (view: MacView) => {
  if (view.phase !== "paired") throw new Error(`not paired: ${view.phase}`);
  return view;
};

async function openBuddy(remote: MacRemote): Promise<void> {
  await remote.start();
  await settle();
  await remote.openChat("buddy");
}

describe("opening the tab", () => {
  it("says not available while the relay is off or cannot be read, and asks for a code before pairing", async () => {
    for (const relay of ["off", "unknown"] as const) {
      const { remote, links } = await setup({ relay });
      await remote.start();
      expect(remote.view).toEqual({ phase: "unavailable" });
      expect(links).toEqual([]);
    }
    const { remote } = await setup({ paired: false });
    await remote.start();
    expect(remote.view).toEqual({ phase: "unpaired", failed: null });
  });

  it("opens a session for a paired phone and lists the chats as Working, Needs you or Done", async () => {
    const { remote, links } = await setup();
    await remote.start();
    await settle();
    expect(paired(remote.view)).toMatchObject({ link: "live", chats: [{ chat: "buddy", state: "needs_you" }, { chat: "kit", state: "done" }] });
    expect(links[0]!.sent).toEqual([{ t: "list" }]);
  });
});

describe("answering from the phone", () => {
  it("allows once only with a passkey over the Mac's challenge for exactly what the screen shows", async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const { remote, passkeys, link } = await setup({
      answer: macAnswers((m) => (m.t === "allow" && m.answer === undefined
        ? { t: "challenge", chat: "buddy", ask: "req-1", revision: 2, option: "once", nonce: toBase64Url(nonce), expiresAt: 0 }
        : m.t === "allow" ? { t: "done" } : null)),
    });
    await openBuddy(remote);
    await remote.allowOnce("req-1");
    await settle();
    const sent = link().sent.filter((m) => m.t === "allow");
    expect(sent[0]).toEqual({ t: "allow", chat: "buddy", ask: "req-1", revision: 2 });
    // The passkey signed the challenge the phone computed from its own screen: this device, this ask, revision 2, once.
    const expected = await decisionChallenge(nonce, { deviceId: DEVICE, requestId: JSON.stringify(["buddy", "req-1"]), revision: 2, optionId: "once" });
    expect(passkeys.signed).toEqual([{ rpId: "phone.manut.test", challenge: expected, credentialId: passkeys.credentialId }]);
    const answer = sent[1]!.answer as Record<string, string>;
    expect(sent[1]).toMatchObject({ t: "allow", chat: "buddy", ask: "req-1", revision: 2, option: "once" });
    expect(answer.challengeId).toBe(toBase64Url(nonce));
    expect(fromBase64Url(answer.signature!).length).toBeGreaterThan(60);
    expect(paired(remote.view).open!.asks.get("req-1")).toMatchObject({ busy: null, note: "allowed" });
  });

  it("opens no prompt for a challenge that names another ask, revision or choice", async () => {
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    for (const wrong of [
      { chat: "buddy", ask: "req-9", revision: 2, option: "once", nonce },
      { chat: "buddy", ask: "req-1", revision: 3, option: "once", nonce },
      { chat: "buddy", ask: "req-1", revision: 2, option: "always", nonce },
      { chat: "kit", ask: "req-1", revision: 2, option: "once", nonce },
      { chat: "buddy", ask: "req-1", revision: 2, option: "once", nonce: "short" },
    ]) {
      const { remote, passkeys, link } = await setup({ answer: macAnswers((m) => (m.t === "allow" ? { t: "challenge", ...wrong, expiresAt: 0 } : null)) });
      await openBuddy(remote);
      await remote.allowOnce("req-1");
      await settle();
      expect(passkeys.signed).toEqual([]);
      expect(link().sent.filter((m) => m.t === "allow").length).toBe(1);
      expect(paired(remote.view).open!.asks.get("req-1")?.note).toBe("no_answer");
    }
  });

  it("offers Confirm after the prompt was closed, and prompts again over the same challenge", async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const { remote, passkeys, link } = await setup({
      answer: macAnswers((m) => (m.t === "allow" && m.answer === undefined
        ? { t: "challenge", chat: "buddy", ask: "req-1", revision: 2, option: "once", nonce: toBase64Url(nonce), expiresAt: 0 }
        : m.t === "allow" ? { t: "done" } : null)),
    });
    await openBuddy(remote);
    passkeys.refuse.push(new PasskeyCancelled());
    await remote.allowOnce("req-1");
    await settle();
    const waiting = paired(remote.view).open!.asks.get("req-1")!;
    expect(waiting).toMatchObject({ busy: null, note: "confirm" });
    expect(link().sent.filter((m) => m.t === "allow").length).toBe(1);
    waiting.confirm!();
    await settle();
    expect(passkeys.signed.length).toBe(2);
    expect(passkeys.signed[1]!.challenge).toEqual(passkeys.signed[0]!.challenge);
    expect(paired(remote.view).open!.asks.get("req-1")).toMatchObject({ note: "allowed", confirm: null });
  });

  it("answers a question through the same challenge and passkey as Allow once when the Mac asks for one, bound to the exact answer", async () => {
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const option = await answerOption("Friday");
    const { remote, passkeys, link } = await setup({
      answer: macAnswers((m) => (m.t === "reply" && m.passkey === undefined
        ? { t: "challenge", chat: "buddy", ask: "q-1", revision: 1, option, nonce: toBase64Url(nonce), expiresAt: 0 }
        : m.t === "reply" ? { t: "done" } : null)),
    });
    await openBuddy(remote);
    await remote.answer("q-1", "Friday");
    await settle();
    const sent = link().sent.filter((m) => m.t === "reply");
    expect(sent[0]).toEqual({ t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" });
    const expected = await decisionChallenge(nonce, { deviceId: DEVICE, requestId: JSON.stringify(["buddy", "q-1"]), revision: 1, optionId: option });
    expect(passkeys.signed.map((x) => x.challenge)).toEqual([expected]);
    expect(sent[1]).toMatchObject({ t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday", passkey: { challengeId: toBase64Url(nonce) } });
    expect(paired(remote.view).open!.asks.get("q-1")?.note).toBe("answered");
    // A challenge bound to another answer than the one on the screen opens no prompt.
    const other = await setup({
      answer: macAnswers((m) => (m.t === "reply" ? { t: "challenge", chat: "buddy", ask: "q-1", revision: 1, option: option.replace(/^./, "x"), nonce: toBase64Url(nonce), expiresAt: 0 } : null)),
    });
    await openBuddy(other.remote);
    await other.remote.answer("q-1", "Saturday");
    await settle();
    expect(other.passkeys.signed).toEqual([]);
    expect(paired(other.remote.view).open!.asks.get("q-1")?.note).toBe("no_answer");
  });

  it("says No with no passkey, and sends answers and Stop as serve.ts reads them to a Mac that takes them at once", async () => {
    const { remote, passkeys, link } = await setup({ answer: macAnswers((m) => (m.t === "reply" || m.t === "stop" ? { t: "done" } : null)) });
    await openBuddy(remote);
    await remote.no("req-1");
    await remote.answer("q-1", "Friday");
    await remote.answer("q-2", { a: "Friday", b: null });
    // An interview takes answers per question, and a single question one text: the other shape sends nothing.
    await remote.answer("q-1", { a: "Friday" });
    await remote.stop();
    expect(link().sent.filter((m) => m.t !== "list" && m.t !== "open")).toEqual([
      { t: "reply", chat: "buddy", ask: "req-1", revision: 2, no: true },
      { t: "reply", chat: "buddy", ask: "q-1", revision: 1, answer: "Friday" },
      { t: "reply", chat: "buddy", ask: "q-2", revision: 1, answers: { a: "Friday", b: null } },
      { t: "stop", chat: "buddy" },
    ]);
    expect(passkeys.signed).toEqual([]);
    const open = paired(remote.view).open!;
    expect([open.asks.get("req-1")?.note, open.asks.get("q-1")?.note, open.asks.get("q-2")?.note, open.stopNote]).toEqual(["declined", "answered", "answered", "stopped"]);
  });

  it("says each of the Mac's refusals in the phone's own words", async () => {
    const { remote } = await setup({ answer: macAnswers((m) => (m.t === "reply" ? { t: "refused", request: "reply", reason: "changed" } : null)) });
    await openBuddy(remote);
    await remote.no("req-1");
    expect(paired(remote.view).open!.asks.get("req-1")?.note).toBe("changed");
    expect(["changed", "ask_closed", "no_ask", "stays_on_mac", "needs_update", "busy", "expired", "not_taken", "no_turn", "unknown_device", "malformed", "no_verification"].map(noteFor))
      .toEqual(["changed", "closed", "gone", "not_offered", "needs_update", "busy", "late", "not_taken", "no_turn", "forgotten", "no_answer", "passkey_refused"]);
  });
});

describe("staying current", () => {
  it("applies events in order, skips a repeat, and asks for what it missed after a gap", async () => {
    let caughtUp: Message | null = null;
    const { remote, link } = await setup({
      answer: macAnswers((m) => {
        if (m.t !== "catchup") return null;
        caughtUp = m;
        return { t: "events", chat: "buddy", events: [
          { event: { k: "message", message: { id: "m3", role: "assistant", text: "Third", ts: 3 } }, cursor: { journal: "j1", seq: 2 } },
          { event: { k: "message", message: { id: "m4", role: "assistant", text: "Fourth", ts: 4 } }, cursor: { journal: "j1", seq: 3 } },
        ] };
      }),
    });
    await openBuddy(remote);
    link().push("buddy", { k: "message", message: { id: "m2", role: "assistant", text: "Second", ts: 2 } }, 1);
    link().push("buddy", { k: "message", message: { id: "m2", role: "assistant", text: "Second, again", ts: 2 } }, 1);
    expect(paired(remote.view).open!.view.messages.map((m) => m.text)).toEqual(["Send the sale to everyone", "Second"]);
    // Number 3 before 2: the phone asks from the last number it holds.
    link().push("buddy", { k: "message", message: { id: "m4", role: "assistant", text: "Fourth", ts: 4 } }, 3);
    await settle();
    expect(caughtUp).toEqual({ t: "catchup", chat: "buddy", cursor: { journal: "j1", seq: 1 } });
    expect(paired(remote.view).open!.view.messages.map((m) => m.text)).toEqual(["Send the sale to everyone", "Second", "Third", "Fourth"]);
    // A state change moves the chat's row in the list too.
    link().push("buddy", { k: "state", state: "done", step: null, title: BUDDY.title }, 4);
    expect(paired(remote.view).open!.view.state).toBe("done");
    expect(paired(remote.view).chats!.find((r) => r.chat === "buddy")!.state).toBe("done");
  });

  it("greys on a drop with nothing to press, dials again, catches up with its cursor, and clears 15 minutes after the Mac last confirmed it", async () => {
    const { remote, clock, links, refuse } = await setup();
    await openBuddy(remote);
    const confirmedAt = paired(remote.view).confirmedAt;
    expect(confirmedAt).toBe(clock.now);
    links[0]!.drop("lost");
    expect(paired(remote.view)).toMatchObject({ link: "down", down: "lost", cleared: false });
    expect(paired(remote.view).open!.view.chat).toBe("buddy");
    // Greyed: nothing can be answered.
    await remote.allowOnce("req-1");
    await remote.no("req-1");
    expect(links[0]!.sent.filter((m) => m.t === "allow" || m.t === "reply")).toEqual([]);
    // It dials again after a second, and catches the open chat up from the cursor it held.
    clock.advance(1_000);
    await settle();
    expect(links.length).toBe(2);
    expect(links[1]!.sent.slice(0, 2)).toEqual([{ t: "catchup", chat: "buddy", cursor: { journal: "j1", seq: 0 } }, { t: "list" }]);
    expect(paired(remote.view).link).toBe("live");

    // The Mac goes away for good: the view stays greyed until 15 minutes after the Mac last confirmed it, then goes.
    refuse({ why: "mac_away", state: "offline" });
    links[1]!.drop("mac_away");
    const lastConfirmed = paired(remote.view).confirmedAt!;
    clock.advance(CLEAR_MS - (clock.now - lastConfirmed) - 1);
    await settle();
    expect(paired(remote.view)).toMatchObject({ cleared: false, link: "down" });
    expect(paired(remote.view).open).not.toBeNull();
    clock.advance(1);
    await settle();
    expect(paired(remote.view)).toMatchObject({ cleared: true, chats: null, open: null });

    // Back: the list is read again, and the view is current.
    refuse(null);
    remote.setVisible(true);
    await settle();
    expect(paired(remote.view)).toMatchObject({ link: "live", cleared: false, chats: [{ chat: "buddy" }, { chat: "kit" }] });
  });

  it("clears on coming back into view when the phone slept through the 15 minutes", async () => {
    const { remote, clock, links, refuse } = await setup();
    await openBuddy(remote);
    remote.setVisible(false);
    refuse({ why: "lost" });
    links[0]!.drop("lost");
    // The phone slept: no timer ran, but the clock moved.
    clock.now += CLEAR_MS + 1;
    remote.setVisible(true);
    expect(paired(remote.view)).toMatchObject({ cleared: true, open: null, chats: null });
  });

  it("says when the Mac no longer knows this phone, and keeps dialling only once a minute", async () => {
    const { remote, clock, links, refuse } = await setup();
    await remote.start();
    await settle();
    refuse({ why: "unknown_door" });
    links[0]!.drop("revoked");
    expect(paired(remote.view)).toMatchObject({ forgotten: true, link: "down" });
    expect(clock.pending()[0]).toBe(60_000);
  });
});

describe("Forget this Mac", () => {
  it("deletes the vault's record, closes the session and forgets what was shown", async () => {
    const { remote, vault, links } = await setup();
    await openBuddy(remote);
    expect(await remote.forget()).toBe(true);
    expect(await vault.load()).toBeNull();
    expect(links[0]!.closed).toBe(true);
    expect(remote.view).toEqual({ phase: "unpaired", failed: null });
  });
});
