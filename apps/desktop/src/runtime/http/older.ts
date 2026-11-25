// Older tasks on the connected runtime: what the app keeps of a shop's tasks beyond the newest `LISTED_TASKS` once a screen
// has asked for them (Show older), and the rules that keep them whole while the shop is read again every minute
// (docs/runtime-adapter.md, "Older tasks"). The reading is the host's (`showOlder`, host.ts); this is only what a list of
// tasks holds and how it changes, so each rule can be tested without a runtime.
//
// A list is a chain, newest to oldest, with no task missing between its links:
// - `tasks` is the newest read (the newest `LISTED_TASKS` of the shop, as of the last minute);
// - `older.tasks` is what Show older has read since, the tasks right after the newest read;
// - `more` is where the newest read stopped, and `older.next` where the page after the older ones starts: the id of the last
//   task the API's list looked at (apps/api/src/task-list.ts), null when it has no more.
//
// Rules this module keeps:
// - The cursor is stable. It is a task's id, not a place in the list, so new tasks land before the newest read and move
//   no cursor; reading on from `older.next` finds exactly the tasks after the last one read. What new tasks do move is the
//   newest read, which is the newest 50 as of each minute: a task made pushes the 50th newest out of it, and that task now lies
//   between the new read and the older pages. `keepOlder` takes the tasks pushed out into the older list (they are already
//   read, so it asks the API for nothing), and the chain stays whole.
// - When the new read holds none of the tasks the last one held, 50 or more tasks were made in between and the ones between
//   are unread. Showing the older pages beside it would skip tasks, so they are let go and Show older starts again from the
//   new read's cursor. This is the only way the minute's read drops them.
// - A task is listed once, as the newer read has it: one in the newest read is never also in the older list. A task the shop
//   deleted from the newest read is gone, not pushed out, and is not carried either: only what lies after the oldest task both
//   reads hold goes into the older list.
// - A request for a page notes itself first (`askOlder`), so a minute's read that lands while the page is on its way carries
//   the tasks it pushes out into the same chain the page will join, and the page is added only if it starts where the chain
//   now ends (`addPage`).
// - Nothing here is kept on disk (cache.ts copies the newest read field by field and knows no `older`), and an older task is
//   shown as it was when it was read: only the newest read is read again.
import type { OlderState } from "../mission";
import type { OlderTasks, ShopTask } from "./shop";

/** What a shop's work, and the signed-in tenant's whole read, carry of the task list. */
export interface TaskList {
  tasks: ShopTask[];
  more?: string;
  older?: OlderTasks;
}

/** Where Show older reads from next: after the older pages already read, else after the newest read; null when the list has no
 *  more. */
export const nextCursor = (l: TaskList): string | null => (l.older ? l.older.next : (l.more ?? null));

/** What the list says about the tasks it does not hold (`OlderState`), or nothing when it holds every task there is. */
export function olderOf(l: TaskList): OlderState | undefined {
  if (l.older) return l.older.next === null ? "end" : "more";
  return l.more === undefined ? undefined : "more";
}

/** The tasks the screens show: the older ones, then the newest read, oldest first as the newest read is kept. */
export const shownTasks = (l: TaskList): ShopTask[] => (l.older && l.older.tasks.length ? [...l.older.tasks, ...l.tasks] : l.tasks);

/** `l` with a request for the page after the newest read noted in it, before the request goes out. Nothing changes when one was
 *  asked for already, or the list has no more. */
export function askOlder<T extends TaskList>(l: T): T {
  return l.older || l.more === undefined ? l : { ...l, older: { tasks: [], next: l.more } };
}

/** `l` without the note `askOlder` made, for a request that got no page: only when nothing was added to it meanwhile and it
 *  still starts at `from`. Anything a read carried into it is real, and stays. */
export function forgetAsk<T extends TaskList>(l: T, from: string): T {
  const { older, ...rest } = l;
  return older && older.tasks.length === 0 && older.next === from ? (rest as T) : l;
}

/** `l` with what Show older read let go: the next page is read from the newest read's cursor again. For a cursor the API no
 *  longer knows (a task it named was deleted). */
export function dropOlder<T extends TaskList>(l: T): T {
  const { older: _gone, ...rest } = l;
  return rest as T;
}

/** The newest read `now`, with what Show older read before carried over from `was`, the read it replaces. With nothing asked
 *  for, `now` stands. See the rules above for what lies between the two reads. */
export function keepOlder<T extends TaskList>(was: TaskList | undefined, now: T): T {
  const held = was?.older;
  // Nothing was asked for. Or the list ended within the new read, so it holds every task the shop has and none is older.
  if (!was || !held || now.more === undefined) return now;
  const fresh = new Set(now.tasks.map((task) => task.id));
  // Oldest first: the older pages, then the newest read as it was. Tasks keep their order, so the ones the new read still holds
  // are the newest of these, and every task before the oldest of them lies after the new read: it was pushed out of it, or
  // is in an older page.
  const before = [...held.tasks, ...was.tasks];
  const at = before.findIndex((task) => fresh.has(task.id));
  if (at < 0) return now;
  return { ...now, older: { tasks: before.slice(0, at), next: held.next } };
}

/** `l` with the page read from `from` added after the older tasks it holds: `page.tasks` (oldest first) before them, and the cursor
 *  the page gave. Null when `from` is not where the next page starts any more (a read let the older pages go meanwhile), so the page
 *  would leave tasks out. A task the list holds already is not added again. */
export function addPage<T extends TaskList>(l: T, from: string, page: { tasks: ShopTask[]; next: string | null }): T | null {
  if (nextCursor(l) !== from) return null;
  const held = l.older?.tasks ?? [];
  const known = new Set([...l.tasks, ...held].map((task) => task.id));
  return { ...l, older: { tasks: [...page.tasks.filter((task) => !known.has(task.id)), ...held], next: page.next } };
}
