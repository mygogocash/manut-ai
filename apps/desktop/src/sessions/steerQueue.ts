// The steer queue of the sessions store's agent chats (lifted out of sessions.ts, the refactor of 27 Nov 2026).
//
// A message sent while an agent chat's turn runs stays in manut (a held row with the ↵ mark, "Waiting") instead of going to the
// agent's own queue, so it can still be sent now, steered in, edited or deleted. When the turn ends the head goes out, one per
// turn, in order. The rows reuse the bot chat's steer queue (held rows, `queue.take` / `queue.front` / `queue.drop`); the store's
// own flush, which sends through the Hermes bridge, is kept off agent chats by a standing `steering` mark (HOLD_MARK), so only
// this code sends them, to the agent.
//
// `createSteerQueue` takes everything it reads as `SteerQueueDeps`, so its rules can be read apart from the sessions store; the
// store's own tests (steerQueueSessions.test.ts) drive it through `createSessions`.
import { editBack } from "../state/queue";
import type { Store } from "../state/store";
import type { ChatEvent, ChatInput } from "./host";
import { errText } from "./sessionErrors";

type SendInput = Extract<ChatInput, { kind: "send" }>;

export interface SteerQueueDeps {
  store(): Pick<Store, "getState" | "dispatch">;
  /** The app-store key of session `id`'s chat. */
  keyOf(id: string): string | undefined;
  /** Session `id` runs as one of the app's agent chats (a Hermes folder chat goes through the bridge instead). */
  isAgent(id: string): boolean;
  input(id: string, i: ChatInput): Promise<void>;
  dispatchChat(id: string, ev: ChatEvent): void;
  note(id: string, text: string): void;
  /** Whether session `id`'s agent takes a steer (its own mid-turn input). */
  steers(id: string): boolean;
  /** The person's unsent text in chat `key`'s box. */
  draftOf(key: string): string;
  /** Runs `fn` once the current call stack is done, as the turn's end does before the next message goes. */
  later?(fn: () => void): void;
}

const HOLD_MARK = "agent-hold";

export function createSteerQueue(d: SteerQueueDeps) {
  /** What each held row sends, by its bubble id. */
  const heldInputs = new Map<string, { id: string; input: SendInput; sent?: () => void }>();
  /** Sessions whose running turn Send now stopped: its end sends the chosen one first and keeps the rest waiting. */
  const sendingNow = new Set<string>();
  const later = d.later ?? ((fn: () => void) => void setTimeout(fn, 0));
  const chatOf = (key: string) => d.store().getState().chats[key];

  /** The head held message goes out now: the row leaves the queue (moved to the end) before the request, once. */
  const sendHead = async (id: string): Promise<void> => {
    const key = d.keyOf(id);
    const head = key ? chatOf(key)?.queue?.[0] : undefined;
    if (!key || !head || chatOf(key)?.turn) return;
    const h = heldInputs.get(head);
    heldInputs.delete(head);
    d.store().dispatch({ type: "queue.take", bot: key, id: head, now: Date.now() });
    d.dispatchChat(id, { event: "message.taken", id: head });
    // no text kept for it, or the send fails: no turn starts, so no turn.end would ever send the next one
    if (!h) return later(() => void sendHead(id));
    h.sent?.();
    try {
      await d.input(id, h.input);
    } catch (e) {
      d.store().dispatch({ type: "send.failed", bot: key, id: head, error: errText(e) });
      later(() => void sendHead(id));
    }
  };

  const heldIn = (id: string, lid: string) => {
    const key = d.keyOf(id);
    return key && chatOf(key)?.queue?.includes(lid) && heldInputs.get(lid)?.id === id ? key : null;
  };

  return {
    /** Held for agent chats only, while a turn runs or messages already wait. */
    mustHold: (id: string, key: string): boolean => d.isAgent(id) && (!!chatOf(key)?.turn || !!chatOf(key)?.queue?.length),

    /** Holds `i` as row `lid` of session `id`'s chat: `show` puts the row down, `sent` runs once it goes out. */
    hold(id: string, key: string, lid: string, i: SendInput, show: () => void, sent?: () => void): void {
      if (chatOf(key)?.steering !== HOLD_MARK) d.store().dispatch({ type: "queue.steering", bot: key, id: HOLD_MARK });
      heldInputs.set(lid, { id, input: i, sent });
      show();
      // the row reads "Waiting", as a message the agent queued does
      d.dispatchChat(id, { event: "message.queued", id: lid });
    },

    /** A turn ended. Stop (not Send now) throws away what waited, as the agents themselves do; otherwise the head goes. */
    afterTurn(id: string, stopped: boolean): void {
      const key = d.keyOf(id);
      // a Send now mark is used by this turn's end, whatever waits: a later real Stop is never read as Send now
      const now = sendingNow.delete(id);
      if (!key || !chatOf(key)?.queue?.length) return;
      if (stopped && !now) {
        for (const lid of [...(chatOf(key)?.queue ?? [])]) {
          heldInputs.delete(lid);
          d.store().dispatch({ type: "queue.take", bot: key, id: lid, now: Date.now() });
          d.dispatchChat(id, { event: "message.dropped", id: lid });
        }
        return;
      }
      later(() => void sendHead(id));
    },

    /** The ↵ ↓ × buttons of a waiting message in session `id`'s chat. */
    async pick(id: string, lid: string, c: "now" | "steer" | "edit" | "delete"): Promise<void> {
      const key = heldIn(id, lid);
      if (!key) return; // already with the agent: the menu offers nothing
      const st = d.store();
      if (c === "delete" || c === "edit") {
        const text = heldInputs.get(lid)?.input.text ?? "";
        heldInputs.delete(lid);
        st.dispatch({ type: "queue.drop", bot: key, id: lid });
        if (c === "edit") st.dispatch({ type: "ui.draft", bot: key, text: editBack(text, d.draftOf(key)) });
        return;
      }
      if (c === "now") {
        st.dispatch({ type: "queue.front", bot: key, id: lid });
        if (!chatOf(key)?.turn) return void sendHead(id);
        // one Stop, however often it is pressed; the stopped turn's end sends this one first
        if (sendingNow.has(id)) return;
        sendingNow.add(id);
        await d.input(id, { kind: "interrupt" }).catch((e) => {
          sendingNow.delete(id);
          d.note(id, errText(e));
        });
        return;
      }
      // Steer: the agent's own mid-turn input, text only; with pictures, or no turn left to steer, it goes out next
      const h = heldInputs.get(lid)!;
      if (!d.steers(id)) return;
      if (!chatOf(key)?.turn || h.input.images?.length) {
        st.dispatch({ type: "queue.front", bot: key, id: lid });
        if (!chatOf(key)?.turn) void sendHead(id);
        return;
      }
      try {
        await d.input(id, { kind: "steer", id: lid, text: h.input.text });
        heldInputs.delete(lid);
        // with the agent now: no longer held, "Waiting" until the agent says it took it
        st.dispatch({ type: "queue.take", bot: key, id: lid, now: Date.now() });
      } catch {
        st.dispatch({ type: "queue.front", bot: key, id: lid });
      }
    },
  };
}

export type SteerQueue = ReturnType<typeof createSteerQueue>;
