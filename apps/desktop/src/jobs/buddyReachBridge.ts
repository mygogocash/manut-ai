// Buddy's reach cards in the way of the runtime the store talks to (item 102l-3, `buddyReach.ts`). Its own file, importing only types,
// so the app's store (`state/store.ts`) can wrap the Connected runtime with it without taking in the cards and what they import.
import type { BridgeEvent, Op, OpParams } from "../lib/protocol";
import type { RuntimeAdapter } from "../runtime/adapter";

/** What the cards do with what passes: `buddyReach.ts`'s `outgoing`, `incoming` and `settled`. */
export interface ReachHooks {
  outgoing<K extends Op>(op: K, params: OpParams<K> | undefined): OpParams<K> | undefined;
  incoming(ev: BridgeEvent): BridgeEvent;
  settled(ev: BridgeEvent): Promise<void>;
}

/** `inner` with the cards in its way: each request passes `outgoing` (Buddy's note beside a message), and each event passes `incoming`
 *  before the store takes it and `settled` after. `hooks` is read each time, so the cards can be made after the store: until then
 *  nothing is listed, and every request and event is as it was. Every other method is `inner`'s own. */
export function withBuddyReach(inner: RuntimeAdapter, hooks: () => ReachHooks | null): RuntimeAdapter {
  return {
    get kind() {
      return inner.kind;
    },
    get capabilities() {
      return inner.capabilities;
    },
    get status() {
      return inner.status;
    },
    connect: () => inner.connect(),
    close: () => inner.close(),
    request: (op, params) => {
      const h = hooks();
      return inner.request(op, h ? h.outgoing(op, params) : params);
    },
    on: (event, handler) => inner.on(event, handler),
    onAny: (handler) =>
      inner.onAny((ev) => {
        const h = hooks();
        const seen = h ? h.incoming(ev) : ev;
        handler(seen);
        if (h) void h.settled(seen);
      }),
    onStatus: (handler) => inner.onStatus(handler),
  };
}

let current: ReachHooks | null = null;

/** The cards the app's store passes its runtime through, once made (`buddyReachApp.ts`). */
export const activeBuddyReach = (): ReachHooks | null => current;

/** Puts the app's cards in the way (null: none). */
export function setActiveBuddyReach(hooks: ReachHooks | null): void {
  current = hooks;
}
