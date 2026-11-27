// The typing bubble of a runtime that answers a message before its request ends (Connected's chat, `answersOnSend` in src/runtime):
// it shows while the person's message is on its way, and no turn is needed for it, so a refused message is only a message not sent.
import { describe, expect, it } from "vitest";
import { initialState, reduce, type AppState } from "../../state/store";
import { answeringOnSend, awaitingFirstToken } from "./Typing";

const T0 = 1_800_000_000_000;
const BOT = "buddy";
const sent = (s: AppState = initialState(), id = "local-1", over: { held?: true } = {}) =>
  reduce(s, { type: "local.user", bot: BOT, id, text: "How were sales today?", now: T0, ...over });
const chat = (s: AppState) => s.chats[BOT];

describe("a message on its way to a runtime that answers it before its request ends", () => {
  it("shows the member writing from the moment it goes, with no turn", () => {
    const s = sent();
    expect(chat(s)?.turn ?? null).toBeNull();
    expect(answeringOnSend(chat(s))).toBe(true);
    // the turn's own rule says nothing yet: no turn runs
    expect(awaitingFirstToken(chat(s))).toBe(false);
  });

  it("ends when the answer's turn starts, which shows the member writing by its own rule, and stays ended once the request is done", () => {
    let s = reduce(sent(), { type: "event", ev: { event: "turn.start", bot: BOT, since: T0 }, now: T0 + 6_000 });
    expect(answeringOnSend(chat(s))).toBe(false);
    expect(awaitingFirstToken(chat(s))).toBe(true);
    s = reduce(s, { type: "event", ev: { event: "message", bot: BOT, id: "c1/m2", text: "Sales were fine." }, now: T0 + 6_000 });
    s = reduce(s, { type: "event", ev: { event: "turn.end", bot: BOT, outcome: "done" }, now: T0 + 6_000 });
    s = reduce(s, { type: "send.ok", bot: BOT, id: "local-1", now: T0 + 6_001 });
    expect(answeringOnSend(chat(s))).toBe(false);
    expect(awaitingFirstToken(chat(s))).toBe(false);
  });

  it("ends when the message is refused: it is marked not sent, and nothing says a turn failed", () => {
    const s = reduce(sent(), { type: "send.failed", bot: BOT, id: "local-1", error: "Buddy takes at most 60 messages an hour." });
    expect(answeringOnSend(chat(s))).toBe(false);
    expect(chat(s)!.items.filter((i) => i.kind === "activity")).toEqual([]);
    expect(chat(s)!.items.at(-1)).toMatchObject({ kind: "user", error: "Buddy takes at most 60 messages an hour." });
  });

  it("is not said for a message the app holds back, which has not gone", () => {
    expect(answeringOnSend(chat(sent(initialState(), "local-1", { held: true })))).toBe(false);
  });

  it("is not said for a message read back from history, however the chat ends: only one that went in this run is on its way", () => {
    const s = reduce(initialState(), { type: "local.user", bot: BOT, id: "cht-1/m1", text: "An old question", now: T0 });
    expect(answeringOnSend(chat(s))).toBe(false);
  });

  it("is not said for a chat that is not there, or one with nothing in it", () => {
    expect(answeringOnSend(undefined)).toBe(false);
    expect(answeringOnSend(chat(reduce(sent(), { type: "send.ok", bot: BOT, id: "local-1", now: T0 + 5 })))).toBe(false);
  });
});
