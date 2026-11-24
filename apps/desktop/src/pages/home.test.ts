// Home's rules, apart from its markup: the design canvas's three modes and their words, where an ask goes from each,
// which waiting asks Home may approve itself, the few asks it lists, and who is working now. The last tests send asks
// on the demo runtime, the way the ask box does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang, t } from "../i18n";
import { createStore, selectAsks, type ApprovalItem, type Ask, type Chat, type ClarifyItem } from "../state/store";
import { threadKey } from "../threads/types";
import { MockHost, MockRuntime } from "../runtime/mock";
import {
  askLines,
  askRoute,
  canApproveHere,
  elapsed,
  FIRST_MODE,
  HOME_MODES,
  homeAsks,
  kitOf,
  MODE_WORDS,
  offeredModes,
  sendAsk,
  settledAsks,
  workingMembers,
} from "./home";

const approval = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  kind: "approval",
  id: "a1",
  ts: 100,
  request_id: "r1",
  title: "Send a reply to a customer",
  command: 'Reply to Khun Mali on LINE: "Your order ships tomorrow morning."',
  choices: ["once", "session", "deny"],
  ...over,
});
const clarify = (over: Partial<ClarifyItem> = {}): ClarifyItem => ({
  kind: "clarify",
  id: "c1",
  ts: 100,
  request_id: "q1",
  question: "Which page should the post go on?",
  ...over,
});
const ask = (bot: string, item: ApprovalItem | ClarifyItem): Ask => ({ bot, item, ts: item.ts });

describe("the ask box's modes", () => {
  afterEach(() => setLang("en"));

  it("are Chat, Team and Code, in the canvas's order, and Home opens on Team as the canvas does", () => {
    expect(HOME_MODES).toEqual(["chat", "team", "code"]);
    expect(FIRST_MODE).toBe("team");
  });

  it("each say the canvas's words: the mode word, the placeholder, the suggestions' title and four suggestions", () => {
    setLang("en");
    const words = (m: (typeof HOME_MODES)[number]) => {
      const w = MODE_WORDS[m];
      return { label: t(w.label), word: t(w.word), placeholder: t(w.placeholder), title: t(w.title), chips: w.chips.map((k) => t(k)) };
    };
    expect(words("chat")).toEqual({
      label: "Chat",
      word: "chat",
      placeholder: "Ask anything, in Thai or English",
      title: "Ask Buddy something",
      chips: ["Write a reply to a customer", "Explain yesterday’s sales", "Translate a message", "Plan the 12.12 sale"],
    });
    expect(words("team")).toEqual({
      label: "Team",
      word: "team",
      placeholder: "What should the team work on next?",
      title: "Give the team a job",
      chips: ["Reply to waiting customers", "Draft a 12.12 post", "Send today’s sales summary", "Set a routine"],
    });
    expect(words("code")).toEqual({
      label: "Code",
      word: "code",
      placeholder: "What should Kit build?",
      title: "Ask Kit to build something",
      chips: ["Build a pre-order page", "Fix the stock sync", "Make a booking form", "Add PromptPay to checkout"],
    });
  });

  it("offer Code only while the team has Kit, whom it talks to", () => {
    expect(kitOf(["buddy", "nam", "pim", "ton", "kit"])).toBe("kit");
    expect(kitOf(["buddy", "nam"])).toBeNull();
    expect(offeredModes("kit")).toEqual(["chat", "team", "code"]);
    expect(offeredModes(null)).toEqual(["chat", "team"]);
  });
});

describe("where an ask goes", () => {
  it("Chat starts a new thread with Buddy", () => {
    expect(askRoute("chat", "buddy", "kit")).toEqual({ to: "thread", bot: "buddy" });
  });

  it("Team goes to Buddy's main chat, where Buddy hands the work to the team", () => {
    expect(askRoute("team", "buddy", "kit")).toEqual({ to: "main", bot: "buddy" });
  });

  it("Code starts a new thread with Kit", () => {
    expect(askRoute("code", "buddy", "kit")).toEqual({ to: "thread", bot: "kit" });
  });

  it("goes nowhere while there is nobody to take it", () => {
    expect(askRoute("chat", null, "kit")).toBeNull();
    expect(askRoute("team", null, null)).toBeNull();
    expect(askRoute("code", "buddy", null)).toBeNull();
  });
});

