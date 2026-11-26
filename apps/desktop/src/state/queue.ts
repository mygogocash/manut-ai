// The steer queue: its reducer, which held message goes out next, whether a new one is held, and the drafts that
// keep held text across a restart. Split out of store.ts (item 125d), which re-exports what it exported before.
import { hideSplitBlocks } from "../threads/types";
import type { MessageItem, Chat, AppState } from "./types";
import { withItems, patchTurn } from "./helpers";

// ---- steer queue ------------------------------------------------------------------------------
//
// A message typed in a bot's main chat while a turn runs stays in manut (a held row with a ↵ mark) instead of going
// to Hermes at once, so it can still change: Hermes keeps no way to take a message back out of its own queue. When
// the turn ends the head goes out with chat.send, one at a time, each after the previous one's turn started.

export type QueueAction =
  /** The head goes out now: no longer held, moved to the end of the timeline, its turn awaited. */
  | { type: "queue.take"; bot: string; id: string; now: number }
  /** Send now / a refused steer: this one goes out next. */
  | { type: "queue.front"; bot: string; id: string }
  /** Delete, or Edit (the text goes back to the composer). */
  | { type: "queue.drop"; bot: string; id: string }
  | { type: "queue.steering"; bot: string; id: string | null }
  /** Hermes' answer to a steer: taken (`ok`), the row joins the running turn; refused, it goes out next instead;
   *  no answer (`unknown`: Hermes may have taken it), it leaves the queue and waits for the person's Send / Delete. */
  | { type: "queue.steered"; bot: string; id: string; ok: boolean; now: number; unknown?: boolean }
  /** Send, on a steer whose answer never came: it goes out next as a normal message. */
  | { type: "queue.resend"; bot: string; id: string }
  /** A send whose turn never started (Hermes ran no turn for it): stop waiting on it. */
  | { type: "queue.idle"; bot: string; id: string };

const toEnd = (c: Chat, id: string, patch: (m: MessageItem) => MessageItem): Chat => {
  const row = c.items.find((i): i is MessageItem => i.kind === "user" && i.id === id);
  return row ? withItems(c, [...c.items.filter((i) => i !== row), patch(row)]) : c;
};

/** The running turn's live line (its activity row, where the typing dots and the answer being written sit) moved
 *  right before (`side` 0) or right after (`side` 1) user row `id`: a message steered in reads above the work it
 *  joined, a message left waiting reads under it. */
export function liveBeside(c: Chat, id: string, side: 0 | 1): Chat {
  if (!c.turn) return c;
  const live = c.items.find((i) => i.kind === "activity" && i.id === c.turn!.id);
  if (!live) return c;
  const items = c.items.filter((i) => i !== live);
  const at = items.findIndex((i) => i.kind === "user" && i.id === id);
  if (at < 0) return c;
  items.splice(at + side, 0, live);
  return withItems(c, items);
}

/** Rows steered in that the stopped turn never read: no longer Steered, marked not used (Send / Delete). Never sent
 *  again on their own: after a Stop the person decides. */
export function unsteer(c: Chat, ids: string[]): Chat {
  if (!c.items.some((i) => i.kind === "user" && ids.includes(i.id) && i.steered)) return c;
  return withItems(
    c,
    c.items.map((i) => (i.kind === "user" && ids.includes(i.id) && i.steered ? { ...withoutSteered(i), steerUnknown: true, steerUnused: true } : i)),
  );
}
const withoutSteered = ({ steered: _s, readAt: _r, ...m }: MessageItem): MessageItem => m;

/** Rows steered in that the turn just consumed: the last one waits for the bot's first words after it (several
 *  consumed together get one reply, on the last, the one the bot answers last). */
export function consumeSteers(c: Chat, ids: string[]): Chat {
  const read = c.items.filter((i): i is MessageItem => i.kind === "user" && ids.includes(i.id) && !!i.steered);
  if (!read.length) return c;
  return { ...c, steerAck: { id: read[read.length - 1].id, from: c.turn?.streaming.length ?? 0 } };
}

/** The person's last row that went out (not held, not failed, not a steer left waiting for Send / Delete). */
export function lastSent(c: Chat): MessageItem | undefined {
  for (let k = c.items.length - 1; k >= 0; k--) {
    const i = c.items[k];
    if (i.kind === "user" && !i.held && !i.error && !i.steerUnknown) return i;
  }
  return undefined;
}

/** Row `id` reached the bot at `now`: it reads "Read" (an earlier mark keeps its time). */
export function markRead(c: Chat, id: string | undefined, now: number): Chat {
  if (!id || !c.items.some((i) => i.kind === "user" && i.id === id && i.readAt === undefined && !i.held && !i.error)) return c;
  return withItems(c, c.items.map((i) => (i.kind === "user" && i.id === id ? { ...i, readAt: now } : i)));
}

/** How long a steer's reply line may be: one glance under the bubble. */
const STEER_REPLY_MAX = 140;

/** The bot's first words after it read a steer: their first line goes under that message. No words yet (a tool call
 *  with nothing written before it), it keeps waiting for the next ones. The rest stays hidden as commentary. */
export function ackSteer(c: Chat, said: string): Chat {
  const id = c.steerAck?.id;
  const line = hideSplitBlocks(said).split("\n").map((l) => l.trim()).find(Boolean);
  if (!id || !line) return c;
  const reply = line.length <= STEER_REPLY_MAX ? line : `${line.slice(0, STEER_REPLY_MAX - 1).trimEnd()}…`;
  const items = c.items.map((i) => (i.kind === "user" && i.id === id ? { ...i, steerReply: reply } : i));
  return { ...withItems(c, items), steerAck: null };
}

/** The row the running answer goes before once `id` leaves: the next user row after it (one still waiting, or
 *  typed under the answer), or none. */
