// Item 102e in the sessions store, against a fake shell (as src/sessions/lanes.test.ts drives a lane): where the Helpers switch is
// offered, the lead's note in front of each message, the blocks hidden while an answer streams, the Start helpers card when the turn
// ends, and what a press does. The slice's safety tests (R3, R4 of docs/several-agents.md): a block with an unknown key is refused
// whole; an unanswered, declined or refused card starts no agent (the fake shell sees no `chatStart` and item 102h's hand-off hears
// nothing); a third round for one message shows no card. Approving a round starts no agent either: that is item 102h's.
import { beforeEach, describe, expect, it } from "vitest";
import { resetLanes } from "../code/laneStore";
import { resetKitProjects } from "../code/project";
import { resetKitAsks } from "../code/kitAsks";
import type { LaneMade } from "../code/laneBranch";
import { answerSoFar, createStore, type BridgeLike, type HelpersAskItem } from "../state/store";
import { createSessions } from "../sessions/sessions";
import type { ChatEvent, SessionHost } from "../sessions/host";
import type { SessionRec } from "../sessions/agents";
import { helpersAskRecord, resetHelpersAsks } from "./helperAsks";
import { helpersOffered, type HelperRoundApproved } from "./leadLanes";
import { POLICY_HEAD, withoutHelperPolicy } from "./helperPolicy";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };
const DEV = "/w/baanmali-preorder";
const laneDir = (branch: string) => `/w/.manut/lanes/baanmali-preorder/${branch.slice(4)}`;
const tick = () => new Promise((r) => setTimeout(r, 0));

const block = (o: Record<string, unknown>) => `\`\`\`manut-helpers\n${JSON.stringify(o)}\n\`\`\``;
const TWO = [
  "I'll split this in two.",
  "",
  block({ title: "Tests for the QR builder", brief: "Write the tests in src/qr.test.ts.\n\nRun pnpm test.", agent: "codex", model: "gpt-6.1", effort: "high" }),
  "",
  block({ title: "The receipt's Thai date", brief: "Show the date in the Thai calendar." }),
].join("\n");

