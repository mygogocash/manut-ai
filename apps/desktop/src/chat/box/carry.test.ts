// The chat box's notes and carried context (item 97): the selection's caps and the form a note goes out in, the scope
// rule, reading a sent message back into its parts, and the chips kept across a restart and cleared by a send.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Bubble } from "../parts/Bubble";
import { CarriedChips } from "./BoxParts";
import { isNoteKey } from "./SelectionNote";
import {
  addCarried,
  bareText,
  carry,
  CARRY_KEY,
  chipWords,
  cutQuote,
  dropCarried,
  getCarried,
  goes,
  noteBlock,
  noteChip,
  NOTES_MAX,
  parseCarry,
  QUOTE_MAX,
  scopeRefusal,
  setCarried,
  setCarryStorage,
  splitSent,
  THREADS_MAX,
  withCarried,
  type Carried,
  type CarryStorage,
  type ThreadChip,
} from "./carry";

const SHOP = { shop: "baan-mali" };

class Mem implements CarryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const thread = (ref: string, scope = SHOP): ThreadChip => ({ kind: "thread", id: `t-${ref}`, ref, title: `Chat ${ref}`, text: `Context of ${ref}`, scope });

describe("a note on a selection", () => {
  it("quotes the selection whole up to the cap, line ends made plain", () => {
    expect(cutQuote("  first line\r\nsecond line  \n\n")).toEqual({ quote: "  first line\nsecond line", more: 0 });
    const exact = "x".repeat(QUOTE_MAX);
    expect(cutQuote(exact)).toEqual({ quote: exact, more: 0 });
  });

  it("cuts a longer selection at the cap with how much was left out, never silently", () => {
    const long = "y".repeat(QUOTE_MAX + 1234);
    const c = noteChip(long, "too long", SHOP, "n1")!;
    expect(c.quote).toHaveLength(QUOTE_MAX);
    expect(c.more).toBe(1234);
    const block = noteBlock(c);
    expect(block.split("\n").at(-2)).toBe("> (cut here: 1,234 more characters not sent)");
    expect(block.split("\n").at(-1)).toBe("Note: too long");
  });

  it("never cuts a character made of two code units in half", () => {
    const text = "a".repeat(QUOTE_MAX - 1) + "😀" + "b";
    const { quote, more } = cutQuote(text);
    expect(quote).toBe("a".repeat(QUOTE_MAX - 1));
    expect(more).toBe(3);
  });

  it("goes out as `>` lines, an empty line as `>` alone, and the note under it", () => {
    const c = noteChip("Pay by QR\n\nor cash", "  ask   about\nfees ", SHOP, "n1")!;
    expect(c.note).toBe("ask about fees");
    expect(noteBlock(c)).toBe("> Pay by QR\n>\n> or cash\nNote: ask about fees");
    expect(noteBlock({ quote: "only this", more: 0, note: "" })).toBe("> only this");
  });

  it("has nothing to quote in an empty selection", () => {
    expect(noteChip(" \n ", "note", SHOP)).toBeNull();
  });

  it("says what it is on its chip: the first words, then the note", () => {
    expect(chipWords(noteChip("The PromptPay QR goes on the receipt and the order page", "keep it", SHOP)!)).toBe("“The PromptPay QR goes on the…” · keep it");
    expect(chipWords(noteChip("Short", "", SHOP)!)).toBe("“Short”");
  });
});

describe("the caps a message holds", () => {
  it("takes at most eight notes, and says so for a ninth", () => {
    let list: Carried[] = [];
    for (let i = 0; i < NOTES_MAX; i++) list = addCarried(list, noteChip(`q${i}`, "", SHOP, `n${i}`)!).list;
    expect(list).toHaveLength(8);
    const r = addCarried(list, noteChip("ninth", "", SHOP)!);
    expect(r.refused).toBe("notes");
    expect(r.list).toHaveLength(8);
  });

  it("takes each chat once, and at most three chats", () => {
    let list: Carried[] = [];
    for (let i = 0; i < THREADS_MAX; i++) list = addCarried(list, thread(String(i))).list;
    expect(addCarried(list, thread("0")).refused).toBe("same");
    expect(addCarried(list, thread("9")).refused).toBe("threads");
    // notes still fit beside three chats
    expect(addCarried(list, noteChip("q", "", SHOP)!).refused).toBeNull();
  });
});

