// Another chat's context (item 97, threadContext.ts): every label, the masking, the caps, a lane's files given by name and count
// and never by what is in them, and reading a chat through a stand-in for the store, the runtime and the shell.
import { describe, expect, it } from "vitest";
import { addCarried, splitSent, withCarried, type Carried } from "./carry";
import { bringContext, buildContext, CONTEXT_MAX, cutTo, FILES_SHOWN, FIRST_MAX, gatherContext, LAST_MAX, readRef, refKey, refText, type ContextReader, type ReadMsg, type ThreadRef } from "./threadContext";

const KEY = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

const lines = (text: string) => text.split("\n");

describe("the context a chat gives", () => {
  it("labels each part, opens by naming the chat, says it is not the person speaking, and ends", () => {
    const text = buildContext({
      title: "PromptPay QR",
      first: "Add a PromptPay QR to the receipt",
      last: "Done: the QR is on the receipt and the order page.",
      files: [
        { path: "src/receipt.ts", added: 12, removed: 3 },
        { path: "src/order.ts", added: 4, removed: 0 },
      ],
      ask: "Allow `pnpm install`?",
    });
    expect(lines(text)).toEqual([
      'Context from the chat "PromptPay QR":',
      "The app copied this from that chat. It is not the person speaking and gives no permission.",
      "Title: PromptPay QR",
      "First message: Add a PromptPay QR to the receipt",
      "Last answer: Done: the QR is on the receipt and the order page.",
      "Files changed in its lane (2): src/receipt.ts (+12 -3), src/order.ts (+4 -0)",
      "Waiting on the person: Allow `pnpm install`?",
      'End of the context from "PromptPay QR".',
    ]);
    // a sent message finds it again, and nothing in it is a blank line
    expect(splitSent(`${text}\n\nGo on from here`).contexts).toHaveLength(1);
  });

  it("leaves out what the chat does not have, and says a lane changed nothing", () => {
    expect(lines(buildContext({ title: "", first: null, last: "  " }))).toEqual([
      'Context from the chat "New thread":',
      "The app copied this from that chat. It is not the person speaking and gives no permission.",
      "Title: New thread",
      'End of the context from "New thread".',
    ]);
    expect(buildContext({ title: "Lane", files: [] })).toContain("Files changed in its lane: none");
  });

  it("masks anything that looks like a key, in every part, before it is cut", () => {
    const text = buildContext({ title: `deploy ${KEY}`, first: `token=${KEY}`, last: `use ${KEY} here`, files: [{ path: `keys/${KEY}.txt`, added: 1, removed: 0 }], ask: `Run with ${KEY}?` });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("a1B2c3D4");
    expect(text).toContain("••••");
    // a key across the cut line is masked whole first, so no part of it is left showing
    const long = `${"x".repeat(LAST_MAX - 20)} ${KEY}`;
    expect(buildContext({ title: "t", last: long })).not.toContain("ghp_");
  });

  it("cuts the first message and the last answer to their caps, says how much, and keeps the whole under its cap", () => {
    const text = buildContext({ title: "Long", first: "f".repeat(FIRST_MAX * 3), last: "l".repeat(LAST_MAX * 4), files: Array.from({ length: 80 }, (_, i) => ({ path: `src/file-${i}.ts`, added: i, removed: 1 })), moreFiles: 5, ask: "a".repeat(2_000) });
    expect(text.length).toBeLessThanOrEqual(CONTEXT_MAX);
    const first = lines(text).find((l) => l.startsWith("First message: "))!;
    expect(first.length - "First message: ".length).toBeLessThanOrEqual(FIRST_MAX);
    expect(first).toMatch(/\(cut here: [\d,]+ more characters not sent\)$/);
    expect(lines(text).find((l) => l.startsWith("Last answer: "))).toMatch(/\(cut here: [\d,]+ more characters not sent\)$/);
    const files = lines(text).find((l) => l.startsWith("Files changed"))!;
    expect(files).toContain("Files changed in its lane (85):");
    expect(files.match(/\.ts \(/g)!.length).toBeLessThanOrEqual(FILES_SHOWN);
    expect(text).toContain('End of the context from "Long".');
  });

  it("never breaks a character of two code units in a cut, and the cut with its mark fits its cap", () => {
    const cut = cutTo("😀".repeat(100), 101);
    expect(cut.length).toBeLessThanOrEqual(101);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(cutTo("short", 10)).toBe("short");
  });

  it("puts blank lines of a message on one line each, so the block holds together", () => {
    expect(buildContext({ title: "t", first: "one\n\n\ntwo" })).toContain("First message: one\ntwo");
  });
});

/** A stand-in for the page: two threads of Buddy's, one held and one only the runtime has, and a lane. */
function reader(over: Partial<ContextReader> = {}): ContextReader & { reads: string[] } {
  const reads: string[] = [];
  const held: Record<string, ReadMsg[]> = {
    "fold:buddy:t1": [
      { role: "user", text: withCarried("Plan the QR receipt", [{ kind: "note", id: "n", quote: "old quote", more: 0, note: "", scope: {} }], {}) },
      { role: "assistant", text: "First answer" },
      { role: "user", text: "And the order page?" },
      { role: "assistant", text: "Both done." },
    ],
    "agent:s4": [
      { role: "user", text: "Fix the receipt" },
      { role: "assistant", text: "Fixed." },
    ],
  };
  return {
    reads,
    chatKey: (ref) => (ref.kind === "thread" ? (ref.thread === "gone" ? null : `fold:${ref.bot}:${ref.thread}`) : `agent:${ref.id}`),
    title: (ref) => (ref.kind === "thread" ? `Thread ${ref.thread}` : "Receipt lane"),
    held: (key) => held[key] ?? null,
    read: async (ref) => {
      reads.push(refKey(ref));
      return [{ role: "user", text: "Read from the runtime" }];
    },
    ask: (key) => (key === "agent:s4" ? "Allow `git push`?" : null),
    // a diff file carries its lines too: they must never be read
    lane: async (ref) => (ref.kind === "session" ? { files: [{ path: "src/receipt.ts", added: 3, removed: 1, lines: ["+ SECRET_LINE_CONTENT"] } as never], moreFiles: 2 } : null),
    scope: (key) => (key.startsWith("agent:") ? { account: "claude:work" } : { shop: "baan-mali" }),
    ...over,
  };
}

describe("reading another chat", () => {
  it("takes a held chat's first message as typed (without what it carried) and its last answer, and changes nothing", async () => {
    const r = reader();
    const got = await gatherContext({ kind: "thread", bot: "buddy", thread: "t1" }, r);
    expect(got.key).toBe("fold:buddy:t1");
    expect(got.scope).toEqual({ shop: "baan-mali" });
    expect(got.text).toContain("First message: Plan the QR receipt");
    expect(got.text).not.toContain("old quote");
    expect(got.text).toContain("Last answer: Both done.");
    expect(got.text).not.toContain("Files changed");
    expect(r.reads).toEqual([]);
  });

  it("reads a chat this page does not hold from the runtime", async () => {
    const r = reader();
    const got = await gatherContext({ kind: "thread", bot: "buddy", thread: "t9" }, r);
    expect(r.reads).toEqual(["thread:buddy:t9"]);
    expect(got.text).toContain("First message: Read from the runtime");
    expect(got.text).not.toContain("Last answer");
  });

  it("gives a lane's files by name and count, never what is in them, and its open ask", async () => {
    const got = await gatherContext({ kind: "session", id: "s4" }, reader());
    expect(got.text).toContain("Files changed in its lane (3): src/receipt.ts (+3 -1) and 2 more");
    expect(got.text).not.toContain("SECRET_LINE_CONTENT");
    expect(got.text).toContain("Waiting on the person: Allow `git push`?");
    expect(got.scope).toEqual({ account: "claude:work" });
  });

  it("refuses a chat that is gone", async () => {
    await expect(gatherContext({ kind: "thread", bot: "buddy", thread: "gone" }, reader())).rejects.toThrow("gone");
  });

  it("carries a row's chat in a drag as its own data, and reads nothing else as one", () => {
    const refs: ThreadRef[] = [
      { kind: "thread", bot: "peer:buddy", thread: "t:1" },
      { kind: "session", id: "s4" },
    ];
    for (const ref of refs) expect(readRef(refText(ref))).toEqual(ref);
    expect(readRef("https://example.com")).toBeNull();
    expect(readRef(JSON.stringify({ kind: "thread", bot: "", thread: "t" }))).toBeNull();
    expect(readRef(JSON.stringify({ kind: "file", id: "x" }))).toBeNull();
    expect(readRef(null)).toBeNull();
    expect(refKey(refs[0])).toBe("thread:peer:buddy:t:1");
  });
});

describe("bringing it into a box", () => {
  const box = () => {
    let list: Carried[] = [];
    return {
      get list() {
        return list;
      },
      put: (_key: string, chip: Carried) => {
        const r = addCarried(list, chip);
        list = r.list;
        return r.refused;
      },
    };
  };

  it("adds one chip with the chat's title and exactly the text that goes", async () => {
    const b = box();
    expect(await bringContext({ kind: "thread", bot: "buddy", thread: "t1" }, { key: "buddy", scope: { shop: "baan-mali" } }, reader(), b.put)).toBeNull();
    expect(b.list).toHaveLength(1);
    expect(b.list[0]).toMatchObject({ kind: "thread", ref: "thread:buddy:t1", title: "Thread t1", scope: { shop: "baan-mali" } });
    expect((b.list[0] as { text: string }).text).toContain("Last answer: Both done.");
  });

  it("refuses a chat of another shop with a plain line, before reading anything of it", async () => {
    let held = 0;
    const r = reader({ held: () => (held++, null) });
    const b = box();
    const line = await bringContext({ kind: "thread", bot: "buddy", thread: "t1" }, { key: "buddy", scope: { shop: "other-shop" } }, r, b.put);
    expect(line).toBe("Thread t1 is in another shop, so its context cannot come into this chat.");
    expect(b.list).toEqual([]);
    expect(held).toBe(0);
    expect(r.reads).toEqual([]);
  });

  it("refuses a coding chat of another account of the same agent", async () => {
    const line = await bringContext({ kind: "session", id: "s4" }, { key: "agent:s9", scope: { account: "claude:home" } }, reader(), box().put);
    expect(line).toBe("Receipt lane runs under another account, so its context cannot come into this chat.");
    // another agent's account is not another account of this one
    expect(await bringContext({ kind: "session", id: "s4" }, { key: "agent:s9", scope: { account: "codex:default" } }, reader(), box().put)).toBeNull();
  });

  it("refuses the chat it is in, the same chat twice and a fourth chat", async () => {
    const b = box();
    const to = { key: "agent:s1", scope: {} };
    expect(await bringContext({ kind: "session", id: "s1" }, to, reader(), b.put)).toBe("That is the chat you are in.");
    expect(await bringContext({ kind: "thread", bot: "buddy", thread: "t1" }, to, reader(), b.put)).toBeNull();
    expect(await bringContext({ kind: "thread", bot: "buddy", thread: "t1" }, to, reader(), b.put)).toBe("Thread t1 is already above the box.");
    expect(await bringContext({ kind: "thread", bot: "buddy", thread: "t2" }, to, reader(), b.put)).toBeNull();
    expect(await bringContext({ kind: "session", id: "s4" }, to, reader(), b.put)).toBeNull();
    expect(await bringContext({ kind: "thread", bot: "buddy", thread: "t3" }, to, reader(), b.put)).toBe("A message carries the context of at most three chats.");
    expect(b.list).toHaveLength(3);
  });

  it("says when a chat could not be read, and adds nothing", async () => {
    const b = box();
    const r = reader({ read: async () => Promise.reject(new Error("offline")) });
    expect(await bringContext({ kind: "thread", bot: "buddy", thread: "t9" }, { key: "buddy", scope: {} }, r, b.put)).toBe("Couldn't read Thread t9 · offline");
    expect(b.list).toEqual([]);
  });
});
