// The store as a phone reaches it (fromStore.ts): its chats reduced for project.ts, and each of a phone's actions mapped
// to the store's own action and nothing else. Allow once is tried on the demo runtime, which settles each approval once,
// through the same settleApproval the card's buttons use.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, selectAsks, type AppState, type ApprovalItem, type Store } from "../state/store";
import { MockHost, MockRuntime } from "../runtime/mock";
import { fromStore, sourceOf, storeActions } from "./fromStore";

const PHONE = "0B5C2D11-7E4A-4F0B-9C3D-2A1B3C4D5E6F";

async function waitingApproval() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  await store.actions.selectBot("nam");
  const sent = store.actions.send("/approve");
  await vi.advanceTimersByTimeAsync(2_000);
  await sent;
  const [ask] = selectAsks(store.getState());
  return { store, ask: ask!, item: ask!.item as ApprovalItem };
}

/** A store whose actions only record what they were asked, over a state a test writes. */
function recordingStore(state: Partial<AppState>) {
  const calls: unknown[][] = [];
  const actions = {
    respondApproval: async (...args: unknown[]) => void calls.push(["respondApproval", ...args]),
    respondClarify: async (...args: unknown[]) => void calls.push(["respondClarify", ...args]),
    interrupt: async (...args: unknown[]) => void calls.push(["interrupt", ...args]),
  };
  const store = { getState: () => ({ bots: [], lastError: null, ...state }) as unknown as AppState, actions } as unknown as Pick<Store, "getState" | "actions">;
  return { store, calls };
}

const turn = { id: "t1", startedAt: 1, status: "Reading the price list", steps: [], skills: [], streaming: "" };

describe("the store as a phone sees it", () => {
  afterEach(() => vi.useRealTimers());

  it("Allow once settles the ask through settleApproval, once, with the phone as who decided", async () => {
    vi.useFakeTimers();
    const { store, ask, item } = await waitingApproval();
    const source = fromStore(store).get(ask.bot)!;
    const shown = source.items.find((i) => i.kind === "approval" && i.id === item.request_id);
    expect(shown).toMatchObject({ kind: "approval", open: true, command: item.command });
    expect(await storeActions(store).allowOnce(ask.bot, item.request_id, PHONE)).toBeNull();
    const after = store.getState().chats[ask.bot]!.items.find((i) => i.id === item.id) as ApprovalItem;
    expect(after).toMatchObject({ resolved: "once", decidedBy: PHONE });
    expect(selectAsks(store.getState())).toEqual([]);
    // Settled once: a second answer changes nothing (serve.ts never sends one for a closed ask), and the first stands.
    await storeActions(store).decline(ask.bot, item.request_id, PHONE);
    expect((store.getState().chats[ask.bot]!.items.find((i) => i.id === item.id) as ApprovalItem).resolved).toBe("once");
    expect(fromStore(store).get(ask.bot)!.items.find((i) => i.kind === "approval" && i.id === item.request_id)).toMatchObject({ open: false, resolved: "once" });
  });

  it("maps No, an answer and Stop to the store's own actions for that chat, and nothing else", async () => {
    const items = [
      { kind: "approval", id: "approval-r1", ts: 1, request_id: "r1", title: "Send", command: "send", choices: ["once", "deny"] },
      { kind: "clarify", id: "clarify-q1", ts: 2, request_id: "q1", question: "Which day?" },
    ];
    const { store, calls } = recordingStore({ chats: { buddy: { items, turn } } as unknown as AppState["chats"] });
    const actions = storeActions(store);
    // The recording store never marks a card settled, so each comes back as not taken; what matters is what was called.
    await actions.decline("buddy", "r1", PHONE);
    await actions.answer("buddy", "q1", "Friday", PHONE);
    expect(await actions.stop("buddy")).toBeNull();
    expect(calls).toEqual([
      ["respondApproval", "r1", "deny", "buddy", PHONE],
      ["respondClarify", "q1", "Friday", "buddy"],
      ["interrupt", "buddy"],
    ]);
    // Nothing is called for an ask or a chat that is not there, or a chat with no turn.
    expect(await actions.allowOnce("buddy", "nope", PHONE)).toBe("gone");
    expect(await actions.answer("kit", "q1", "x", PHONE)).toBe("gone");
    const { store: idle, calls: none } = recordingStore({ chats: { kit: { items: [], turn: null } } as unknown as AppState["chats"] });
    expect(await storeActions(idle).stop("kit")).toBe("no_turn");
    expect(none).toEqual([]);
  });

  it("reduces a chat to its sent messages, its asks and its step", () => {
    const state = {
      bots: [{ name: "buddy", display_name: "Buddy" }],
      chats: {
        buddy: {
          turn,
          items: [
            { kind: "user", id: "u1", ts: 10, text: "Hello" },
            { kind: "user", id: "u2", ts: 11, text: "Held on the Mac", held: true },
            { kind: "assistant", id: "a1", ts: 12, text: "Hi" },
            { kind: "activity", id: "act", ts: 12, turn },
            { kind: "approval", id: "approval-r1", ts: 13, request_id: "r1", title: "Send", command: "send", choices: ["once", "always", "deny"], subagent: { id: "s", name: "Writer" } },
            { kind: "approval", id: "approval-r2", ts: 14, request_id: "r2", title: "Shop", command: "pay", choices: ["once", "deny"], passOn: true, shop: { id: "s1", name: "Ton's", owner: "Ton", role: "helper" } },
            { kind: "clarify", id: "clarify-q1", ts: 15, request_id: "q1", question: "Which?", questions: [{ qid: "a", question: "A", choices: ["x"], multi_select: true }] },
          ],
        },
      },
    } as unknown as AppState;
    const source = sourceOf(state, "buddy")!;
    expect(source).toMatchObject({ key: "buddy", title: "Buddy", working: true, step: "Reading the price list", updatedAt: 15 });
    expect(source.items.map((i) => i.id)).toEqual(["u1", "a1", "r1", "r2", "q1"]);
    expect(source.items[2]).toMatchObject({ kind: "approval", from: "Writer", choices: ["once", "always", "deny"] });
    // An ask the person may only pass on to the shop's owner offers nothing, here or on a phone.
    expect(source.items[3]).toMatchObject({ choices: [], from: "Ton's" });
    expect(source.items[4]).toMatchObject({ kind: "clarify", questions: [{ id: "a", question: "A", choices: ["x"], multi: true }] });
    expect(sourceOf(state, "nope")).toBeNull();
  });
});
