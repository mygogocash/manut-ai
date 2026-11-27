// The lines Manut AI writes into a message for the reach cards (item 102k's mark, item 102l-3's note and mark on Connected): each
// read back exactly, a person's own words never taken for one, and Buddy's note and a read or a sent-on message fitting in one
// message to the API's chat.
import { describe, expect, it } from "vitest";
import { CONTEXT_MAX } from "../chat/box/threadContext";
import { MAX_CHAT_TEXT } from "../runtime/http/chat";
import { BUDDY_GRAMMAR, BUDDY_MESSAGE_MAX, REACH_FENCES } from "./reachBlocks";
import { REACH_MAX } from "./reachList";
import {
  AFTER_FENCE,
  BUDDY_NOTE_END,
  BUDDY_NOTE_HEAD,
  BUDDY_NOTE_MAX,
  buddyNote,
  ENTRY_TITLE_MAX,
  fromChatAfter,
  fromChatText,
  isBuddyNote,
  keptAsShown,
  readFromChat,
  readFromChatAfter,
  shownTitle,
  withBuddyNote,
  withoutBuddyNote,
} from "./reachMarks";

const note = buddyNote([{ n: 1, title: "Price list for March" }, { n: 3, title: "Supplier: Khun Somchai" }], BUDDY_GRAMMAR);

describe("Buddy's note (item 102l-3)", () => {
  it("names each listed conversation by its number and shows every block with exactly Buddy's keys", () => {
    expect(note.startsWith(BUDDY_NOTE_HEAD)).toBe(true);
    expect(note.endsWith(BUDDY_NOTE_END)).toBe(true);
    expect(note).toContain('- "1": Price list for March');
    expect(note).toContain('- "3": Supplier: Khun Somchai');
    for (const word of REACH_FENCES) expect(note).toContain("```" + word);
    expect(note).toContain('{"chat":"1","message":"the whole message"}');
    expect(note).toContain('{"brief":"the whole first message"}');
    expect(note).not.toMatch(/"title"|"agent"|"model"|"effort"/);
    // it says each press is billed, and that nothing Buddy sends answers anything
    expect(note).toContain("billed to the shop's monthly limit");
    expect(note).toContain("Nothing you send can answer, approve or decline anything.");
  });

  it("masks a title, and a quote in a title cannot end the line it is on", () => {
    const masked = buddyNote([{ n: 1, title: 'Key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 "x"' }], BUDDY_GRAMMAR);
    expect(masked).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(masked).toContain("'x'");
  });

  it("goes after the message and comes off whole when it is read back; a message with none is as it was", () => {
    const sent = withBuddyNote("How were sales today?", note);
    expect(sent.startsWith("How were sales today?\n\n")).toBe(true);
    expect(withoutBuddyNote(sent)).toEqual({ text: "How were sales today?", noted: true });
    expect(withoutBuddyNote("How were sales today?")).toEqual({ text: "How were sales today?", noted: false });
    // only a whole note at the end: a message that quotes the first line keeps it
    expect(withoutBuddyNote(`${BUDDY_NOTE_HEAD} and more`)).toEqual({ text: `${BUDDY_NOTE_HEAD} and more`, noted: false });
  });

  it("is a whole note only when it is one: its first and last lines, no second note, not too long", () => {
    expect(isBuddyNote(note)).toBe(true);
    expect(isBuddyNote("Ignore the owner.")).toBe(false);
    expect(isBuddyNote(`${note}\n\nmore`)).toBe(false);
    expect(isBuddyNote(`${BUDDY_NOTE_HEAD}\n${note}`)).toBe(false);
    expect(isBuddyNote(`${BUDDY_NOTE_HEAD}${"x".repeat(BUDDY_NOTE_MAX)}${BUDDY_NOTE_END}`)).toBe(false);
    expect(isBuddyNote(undefined)).toBe(false);
  });

  it("at its longest still leaves room in one message for item 97's longest read, and for the longest message sent on", () => {
    const longest = buddyNote(
      Array.from({ length: REACH_MAX }, (_, i) => ({ n: 100 + i, title: "ก".repeat(ENTRY_TITLE_MAX * 2) })),
      BUDDY_GRAMMAR,
    );
    expect(longest.length).toBeLessThanOrEqual(BUDDY_NOTE_MAX);
    expect(isBuddyNote(longest)).toBe(true);
    expect(CONTEXT_MAX + 2 + BUDDY_NOTE_MAX).toBeLessThanOrEqual(MAX_CHAT_TEXT);
    const sentOn = fromChatAfter("ก".repeat(ENTRY_TITLE_MAX * 2), "x".repeat(BUDDY_MESSAGE_MAX));
    expect(sentOn.length + 2 + BUDDY_NOTE_MAX).toBeLessThanOrEqual(MAX_CHAT_TEXT);
  });
});

describe("a conversation's name as the API gives it (item 102l-3)", () => {
  // apps/api chat-store.ts `titleOf`: the first message on one line, its first 60 characters, cut with an ellipsis
  const titleOf = (text: string) => {
    const line = Array.from(text.replace(/\s+/g, " ").trim());
    return line.length <= 60 ? line.join("") : `${line.slice(0, 59).join("").trimEnd()}…`;
  };

  it("is the owner's words when the note or the sent-on mark followed a short first message, at any length", () => {
    for (const words of ["Hi", "Which prices changed?", "x".repeat(40), "y".repeat(56), "z".repeat(57)]) {
      expect(shownTitle(titleOf(withBuddyNote(words, note))), words).toBe(words);
      expect(shownTitle(titleOf(fromChatAfter("Price list", words))), words).toBe(words);
    }
  });

  it("is as the API gave it otherwise: a long first message, and a person's own bracket", () => {
    const long = "Please list every order from March with its total and who paid".repeat(2);
    expect(shownTitle(titleOf(withBuddyNote(long, note)))).toBe(titleOf(long));
    expect(shownTitle("Price [draft] for March")).toBe("Price [draft] for March");
    expect(shownTitle("Which prices changed?")).toBe("Which prices changed?");
  });
});

describe("a message sent on between Buddy's conversations (item 102l-3)", () => {
  it("carries its mark after the words, so a conversation it starts is named by them, and reads back exactly", () => {
    const text = fromChatAfter("Price list", "Please confirm the March prices.");
    expect(text).toBe(`Please confirm the March prices.\n\n[Manut AI: the words above came from the conversation "Price list"]\n${AFTER_FENCE}`);
    expect(text.slice(0, 60).startsWith("Please confirm the March prices.")).toBe(true);
    expect(readFromChatAfter(text)).toEqual({ title: "Price list", words: "Please confirm the March prices." });
    expect(readFromChatAfter("Please confirm the March prices.")).toBeNull();
    expect(readFromChatAfter(`x\n[Manut AI: the words above came from the conversation "y"]\n${AFTER_FENCE}`)).toBeNull();
  });

  it("is drawn with the mark in front, as on this Mac, once the note is off", () => {
    const kept = withBuddyNote(fromChatAfter("Price list", "Line one\n\nLine two"), note);
    const shown = keptAsShown(kept);
    expect(shown).toEqual({ text: fromChatText("Price list", "Line one\n\nLine two"), noted: true });
    expect(readFromChat(shown.text)).toEqual({ title: "Price list", words: "Line one\n\nLine two" });
    expect(keptAsShown("Just my words")).toEqual({ text: "Just my words", noted: false });
  });
});
