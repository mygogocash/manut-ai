// What the command palette lists, built from data so a later item adds one line.
//
// It adds no power of its own. "Go to" rows only open a page. "Do" rows only press what a person could press somewhere
// else in the app, each calling the function that button calls; every definition names where else it is pressed
// (`elsewhere`, found in the app's own files), and a test fails when that place is gone. Nothing here approves, sends,
// removes or pays: an ask stays an ask on its own card (registry.test.ts holds the registry to that).
import { LANG_NAMES, LANGS, t, type Key, type Lang } from "../i18n";
import type { MenuPage } from "../state/store";
import { APP_PAGES } from "../settings/pages";
import { MENU_ROWS, rowPage, type MenuRow } from "../sidebar/menu";
import type { Places } from "./places";
import type { IconName } from "../ui/icons";

/** What the registry needs of the app: plain data and the functions the app's own buttons call. */
export interface PaletteCtx {
  lang: Lang;
  /** the members the menu lists, in its order, with the name each shows */
  bots: { name: string; displayName: string }[];
  /** the member Home's Chat mode talks to (Buddy) while a new thread with them can be started, else null */
  buddy: { name: string; displayName: string } | null;
  /** Settings › People is offered for this shop */
  people: boolean;
  places: Places;
  openPage(page: MenuPage): void;
  /** History with `query` in its search box and the focus there */
  openHistory(query: string): void;
  openSettings(page: string): void;
  /** the Team page's New thread for a member */
  newThread(bot: string): void;
  setLanguage(lang: Lang): void;
  /** the Code page's + menu, as ⌘N opens it */
  openNewSessionMenu(): void;
  /** the workflows Settings › Workflows offers Run now for at this moment (Workflows on, the file readable, no run going) */
  workflows: { file: string; name: string }[];
  /** Settings › Workflows' Run now for workflow `file`, on its page */
  runWorkflow(file: string): void;
}

export interface Row {
  id: string;
  label: string;
  /** a quiet second line or tail (who a chat is with) */
  hint?: string;
  /** the row's icon, from the brand's set: every row of the command menu has one before its word (the canvas's Search
   *  board); a row given none takes its group's */
  icon?: IconName;
  run(): void;
}

/** Each page's icon, the drawing its row has in the side menu (sidebar/menuIcons.tsx). */
const MENU_ICON: Record<MenuRow, IconName> = {
  new: "plus",
  needs: "bell",
  team: "users",
  code: "code",
  artifacts: "panels",
  customize: "sliders",
  history: "clock",
};

const MENU_WORDS: Record<MenuRow, Key> = {
  new: "menu.new",
  needs: "menu.needs",
  team: "menu.team",
  code: "menu.code",
  artifacts: "menu.artifacts",
  customize: "menu.customize",
  history: "menu.history",
};

/** "Go to": every page of the side menu, then every Settings page, by the names the app already shows. */
export function goRows(c: PaletteCtx): Row[] {
  const pages: Row[] = MENU_ROWS.map((row) => ({ id: `go:${row}`, label: t(MENU_WORDS[row]), icon: MENU_ICON[row], run: () => c.openPage(rowPage(row)) }));
  const settings = t("set.title");
  const own = (id: string, name: string): Row => ({ id: `go:settings:${id}`, label: `${settings} › ${name}`, icon: "gear", run: () => c.openSettings(id) });
  return [
    ...pages,
    own("general", t("set.general")),
    own("bots", t("set.allBots")),
    ...c.bots.map((b) => own(`bot:${b.name}`, b.displayName)),
    ...(c.people ? [own("people", t("set.people"))] : []),
    // General is listed first above, so the App list skips it
    ...APP_PAGES.filter((p) => p.id !== "general").map((p) => own(p.id, t(p.label))),
  ];
}

/** An action the app already offers somewhere else, and what it needs to be offered here. */
export interface ActionDef {
  id: string;
  /** where the app already presses the same thing, for a test to find: a `data-testid` it draws, or (with a call in it) the
   *  call a button makes. A test fails when it is gone from the app's own files. */
  elsewhere: string;
  /** the rows it offers now; none while the place it needs is not open */
  offer(c: PaletteCtx): Row[];
}

export const ACTIONS: ActionDef[] = [
  {
    // the Team page's member menu, "New thread with ..."; the chat box offers it too
    id: "new-chat",
    elsewhere: "s.newThread(b.name)",
    offer: (c) => (c.buddy ? [{ id: "do:new-chat", label: t("thread.newWith", { name: c.buddy.displayName }), icon: "message-plus", run: () => c.newThread(c.buddy!.name) }] : []),
  },
  {
    id: "new-session",
    elsewhere: "session-new",
    offer: (c) => [{ id: "do:new-session", label: t("sessions.new"), icon: "terminal", run: () => c.openNewSessionMenu() }],
  },
  {
    id: "new-lane",
    elsewhere: "lane-new",
    offer: (c) => (c.places.lane ? [{ id: "do:new-lane", label: t("lane.new"), icon: "plus", run: () => c.places.lane!.newLane() }] : []),
  },
  {
    id: "microphone",
    elsewhere: "voice-mic",
    offer: (c) => {
      const b = c.places.box;
      if (!b) return [];
      return [{ id: "do:microphone", label: b.micLive() ? t("voice.micStop") : t("voice.mic", { lang: b.spoken() }), icon: "mic", run: () => b.toggleMic() }];
    },
  },
  {
    id: "voice-mode",
    elsewhere: "voice-mode",
    offer: (c) => {
      const b = c.places.box;
      if (!b) return [];
      return [{ id: "do:voice-mode", label: b.modeLive() ? t("voice.modeStop") : t("voice.mode", { lang: b.spoken() }), icon: "audio-lines", run: () => b.toggleMode() }];
    },
  },
  {
    // opens the Team page's own question ("Pause everyone?"); the pause itself is still that card's button
    id: "pause-question",
    elsewhere: "pause-open",
    offer: (c) => (c.places.pause ? [{ id: "do:pause-question", label: t("pause.button"), icon: "pause", run: () => c.places.pause!.ask() }] : []),
  },
  {
    // Settings › Workflows' Run now, a row for each workflow it is offered for now: the run is a lane whose every ask is still its
    // card's, and the dial reads it at its most careful level
    id: "workflow",
    elsewhere: "workflow-run-now",
    offer: (c) => c.workflows.map((w) => ({ id: `do:workflow:${w.file}`, label: t("wf.palette", { name: w.name }), icon: "nodes", run: () => c.runWorkflow(w.file) })),
  },
  {
    id: "language",
    elsewhere: "language",
    offer: (c) => LANGS.filter((l) => l !== c.lang).map((l) => ({ id: `do:language:${l}`, label: `${t("lang.title")}: ${LANG_NAMES[l]}`, icon: "globe", run: () => c.setLanguage(l) })),
  },
  {
    id: "runtime",
    elsewhere: "dev-runtime",
    offer: (c) => {
      const r = c.places.runtime;
      if (!r) return [];
      const other = r.mode === "practice" ? "connected" : "practice";
      return [{ id: `do:runtime:${other}`, label: `${t("dev.runtime")}: ${t(other === "practice" ? "dev.practice" : "dev.connected")}`, icon: "plug", run: () => r.set(other) }];
    },
  },
];

/** "Do": what the open screen and the app offer, in the registry's order. */
export function doRows(c: PaletteCtx): Row[] {
  return ACTIONS.flatMap((a) => a.offer(c));
}
