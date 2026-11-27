// The whole app view model: one reducer, one store, one React hook. UI nodes only read this and call
// its actions; they never edit this file.
//
// Its sections live beside it (item 125d): types.ts, activity.ts, prefs.ts, helpers.ts, chatRoutes.ts, queue.ts,
// selectors.ts, reducer.ts and createStore.ts, each importing only from the ones before it. This file keeps the
// app's one store, its notifications and the hook, and re-exports every name it exported when it was one file, so
// no import elsewhere changed.
import { useSyncExternalStore } from "react";
import { createRuntime, runtimeKind } from "../runtime";
import { activeBuddyReach, withBuddyReach } from "../jobs/buddyReachBridge";
import {
  bringToFront,
  createNoteGate,
  noteFor,
  sessionNote,
  sessionRings,
  showNewDevice,
  showNote,
  watchMissedNote,
  windowWatched,
  type SessionNote,
} from "../lib/notify";
import { noteAsk } from "../chat/cards/askNote";
import { settleApproval } from "../chat/cards/respond";
import { appSounds, soundFor, type SoundBoard } from "../lib/sounds";
import { parseResume, RESUME_KEY } from "../app/resume";
import type { BridgeEvent, Msg } from "../lib/protocol";
import type { ApprovalItem, AppState } from "./types";
import { readList } from "./prefs";
import { chatRoute, folderKey, isSessionChat } from "./chatRoutes";
import { askOpen, selectAsks } from "./selectors";
import type { Action } from "./reducer";
import { createStore, type Actions, type Store } from "./createStore";

export { BUBBLE_STYLES, CHAT_WIDTHS, PALETTES, MENU_PAGES, isMenuPage } from "./types";
export type {
  PanelTabId, Step, Turn, SubagentRow, Fanout, MessageItem, SentFile, OutFile, ActivityItem, AskExpiry, ApprovalItem,
  ClarifyItem, RoutineItem, RoutineAddedItem, PluginAddedItem, BriefNoticeItem, SystemItem, ThreadLinkItem,
  ThreadRouteItem, HelpersAskItem, ReachAskItem, ChatItem, TimelineItem, Chat, ReplyChip, Peek, Theme, Palette, BubbleStyle, TextSize, ChatWidth, Look,
  MenuPage, Ui, FocusAsk, ShopsState, AppState,
} from "./types";
export { activityText, WORKING, THINKING, PENDING_TURN_MS, THINKING_MAX, parsePlan, liveLabel, answerSoFar, turnHasActivity } from "./activity";
export { DEFAULT_LOOK, LOOK_VERSION, parseLook, savedLook, ROSTER_KEY, seedRoster, readTheme, initialState } from "./prefs";
export { SUB_STEPS, subagentEnded, answerSlot, replyOf, replyChipFor } from "./helpers";
export { setChatRoute, chatRoute, folderKey, isSessionChat, chatTarget } from "./chatRoutes";
export type { ChatRoute } from "./chatRoutes";
export { reduceQueue, queueReady, heldDrafts, mustHold } from "./queue";
export type { QueueAction } from "./queue";
export {
  selectTimeline, shopName, viewedShopName, askOpen, selectAsks, asksIn, askFrom, askText, selectSidebarBots, selectUnlisted,
  selectUnreadTotal,
} from "./selectors";
export type { Ask } from "./selectors";
export { briefNoticed, reduce } from "./reducer";
export type { Action } from "./reducer";
export { newWatchRows, onBridgeEvent, createStore } from "./createStore";
export type { Actions, BridgeLike, Store, StoreOptions } from "./createStore";

// ---- app singleton + hook -------------------------------------------------------------------

/** "Notify me" (Settings > General). On unless turned off; saved on this computer. */
export function notifyEnabled(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem("manut.notify") !== "off";
  } catch {
    return true;
  }
}

export function setNotifyEnabled(on: boolean): void {
  try {
    localStorage.setItem("manut.notify", on ? "on" : "off");
  } catch {
    /* no storage */
  }
}

/** "Also notify on errors" (Settings > General): a turn that ends with an error raises a notification too. Off unless
 *  turned on: an error only marks its chat. */
export function notifyErrorsEnabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("manut.notifyErrors") === "on";
  } catch {
    return false;
  }
}

export function setNotifyErrorsEnabled(on: boolean): void {
  try {
    localStorage.setItem("manut.notifyErrors", on ? "on" : "off");
  } catch {
    /* no storage */
  }
}

