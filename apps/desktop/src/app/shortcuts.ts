// App-wide keyboard shortcuts. ⌘ on macOS, Ctrl elsewhere. These are the defaults: every one but ⌘1…⌘9 and Esc can be set in
// Settings › General's Keyboard list, kept on this Mac (keys.ts, item 99):
//   ⌘1…⌘9  open team member 1 to 9 (the Team page's order)   ⌘K  the command palette (src/palette): where to go, what to
//          do and the chats History finds; ⌘K again closes it (in a terminal on macOS it clears the terminal instead:
//          engine-input.ts, and Ctrl+K in a terminal is the program's)
//   ⌘F     find in the chat in view (src/chat/find): a bar over its messages and steps; in a terminal, in a pane or field that
//          has a find of its own, or over an open menu or dialog it is theirs, and with no chat on screen it does nothing
//   ⌘.     show or hide Details                    ⌘,  Settings
//   ⌘J     jump to the next approval or question waiting on you (any bot or SESSIONS chat)
//   ⌘⇧G   maximise the side panel in place, or restore it (Esc restores; a closed panel opens on Plans)
//   ⌘N ⌘T  the Code page's TERMINALS + menu (a CLI as a chat with Kit, or the Shell or a CLI in a terminal, which has
//          the focus); the Code page opens first
//   ⌘⇧]    the next terminal session (the Code page's order, wrapping)  ⌘⇧[  the previous one
//   ⌘⌥↑ ⌘⌥↓ the previous and the next lane in the side menu's order, wrapping (item 167a; Ctrl+Shift+Alt with the arrow off
//          macOS, as Paradev's previous and next workspace); it only opens the lane, and answers none of its asks
//   ⌘W     (the menu's Close Window) closes the focused split pane while a split has the keyboard, else the window
//   Esc    stop the running answer (only when no popover, field or dialog wants Esc first)
//   Ctrl+` the bottom terminal panel, show or hide, on every OS (Ctrl on macOS too, as in VS Code; a maximised side
//          panel goes back to its own width first, so the terminal shows); taken before a
//          terminal sees it, so it works with the keyboard inside a terminal (it is manut's, not the program's)
// An approval card's own 1/2/3 keys live on the card (src/chat/cards), never here.
// None of these fire while an input method is composing (a Korean, Japanese or Chinese word not yet committed).
import { folderGroups, getFolderPrefs, orderFolders } from "../sessions/folders";
import { useEffect } from "react";
import { getStore, selectAsks, selectSidebarBots, type Ask, type FocusAsk } from "../state/store";
import { getSessions } from "../sessions/sessions";
import { openNewSessionMenu } from "../sessions/newMenu";
import { SESSIONS_ENTRY } from "../sessions/entry";
import { isTerminalRec } from "../sessions/agents";
import { composing } from "../lib/ime";
import { getTermPanel, toggleTerminal } from "../terminal/state";
import { isFirstRunOpen } from "../onboarding/flow";
import { listenMenuClose } from "./menuClose";
import { paletteOpen, togglePalette } from "../palette/state";
import { currentKeys, keysRecording, matches, type KeyAction, type Keys } from "./keys";
import { toggleSide } from "../sidebar/sideState";
import { keepsFind, openChatFind } from "../chat/find/host";
import { openLane } from "../code/Lanes";
import { menuLaneIds } from "../sidebar/laneGroups";
import { menuLanesNow } from "../sidebar/MenuLanes";

export const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** What a keydown means, or null. Pure so it can be tested without a DOM: the settable actions' keys come from `keys`
 *  (the person's own on this Mac, else this system's defaults: keys.ts); ⌘1 to ⌘9 (team members) and Esc are fixed. */
export function shortcutFor(
  e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number },
  mac: boolean,
  keys: Keys = currentKeys(mac),
): { kind: "bot"; index: number } | { kind: "session" | "lane"; step: 1 | -1 } | { kind: "search" | "find" | "details" | "settings" | "stop" | "next-ask" | "graph" | "new-session" | "terminal" | "sidebar" } | null {
  if (composing(e)) return null;
  const hit = (a: KeyAction) => keys[a].some((c) => matches(c, e));
  // the bottom terminal panel first: its key is taken before a terminal sees it (onTerminalKey)
  if (hit("terminal")) return { kind: "terminal" };
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) return { kind: "bot", index: Number(e.key) - 1 };
  if (hit("graph")) return { kind: "graph" };
  if (hit("sidebar")) return { kind: "sidebar" };
  if (hit("session-next")) return { kind: "session", step: 1 };
  if (hit("session-prev")) return { kind: "session", step: -1 };
  if (hit("lane-prev")) return { kind: "lane", step: -1 };
  if (hit("lane-next")) return { kind: "lane", step: 1 };
  if (hit("search")) return { kind: "search" };
  if (hit("details")) return { kind: "details" };
  if (hit("settings")) return { kind: "settings" };
  if (hit("next-ask")) return { kind: "next-ask" };
  if (hit("new-session")) return { kind: "new-session" };
  // last of the settable keys: find is a newer default than any key the person has set, so ⌘F they gave another action stays theirs
  if (hit("find")) return { kind: "find" };
  if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return { kind: "stop" };
  return null;
}

