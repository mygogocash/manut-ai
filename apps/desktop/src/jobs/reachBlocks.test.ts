// Item 102k's reach blocks (docs/several-agents.md, rule R10): a read, a send and an open, each read with item 102e's fence walk;
// a block with a key outside its own refused whole; one request an answer; quoted examples are the agent's own words.
import { describe, expect, it } from "vitest";
import { BUDDY_GRAMMAR, BUDDY_MESSAGE_MAX, MAC_GRAMMAR, MESSAGE_MAX, REACH_KEYS, endsInReachBlock, hasReachBlock, hideReachBlocks, reachOutcome, reachReply } from "./reachBlocks";
import { helperOutcome } from "./helperBlocks";

const block = (word: string, o: unknown) => `\`\`\`manut-${word}\n${typeof o === "string" ? o : JSON.stringify(o)}\n\`\`\``;

describe("reading a reach block", () => {
  it("reads a read, a send and an open", () => {
    expect(reachOutcome(`Let me look.\n\n${block("read", { chat: "1" })}`)).toEqual({ kind: "request", request: { kind: "read", chat: "1" } });
    expect(reachOutcome(block("send", { chat: "Receipt layout", message: "  The QR changed.\n\nPlease check.  " }))).toEqual({
      kind: "request",
      request: { kind: "send", chat: "Receipt layout", message: "The QR changed.\n\nPlease check." },
    });
    expect(reachOutcome(block("open", { title: "Thai date", brief: "Show the Thai date.", agent: "codex", model: "gpt-6.1", effort: "high" }))).toEqual({
      kind: "request",
      request: { kind: "open", lane: { title: "Thai date", brief: "Show the Thai date.", agent: "codex", model: "gpt-6.1", effort: "high" } },
    });
  });

  it("reads a whole block on one line, as the fork reads its own", () => {
    expect(reachOutcome('```manut-read {"chat": "2"}```')).toEqual({ kind: "request", request: { kind: "read", chat: "2" } });
  });

  it("gives an open with no title its brief's first words, as a helper block does", () => {
    const out = reachOutcome(block("open", { brief: "Fix the totals in the receipt" }));
    expect(out.kind === "request" && out.request.kind === "open" && out.request.lane.title).toBe("Fix the totals in the receipt");
  });

  it.each([
    ["mode", { chat: "1", mode: "bypassPermissions" }],
    ["approve", { chat: "1", approve: true }],
    ["permission", { chat: "1", permission: "allow" }],
    ["path", { chat: "1", path: "/Users/you/.ssh" }],
    ["Chat", { Chat: "1" }],
  ])("refuses a read with a key it does not take (%s) whole", (key, o) => {
    expect(reachOutcome(block("read", o))).toEqual({ kind: "refused", refusal: { why: "key", key } });
  });

  it("refuses a send or an open with a key outside its own, and a read with a send's key", () => {
    expect(reachOutcome(block("send", { chat: "1", message: "hi", answer: "allow" }))).toEqual({ kind: "refused", refusal: { why: "key", key: "answer" } });
    expect(reachOutcome(block("open", { brief: "x", mode: "fullAccess" }))).toEqual({ kind: "refused", refusal: { why: "key", key: "mode" } });
    expect(reachOutcome(block("read", { chat: "1", message: "hi" }))).toEqual({ kind: "refused", refusal: { why: "key", key: "message" } });
  });

  it("each block's keys are exactly the design's, and an open's are a helper's", () => {
    expect(REACH_KEYS).toEqual({ read: ["chat"], send: ["chat", "message"], open: ["title", "brief", "agent", "model", "effort"] });
  });

  it.each([
    ["not JSON", block("read", "{chat: 1"), { why: "json" }],
    ["a list", block("read", [{ chat: "1" }]), { why: "shape" }],
    ["a string", block("read", '"1"'), { why: "shape" }],
    ["a number for the chat", block("read", { chat: 1 }), { why: "value", key: "chat" }],
    ["a chat on two lines", block("read", { chat: "1\n2" }), { why: "value", key: "chat" }],
    ["no chat", block("read", {}), { why: "chat" }],
    ["an empty chat", block("send", { chat: "  ", message: "hi" }), { why: "chat" }],
    ["no message", block("send", { chat: "1" }), { why: "message" }],
    ["a message that is not text", block("send", { chat: "1", message: ["hi"] }), { why: "value", key: "message" }],
    ["a message past the cap", block("send", { chat: "1", message: "x".repeat(MESSAGE_MAX + 1) }), { why: "long" }],
    ["an open with no brief", block("open", { title: "x" }), { why: "brief" }],
    ["an open whose agent is not text", block("open", { brief: "x", agent: 5 }), { why: "value", key: "agent" }],
  ])("refuses %s", (_name, text, refusal) => {
    expect(reachOutcome(text)).toEqual({ kind: "refused", refusal });
  });

  it("refuses an answer with two blocks, and one left open at the end", () => {
    expect(reachOutcome(`${block("read", { chat: "1" })}\n\n${block("send", { chat: "2", message: "hi" })}`)).toEqual({ kind: "refused", refusal: { why: "many" } });
    expect(reachOutcome('Reading it.\n\n```manut-read\n{"chat": "1"')).toEqual({ kind: "refused", refusal: { why: "unclosed" } });
  });

  it("does not count a block quoted as an example, in a > quote, or named in a sentence", () => {
    const quoted = ["A read looks like this:", "", "````", block("read", { chat: "1" }), "````", "", "> " + "```manut-send", "", "Use ```manut-read to ask."].join("\n");
    expect(reachOutcome(quoted)).toEqual({ kind: "none" });
    expect(hasReachBlock(quoted)).toBe(false);
    expect(hideReachBlocks(quoted)).toBe(quoted);
  });

  it("leaves helper blocks to item 102e and the fork's words alone", () => {
    const helper = '```manut-helpers\n{"brief": "x"}\n```';
    expect(reachOutcome(helper)).toEqual({ kind: "none" });
    expect(helperOutcome(block("read", { chat: "1" }))).toEqual({ kind: "none" });
  });
});