let singleton: Store | null = null;
export function getStore(): Store {
  // On Connected, Buddy's reach cards stand in the runtime's way (item 102l-3, src/jobs/buddyReachBridge.ts); they act only once a
  // list holds a conversation, so every other runtime is handed over as it is.
  return (singleton ??= createStore(runtimeKind() === "http" ? withBuddyReach(createRuntime(), activeBuddyReach) : createRuntime(), {
    onEvent(ev, state) {
      notifySessionEvent(ev, state);
    },
    onWatchMissed: notifyWatchMissed,
    onAction: (a, state) => soundOf(a, state, appSounds()),
    onSettled: () => appSounds().settle(),
    resume: () => {
      try {
        return parseResume(typeof localStorage !== "undefined" ? localStorage.getItem(RESUME_KEY) : null);
      } catch {
        return null;
      }
    },
    hiddenBots: () => readList("manut.hidden"),
    firstRoster: "all",
  }));
}

/** True while the person sees chat `key`: the window has focus and shows that bot's chat or that session. */
function watchingChat(state: AppState, key: string): boolean {
  if (!windowWatched()) return false;
  if (isSessionChat(key)) return state.ui.view === "session" && sessionKeyOf?.(state.ui.session) === key;
  return state.ui.view === "chat" && state.selectedBot === key;
}

/** Sounds: your own send (any chat), and a bot's or SESSIONS chat's events. A chat's (re)load and a dropped
 *  connection tell the board which asks are replays. */
export function soundOf(a: Action, state: AppState, board: SoundBoard): void {
  if (a.type === "local.user") board.offer("send");
  else if (a.type === "chat.opened") board.opened(a.bot);
  else if (a.type === "conn" && a.status !== "open") board.unsettle();
  else if (a.type === "event") {
    const ev = a.ev.session ? { ...a.ev, bot: folderKey(a.ev.bot, a.ev.session) } : a.ev;
    if (ev.event === "turn.start") turnStarts.set(ev.bot, (turnStarts.get(ev.bot) ?? 0) + 1);
    const s = soundFor(ev, {
      watching: (key) => watchingChat(state, key),
      open: (key, id) => selectAsks(state).some((x) => x.bot === key && x.item.request_id === id),
    });
    // a finish is named by its chat and its turn, so a turn that ends twice (a replay, a reconnect) chimes once
    if (s) board.offer(s.sound, s.ask ? { chat: ev.bot, id: s.ask } : s.sound === "finish" ? { chat: ev.bot, id: finishKey(ev.bot) } : undefined);
  }
}

/** How many turns each chat has started, so the end of one turn is named by it. */
const turnStarts = new Map<string, number>();
let finishesWithoutStart = 0;
/** The name of the finish of `bot`'s running turn: its turn's number, or a fresh one for an adapter that sends no start. */
const finishKey = (bot: string): string => {
  const n = turnStarts.get(bot);
  return n ? `turn:${n}` : `finish:${++finishesWithoutStart}`;
};

/** Rings with no words wait for the question that says what they want (notify.ts `createNoteGate`). */
const noteGate = createNoteGate();

/** A system notification for a chat event, unless the person is looking at that chat. SESSIONS chats
 *  (`fold:` / `agent:` keys) name themselves through their route and open their own view. A question with no text
 *  waits for a texted one (8 s); an error notifies only with "Also notify on errors". */
export function notifySessionEvent(ev: BridgeEvent, state: AppState, store?: Pick<Store, "getState" | "actions">): void {
  if (!notifyEnabled()) return;
  // A helper signed in on a new device at a shop the person owns: Look first (and a click on the notification) opens Settings ›
  // People for that shop, where its owner can remove access, as the notification's words say (notify.ts `showNewDevice`)
  if (ev.event === "device.new") {
    const shop = ev.shop.id;
    void showNewDevice({ id: ev.id, helper: ev.helper, shop: ev.shop.name, at: ev.at * 1000 }, () => void openPeopleOf(shop, store ?? singleton));
    return;
  }
  const watching = (bot: string) => watchingChat(state, bot);
  const name = (bot: string) => chatRoute(bot)?.label ?? state.bots.find((b) => b.name === bot)?.display_name ?? bot;
  const note = noteFor(ev, { name, watching, errors: notifyErrorsEnabled(), waiting: () => selectAsks(state).length });
  if (!note) return;
  const asks = ev.event === "approval.request" || ev.event === "clarify.request";
  const empty = ev.event === "clarify.request" && !ev.question.trim();
  const app = () => store ?? singleton ?? undefined;
  // Look first opens the app on the request itself, scrolled into view and focused; any other note opens its chat
  const open = () => {
    if (asks) {
      void app()?.actions.jumpToAsk(note.bot, `${ev.event === "approval.request" ? "approval" : "clarify"}-${ev.request_id}`);
      return;
    }
    const route = chatRoute(note.bot);
    if (route) route.open();
    else void singleton?.actions.selectBot(note.bot);
  };
  // Approve is offered only to a request the card itself can answer, and the system reads it only for a message or a reply
  // (notify-rules): what it does is the card's Allow once
  const approve =
    ev.event === "approval.request" && note.ask?.canApprove
      ? () => {
          const target = app();
          return target ? approveFromNotification(target, note.bot, ev.request_id) : undefined;
        }
      : undefined;
  noteGate.offer(note.bot, empty ? "empty" : asks ? "ask" : "plain", () => void showNote(note, open, ev.event === "message" && !!ev.watch, approve));
}