describe("Approve on Home", () => {
  it("is offered for an approval that offers Allow once and names its exact action, with nothing more to read", () => {
    expect(canApproveHere(approval())).toBe(true);
  });

  it("is not offered for a question: it is answered on its card", () => {
    expect(canApproveHere(clarify())).toBe(false);
  });

  it("is not offered where the card holds more than Home shows: a plan, a folder, a risk warning or a subagent", () => {
    expect(canApproveHere(approval({ plan: "1. Change the checkout" }))).toBe(false);
    expect(canApproveHere(approval({ cwd: "/shop/site" }))).toBe(false);
    expect(canApproveHere(approval({ command: "rm -rf build/" }))).toBe(false);
    expect(canApproveHere(approval({ subagent: { id: "s1", name: "Draft the replies" } }))).toBe(false);
  });

  it("is not offered without Allow once, the choice it sends, or without an exact action", () => {
    expect(canApproveHere(approval({ choices: ["session", "deny"] }))).toBe(false);
    expect(canApproveHere(approval({ command: "" }))).toBe(false);
    expect(canApproveHere(approval({ command: "   " }))).toBe(false);
  });
});

describe("an ask in its card's words", () => {
  afterEach(() => setLang("en"));

  it("is an approval's title over the exact action it names", () => {
    expect(askLines(approval())).toEqual({ title: "Send a reply to a customer", action: 'Reply to Khun Mali on LINE: "Your order ships tomorrow morning."', whole: false });
    // a browser write's sentence is shown whole, as its card shows it
    expect(askLines(approval({ whole: true })).whole).toBe(true);
    expect(askLines(approval({ whole: true, command: " " }))).toMatchObject({ action: null, whole: false });
  });

  it("uses the card's own words for an approval with no title, or one that starts on a plan", () => {
    setLang("en");
    expect(askLines(approval({ title: "" })).title).toBe("Approval needed");
    expect(askLines(approval({ plan: "1. Change the checkout", command: "" }))).toEqual({ title: "Start working on this plan?", action: null, whole: false });
  });

  it("is a question as asked, or an interview's count and first question", () => {
    setLang("en");
    expect(askLines(clarify())).toEqual({ title: "Which page should the post go on?", action: null, whole: false });
    const questions = [
      { qid: "a", question: "Who is the promotion for?" },
      { qid: "b", question: "Where should it run?" },
    ];
    expect(askLines(clarify({ questions })).title).toBe(t("ask.questions", { n: 2, first: "Who is the promotion for?" }));
  });
});

describe("the asks Home lists", () => {
  const a = (id: string, ts: number, bot = "nam") => ask(bot, approval({ id, ts, request_id: `r-${id}` }));

  it("are the three newest open asks, newest first", () => {
    const rows = homeAsks([a("1", 1), a("2", 4), a("3", 2), a("4", 3)], []);
    expect(rows.map((r) => [r.item.id, r.settled])).toEqual([
      ["2", false],
      ["4", false],
      ["3", false],
    ]);
  });

  it("keep an ask approved here in its place, as its settled line", () => {
    const done = ask("nam", approval({ id: "2", ts: 4, resolved: "once" }));
    const rows = homeAsks([a("1", 1), a("3", 2), a("4", 3)], [done]);
    expect(rows.map((r) => [r.item.id, r.settled])).toEqual([
      ["2", true],
      ["4", false],
      ["3", false],
      ["1", false],
    ]);
  });

  it("show an ask once, open, when it is open again", () => {
    const rows = homeAsks([a("2", 4)], [a("2", 4)]);
    expect(rows.map((r) => [r.item.id, r.settled])).toEqual([["2", false]]);
  });

  it("show as many as asked for", () => {
    expect(homeAsks([a("1", 1), a("2", 2)], [], 1).map((r) => r.item.id)).toEqual(["2"]);
  });
});

describe("the asks approved from Home", () => {
  const chats = (items: (ApprovalItem | ClarifyItem)[]) => ({ nam: { items } as unknown as Chat });

  it("are those the store shows settled, read from the chat they were asked in", () => {
    const done = approval({ id: "a1", resolved: "once" });
    expect(settledAsks(chats([done]), [{ bot: "nam", id: "a1" }])).toEqual([{ bot: "nam", item: done, ts: done.ts }]);
  });

  it("name an ask once, however often it was recorded", () => {
    const done = approval({ id: "a1", resolved: "once" });
    expect(settledAsks(chats([done]), [{ bot: "nam", id: "a1" }, { bot: "nam", id: "a1" }])).toHaveLength(1);
  });

  it("leave out one that was not taken, one that is gone, and a question", () => {
    const list = [approval({ id: "a1" }), clarify({ id: "c1", answer: "Facebook" })];
    expect(settledAsks(chats(list), [{ bot: "nam", id: "a1" }, { bot: "nam", id: "gone" }, { bot: "pim", id: "a1" }, { bot: "nam", id: "c1" }])).toEqual([]);
  });
});

