// Show older in a conversation (item 102l-6): what the store holds of it. A conversation read says where older messages start (the
// cursor `thread.older` reads from); a page of older ones goes above everything the chat holds, in order, without a message it already
// has; the last page ends it; and a chat read again shows its newest page and says its own cursor.
import { describe, expect, it } from "vitest";
import type { ChatOpenResult } from "../lib/protocol";
import { initialState, reduce, type AppState } from "./store";

const T0 = 1_800_000_000_000;
const KEY = "fold:buddy:cht-1";
/** A message of conversation cht-1, number `n`: odd are the owner's, even are Buddy's. */
const m = (n: number) => ({ id: `cht-1/m${n}`, role: n % 2 ? ("user" as const) : ("assistant" as const), text: `${n % 2 ? "Question" : "Answer"} ${Math.ceil(n / 2)}`, ts: T0 / 1000 + n });
const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => m(from + i));
const read = (messages: ChatOpenResult["messages"], older?: string): ChatOpenResult => ({ session_id: "cht-1", messages, running: false, model: "", provider: "", reasoning: "", ...(older ? { older } : {}) });
const open = (s: AppState, res: ChatOpenResult) => reduce(s, { type: "chat.opened", bot: KEY, res, now: T0 });
const ids = (s: AppState) => s.chats[KEY].items.map((i) => i.id);

describe("a conversation that says it has older messages", () => {
  it("holds the cursor beside its newest page", () => {
    const s = open(initialState(), read(span(5, 8), "m5"));
    expect(ids(s)).toEqual(["cht-1/m5", "cht-1/m6", "cht-1/m7", "cht-1/m8"]);
    expect(s.chats[KEY].older).toBe("m5");
  });

  it("holds none when it says none, and none for a chat that is given whole", () => {
    expect(open(initialState(), read(span(1, 4))).chats[KEY].older).toBeUndefined();
    expect("older" in open(initialState(), read(span(1, 4))).chats[KEY]).toBe(false);
  });

  it("takes the cursor of a read made later, or none: a chat read again shows its newest page, without the older rows put above it", () => {
    let s = open(initialState(), read(span(5, 8), "m5"));
    s = reduce(s, { type: "chat.older", bot: KEY, messages: span(1, 4), older: null });
    expect(ids(s)).toHaveLength(8);
    s = open(s, read(span(5, 8), "m5"));
    expect(ids(s)).toEqual(["cht-1/m5", "cht-1/m6", "cht-1/m7", "cht-1/m8"]);
    expect(s.chats[KEY].older).toBe("m5");
    expect("older" in open(s, read(span(5, 8))).chats[KEY]).toBe(false);
  });
});

describe("a page of older messages", () => {
  it("goes above everything the chat holds, oldest first, and says where the page before it starts", () => {
    let s = open(initialState(), read(span(7, 10), "m7"));
    s = reduce(s, { type: "chat.older", bot: KEY, messages: span(3, 6), older: "m3" });
    expect(ids(s)).toEqual(span(3, 10).map((x) => x.id));
    expect(s.chats[KEY].older).toBe("m3");
    expect(s.chats[KEY].messages.map((x) => x.id)).toEqual(span(3, 10).map((x) => x.id));
    expect(s.chats[KEY].items[0]).toMatchObject({ kind: "user", id: "cht-1/m3", text: "Question 2", ts: T0 / 1000 + 3 });
    expect(s.chats[KEY].items[1]).toMatchObject({ kind: "assistant", id: "cht-1/m4", text: "Answer 2" });
  });

  it("ends the cursor when it reaches the first message", () => {
    let s = open(initialState(), read(span(3, 6), "m3"));
    s = reduce(s, { type: "chat.older", bot: KEY, messages: span(1, 2), older: null });
    expect(ids(s)).toEqual(span(1, 6).map((x) => x.id));
    expect("older" in s.chats[KEY]).toBe(false);
  });

  it("leaves out a message the chat already holds, so two presses that read the same page add it once", () => {
    let s = open(initialState(), read(span(7, 10), "m7"));
    s = reduce(s, { type: "chat.older", bot: KEY, messages: span(3, 6), older: "m3" });
    s = reduce(s, { type: "chat.older", bot: KEY, messages: span(3, 6), older: "m3" });
    expect(ids(s)).toEqual(span(3, 10).map((x) => x.id));
  });

  it("keeps the rows that are not messages where they were, below the older ones", () => {
    let s = open(initialState(), read(span(7, 10), "m7"));
    s = reduce(s, { type: "system.note", bot: KEY, text: "Reconnected", now: T0 + 1000 });
    s = reduce(s, { type: "chat.older", bot: KEY, messages: span(5, 6), older: "m5" });
    expect(s.chats[KEY].items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "system"]);
  });

  it("brings no chat back when it lands after its chat was removed", () => {
    let s = open(initialState(), read(span(7, 10), "m7"));
    s = reduce(s, { type: "thread.gone", bot: "buddy", thread: "cht-1" });
    expect(s.chats[KEY]).toBeUndefined();
    s = reduce(s, { type: "chat.older", bot: KEY, messages: span(3, 6), older: "m3" });
    expect(s.chats[KEY]).toBeUndefined();
  });
});
