// A chat's title by the person's chosen model, through the sessions store (item 96): no run while the setting is off, one run
// after the first answer with the first message and that answer, the title kept as a proposal, a name the person gave while it
// ran kept instead, no second run on its own, and a run stopped when its chat closes. A fake shell stands in; no agent runs.
import { beforeEach, expect, test } from "vitest";
import { createStore, type BridgeLike } from "../state/store";
import { TITLE_MODEL_KEY } from "../lib/titleModel";
import { createSessions } from "./sessions";
import type { ChatEvent, SessionHost, TitleRequest, TitleWords } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v), removeItem: (k: string) => void saved.delete(k) };
});

const turnOn = () => saved.set(TITLE_MODEL_KEY, JSON.stringify({ on: true, model: "haiku", effort: "low" }));
/** Lets the store's own awaits run. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

async function setup() {
  const sinks = new Map<string, (e: ChatEvent) => void>();
  const asked: TitleRequest[] = [];
  const cancelled: string[] = [];
  const answers: { resolve: (w: TitleWords) => void; reject: (e: unknown) => void }[] = [];
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: "claude", label: "Claude Code", mode: "chat", path: "/bin/claude" }],
    home: async () => "/w",
    pickFolder: async () => null,
    branch: async () => "main",
    chatStart: async (_a: string, _cwd: string, on: (e: ChatEvent) => void, _r?: string, _acc?: string, session?: string) => {
      sinks.set(session ?? "", on);
      return sinks.size;
    },
    chatInput: async () => {},
    chatClose: async () => {},
    removeFiles: async () => {},
    pruneFiles: async () => {},
    historyPrune: async () => {},
    titleRun: (req: TitleRequest) => {
      asked.push(req);
      return new Promise<TitleWords>((resolve, reject) => answers.push({ resolve, reject }));
    },
    titleCancel: async (key: string) => void cancelled.push(key),
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  await ss.loadAgents();
  const start = async (text: string) => {
    const id = ss.draft("claude" as never);
    ss.setDraft(id, { cwd: "/w/shop" });
    await ss.start(id, text);
    return id;
  };
  const emit = (id: string, e: ChatEvent) => sinks.get(id)?.(e);
  /** One whole turn: the agent answers `text` and the turn ends done. */
  const answer = async (id: string, text: string) => {
    emit(id, { event: "turn.start" });
    emit(id, { event: "delta", text });
    emit(id, { event: "turn.end", outcome: "done" });
    await settle();
  };
  const row = (id: string) => ss.getState().list.find((r) => r.id === id);
  return { ss, start, answer, row, asked, cancelled, answers };
}

test("off: no run is made, whatever the chat says", async () => {
  const t = await setup();
  const id = await t.start("Add a PromptPay QR to the checkout.");
  await t.answer(id, "Done. The checkout shows the QR.");
  expect(t.asked).toEqual([]);
  expect(t.row(id)?.modelTitle).toBeUndefined();
});

test("on: one run after the first answer, given the first message and that answer, and its title kept as a proposal", async () => {
  turnOn();
  const t = await setup();
  const id = await t.start("Add a PromptPay QR to the checkout. My key is ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  expect(t.asked).toEqual([]); // nothing before an answer
  await t.answer(id, "Done. The checkout shows the QR.");
  expect(t.asked).toHaveLength(1);
  expect(t.asked[0]).toMatchObject({ agent: "claude", model: "haiku", effort: "low", purpose: "title", key: t.ss.chatKey(id) });
  expect(t.asked[0].material).toContain("Add a PromptPay QR to the checkout.");
  expect(t.asked[0].material).toContain("Done. The checkout shows the QR.");
  expect(t.asked[0].material).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  // a second turn while the first run is still going starts no second run
  await t.answer(id, "Anything else?");
  expect(t.asked).toHaveLength(1);
  t.answers[0].resolve({ title: "PromptPay QR at checkout", body: "" });
  await settle();
  expect(t.row(id)?.modelTitle).toBe("PromptPay QR at checkout");
  expect(t.row(id)?.title).toBeUndefined(); // never written as the person's own name
  // written once: later turns ask for no other
  await t.answer(id, "The QR is larger now.");
  expect(t.asked).toHaveLength(1);
});

test("a name the person gave while the run was going is kept, and the run's words are dropped", async () => {
  turnOn();
  const t = await setup();
  const id = await t.start("Add a PromptPay QR to the checkout.");
  await t.answer(id, "Done.");
  expect(t.asked).toHaveLength(1);
  t.ss.rename(id, "Checkout work");
  t.answers[0].resolve({ title: "PromptPay QR at checkout", body: "" });
  await settle();
  expect(t.row(id)?.title).toBe("Checkout work");
  expect(t.row(id)?.modelTitle).toBeUndefined();
  // and a named chat is never asked about again, even by Write the title again
  await t.ss.rewriteTitle(id);
  expect(t.asked).toHaveLength(1);
});

test("a failed run on its own is quiet and leaves the title as it was", async () => {
  turnOn();
  const t = await setup();
  const id = await t.start("Add a PromptPay QR to the checkout.");
  await t.answer(id, "Done.");
  t.answers[0].reject(new Error("timeout"));
  await settle();
  expect(t.row(id)?.modelTitle).toBeUndefined();
  expect(t.row(id)?.title).toBeUndefined();
});

test("closing a chat stops the run being made for it, and a chat with no run cancels nothing", async () => {
  turnOn();
  const t = await setup();
  const quiet = await t.start("List the files.");
  t.ss.close(quiet);
  await settle();
  expect(t.cancelled).toEqual([]);
  const id = await t.start("Add a PromptPay QR to the checkout.");
  await t.answer(id, "Done.");
  expect(t.asked).toHaveLength(1);
  const key = t.ss.chatKey(id);
  t.ss.close(id);
  await settle();
  expect(t.cancelled).toEqual([key]);
  // the words that come back late land nowhere
  t.answers[0].resolve({ title: "PromptPay QR at checkout", body: "" });
  await settle();
  expect(t.row(id)).toBeUndefined();
});