describe("who is working now", () => {
  const bot = (name: string, over: { status?: "online" | "offline"; running?: boolean } = {}) => ({
    name,
    display_name: name[0].toUpperCase() + name.slice(1),
    is_default: false,
    model: "m",
    provider: "p",
    description: `${name} work`,
    status: over.status ?? "online",
    running: over.running ?? false,
  });
  const turnChat = (status: string, startedAt: number) => ({ turn: { id: "t", startedAt, status, steps: [], skills: [], streaming: "" }, lastTurn: null }) as unknown as Chat;

  it("is each listed member whose running turn the Team page calls Working, with what the turn says and when it started", () => {
    const rows = workingMembers([bot("buddy"), bot("pim", { running: true }), bot("ton")], { pim: turnChat("Drafting the post", 5_000) }, []);
    expect(rows).toEqual([{ name: "pim", displayName: "Pim", description: "pim work", status: "Drafting the post", since: 5_000 }]);
  });

  it("leaves out a member whose ask waits, who is under Needs you instead, and one the runtime cannot reach", () => {
    const asks = [ask("nam", approval())];
    const chats = { nam: turnChat("Waiting for approval", 1), kit: turnChat("Running the tests", 1) };
    expect(workingMembers([bot("nam", { running: true }), bot("kit", { status: "offline", running: true })], chats, asks)).toEqual([]);
  });

  it("names a member the runtime says is busy with no turn in its main chat, with nothing more", () => {
    expect(workingMembers([bot("kit", { running: true })], {}, [])).toEqual([{ name: "kit", displayName: "Kit", description: "kit work", status: "", since: null }]);
  });
});

describe("how long a turn has run", () => {
  afterEach(() => setLang("en"));

  it("counts seconds, then minutes, then hours", () => {
    setLang("en");
    expect(elapsed(10_000, 10_000)).toBe("0s");
    expect(elapsed(10_000, 48_000)).toBe("38s");
    expect(elapsed(0, 3 * 60_000 + 59_000)).toBe("3m");
    expect(elapsed(0, 2 * 3_600_000 + 1)).toBe("2h");
    // a clock that moved back never shows a negative time
    expect(elapsed(10_000, 9_000)).toBe("0s");
  });
});

/** A store of its own on a fresh demo runtime, listing the whole team as the app does. */
async function demoStore() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  return store;
}

describe("sending from the ask box, on the demo runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Chat opens a new thread with Buddy and sends the words there", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    expect(await sendAsk(store.actions, { to: "thread", bot: "buddy" }, "Translate a message")).toBe(true);
    const s = store.getState();
    expect(s.selectedBot).toBe("buddy");
    expect(s.ui.view).toBe("chat");
    expect(s.ui.thread).not.toBeNull();
    const items = s.chats[threadKey("buddy", s.ui.thread!)].items;
    expect(items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["Translate a message"]);
    // Buddy's main chat got nothing
    expect(s.chats.buddy.items.some((i) => i.kind === "user" && i.text === "Translate a message")).toBe(false);
  });

  it("Team sends the words to Buddy's main chat", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    store.actions.openPage("history");
    expect(await sendAsk(store.actions, { to: "main", bot: "buddy" }, "Reply to waiting customers")).toBe(true);
    const s = store.getState();
    expect(s.ui).toMatchObject({ view: "chat", thread: null });
    expect(s.selectedBot).toBe("buddy");
    expect(s.chats.buddy.items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toContain("Reply to waiting customers");
  });

  it("Code opens a new thread with Kit and sends the words there", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    expect(await sendAsk(store.actions, { to: "thread", bot: "kit" }, "Build a pre-order page")).toBe(true);
    const s = store.getState();
    expect(s.selectedBot).toBe("kit");
    expect(s.ui.thread).not.toBeNull();
    expect(s.chats[threadKey("kit", s.ui.thread!)].items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["Build a pre-order page"]);
  });

  it("says when a thread could not be made, so the words stay in the box", async () => {
    vi.useFakeTimers();
    const store = await demoStore();
    expect(await sendAsk(store.actions, { to: "thread", bot: "nobody" }, "Hello")).toBe(false);
    expect(selectAsks(store.getState())).toEqual([]);
  });
});
