// The first-run setup's rules (Onboarding.tsx draws them): the design canvas's Welcome.dc.html, then its three steps
// from Onboarding.dc.html, Your shop, One channel and Your team, then Home. The flow shows on a first run until the
// person finishes it or presses Skip for now, and Settings can open it again on Your shop.
//
// Everything here is pure: the store holds a FlowState while the setup is open and moves it with flowReduce, and saves
// and ends the setup itself (store.ts, firstRunDo and firstRunEnd), because only the store can write to this computer.
import { cut, keepMain, SHOP_LIMITS, togglePlace, type Channel, type ShopProfile } from "./shop";

/** Set to "1" once the setup was finished or skipped. The fork already read this key to tell a first run from a later
 *  one (i18n `readLang` takes the system's language only before it is set), so the setup reuses it rather than adding a
 *  second answer to the same question. */
export const ONBOARDED_KEY = "manut.onboarded";

export type Step = "shop" | "channel" | "team";
export type Screen = "welcome" | Step;

/** The canvas's steps, in order: 1 Your shop, 2 One channel, 3 Your team. */
export const STEPS: readonly Step[] = ["shop", "channel", "team"];
const SCREENS: readonly Screen[] = ["welcome", ...STEPS];

/** Where the setup opens: Welcome on a first run, Your shop when Settings opens it again. */
export type FirstRunEntry = "welcome" | "shop";

/** Whether the setup opens as the app starts, given what this computer holds under ONBOARDED_KEY: on Welcome until it
 *  was finished or skipped once, and never on its own after that. Anything but "1" counts as not yet, so a computer
 *  that cannot keep the answer shows the setup each time rather than skip it unseen. */
export function firstRunEntry(onboarded: string | null): FirstRunEntry | null {
  return onboarded === "1" ? null : "welcome";
}

/** What a step still needs before its Next moves on. */
export type Problem = "shop" | "places" | "main";

/** Your shop needs the shop's name and at least one place, the canvas's "Pick at least one"; the person's name and what
 *  the shop sells can wait. One channel needs its pick. Welcome and Your team need nothing. */
export function problemsOf(screen: Screen, d: ShopProfile): Problem[] {
  if (screen === "shop") {
    const out: Problem[] = [];
    if (!d.shop.trim()) out.push("shop");
    if (!d.places.length) out.push("places");
    return out;
  }
  if (screen === "channel") return keepMain(d.places, d.main) ? [] : ["main"];
  return [];
}

export interface FlowState {
  screen: Screen;
  /** What the person typed and picked so far. Text stays as typed, spaces and all, until the store keeps it. */
  draft: ShopProfile;
  /** What a refused Next found missing on this screen, shown until each is fixed. */
  problems: Problem[];
}

export type TextField = "person" | "shop" | "sells";

export type FlowEvent =
  | { type: "next" }
  | { type: "back" }
  | { type: "edit"; field: TextField; value: string }
  | { type: "place"; channel: Channel }
  | { type: "main"; channel: Channel };

export function startFlow(entry: FirstRunEntry, saved: ShopProfile): FlowState {
  return { screen: entry, draft: saved, problems: [] };
}

/** Whether the setup fills the window. While it does, the app's shortcuts stay quiet: they would change screens the
 *  person cannot see behind it. */
export const isFirstRunOpen = (ui: { firstRun: FlowState | null }): boolean => ui.firstRun !== null;

/** A change keeps only the problems it did not fix. A new problem waits for the next press of Next: telling someone
 *  off for a field they have not reached yet only gets in the way. */
function edited(s: FlowState, draft: ShopProfile): FlowState {
  const left = problemsOf(s.screen, draft);
  return { ...s, draft, problems: s.problems.filter((p) => left.includes(p)) };
}

/** One move of the setup. A move that changes nothing returns the same state, so the store can tell. */
export function flowReduce(s: FlowState, e: FlowEvent): FlowState {
  const at = SCREENS.indexOf(s.screen);
  switch (e.type) {
    case "next": {
      // The last step's button ends the setup, which is the store's to do.
      if (s.screen === "team") return s;
      const problems = problemsOf(s.screen, s.draft);
      if (problems.length) return { ...s, problems };
      const screen = SCREENS[at + 1];
      // A shop that sells in one place has its main channel already, so One channel opens with it picked.
      const one = screen === "channel" && !s.draft.main && s.draft.places.length === 1;
      return { screen, draft: one ? { ...s.draft, main: s.draft.places[0] } : s.draft, problems: [] };
    }
    case "back":
      return at > 0 ? { ...s, screen: SCREENS[at - 1], problems: [] } : s;
    case "edit":
      return edited(s, { ...s.draft, [e.field]: cut(e.value, SHOP_LIMITS[e.field]) });
    case "place": {
      const places = togglePlace(s.draft.places, e.channel);
      return edited(s, { ...s.draft, places, main: keepMain(places, s.draft.main) });
    }
    case "main":
      return s.draft.places.includes(e.channel) ? edited(s, { ...s.draft, main: e.channel }) : s;
  }
}

/** How the stepper marks a step: done once passed, now while open, nothing before it is reached. */
export function stepMark(step: Step, screen: Screen): "done" | "now" | "" {
  const at = SCREENS.indexOf(screen);
  const it = SCREENS.indexOf(step);
  return at > it ? "done" : at === it ? "now" : "";
}

/** Where an arrow key moves a radio group's pick (wrapping round, as radio groups do), Home and End to either end;
 *  null for any other key or an empty group. With nothing picked, down starts at the top and up at the bottom. */
export function radioMove<T>(list: readonly T[], current: T | null, key: string): T | null {
  if (!list.length) return null;
  const at = current === null ? -1 : list.indexOf(current);
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return list[(at + 1) % list.length];
    case "ArrowUp":
    case "ArrowLeft":
      return list[at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length];
    case "Home":
      return list[0];
    case "End":
      return list[list.length - 1];
    default:
      return null;
  }
}

/** What each member Your team introduces drafts, as the canvas says it. */
export type PracticeRole = "sales" | "content" | "books";

/** The members Your team introduces, in the canvas's order. They are found by their names, as Home finds Kit, so a
 *  runtime without one of them leaves that row out rather than draw a member who is not there. */
const PRACTICE: readonly { name: string; role: PracticeRole }[] = [
  { name: "nam", role: "sales" },
  { name: "pim", role: "content" },
  { name: "ton", role: "books" },
];

export function practiceTeam<B extends { name: string }>(bots: readonly B[]): { bot: B; role: PracticeRole }[] {
  return PRACTICE.flatMap(({ name, role }) => {
    const bot = bots.find((b) => b.name === name);
    return bot ? [{ bot, role }] : [];
  });
}
