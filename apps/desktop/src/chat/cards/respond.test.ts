// The one path an approval is settled by, whether from its card in the chat or from Home: the store's own
// respondApproval, then a look at the card to see whether the runtime took the answer. Tried on the demo runtime,
// which settles each approval once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n";
import { createStore, selectAsks, type ApprovalItem } from "../../state/store";
import { MockHost, MockRuntime } from "../../runtime/mock";
import { APPROVAL_SEED } from "../../runtime/mock/seed";
import { ALLOW_LABEL, respond, settleApproval } from "./respond";

/** A demo store on a runtime of its own, with Nam's scripted approval waiting on the person. */
async function waitingApproval() {
  const store = createStore(new MockRuntime(new MockHost()), { firstRoster: "all", hiddenBots: () => [], resume: () => null });
  await store.actions.init();
  await store.actions.selectBot("nam");
  const sent = store.actions.send("/approve");
  await vi.advanceTimersByTimeAsync(2_000);
  await sent;
  const [ask] = selectAsks(store.getState());
  return { store, ask, item: ask.item as ApprovalItem };
}

describe("settling an approval", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers it through the store, which marks the card settled with the choice, and reports no error", async () => {
    vi.useFakeTimers();
    const { store, ask, item } = await waitingApproval();
    expect(item).toMatchObject({ kind: "approval", command: APPROVAL_SEED.command });
    expect(await settleApproval(store, ask.bot, item, "once")).toBeNull();
    const after = store.getState().chats.nam.items.find((i) => i.id === item.id) as ApprovalItem;
    expect(after.resolved).toBe("once");
    expect(selectAsks(store.getState())).toEqual([]);
    // the runtime carried on with the action it was allowed to take
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.getState().chats.nam.items.some((i) => i.kind === "assistant" && i.text === APPROVAL_SEED.done("once"))).toBe(true);
  });

  it("settles once: a second answer is refused by the runtime, and the first one stands", async () => {
    vi.useFakeTimers();
    const { store, ask, item } = await waitingApproval();
    expect(await settleApproval(store, ask.bot, item, "once")).toBeNull();
    await settleApproval(store, ask.bot, item, "deny");
    const after = store.getState().chats.nam.items.find((i) => i.id === item.id) as ApprovalItem;
    expect(after.resolved).toBe("once");
    expect(store.getState().lastError).toMatch(/no pending approval/);
  });

  it("says why when the runtime does not take the answer, and leaves the card open", async () => {
    vi.useFakeTimers();
    const { store, ask, item } = await waitingApproval();
    const error = await settleApproval(store, ask.bot, { ...item, request_id: "not-this-one" }, "once");
    expect(error).toMatch(/no pending approval not-this-one/);
    expect(selectAsks(store.getState()).map((a) => a.item.id)).toEqual([item.id]);
  });
});

describe("a respond action", () => {
  it("reports the store's error when the card it answers is still open afterwards, and a fallback when there is none", async () => {
    setLang("en");
    const state = (open: boolean, lastError: string | null) => ({
      chats: { nam: { items: [{ kind: "clarify", id: "c1", ts: 1, request_id: "q1", question: "Which page?", ...(open ? {} : { answer: "Facebook" }) }] } },
      lastError,
    });
    const store = (open: boolean, lastError: string | null) => ({ getState: () => state(open, lastError) }) as never;
    expect(await respond(store(false, null), "nam", "c1", async () => {})).toBeNull();
    expect(await respond(store(true, "offline"), "nam", "c1", async () => {})).toBe("offline");
    expect(await respond(store(true, null), "nam", "c1", async () => {})).toBe("it was not taken");
    // a card that is gone has nothing left to answer
    expect(await respond(store(true, null), "nam", "gone", async () => {})).toBeNull();
  });
});

describe("the settled line's words", () => {
  it("name each choice as the card's line does", () => {
    expect(ALLOW_LABEL).toEqual({ once: "card.allowedOnce", session: "card.allowedSession", always: "card.allowedAlways", deny: "card.denied" });
  });
});
