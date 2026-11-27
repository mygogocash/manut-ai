// The app's one set of Buddy's reach cards on the Connected runtime (item 102l-3, `buddyReach.ts`), over the app's store and item 97's
// reader of it, made the first time a screen asks for it (Buddy's chat box, or a card's press). It puts itself in the way of the
// store's runtime (`buddyReachBridge.ts`), which `state/store.ts` wrapped when the store was made on Connected; until it is made,
// nothing is listed, so nothing is told to Buddy and no block is read.
import { getStore } from "../state/store";
import { getSessions } from "../sessions/sessions";
import { getHost } from "../sessions/host";
import { appReader } from "../chat/box/contextReader";
import { runtimeKind } from "../runtime";
import { createBuddyReach, type BuddyReach } from "./buddyReach";
import { setActiveBuddyReach } from "./buddyReachBridge";

let made: BuddyReach | null = null;

export function getBuddyReach(): BuddyReach {
  if (made) return made;
  const store = getStore();
  const reach = createBuddyReach({
    store: () => store,
    reader: () => appReader({ store, sessions: getSessions(), host: getHost() }),
    connected: () => runtimeKind() === "http",
  });
  // signing out, or no longer owning a shop, takes that shop's lists along
  store.subscribe(() => reach.prune());
  setActiveBuddyReach(reach);
  made = reach;
  return reach;
}