describe("hiding a block while it streams", () => {
  it("cuts a block still being written from its fence, and takes a closed one out", () => {
    const so = "I'll look at the other lane.\n\n```manut-read\n{\"ch";
    expect(hideReachBlocks(so)).toBe("I'll look at the other lane.");
    expect(endsInReachBlock(so)).toBe(true);
    const done = `I'll look at the other lane.\n\n${block("read", { chat: "1" })}\n`;
    expect(hideReachBlocks(done)).toBe("I'll look at the other lane.");
    expect(endsInReachBlock(done)).toBe(true);
    expect(endsInReachBlock(`${block("read", { chat: "1" })}\n\nAnd more.`)).toBe(false);
  });

  it("picks the newest answer of a turn with a block, readable or not", () => {
    expect(reachReply(["plain", block("read", { chat: "1" }), "after"])).toBe(1);
    expect(reachReply([block("read", {}), "x", '```manut-send\n{"chat": "2"}\n```'])).toBe(2);
    expect(reachReply(["plain"])).toBeNull();
  });
});

// Item 102l-3: Buddy's blocks on the Connected runtime take the same fences with what differs handed in (`BUDDY_GRAMMAR`).
describe("Buddy's blocks on Connected (item 102l-3)", () => {
  it("reads a read and a send as a coding chat's, and a new conversation by its brief alone, named by its first words", () => {
    expect(reachOutcome(block("read", { chat: "1" }), BUDDY_GRAMMAR)).toEqual({ kind: "request", request: { kind: "read", chat: "1" } });
    expect(reachOutcome(block("send", { chat: "2", message: "Please confirm the price." }), BUDDY_GRAMMAR)).toEqual({
      kind: "request",
      request: { kind: "send", chat: "2", message: "Please confirm the price." },
    });
    expect(reachOutcome(block("open", { brief: "Plan the Songkran sale for next week" }), BUDDY_GRAMMAR)).toEqual({
      kind: "request",
      request: { kind: "open", lane: { title: "Plan the Songkran sale for next week", brief: "Plan the Songkran sale for next week" } },
    });
  });

  it("refuses a new conversation's title, agent, model or effort whole, since the API keeps none of them", () => {
    for (const key of ["title", "agent", "model", "effort"]) {
      expect(reachOutcome(block("open", { brief: "Plan the sale", [key]: "x" }), BUDDY_GRAMMAR)).toEqual({ kind: "refused", refusal: { why: "key", key } });
    }
    // a coding chat's grammar still takes them
    expect(reachOutcome(block("open", { brief: "Plan the sale", title: "Sale" })).kind).toBe("request");
  });

  it("refuses a message or a brief longer than one message to the API leaves room for", () => {
    const long = "x".repeat(BUDDY_MESSAGE_MAX + 1);
    expect(reachOutcome(block("send", { chat: "1", message: long }), BUDDY_GRAMMAR)).toEqual({ kind: "refused", refusal: { why: "long" } });
    expect(reachOutcome(block("open", { brief: long }), BUDDY_GRAMMAR)).toEqual({ kind: "refused", refusal: { why: "long" } });
    expect(reachOutcome(block("send", { chat: "1", message: "x".repeat(BUDDY_MESSAGE_MAX) }), BUDDY_GRAMMAR).kind).toBe("request");
    // a coding chat takes the longer one
    expect(reachOutcome(block("send", { chat: "1", message: long })).kind).toBe("request");
    expect(MAC_GRAMMAR.max).toBe(MESSAGE_MAX);
  });
});
