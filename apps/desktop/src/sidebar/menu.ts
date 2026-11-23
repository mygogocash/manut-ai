// The side menu's rules, kept apart from its markup so they can be tested without a page. The menu is the design
// canvas's `<nav class="sb">` (Approvals.dc.html): the brand mark and Search, then New, Needs you, Team, Code,
// Artifacts, Customize and History, a Recent list, and the account row at the bottom.
//
// Which row is current comes from the canvas too: Home marks New, a member's page marks Team, the menu's own pages
// mark themselves, and a thread, a job and Settings mark none. Home does not exist in the app yet, so the home
// member's main chat stands in for it; any other member's main chat is that member's page.
import type { Bot } from "../lib/protocol";
import type { MenuPage, Ui } from "../state/store";
import type { ThreadRow } from "../threads/types";

export type MenuRow = "new" | MenuPage;

/** The rows, top to bottom. */
export const MENU_ROWS: readonly MenuRow[] = ["new", "needs", "team", "code", "artifacts", "customize", "history"];

/** The row marked current (`aria-current="page"`) for what the main column shows, or null when none is. `home` is the
 *  member whose main chat stands in for Home (homeBot). */
export function currentRow(ui: Pick<Ui, "view" | "thread">, selectedBot: string | null, home: string | null): MenuRow | null {
  switch (ui.view) {
    case "chat":
      // A thread is a conversation, not a place in the menu. Before any member is open the app is at its start,
      // which is Home.
      if (ui.thread) return null;
      return selectedBot === null || selectedBot === home ? "new" : "team";
    case "needs":
    case "team":
    case "code":
    case "artifacts":
    case "customize":
    case "history":
      return ui.view;
    // A terminal session and the Tasks page are the Code page's own places.
    case "session":
    case "tasks":
      return "code";
    // Automations and Plugins are entries of the Customize page.
    case "automations":
    case "plugins":
      return "customize";
    case "settings":
      return null;
  }
}

/** The member whose main chat stands in for Home: the one the runtime marks as its default (Buddy in the demo),
 *  else the first listed member, so New always leads somewhere while there is a team. */
export function homeBot(bots: readonly Pick<Bot, "name" | "is_default">[], listed: readonly string[]): string | null {
  return bots.find((b) => b.is_default)?.name ?? listed[0] ?? null;
}

/** A thread and the member it belongs to, with the time it is sorted by. */
export interface MemberThread {
  bot: string;
  row: ThreadRow;
  /** seconds since epoch of the thread's last activity, or of its start when nothing has happened in it */
  ts: number;
}

/** Every thread of the listed members, newest activity first: what Recent and History both list. A thread counts
 *  from its start until something happens in it; members outside the list are left out, as the menu lists the team. */
export function threadsNewestFirst(threads: Readonly<Record<string, readonly ThreadRow[]>>, members: readonly string[]): MemberThread[] {
  const all: MemberThread[] = [];
  for (const bot of members) for (const row of threads[bot] ?? []) all.push({ bot, row, ts: Math.max(row.last ?? 0, row.started_at ?? 0) });
  // The sort is stable, so equal times keep the members' order.
  return all.sort((a, b) => b.ts - a.ts);
}

/** One thread as the Recent list names it. `title` is "" until the thread's first message names it. */
export interface RecentThread {
  bot: string;
  thread: string;
  title: string;
  ts: number;
}

/** The `n` threads of the listed members with the newest activity, newest first. */
export function recentThreads(threads: Readonly<Record<string, readonly ThreadRow[]>>, members: readonly string[], n = 3): RecentThread[] {
  return threadsNewestFirst(threads, members)
    .slice(0, n)
    .map(({ bot, row, ts }) => ({ bot, thread: row.thread, title: row.title, ts }));
}
