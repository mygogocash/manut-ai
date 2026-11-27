// The reach cards and the "Kit may reach" list from props alone (item 102k), drawn with react-dom/server as the Start helpers card is
// (HelpersCard.test.tsx): each card shows exactly what would happen, whole (the text a read sends, the words a send puts in the other
// chat, masked as they go; the lane an open starts), the no before the yes, Start lane held while its agent will not start, the line
// each settled state collapses to, and a message from another chat drawn with where it came from. What a press does is
// reachChats.test.ts's; how they behave in the app is e2e/reach-chats.spec.ts's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { helperRows } from "./helperAsks";
import type { BuddyAsk, ReachAsk } from "./reachAsks";
import { ReachCardView, reachRefusedWords, reachTitle } from "./ReachCards";
import { MayReachView } from "./MayReach";
import { addEntry, fromChatText, type ReachEntry } from "./reachList";
import { Bubble } from "../chat/parts/Bubble";

afterEach(() => setLang("en"));

const draw = (el: ReturnType<typeof createElement>) => renderToString(el).replace(/<!-- -->/g, "");
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
const target = { n: 1, ref: { kind: "session" as const, id: "s2" }, key: "agent:s2", title: "Receipt layout", scope: {} };
const base = { id: "reach-s1-t1-1", asker: "s1", turn: "agent:s1-t1" };
const READ: ReachAsk = { ...base, kind: "read", target, text: 'Context from the chat "Receipt layout":\nThe app copied this from that chat.\nLast answer: printed in Thai' };
const SEND: ReachAsk = { ...base, kind: "send", target, message: `Allow.\n\nThe payload ends with a CRC-16 checksum. Key: ${KEY}` };
const lane = (agent?: string) =>
  helperRows([{ title: "Thai date on the receipt", brief: "Show the Thai date.\n\nCheck with pnpm test.", ...(agent ? { agent } : {}) }], { agent: "claude", models: [], efforts: [] }, [
    { id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" },
    { id: "codex", label: "Codex", mode: "chat", path: "/bin/codex" },
    { id: "opencode", label: "OpenCode", mode: "chat", path: null },
  ]).rows[0];
const OPEN: ReachAsk = { ...base, kind: "open", lane: lane("codex"), cwd: "/w/baanmali-preorder" };

describe("the cards", () => {
  it("a read shows the text Kit would get, whole, with No before Let Kit read", () => {
    const html = draw(createElement(ReachCardView, { ask: READ }));
    expect(text(html)).toContain("Kit asks to read “Receipt layout”");
    expect(text(html)).toContain("Last answer: printed in Thai");
    expect(text(html)).toContain("This is exactly what Kit gets if you let it");
    expect(html.indexOf('data-testid="reach-no"')).toBeLessThan(html.indexOf('data-testid="reach-yes"'));
    expect(text(html)).toMatch(/No.*Let Kit read/);
  });

  it("a send shows the words whole, a key in them masked as it is sent, and where they land", () => {
    const html = draw(createElement(ReachCardView, { ask: SEND }));
    expect(reachTitle(SEND)).toBe("Send this to “Receipt layout”?");
    expect(text(html)).toContain("The payload ends with a CRC-16 checksum.");
    expect(html).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(text(html)).toContain("It cannot answer anything that chat is waiting on.");
    expect(text(html)).toMatch(/Keep here.*Send there/);
  });

  it("an open shows the agent, the title and the brief whole, and holds Start lane while its agent will not start", () => {
    const html = draw(createElement(ReachCardView, { ask: OPEN }));
    expect(text(html)).toContain("Kit asks to open a new lane");
    expect(text(html)).toContain("Codex · its default model");
    expect(text(html)).toContain("Thai date on the receipt");
    expect(text(html)).toContain("Check with pnpm test.");
    expect(text(html)).toContain("made from baanmali-preorder, in its agent's Ask mode");
    expect(html).not.toMatch(/data-testid="reach-yes"[^>]*disabled/);
    const off = draw(createElement(ReachCardView, { ask: { ...OPEN, lane: lane("opencode") } }));
    expect(text(off)).toContain("not installed, will not start");
    expect(off).toMatch(/disabled=""[^>]*data-testid="reach-yes"/);
  });

  it("collapses to one line once settled, and says what went wrong after a yes", () => {
    const line = (ask: ReachAsk, done: "yes" | "no" | "gone", failed?: string) => text(draw(createElement(ReachCardView, { ask, done, failed })));
    expect(line(READ, "yes")).toContain("Kit read “Receipt layout”.");
    expect(line(READ, "no")).toContain("Not read: nothing of “Receipt layout” went to Kit.");
    expect(line(SEND, "yes")).toContain("Sent to “Receipt layout”, marked as from this chat.");
    expect(line(SEND, "gone")).toContain("No longer open, so nothing was sent.");
    expect(line(OPEN, "no")).toContain("Not now: no lane started.");
    expect(line(OPEN, "yes", "the lane did not start")).toContain("It did not go through: the lane did not start");
    const opened = draw(createElement(ReachCardView, { ask: OPEN, done: "yes", onOpenLane: () => {} }));
    expect(text(opened)).toContain("Lane started: Thai date on the receipt.");
    expect(opened).toContain('data-testid="reach-open-lane"');
  });

  it("says why a press was not taken, in the person's language", () => {
    expect(reachRefusedWords("notRunning")).toContain("Open it and press Resume");
    expect(reachRefusedWords("shop")).toBe("That chat is now of another shop, so nothing happened.");
    expect(reachRefusedWords("weird")).toBe("Not taken (weird).");
    setLang("ja");
    expect(reachRefusedWords("already_decided")).toBe("これはもう決まっています。");
  });
});

describe("the list under the box", () => {
  const list = (["Receipt layout", "QR builder"] as const).reduce<ReachEntry[]>((l, title, i) => addEntry(l, { ref: { kind: "session", id: `s${i + 2}` }, title, scope: {} }).list, []);

  it("is one quiet button while empty", () => {
    const html = draw(createElement(MayReachView, { list: [] }));
    expect(text(html)).toBe("Let Kit reach another chat…");
    expect(html).not.toContain("reach-chip");
  });

  it("shows each chat with its number and a way to take it off, and the line an add left", () => {
    const html = draw(createElement(MayReachView, { list, line: "Orders is in another shop, so Kit cannot reach it from here." }));
    expect(text(html)).toContain("Kit may reach");
    expect((html.match(/data-testid="reach-chip"/g) ?? []).length).toBe(2);
    expect(text(html)).toContain("1Receipt layout");
    expect(text(html)).toContain("2QR builder");
    expect(html).toContain('aria-label="Take Receipt layout off the list"');
    expect(text(html)).toContain("Orders is in another shop");
  });
});

// Item 102l-3: Buddy's cards on the Connected runtime, the same cards in Buddy's words, each saying before the press that it is one
// message billed to the shop's monthly limit.
describe("Buddy's cards on Connected (item 102l-3)", () => {
  const conv = { n: 1, ref: { kind: "thread" as const, bot: "buddy", thread: "cht-000000001-abc-00000001" }, key: "fold:buddy:cht-000000001-abc-00000001", title: "Price list for March", scope: { shop: "pilot:shop-a" } };
  const buddy = { id: "buddy-reach-1-t1", buddy: true as const, asker: "buddy", shop: "pilot:shop-a", turn: "buddy-t1" };
  const B_READ: BuddyAsk = { ...buddy, kind: "read", target: conv, text: 'Context from the chat "Price list for March":\nLast answer: rice is ฿45 a bag' };
  const B_SEND: BuddyAsk = { ...buddy, kind: "send", target: conv, message: "Please confirm the March prices." };
  const B_OPEN: BuddyAsk = { ...buddy, kind: "open", brief: "Plan the Songkran sale: which items and what discount.", title: "Plan the Songkran sale: which items and what discount." };

  it("a read shows what Buddy would get, whole, and says Let Buddy read is one message billed to the shop", () => {
    const html = draw(createElement(ReachCardView, { ask: B_READ }));
    expect(text(html)).toContain("Buddy asks to read “Price list for March”");
    expect(text(html)).toContain("Last answer: rice is ฿45 a bag");
    expect(text(html)).toContain("This is exactly what Buddy gets if you let it");
    expect(text(html)).toContain("one message, billed to the shop's monthly limit.");
    expect(html.indexOf('data-testid="reach-cost"')).toBeLessThan(html.indexOf('data-testid="reach-yes"'));
    expect(text(html)).toMatch(/No.*Let Buddy read/);
  });

  it("a send shows the words whole, that Buddy answers them there, that they approve nothing, and what the press costs", () => {
    const html = draw(createElement(ReachCardView, { ask: B_SEND }));
    expect(reachTitle(B_SEND)).toBe("Send this to “Price list for March”?");
    expect(text(html)).toContain("Please confirm the March prices.");
    expect(text(html)).toContain("It cannot answer or approve anything that is waiting.");
    expect(text(html)).toContain("Send there posts it to that conversation: one message, billed to the shop's monthly limit.");
    expect(text(html)).toMatch(/Keep here.*Send there/);
  });

  it("a new conversation shows its first message whole, the name it will have, and what Start conversation costs", () => {
    const html = draw(createElement(ReachCardView, { ask: B_OPEN }));
    expect(text(html)).toContain("Buddy asks to start a new conversation");
    expect(text(html)).toContain("It will be named “Plan the Songkran sale: which items and what discount.”");
    expect(text(html)).toContain("Start conversation posts it: one message, billed to the shop's monthly limit.");
    expect(text(html)).toMatch(/Not now.*Start conversation/);
    expect(html).not.toMatch(/disabled=""[^>]*data-testid="reach-yes"/);
  });

  it("collapses to Buddy's line once settled, and says its own refusals", () => {
    const line = (ask: BuddyAsk, done: "yes" | "no" | "gone") => text(draw(createElement(ReachCardView, { ask, done })));
    expect(line(B_READ, "yes")).toContain("Buddy read “Price list for March”.");
    expect(line(B_READ, "no")).toContain("Not read: nothing of “Price list for March” went to Buddy.");
    expect(line(B_SEND, "yes")).toContain("Sent to “Price list for March”, marked as from this conversation.");
    expect(line(B_SEND, "no")).toContain("Kept here: nothing was sent.");
    expect(line(B_OPEN, "gone")).toContain("No longer open, so no conversation started.");
    expect(reachRefusedWords("shop", true)).toBe("This card is of another shop than the one shown now, so nothing was sent.");
    expect(reachRefusedWords("notOwner", true)).toBe("Only the shop's owner can press this, so nothing was sent.");
    expect(reachRefusedWords("gone", true)).toBe("That chat is gone, so nothing happened.");
  });

  it("the list is Buddy's in Buddy's words", () => {
    expect(text(draw(createElement(MayReachView, { list: [], buddy: true })))).toBe("Let Buddy reach another conversation…");
    const list = addEntry([], { ref: conv.ref, title: conv.title, scope: conv.scope }).list;
    expect(text(draw(createElement(MayReachView, { list, buddy: true })))).toContain("Buddy may reach");
  });
});

describe("a message from another chat in the chat it reached", () => {
  it("says where it came from above its words, so it never reads as typed there", () => {
    const html = draw(createElement(Bubble, { item: { kind: "user", text: fromChatText("Add the PromptPay QR", "Allow. Print the checksum.") } }));
    expect(html).toContain('data-testid="bubble-reached-from"');
    expect(text(html)).toContain("From “Add the PromptPay QR”, sent on by you");
    expect(text(html)).toContain("Allow. Print the checksum.");
    expect(text(html)).not.toContain("[Manut AI:");
    const own = draw(createElement(Bubble, { item: { kind: "user", text: "Allow. Print the checksum." } }));
    expect(own).not.toContain("bubble-reached-from");
  });
});
