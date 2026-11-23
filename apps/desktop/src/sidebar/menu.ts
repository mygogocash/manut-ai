// The side menu's rules, kept apart from its markup so they can be tested without a page. The menu is the design
// canvas's `<nav class="sb">` (Approvals.dc.html): the brand mark and Search, then New, Needs you, Team, Code,
// Artifacts, Customize and History, a Recent list, and the account row at the bottom.
//
// Which row is current comes from the canvas too: Home marks New, a member's page marks Team, the menu's own pages
// mark themselves, and a thread, a job and Settings mark none. New opens Home (src/pages/HomePage.tsx), and every
// member's main chat, Buddy's included, is that member's page.
import type { Bot } from "../lib/protocol";
import type { MenuPage, Ui } from "../state/store";
import type { ThreadRow } from "../threads/types";

/** A row of the menu. New is the row whose page is Home, so Home itself is not a row's name. */
export type MenuRow = "new" | Exclude<MenuPage, "home">;

/** The rows, top to bottom. */
export const MENU_ROWS: readonly MenuRow[] = ["new", "needs", "team", "code", "artifacts", "customize", "history"];

/** The page a row opens: Home for New, as the canvas's New row and brand mark link to Home; each other row its own. */
export function rowPage(row: MenuRow): MenuPage {
  return row === "new" ? "home" : row;
}

/** The row marked current (`aria-current="page"`) for what the main column shows, or null when none is. */
export function currentRow(ui: Pick<Ui, "view" | "thread">, selectedBot: string | null): MenuRow | null {
  switch (ui.view) {
    case "home":
      return "new";
    case "chat":
      // A thread is a conversation, not a place in the menu. Before any member is open the app is still starting,
      // and it starts on Home.
      if (ui.thread) return null;
      return selectedBot === null ? "new" : "team";
    case "needs":
    case "team":
    case "code":
    case "artifacts":
    case "customize":
    case "history":
      return ui.view;
    // The activity log is History's own place. A job's page is, like a thread, a conversation's worth of work and not a
    // place in the menu.
    case "activity":
      return "history";
    case "job":
      return null;
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

/** The member Home's Chat and Team modes talk to: the one the runtime marks as its default (Buddy in the demo), else
 *  the first listed member, so the ask box always reaches someone while there is a team. */
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
