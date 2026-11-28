// The question before a conversation with Buddy is removed (item 102l-6; docs/connected-chat.md, "What 102l-6 built"). Nothing is sent by
// asking, by Cancel, by Escape or by a press outside; the destructive button sends the removal once, with exactly the conversation the
// question named; a refusal keeps the question open with the runtime's words and a button that works again. Written without a DOM: the
// question is a small state machine over the store's `removeThread`, which these tests stand in for.
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../i18n";
import { RemoveAsk, type ConversationRef } from "./removeAsk";

afterEach(() => setLang("en"));

const PRICES: ConversationRef = { bot: "buddy", thread: "cht-000000001-abc-00000001", title: "Which prices changed?" };
const OTHER: ConversationRef = { bot: "buddy", thread: "cht-000000002-abc-00000002", title: "Plan next week's posts" };

/** A `removeThread` that records each call and answers by `how`: at once, with a refusal, or when the test says. */
function removal(how: "done" | { refused: string } | "wait" = "done") {
  const calls: [string, string][] = [];
  let release: () => void = () => undefined;
  const remove = (bot: string, thread: string): Promise<void> => {
    calls.push([bot, thread]);
    if (how === "done") return Promise.resolve();
    if (how === "wait") return new Promise<void>((done) => (release = done));
    return Promise.reject({ code: "refused", message: how.refused });
  };
  return { calls, remove, release: () => release() };
}

describe("asking to remove a conversation", () => {
  it("opens the question about that conversation and sends nothing", () => {
    const r = removal();
    const q = new RemoveAsk(r.remove);
    expect(q.get()).toEqual({ asked: null, busy: false, error: null });
    q.ask(PRICES);
    expect(q.get()).toEqual({ asked: PRICES, busy: false, error: null });
    expect(r.calls).toEqual([]);
  });

  it("is not replaced by a second Remove pressed elsewhere while the question is open", () => {
    const q = new RemoveAsk(removal().remove);
    q.ask(PRICES);
    q.ask(OTHER);
    expect(q.get().asked).toEqual(PRICES);
  });

  it("tells whoever listens when it opens and closes", () => {
    const q = new RemoveAsk(removal().remove);
    const seen: (string | null)[] = [];
    const off = q.subscribe(() => seen.push(q.get().asked?.thread ?? null));
    q.ask(PRICES);
    q.cancel();
    off();
    q.ask(OTHER);
    expect(seen).toEqual([PRICES.thread, null]);
  });
});

describe("Cancel, Escape and a press outside", () => {
  it("close the question and send nothing", async () => {
    const r = removal();
    const q = new RemoveAsk(r.remove);
    q.ask(PRICES);
    q.cancel();
    expect(q.get().asked).toBeNull();
    expect(r.calls).toEqual([]);
    // a press of the destructive button after it was cancelled does nothing either
    await q.confirm();
    expect(r.calls).toEqual([]);
  });

  it("do nothing while the removal is on its way, which a cancel could no longer stop", async () => {
    const r = removal("wait");
    const q = new RemoveAsk(r.remove);
    q.ask(PRICES);
    const pressed = q.confirm();
    q.cancel();
    expect(q.get()).toEqual({ asked: PRICES, busy: true, error: null });
    r.release();
    await pressed;
    expect(q.get().asked).toBeNull();
  });
});

describe("the destructive button", () => {
  it("sends the removal once, for exactly the conversation the question named, and ends the question", async () => {
    const r = removal();
    const q = new RemoveAsk(r.remove);
    q.ask(PRICES);
    await q.confirm();
    expect(r.calls).toEqual([["buddy", PRICES.thread]]);
    expect(q.get()).toEqual({ asked: null, busy: false, error: null });
  });

  it("sends nothing when no question is open", async () => {
    const r = removal();
    await new RemoveAsk(r.remove).confirm();
    expect(r.calls).toEqual([]);
  });

  it("is pressed once however often it is pressed while the removal is on its way", async () => {
    const r = removal("wait");
    const q = new RemoveAsk(r.remove);
    q.ask(PRICES);
    const first = q.confirm();
    await q.confirm();
    await q.confirm();
    expect(r.calls).toEqual([["buddy", PRICES.thread]]);
    expect(q.get().busy).toBe(true);
    r.release();
    await first;
    expect(r.calls).toHaveLength(1);
  });

  it("keeps the question open with the runtime's words when it was refused, the button working again, and removes nothing from the question", async () => {
    const r = removal({ refused: "This conversation is not there any more." });
    const q = new RemoveAsk(r.remove);
    q.ask(PRICES);
    await q.confirm();
    expect(q.get()).toEqual({ asked: PRICES, busy: false, error: "This conversation is not there any more." });
    // pressed again it is asked again, and the old reason goes while it is on its way
    const again = q.confirm();
    expect(q.get().error).toBeNull();
    await again;
    expect(r.calls).toHaveLength(2);
    // Cancel closes it, and the reason with it
    q.cancel();
    expect(q.get()).toEqual({ asked: null, busy: false, error: null });
  });

  it("says a failure that carries no words plainly, never as nothing", async () => {
    const q = new RemoveAsk(() => Promise.reject(new Error("")));
    q.ask(PRICES);
    await q.confirm();
    expect(q.get().error).toBe(t("rt.chat.removeRefused"));
    const named = new RemoveAsk(() => Promise.reject(new Error("The shop did not answer.")));
    named.ask(PRICES);
    await named.confirm();
    expect(named.get().error).toBe("The shop did not answer.");
  });
});