function nextBefore(c: Chat, id: string): string | undefined {
  const at = c.items.findIndex((i) => i.kind === "user" && i.id === id);
  if (at < 0) return undefined;
  return c.items.slice(at + 1).find((i) => i.kind === "user" && !i.steered)?.id;
}

export function reduceQueue(c: Chat, a: QueueAction): Chat {
  const queue = c.queue ?? [];
  const without = queue.filter((x) => x !== a.id);
  switch (a.type) {
    case "queue.take": {
      if (!queue.includes(a.id)) return c;
      const moved = toEnd(c, a.id, ({ held: _h, autoSteer: _a, ...m }) => ({ ...m, ts: a.now / 1000 }));
      return { ...moved, queue: without, pendingTurn: a.id };
    }
    case "queue.front":
      return queue.includes(a.id) ? { ...c, queue: [a.id, ...without] } : c;
    case "queue.drop": {
      const unknown = c.items.some((i) => i.kind === "user" && i.id === a.id && i.steerUnknown);
      if (!queue.includes(a.id) && !unknown) return c;
      // the answer was kept above this row: it now stays above the next one (or goes back to the end)
      const moved = c.turn?.before === a.id ? patchTurn(c, (t) => ({ ...t, before: nextBefore(c, a.id) })) : c;
      return { ...withItems(moved, moved.items.filter((i) => !(i.kind === "user" && i.id === a.id))), queue: without, ...(c.steering === a.id ? { steering: null } : {}) };
    }
    case "queue.resend":
      if (!c.items.some((i) => i.kind === "user" && i.id === a.id && i.steerUnknown)) return c;
      return {
        ...withItems(c, c.items.map((i) => (i.kind === "user" && i.id === a.id ? (({ steerUnknown: _u, steerUnused: _n, ...m }) => ({ ...m, held: true }))(i) : i))),
        queue: [a.id, ...without],
      };
    case "queue.steering":
      return { ...c, steering: a.id };
    case "queue.steered": {
      if (!queue.includes(a.id)) return { ...c, steering: null };
      if (!a.ok) {
        // refused or unanswered: this row and every one behind it stop steering on their own and wait (↵ ↓ ×), so
        // none goes ahead of it; the running answer stays above them, as for any held message
        const waiting = withItems(c, c.items.map((i) => (i.kind === "user" && queue.includes(i.id) && i.autoSteer ? (({ autoSteer: _a, ...m }) => m)(i) : i)));
        if (a.unknown) {
          const marked = withItems(waiting, waiting.items.map((i) => (i.kind === "user" && i.id === a.id ? { ...i, steerUnknown: true } : i)));
          return { ...marked, queue: without, steering: null };
        }
        const kept = waiting.turn && !waiting.turn.before ? patchTurn(liveBeside(waiting, a.id, 0), (t) => ({ ...t, before: a.id })) : waiting;
        return { ...kept, queue: [a.id, ...without], steering: null };
      }
      // Hermes queued it: the bot has it
      const moved = toEnd(c, a.id, ({ held: _h, autoSteer: _a, ...m }) => ({ ...m, steered: true, ts: a.now / 1000, readAt: a.now }));
      // it joined the running turn: it sits before the messages still waiting (they go out after this turn), and
      // the turn's answer lands after it, still above those waiting ones
      const items = [...moved.items];
      const next = without.length ? items.findIndex((i) => i.kind === "user" && i.id === without[0]) : -1;
      if (next >= 0) items.splice(next, 0, items.pop()!);
      // the running turn's live line (dots, activity) stays under the message it now works on, as in a messenger
      const placed = liveBeside(withItems(moved, items), a.id, 1);
      const joined = placed.turn?.before === a.id ? patchTurn(placed, (t) => ({ ...t, before: without[0] })) : placed;
      return { ...joined, queue: without, steering: null, steeredUnread: [...(c.steeredUnread ?? []), a.id] };
    }
    case "queue.idle":
      return c.pendingTurn === a.id ? { ...c, pendingTurn: null } : c;
  }
}

/** The held row that goes out now, or null: the bridge is up, the chat was read, no turn runs, no send is waiting
 *  for its turn to start, and no steer is waiting for Hermes' answer. */
export function queueReady(state: AppState, bot: string): string | null {
  const c = state.chats[bot];
  if (!c?.queue?.length || state.conn !== "open" || !c.loaded || c.turn || c.pendingTurn || c.stale || c.steering) return null;
  return c.queue[0];
}

/** The drafts to save before a reload or quit, with every chat's held messages (and unknown steers) put back in
 *  its box in queue order, above what was typed there: nothing typed is lost (files are not kept, only the text). */
export function heldDrafts(state: AppState, drafts: Record<string, string>): Record<string, string> {
  const out = { ...drafts };
  for (const [key, c] of Object.entries(state.chats)) {
    const byId = new Map(c.items.flatMap((i) => (i.kind === "user" ? [[i.id, i] as const] : [])));
    const waiting = [...(c.queue ?? []), ...c.items.filter((i) => i.kind === "user" && i.steerUnknown).map((i) => i.id)];
    const texts = waiting.map((id) => byId.get(id)?.text?.trim() ?? "").filter(Boolean);
    if (!texts.length) continue;
    const typed = out[key]?.trim();
    out[key] = [...texts, ...(typed ? [typed] : [])].join("\n");
  }
  return out;
}

/** Whether a message typed now in `bot`'s main chat is held instead of sent: a turn runs, others wait before it,
 *  a send's turn has not started, or the chat is being read again after the bridge came back. */
export function mustHold(state: AppState, bot: string): boolean {
  const c = state.chats[bot];
  return !!c && (!!c.turn || !!c.queue?.length || !!c.pendingTurn || !!c.stale || !!c.steering);
}