describe("the shop and account a chip belongs to", () => {
  it("refuses another shop, and another account of the same agent", () => {
    expect(scopeRefusal({ shop: "a" }, { shop: "b" })).toBe("shop");
    expect(scopeRefusal({ shop: "a" }, { shop: "a" })).toBeNull();
    expect(scopeRefusal({ account: "claude:work" }, { account: "claude:home" })).toBe("account");
    expect(scopeRefusal({ account: "claude:work" }, { account: "claude:work" })).toBeNull();
  });

  it("does not compare what a side does not name, nor accounts of two agents", () => {
    expect(scopeRefusal({ account: "claude:work" }, { shop: "a" })).toBeNull();
    expect(scopeRefusal({ shop: "a" }, {})).toBeNull();
    expect(scopeRefusal({ account: "claude:work" }, { account: "codex:default" })).toBeNull();
  });

  it("sends only what may go to this chat, and leaves out the rest", () => {
    const mine = noteChip("ours", "yes", SHOP, "n1")!;
    const theirs = noteChip("theirs", "no", { shop: "other" }, "n2")!;
    const sent = withCarried("  Can you check this?  ", [mine, theirs, thread("x")], SHOP);
    expect(sent).toBe("> ours\nNote: yes\n\nContext of x\n\nCan you check this?");
    expect(goes([mine, theirs], SHOP)).toEqual([mine]);
    // only chips, nothing typed
    expect(withCarried("", [mine], SHOP)).toBe("> ours\nNote: yes");
  });
});

describe("a sent message read back", () => {
  it("finds the notes in front, and what was typed after them", () => {
    const text = withCarried("What do you think?\n\nSecond paragraph", [noteChip("Line one\nline two", "check", SHOP)!, noteChip("Another", "", SHOP)!], SHOP);
    expect(splitSent(text)).toEqual({
      quotes: [
        { quote: "Line one\nline two", note: "check" },
        { quote: "Another", note: "" },
      ],
      contexts: [],
      rest: "What do you think?\n\nSecond paragraph",
    });
    expect(bareText(text)).toBe("What do you think?\n\nSecond paragraph");
  });

  it("finds a chat's context by its first line", () => {
    const block = 'Context from the chat "PromptPay":\nThe app copied this.\nTitle: PromptPay\nEnd of the context from "PromptPay".';
    const r = splitSent(`${block}\n\nGo on from here`);
    expect(r.contexts).toEqual([{ title: "PromptPay", body: 'The app copied this.\nTitle: PromptPay\nEnd of the context from "PromptPay".' }]);
    expect(r.rest).toBe("Go on from here");
  });

  it("leaves a message that starts with the person's own text as it is", () => {
    const text = "> a quote typed by hand\nand two lines after\nit";
    expect(splitSent(text)).toEqual({ quotes: [], contexts: [], rest: text });
    expect(splitSent("Plain message").rest).toBe("Plain message");
  });
});