/** The session ⌘⇧] / ⌘⇧[ goes to from `current` (none open: the first, or the last going back), wrapping. */
export function stepSession(ids: string[], current: string | null, step: 1 | -1): string | null {
  if (!ids.length) return null;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return step === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(at + step + ids.length) % ids.length];
}

/** The ask ⌘J goes to: the one after the last jumped-to (in age order), wrapping; the oldest first. */
export function nextAsk(asks: Ask[], last: FocusAsk | null): Ask | null {
  if (!asks.length) return null;
  const at = last ? asks.findIndex((a) => a.bot === last.bot && a.item.id === last.id) : -1;
  return asks[(at + 1) % asks.length];
}

const inTerminal = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.(".xterm");

/** Terminal session ids in TERMINALS order: one group per folder however its path is spelled (`folderGroups`, as the
 *  Code page groups them), the groups in the saved order. */
export function terminalOrder(rows: readonly { id: string; cwd: string }[], order: readonly string[]): string[] {
  return orderFolders(folderGroups(rows), order).flatMap((g) => g.rows.map((r) => r.id));
}

/** Open the previous (-1) or next (1) lane in the side menu's order (item 167a: MenuLanes.tsx, the project the Code page shows
 *  first), wrapping at the ends; with no lane open, the first or the last. It only opens the lane, as its row does: no ask is
 *  answered, nothing is sent, and a lane that asks opens with its card in view. */
export function stepLane(step: 1 | -1): void {
  const store = getStore();
  const s = store.getState();
  const to = stepSession(menuLaneIds(menuLanesNow()), s.ui.view === "session" ? s.ui.session : null, step);
  if (to) openLane(to);
}

/** Open the next (1) or previous (-1) terminal session in TERMINALS order: the folder groups as the Code page shows them. */
function stepTerminal(step: 1 | -1) {
  const store = getStore();
  const s = store.getState();
  const ss = getSessions().getState();
  const ids = terminalOrder(ss.list.filter((r) => isTerminalRec(ss.agents, r)), getFolderPrefs().order);
  const to = stepSession(ids, s.ui.view === "session" ? s.ui.session : null, step);
  if (to) store.actions.openSession(to);
}

// Ctrl+` is taken on the way down, before a focused terminal (xterm stops the keys it handles) can claim it. The
// panel lives under the chat column, which a maximised side panel hides: showing it restores the side panel first
export function onTerminalKey(e: KeyboardEvent): void {
  // While the first-run setup fills the window, every key is the setup's: a shortcut would open a page, a chat or
  // the terminal behind it, where the person cannot see what changed. While Settings waits for an action's new keys, they
  // are the keys being set, not a shortcut.
  if (isFirstRunOpen(getStore().getState().ui) || keysRecording()) return;
  const hit = shortcutFor(e, isMac());
  // Ctrl+Shift+] / [ on Windows and Linux: manut's own chord, which no shell needs; inside a terminal xterm would
  // take it (as Ctrl+] / Ctrl+[), so it is taken here first. Every other Ctrl+key in a terminal stays the program's
  if (hit?.kind === "session" && !isMac() && SESSIONS_ENTRY && inTerminal(e.target)) {
    e.preventDefault();
    e.stopPropagation();
    stepTerminal(hit.step);
    return;
  }
  if (hit?.kind !== "terminal") return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  const store = getStore();
  if (!getTermPanel().open && store.getState().ui.panelMax) store.actions.setPanelMax(false);
  toggleTerminal();
}