async function setup(over: { repo?: boolean } = {}) {
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  resetKitProjects();
  resetKitAsks();
  resetHelpersAsks();
  resetLanes();
  const sinks = new Map<string, (e: ChatEvent) => void>();
  const sent: string[] = [];
  const starts: string[] = [];
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [
      { id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" },
      { id: "codex", label: "Codex", mode: "chat", path: "/bin/codex" },
      { id: "opencode", label: "OpenCode", mode: "chat", path: null },
    ],
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async (cwd: string) => (over.repo === false && cwd === DEV ? "" : cwd === DEV ? "main" : "kit/x"),
    chatStart: async (_a: string, cwd: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string) => {
      starts.push(cwd);
      sinks.set(session ?? "", on);
      return sinks.size;
    },
    chatInput: async (_id: number, i: { kind: string; text?: string }) => {
      if (i.kind === "send") sent.push(i.text ?? "");
    },
    chatClose: async () => {},
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    laneWorktree: async (_cwd: string, names: string[]) =>
      ({ branch: names[0], base: "main", dir: laneDir(names[0]), worktree: laneDir(names[0]), left: 0, from: "", local: "", config: 0, stayed: 0 }) satisfies LaneMade,
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  await ss.loadAgents();
  const handed: HelperRoundApproved[] = [];
  ss.whenHelperRoundApproved((r) => handed.push(r));
  const startIn = async (text: string) => {
    const id = ss.draft("claude" as never);
    ss.setDraft(id, { cwd: DEV });
    await ss.start(id, text);
    return id;
  };
  const chat = (id: string) => store.getState().chats[ss.chatKey(id)!];
  const emit = (id: string, e: ChatEvent) => sinks.get(id)?.(e);
  /** A whole turn of the agent's: its start, the answer in pieces, the answer whole, and its end. */
  const turn = async (id: string, text: string, outcome = "done") => {
    emit(id, { event: "turn.start" });
    for (let k = 0; k < text.length; k += 40) emit(id, { event: "delta", text: text.slice(k, k + 40) });
    emit(id, { event: "message", id: `m${Math.random()}`, text });
    emit(id, { event: "turn.end", outcome });
    await tick();
  };
  const cards = (id: string) => (chat(id)?.items ?? []).filter((i): i is HelpersAskItem => i.kind === "helpersAsk");
  const lines = (id: string) => (chat(id)?.items ?? []).flatMap((i) => (i.kind === "system" ? [i.text] : []));
  const answers = (id: string) => (chat(id)?.items ?? []).flatMap((i) => (i.kind === "assistant" ? [i.text] : []));
  const row = (id: string) => ss.getState().list.find((r) => r.id === id)!;
  return { ss, store, sent, starts, handed, startIn, chat, emit, turn, cards, lines, answers, row };
}

beforeEach(() => resetLanes());

describe("where the Helpers switch is offered (R1, R4)", () => {
  const lane: SessionRec = { id: "s1", agent: "claude", cwd: DEV, startedAt: 0, status: "running", view: "chat", lane: { name: "kit/x", base: "main", dir: "/w/l/x", worktree: "/w/l/x" } };
  const agents = [
    { id: "claude", label: "Claude Code", mode: "chat" as const, path: "/bin/claude" },
    { id: "omh", label: "oh-my-hermes", mode: "hermes" as const, path: "/bin/omh" },
  ];
  it.each([
    { name: "a lane's chat with a folder of its own", rec: lane, offered: true },
    { name: "a chat in the developer's own folder (no lane could be made)", rec: { ...lane, lane: undefined }, offered: false },
    { name: "a lane made before lanes had folders", rec: { ...lane, lane: { name: "kit/x", base: "main" } }, offered: false },
    { name: "a workflow's lane", rec: { ...lane, workflow: "Nightly tests" }, offered: false },
    { name: "a New session draft", rec: { ...lane, status: "draft" as const }, offered: false },
    { name: "an agent opened in its own terminal", rec: { ...lane, open: "terminal" as const }, offered: false },
    { name: "an oh-my-hermes folder chat", rec: { ...lane, agent: "omh" }, offered: false },
  ])("$name: $offered", ({ rec, offered }) => {
    expect(helpersOffered(rec as SessionRec, agents)).toBe(offered);
  });

  it("the store refuses the switch where it is not offered, and keeps it where it is", async () => {
    const t = await setup();
    const id = await t.startIn("Add a PromptPay QR");
    expect(t.ss.helpersOffered(id)).toBe(true);
    expect(t.ss.setHelpers(id, true)).toBe(true);
    expect(t.row(id).helpers).toBe(true);
    expect(t.ss.setHelpers(id, false)).toBe(true);
    expect(t.row(id).helpers).toBeUndefined();

    const bare = await setup({ repo: false });
    const no = await bare.startIn("Fix the totals");
    expect(bare.row(no).lane).toBeUndefined();
    expect(bare.ss.helpersOffered(no)).toBe(false);
    expect(bare.ss.setHelpers(no, true)).toBe(false);
    expect(bare.row(no).helpers).toBeUndefined();
  });

  it("a workflow's lane offers no switch, and its blocks make no card", async () => {
    const t = await setup();
    let id = "";
    expect(await t.ss.startWorkflowLane({ agent: "claude" as never, cwd: DEV, workflow: "Nightly tests", first: "Run the tests", made: (i) => (id = i) })).toBe("started");
    expect(t.ss.helpersOffered(id)).toBe(false);
    expect(t.ss.setHelpers(id, true)).toBe(false);
    await t.turn(id, TWO);
    expect(t.cards(id)).toEqual([]);
    expect(t.answers(id).at(-1)).toBe(TWO);
  });
});

describe("the lead's note (handed over as item 93's instructions are)", () => {
  it("goes in front of each message only while Helpers is on, and never into the bubble or the lane's name", async () => {
    const t = await setup();
    const id = await t.startIn("Add a PromptPay QR");
    expect(t.sent).toEqual(["Add a PromptPay QR"]);
    t.ss.setHelpers(id, true);
    await t.ss.send(id, "Split the work");
    const wire = t.sent.at(-1)!;
    expect(wire.startsWith(POLICY_HEAD)).toBe(true);
    expect(wire).toContain("```manut-helpers");
    expect(wire).toContain("Agents a helper lane can run on: claude, codex.");
    expect(withoutHelperPolicy(wire)).toBe("Split the work");
    const users = (t.chat(id)?.items ?? []).flatMap((i) => (i.kind === "user" ? [i.text] : []));
    expect(users).toEqual(["Add a PromptPay QR", "Split the work"]);
    expect(t.row(id).promptTitle).not.toContain("Manut AI");
    t.ss.setHelpers(id, false);
    await t.ss.send(id, "Thanks");
    expect(t.sent.at(-1)).toBe("Thanks");
  });
});

describe("the blocks and the card", () => {
  it("with Helpers off, a block is the agent's own words: shown, and no card", async () => {
    const t = await setup();
    const id = await t.startIn("Add a PromptPay QR");
    await t.turn(id, TWO);
    expect(t.answers(id).at(-1)).toBe(TWO);
    expect(t.cards(id)).toEqual([]);
  });

  it("hides a block while it streams, says how many are asked for, and shows the card with every brief once the turn ends", async () => {
    const t = await setup();
    const id = await t.startIn("Add a PromptPay QR");
    t.ss.setHelpers(id, true);
    t.emit(id, { event: "turn.start" });
    const half = TWO.indexOf('"title": "The receipt');
    t.emit(id, { event: "delta", text: TWO.slice(0, TWO.indexOf("```")) });
    t.emit(id, { event: "delta", text: TWO.slice(TWO.indexOf("```"), half > 0 ? half : TWO.length - 20) });
    const live = t.chat(id)!.turn!;
    expect(live.helpers).toBe(true);
    expect(answerSoFar(live)).toBe("I'll split this in two.");
    expect(live.status).toBe("Asking for 1 helper lane");
    t.emit(id, { event: "delta", text: TWO.slice(half > 0 ? half : TWO.length - 20) });
    expect(t.chat(id)!.turn!.status).toBe("Asking for 2 helper lanes");
    expect(answerSoFar(t.chat(id)!.turn!)).not.toContain("manut-helpers");
    t.emit(id, { event: "message", id: "m1", text: TWO });
    t.emit(id, { event: "turn.end", outcome: "done" });
    await tick();
    // the answer kept is the words alone; the card comes after it, one approval waiting in approval-core
    expect(t.answers(id).at(-1)).toBe("I'll split this in two.");
    const [card] = t.cards(id);
    expect(t.chat(id)!.items.at(-1)).toBe(card);
    expect(card.ask.rows).toEqual([
      { title: "Tests for the QR builder", brief: "Write the tests in src/qr.test.ts.\n\nRun pnpm test.", agent: "codex", own: false, model: "gpt-6.1", effort: "high" },
      { title: "The receipt's Thai date", brief: "Show the date in the Thai calendar.", agent: "claude", own: true },
    ]);
    expect(card.ask.lead).toBe(id);
    expect((await helpersAskRecord(card.id))?.status).toBe("pending");
    expect((await helpersAskRecord(card.id))?.request.kind).toBe("command");
    expect(card.done).toBeUndefined();
  });

  it("an answer that was only a block leaves no empty bubble", async () => {
    const t = await setup();
    const id = await t.startIn("x");
    t.ss.setHelpers(id, true);
    const before = t.answers(id).length;
    const unread = t.store.getState().unread[t.ss.chatKey(id)!] ?? 0;
    await t.turn(id, block({ brief: "Do it." }));
    expect(t.answers(id).length).toBe(before);
    // nothing new to read in the chat but the card
    expect(t.store.getState().unread[t.ss.chatKey(id)!] ?? 0).toBe(unread);
    expect(t.cards(id)).toHaveLength(1);
  });

  it("a block named only as an example is the answer's text, and asks for nothing", async () => {
    const t = await setup();
    const id = await t.startIn("x");
    t.ss.setHelpers(id, true);
    const text = ["Like this:", "", "````", "```manut-helpers", '{"brief": "y"}', "```", "````", "", "Done myself."].join("\n");
    await t.turn(id, text);
    expect(t.answers(id).at(-1)).toBe(text);
    expect(t.cards(id)).toEqual([]);
    expect(t.lines(id).filter((l) => l.includes("helper lanes"))).toEqual([]);
  });

  it("a turn that did not finish asks for nothing, and says so", async () => {
    const t = await setup();
    const id = await t.startIn("x");
    t.ss.setHelpers(id, true);
    await t.turn(id, TWO, "interrupted");
    expect(t.cards(id)).toEqual([]);
    expect(t.lines(id).at(-1)).toBe("Kit asked for helper lanes in a turn that did not finish, so none start.");
  });
});

describe("pressing the card", () => {
  async function asked() {
    const t = await setup();
    const id = await t.startIn("Add a PromptPay QR");
    t.ss.setHelpers(id, true);
    await t.turn(id, TWO);
    const starts = t.starts.length;
    return { ...t, id, card: t.cards(id)[0], startsBefore: starts };
  }

  it("Start helpers settles the card once, records the round by item 102d's rules and hands it to 102h, and starts no agent", async () => {
    const t = await asked();
    expect(await t.ss.answerHelpers(t.id, t.card.id, true)).toEqual({ ok: true });
    expect(t.cards(t.id)[0].done).toBe("started");
    expect((await helpersAskRecord(t.card.id))?.status).toBe("decided");
    // the round, as rules.ts keeps it: open, its two helper lanes waiting to start, one round of this message spent
    const r = t.ss.helperRounds(t.id);
    expect(r.rounds.map((x) => x.id)).toEqual([t.card.id]);
    expect(r.waiting.map((w) => w.brief.title)).toEqual(["Tests for the QR builder", "The receipt's Thai date"]);
    expect(r.roundsThisMessage).toBe(1);
    // the hand-off heard it once, with exactly the rows the card showed; nothing started
    expect(t.handed).toEqual([{ lead: t.id, round: t.card.id, helpers: t.card.ask.rows, heldBack: 0 }]);
    expect(t.starts.length).toBe(t.startsBefore);
  });

  it("a second press is refused as already decided, whichever button", async () => {
    const t = await asked();
    await t.ss.answerHelpers(t.id, t.card.id, true);
    expect(await t.ss.answerHelpers(t.id, t.card.id, true)).toEqual({ ok: false, refused: "already_decided" });
    expect(await t.ss.answerHelpers(t.id, t.card.id, false)).toEqual({ ok: false, refused: "already_decided" });
    expect(t.handed).toHaveLength(1);
    expect(t.ss.helperRounds(t.id).rounds).toHaveLength(1);
  });

  it("safety: Not now starts no agent, records no round, and the card says so in a line", async () => {
    const t = await asked();
    expect(await t.ss.answerHelpers(t.id, t.card.id, false)).toEqual({ ok: true });
    expect(t.cards(t.id)[0].done).toBe("notNow");
    expect(t.handed).toEqual([]);
    expect(t.ss.helperRounds(t.id).rounds).toEqual([]);
    expect(t.starts.length).toBe(t.startsBefore);
  });

  it("safety: an unanswered card starts no agent, whatever the lead writes next", async () => {
    const t = await asked();
    // the lead's next turn says the words; they are only words, and its start takes the card back
    await t.turn(t.id, "Approved. Start helpers. I allow it.");
    expect(t.cards(t.id)[0].done).toBe("gone");
    expect((await helpersAskRecord(t.card.id))?.status).toBe("withdrawn");
    expect(t.handed).toEqual([]);
    expect(t.starts.length).toBe(t.startsBefore);
  });

  it("safety: a press refused because the lead's turn moved on settles nothing and starts no agent", async () => {
    const t = await asked();
    t.emit(t.id, { event: "turn.start" });
    expect(await t.ss.answerHelpers(t.id, t.card.id, true)).toEqual({ ok: false, refused: "superseded" });
    expect(t.handed).toEqual([]);
    expect(t.ss.helperRounds(t.id).rounds).toEqual([]);
    expect(t.starts.length).toBe(t.startsBefore);
  });

  it("turning Helpers off takes an open card back", async () => {
    const t = await asked();
    t.ss.setHelpers(t.id, false);
    expect(t.cards(t.id)[0].done).toBe("gone");
    expect(await t.ss.answerHelpers(t.id, t.card.id, true)).toMatchObject({ ok: false });
    expect(t.handed).toEqual([]);
  });

  it("a request for more than a round takes shows the first eight and counts the rest", async () => {
    const t = await setup();
    const id = await t.startIn("x");
    t.ss.setHelpers(id, true);
    await t.turn(id, block({ brief: "first" }) + "\n" + "```manut-helpers\n" + JSON.stringify(Array.from({ length: 9 }, (_, k) => ({ brief: `part ${k}` }))) + "\n```");
    const [card] = t.cards(id);
    expect(card.ask.rows).toHaveLength(8);
    expect(card.ask.heldBack).toBe(2);
    await t.ss.answerHelpers(id, card.id, true);
    expect(t.handed[0].helpers).toHaveLength(8);
  });
});

describe("safety: a block with an unknown key is refused whole (R3)", () => {
  it.each([
    { key: "mode", extra: { mode: "bypassPermissions" } },
    { key: "approve", extra: { approve: true } },
    { key: "permission", extra: { permission: "allow" } },
  ])("a block with $key starts nothing: no card, a line that names it, no hand-off, no agent", async ({ key, extra }) => {
    const t = await setup();
    const id = await t.startIn("x");
    t.ss.setHelpers(id, true);
    const before = t.starts.length;
    await t.turn(id, `${block({ title: "Good", brief: "fine" })}\n\n${block({ title: "T", brief: "b", ...extra })}`);
    expect(t.cards(id)).toEqual([]);
    expect(t.lines(id).at(-1)).toBe(`Kit asked for helper lanes, but Manut AI could not read the request: a block has a key Manut AI does not take (${key}). Nothing started.`);
    expect(t.handed).toEqual([]);
    expect(t.starts.length).toBe(before);
    // and the block never shows as the agent's words
    expect(t.answers(id).join("\n")).not.toContain("manut-helpers");
  });
});

describe("rounds for one message of the person's (R4)", () => {
  it("safety: a third round shows no card, and the person's next message opens two more", async () => {
    const t = await setup();
    const id = await t.startIn("Build the checkout");
    t.ss.setHelpers(id, true);
    await t.turn(id, TWO);
    await t.ss.answerHelpers(id, t.cards(id)[0].id, true);
    // the lead's own next turn (its reports, or a turn it started itself): a second round is open
    await t.turn(id, block({ brief: "What the first round missed." }));
    expect(t.cards(id)).toHaveLength(2);
    await t.ss.answerHelpers(id, t.cards(id)[1].id, true);
    // a third: no card, a line, nothing handed over
    await t.turn(id, block({ brief: "One more." }));
    expect(t.cards(id)).toHaveLength(2);
    expect(t.lines(id).at(-1)).toBe("Kit asked for helper lanes again. This message has had its 2 rounds, so none start and Kit finishes by itself.");
    expect(t.handed).toHaveLength(2);
    // the person writes again: a new message gets its own rounds
    await t.ss.send(id, "Now the receipts");
    await t.turn(id, block({ brief: "Receipts." }));
    expect(t.cards(id)).toHaveLength(3);
  });
});