/** Shows Settings › People for `shop`: the shop's own page of who can use Manut AI for it, which is where a helper's new device
 *  is dealt with. The shop is shown first, since the page lists the people of the shop every page shows. If the shop cannot be
 *  shown (it left the person's list meanwhile, or the switch was refused), the page is not opened on another shop's people: the
 *  app comes forward as it is, and says why as any failed switch does. */
export async function openPeopleOf(shop: string, store: Pick<Store, "getState" | "actions"> | null | undefined): Promise<void> {
  if (!store) return;
  await store.actions.switchShop(shop);
  if (store.getState().shops.current !== shop) return;
  store.actions.openSettings("people");
}

/** Approve pressed on a notification: the card's own Allow once, through the card's own path (`settleApproval`, the one way
 *  every button settles an approval; the runtime's decide route then settles it once). If the request is no longer waiting,
 *  or the answer was refused or no word came back, the app comes forward on that card with what happened (a refusal's
 *  words under it), so a notification never swallows an answer. */
export async function approveFromNotification(store: Pick<Store, "getState" | "actions">, bot: string, requestId: string): Promise<void> {
  const chat = store.getState().chats[bot];
  const item = chat?.items.find((i): i is ApprovalItem => i.kind === "approval" && i.request_id === requestId);
  if (item && askOpen(chat.items, item)) {
    const error = await settleApproval(store, bot, item, "once");
    if (error === null) return;
    noteAsk(requestId, error);
  }
  await bringToFront();
  await store.actions.jumpToAsk(bot, item?.id ?? `approval-${requestId}`);
}

/** One note for the automation answers `bot` got while manut was closed ("<bot>: N watch alerts"). */
export function notifyWatchMissed(bot: string, rows: Msg[], state: AppState): void {
  if (!notifyEnabled() || watchingChat(state, bot)) return;
  const who = state.bots.find((b) => b.name === bot)?.display_name ?? bot;
  const note = watchMissedNote(who, bot, rows);
  if (note) void showNote(note, () => void singleton?.actions.selectBot(bot), true);
}

/** A system notification for what session `id` did outside its chat (its program ended badly, it could not start, its
 *  terminal rang), unless the person is looking at that session. A clean exit only marks the row. A click opens the
 *  session. */
export function notifySessionNote(id: string, n: SessionNote, state: AppState): void {
  if (!notifyEnabled() || !sessionRings(n)) return;
  if (n.told && notifyErrorsEnabled()) return; // the failed turn's own notification said it
  if (windowWatched() && state.ui.view === "session" && state.ui.session === id) return;
  const fire = () => void showNote(sessionNote(id, n), () => singleton?.actions.openSession(id));
  // a session with a chat can follow its ring with the question itself; a bare terminal never says more than the ring
  const key = n.kind === "bell" ? (sessionKeyOf?.(id) ?? null) : null;
  if (key) noteGate.offer(key, "empty", fire);
  else fire();
}

/** Set by SESSIONS: the chat key shown for a session id (so its own notifications stay quiet). */
let sessionKeyOf: ((id: string | null) => string | null) | null = null;
export function setSessionKeyLookup(fn: (id: string | null) => string | null): void {
  sessionKeyOf = fn;
}

/** The whole view model plus actions. Re-renders on any state change. */
export function useStore(): AppState & Actions {
  const s = getStore();
  return useSyncExternalStore(s.subscribe, s.getSnapshot, s.getSnapshot);
}