/** Every other shortcut, as its key goes up through the page (exported so a test can press one). */
export function onShortcutKey(e: KeyboardEvent): void {
  if (isFirstRunOpen(getStore().getState().ui) || keysRecording()) return;
  const hit = shortcutFor(e, isMac());
  if (!hit || hit.kind === "terminal") return;
  if (!SESSIONS_ENTRY && (hit.kind === "new-session" || hit.kind === "session" || hit.kind === "lane")) return;
  // In a terminal session, Ctrl+<key> belongs to the program (Ctrl+K kills a line); ⌘ on macOS stays ours.
  if (!isMac() && inTerminal(e.target)) return;
  // ⌘K in a macOS terminal clears it (engine-input.ts); the terminal keeps the key
  if (hit.kind === "search" && inTerminal(e.target)) return;
  // While the palette is open its field has the keys: only ⌘K (which closes it) is still a shortcut.
  if (paletteOpen() && hit.kind !== "search") return;
  if (hit.kind === "find") {
    // ⌘F is first the place that already took it (a terminal's find says so with preventDefault, as does a field with its own),
    // then any place that keeps it (a terminal, its bar, a pane marked data-own-find, an open menu or dialog); the chat's bar
    // opens only where none of them did, and only with a chat on screen. With none, the key is left as it was.
    if (e.defaultPrevented || keepsFind(e.target)) return;
    if (openChatFind(e.target)) e.preventDefault();
    return;
  }
  const store = getStore();
  const s = store.getState();
  const a = store.actions;
  if (hit.kind === "stop") {
    // Esc belongs to whatever is open first (popover, search field, inline rename, a card's input).
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest("input, [role=dialog], [role=menu], [role=listbox]")) return;
    // Esc in the bottom terminal panel is the shell's: it neither stops an answer nor closes the panel
    if (t && t.closest(".termpanel")) return;
    // a maximised panel goes back to its own width first (the chat behind it is inert anyway)
    if (s.ui.panelMax && s.ui.panelOpen) {
      e.preventDefault();
      a.setPanelMax(false);
      return;
    }
    const bot = s.selectedBot;
    if (s.ui.view === "chat" && bot && s.chats[bot]?.turn) {
      e.preventDefault();
      void a.interrupt();
    } else if (s.ui.view === "session" && s.ui.session) {
      // a SESSIONS chat: Esc is the agent's own interrupt (Claude Code `interrupt`, Codex `turn/interrupt`,
      // pi `abort`, Hermes `session.interrupt`)
      const key = getSessions().chatKey(s.ui.session);
      if (key && s.chats[key]?.turn) {
        e.preventDefault();
        void getSessions().interrupt(s.ui.session);
      }
    }
    return;
  }
  e.preventDefault();
  if (hit.kind === "graph") {
    // maximise the side panel in place, or restore it; a closed panel opens on Plans
    if (s.ui.panelMax && s.ui.panelOpen) a.setPanelMax(false);
    else if (s.selectedBot) {
      if (s.ui.view !== "chat") a.closeSettings();
      a.setPanelMax(true, s.ui.panelOpen ? undefined : "runs");
    }
  } else if (hit.kind === "bot") {
    const b = selectSidebarBots(s)[hit.index];
    if (b) void a.selectBot(b.name);
  } else if (hit.kind === "new-session") {
    // The + menu lives on the Code page. Away from it, the page opens first and its menu opens as it mounts (newMenu.ts).
    if (s.ui.view !== "code") a.openPage("code");
    openNewSessionMenu();
  } else if (hit.kind === "session") {
    stepTerminal(hit.step);
  } else if (hit.kind === "lane") {
    stepLane(hit.step);
  } else if (hit.kind === "next-ask") {
    const n = nextAsk(selectAsks(s), s.ui.focusAsk);
    if (n) void a.jumpToAsk(n.bot, n.item.id);
  } else if (hit.kind === "search") {
    // The menu's Search button does the same: the palette opens over whatever is open, and Esc gives the focus back.
    togglePalette();
  } else if (hit.kind === "details") {
    // a SESSIONS chat has its own panel (its Plans); anywhere else the bot's chat comes back first
    if (s.ui.view !== "chat" && s.ui.view !== "session") a.closeSettings();
    a.togglePanel();
  } else if (hit.kind === "sidebar") {
    toggleSide();
  } else if (hit.kind === "settings") {
    if (s.ui.view === "settings") a.closeSettings();
    else a.openSettings();
  }
}

export function useShortcuts(): void {
  useEffect(() => {
    // Close Window (⌘W) from the menu bar: a split pane with the keyboard closes before the window does
    listenMenuClose();
    window.addEventListener("keydown", onTerminalKey, true);
    window.addEventListener("keydown", onShortcutKey);
    return () => {
      window.removeEventListener("keydown", onTerminalKey, true);
      window.removeEventListener("keydown", onShortcutKey);
    };
  }, []);
}