describe("kept by chat", () => {
  let mem: Mem;
  beforeEach(() => {
    mem = new Mem();
    setCarryStorage(mem);
  });

  it("keeps a chat's notes across a restart, and reads back only what it can", () => {
    expect(carry("agent:s3", noteChip("keep me", "and this", SHOP, "n1")!)).toBeNull();
    // a restart reads storage again
    setCarryStorage(mem);
    expect(getCarried("agent:s3")).toEqual([{ kind: "note", id: "n1", quote: "keep me", more: 0, note: "and this", scope: SHOP }]);
    const raw = JSON.parse(mem.getItem(CARRY_KEY)!);
    raw["agent:s3"].push({ kind: "note", id: "bad" }, { kind: "thread", id: "t", ref: "r", title: "T", text: "", scope: SHOP }, "junk");
    raw["other"] = "not a list";
    expect(parseCarry(JSON.stringify(raw))).toEqual({ "agent:s3": getCarried("agent:s3") });
    expect(parseCarry("{not json")).toEqual({});
  });

  it("holds the caps on what it reads back", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ kind: "note", id: `n${i}`, quote: `q${i}`, more: 0, note: "", scope: SHOP }));
    expect(parseCarry(JSON.stringify({ buddy: many })).buddy).toHaveLength(NOTES_MAX);
  });

  it("forgets a chip removed, and the chat once a send cleared it", () => {
    carry("buddy", noteChip("one", "", SHOP, "n1")!);
    carry("buddy", noteChip("two", "", SHOP, "n2")!);
    dropCarried("buddy", "n1");
    expect(getCarried("buddy").map((c) => c.id)).toEqual(["n2"]);
    setCarried("buddy", []);
    setCarryStorage(mem);
    expect(getCarried("buddy")).toEqual([]);
    expect(JSON.parse(mem.getItem(CARRY_KEY)!)).toEqual({});
  });

  it("says why a chip was not added, and keeps the list as it was", () => {
    for (let i = 0; i < NOTES_MAX; i++) carry("buddy", noteChip(`q${i}`, "", SHOP, `n${i}`)!);
    expect(carry("buddy", noteChip("ninth", "", SHOP)!)).toBe("notes");
    expect(getCarried("buddy")).toHaveLength(NOTES_MAX);
  });
});

describe("drawn", () => {
  const key = (over: Partial<{ key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) => ({ key: "N", code: "KeyN", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, ...over });

  it("opens a note from the keyboard with Cmd+Shift+N on a Mac and Ctrl+Shift+N elsewhere, by where the key stands", () => {
    expect(isNoteKey(key({ metaKey: true }), true)).toBe(true);
    expect(isNoteKey(key({ ctrlKey: true }), false)).toBe(true);
    expect(isNoteKey(key({ ctrlKey: true }), true)).toBe(false);
    expect(isNoteKey(key({ metaKey: true, shiftKey: false }), true)).toBe(false);
    // a Korean layout prints another letter on the same key
    expect(isNoteKey(key({ metaKey: true, key: "ㅜ" }), true)).toBe(true);
  });

  it("draws a chip for each note and chat, a refused one red with why, each with its x", () => {
    const html = renderToString(createElement(CarriedChips, { chatKey: "buddy", scope: SHOP, list: [noteChip("Pay by QR", "ask", SHOP, "n1")!, noteChip("Elsewhere", "", { shop: "other" }, "n2")!, thread("x")] }));
    expect(html.match(/data-testid="carry-chip"/g)).toHaveLength(3);
    expect(html).toContain("“Pay by QR” · ask");
    expect(html).toContain('data-refused="true"');
    expect(html).toContain("Made in another shop, so it will not be sent here");
    expect(html.match(/data-testid="carry-remove"/g)).toHaveLength(3);
    // a chat's context opens to show its text; nothing is open at first
    expect(html).toContain('data-testid="carry-open"');
    expect(html).not.toContain('data-testid="carry-panel"');
  });

  it("draws a sent note in the person's own bubble as their quote, with their note under it", () => {
    const text = withCarried("Is this right?", [noteChip("The fee is 2%", "check the fee", SHOP)!], SHOP);
    const html = renderToString(createElement(Bubble, { item: { kind: "user", text } }));
    expect(html).toContain('data-testid="bubble-user"');
    expect(html).toContain('data-testid="bubble-carry"');
    expect(html).toContain("The fee is 2%");
    expect(html).toContain("check the fee");
    expect(html).toContain("Is this right?");
    expect(html).not.toContain("&gt; The fee");
  });
});
