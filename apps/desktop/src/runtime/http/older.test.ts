// What the connected runtime keeps of a shop's older tasks (older.ts): the chain of the newest read and the pages Show older read,
// and how it changes when the shop is read again, a page is added, or tasks are made or deleted. The rules are pure, so a fake
// shop stands in for the API here: an index of task ids, oldest first, read as apps/api's list reads it (the newest 50 as two
// pages, a page of 25 after a cursor that is a task's id).
import { describe, expect, it } from "vitest";
import { addPage, askOlder, dropOlder, forgetAsk, keepOlder, nextCursor, olderOf, shownTasks, type TaskList } from "./older";
import { LISTED_TASKS, TASK_PAGE, type ShopTask } from "./shop";

const task = (id: string, title = id): ShopTask => ({ id, title, objective: "", state: "completed", createdAt: null, updatedAt: null, actions: [], attempts: [], draft: null, raw: null });
const ids = (l: TaskList) => shownTasks(l).map((x) => x.id);

/** A shop's index: the ids of its tasks, oldest first, as the API's task index holds them (`t1` is the oldest). */
const index = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `t${from + i}`);

/** The newest read of a shop: its newest `LISTED_TASKS` tasks, oldest first, and the cursor it stopped at (the id of the last task
 *  the list looked at: the oldest of them), none when the list ended within them. `titles` renames tasks, as a later read finds them. */
function newest(all: readonly string[], titles: Record<string, string> = {}): TaskList {
  const held = all.slice(-LISTED_TASKS);
  return { tasks: held.map((id) => task(id, titles[id])), ...(all.length > LISTED_TASKS ? { more: all[all.length - LISTED_TASKS] } : {}) };
}

/** The page after `cursor`, as the list answers it: the `TASK_PAGE` tasks right before it, oldest first, and the cursor of the page
 *  after it, null on the last. A cursor that names no task of the index is the API's 400, here `null`. */
function pageAfter(all: readonly string[], cursor: string): { tasks: ShopTask[]; next: string | null } | null {
  const at = all.indexOf(cursor);
  if (at < 0) return null;
  const looked = all.slice(Math.max(0, at - TASK_PAGE), at);
  return { tasks: looked.map((id) => task(id)), next: at - looked.length > 0 ? (looked[0] ?? null) : null };
}

/** Show older, pressed: the page after the list's cursor, added. */
function press(all: readonly string[], l: TaskList): TaskList {
  const from = nextCursor(l);
  if (from === null) throw new Error("nothing older to read");
  const page = pageAfter(all, from);
  if (!page) throw new Error("the API does not know the cursor");
  const joined = addPage(askOlder(l), from, page);
  if (!joined) throw new Error("the page does not join");
  return joined;
}

describe("what a list says about the tasks it does not hold", () => {
  it("says nothing for a read that ended, `more` while there are older tasks, and `end` once Show older read the last page", () => {
    const ended = newest(index(30));
    expect(olderOf(ended)).toBeUndefined();
    expect(nextCursor(ended)).toBeNull();
    const cut = newest(index(80));
    expect(olderOf(cut)).toBe("more");
    expect(nextCursor(cut)).toBe("t31");
    expect(olderOf({ ...cut, older: { tasks: [task("t30")], next: "t6" } })).toBe("more");
    expect(nextCursor({ ...cut, older: { tasks: [task("t30")], next: "t6" } })).toBe("t6");
    expect(olderOf({ ...cut, older: { tasks: [task("t1")], next: null } })).toBe("end");
    expect(nextCursor({ ...cut, older: { tasks: [task("t1")], next: null } })).toBeNull();
  });

  it("shows the older tasks, then the newest read, oldest first, and the newest read alone as it was when none were read", () => {
    const l = newest(index(80));
    expect(shownTasks(l)).toBe(l.tasks);
    expect(ids({ ...l, older: { tasks: [task("t29"), task("t30")], next: "t29" } }).slice(0, 4)).toEqual(["t29", "t30", "t31", "t32"]);
    expect(shownTasks({ ...l, older: { tasks: [], next: "t31" } })).toBe(l.tasks);
  });
});

describe("a request for a page", () => {
  it("is noted before it is sent, once, and only where the list has more", () => {
    const l = newest(index(80));
    expect(askOlder(l).older).toEqual({ tasks: [], next: "t31" });
    const asked = askOlder(l);
    expect(askOlder(asked)).toBe(asked);
    const whole = newest(index(30));
    expect(askOlder(whole)).toBe(whole);
  });

  it("is forgotten when it got no page and nothing came into the list meanwhile, and kept when something did", () => {
    const l = newest(index(80));
    expect(forgetAsk(askOlder(l), "t31")).toEqual(l);
    expect("older" in forgetAsk(askOlder(l), "t31")).toBe(false);
    // a read carried the task it pushed out into the note: that task is real, and stays
    const carried = { ...l, older: { tasks: [task("t30")], next: "t31" } };
    expect(forgetAsk(carried, "t31")).toBe(carried);
    // a page that was added since
    const added = { ...l, older: { tasks: [], next: "t6" } };
    expect(forgetAsk(added, "t31")).toBe(added);
  });

  it("is let go for a cursor the API no longer knows, so the next page starts from the newest read's cursor again", () => {
    const l = press(index(120), newest(index(120)));
    expect(nextCursor(l)).toBe("t46");
    const dropped = dropOlder(l);
    expect(nextCursor(dropped)).toBe("t71");
    expect(ids(dropped)).toEqual(index(50, 71));
  });
});

describe("adding a page", () => {
  it("puts the page before the older tasks held, and takes its cursor", () => {
    const all = index(120);
    const first = press(all, newest(all));
    expect(ids(first)).toEqual(index(75, 46));
    expect(olderOf(first)).toBe("more");
    const second = press(all, first);
    expect(ids(second)).toEqual(index(100, 21));
    expect(nextCursor(second)).toBe("t21");
    // the last page: the list says it has no more
    const third = press(all, second);
    expect(ids(third)).toEqual(index(120));
    expect(nextCursor(third)).toBeNull();
    expect(olderOf(third)).toBe("end");
  });

  it("is refused for a page read from a cursor that is not where the next page starts, which would leave tasks out", () => {
    const all = index(120);
    const l = askOlder(newest(all));
    expect(addPage(l, "t99", { tasks: [task("t98")], next: "t98" })).toBeNull();
    // and for a list with no older note at all (a read let the pages go while the page was on its way)
    expect(addPage(newest(index(125)), "t71", { tasks: [], next: null })).toBeNull();
  });

  it("lists a task once, as it is held: a page that repeats one the list already has adds nothing of it", () => {
    const all = index(120);
    const l = askOlder(newest(all, { t80: "Held" }));
    // the page repeats t80, which the newest read has, and t60, a new one
    const joined = addPage(l, "t71", { tasks: [task("t60"), task("t80", "Page")], next: "t60" });
    expect(joined && ids(joined).filter((id) => id === "t80")).toEqual(["t80"]);
    expect(joined?.tasks.find((x) => x.id === "t80")?.title).toBe("Held");
    expect(joined?.older?.tasks.map((x) => x.id)).toEqual(["t60"]);
    // and one an earlier page added
    const twice = addPage(joined!, "t60", { tasks: [task("t59"), task("t60", "Again")], next: "t59" });
    expect(twice?.older?.tasks.map((x) => [x.id, x.title])).toEqual([["t59", "t59"], ["t60", "t60"]]);
  });
});

describe("the newest read, read again", () => {
  it("stands as it is when nothing was asked for: the shop keeps showing its newest tasks, and a task that falls out is gone", () => {
    const was = newest(index(120));
    const now = newest(index(122));
    expect(keepOlder(was, now)).toBe(now);
    expect(keepOlder(undefined, now)).toBe(now);
    expect(keepOlder(askOlder(newest(index(30))), newest(index(31)))).toEqual(newest(index(31)));
  });

  it("keeps the older pages when nothing was made, as they were", () => {
    const all = index(120);
    const was = press(all, newest(all));
    const now = keepOlder(was, newest(all));
    expect(now.older).toEqual(was.older);
    expect(ids(now)).toEqual(ids(was));
    expect(nextCursor(now)).toBe("t46");
  });

  it("takes the tasks that new ones push out of the newest read into the older ones, so none is skipped, and keeps the cursor", () => {
    const all = index(120);
    const was = press(all, newest(all)); // t46 .. t120
    expect(nextCursor(was)).toBe("t46");
    const made = [...all, ...index(7, 121)];
    const now = keepOlder(was, newest(made));
    // the newest read moved on: it holds t78 .. t127, and its cursor is t78
    expect(now.tasks.map((x) => x.id)).toEqual(index(50, 78));
    expect(now.more).toBe("t78");
    // t71 .. t77 were pushed out of it; with the pages read, they are what lies after it
    expect(now.older?.tasks.map((x) => x.id)).toEqual(index(32, 46));
    expect(ids(now)).toEqual(index(82, 46));
    // the page after the older ones starts where it always did
    expect(nextCursor(now)).toBe("t46");
    expect(press(made, now) && ids(press(made, now))).toEqual(index(107, 21));
  });

  it("keeps the older pages when a request for the first page is still on its way, and the page joins them", () => {
    const all = index(120);
    const asked = askOlder(newest(all));
    // a task is made, and the minute's read lands before the page does
    const made = [...all, "t121", "t122", "t123"];
    const now = keepOlder(asked, newest(made));
    expect(now.older).toEqual({ tasks: ["t71", "t72", "t73"].map((id) => task(id)), next: "t71" });
    const page = pageAfter(made, "t71")!;
    const joined = addPage(now, "t71", page);
    expect(joined && ids(joined)).toEqual(index(78, 46));
  });

  it("lets the older pages go when 50 or more tasks were made since the last read, as the tasks between would be left out", () => {
    const all = index(120);
    const was = press(all, newest(all));
    const made = [...all, ...index(60, 121)];
    const now = keepOlder(was, newest(made));
    expect(now.older).toBeUndefined();
    expect(ids(now)).toEqual(index(50, 131));
    expect(nextCursor(now)).toBe("t131");
    // 49 are made, and the newest read still holds the newest task of the last one: the chain is whole
    const kept = keepOlder(was, newest([...all, ...index(49, 121)]));
    expect(ids(kept)).toEqual(index(124, 46));
  });

  it("lets the older pages go when the list ended within the newest read, which now holds every task the shop has", () => {
    const all = index(120);
    const was = press(all, newest(all));
    const shrunk = index(40, 81);
    const now = keepOlder(was, newest(shrunk));
    expect(now.older).toBeUndefined();
    expect(olderOf(now)).toBeUndefined();
    expect(ids(now)).toEqual(shrunk);
  });

  it("does not carry a task the shop deleted from the newest read, which is gone and not pushed out", () => {
    const all = index(120);
    const was = press(all, newest(all)); // t46 .. t120
    const made = all.filter((id) => id !== "t100" && id !== "t119");
    const now = keepOlder(was, newest(made));
    expect(ids(now)).not.toContain("t100");
    expect(ids(now)).not.toContain("t119");
    // 118 tasks: the newest read holds t69 .. t120 but the two, and the pages read stay as they were
    expect(now.tasks.map((x) => x.id)).toEqual(made.slice(-50));
    expect(ids(now)).toEqual(made.slice(made.indexOf("t46")));
  });

  it("lists a task once, as the newer read has it, when deletions bring the newest read down into the older pages", () => {
    const all = index(120);
    const was = press(all, newest(all)); // t46 .. t120
    // ten of the newest tasks are deleted, and one of the older ones is renamed: the newest read now reaches t61
    const made = all.slice(0, 110);
    const now = keepOlder(was, newest(made, { t65: "Renamed" }));
    expect(now.tasks.map((x) => x.id)).toEqual(index(50, 61));
    expect(ids(now)).toEqual(index(65, 46));
    expect(shownTasks(now).filter((x) => x.id === "t65")).toHaveLength(1);
    expect(shownTasks(now).find((x) => x.id === "t65")?.title).toBe("Renamed");
    expect(now.older?.tasks.map((x) => x.id)).toEqual(index(15, 46));
  });
});

// A shop over a long time: tasks are made, the shop is read each minute, and Show older is pressed, in any order. Whatever the
// order, the list shows every task from its oldest down to the newest exactly once, in order: none skipped, none twice, the
// cursor always names the oldest one shown, and a press never reads a task the list already holds.
describe("a shop that is read, paged and added to, in any order", () => {
  /** A small seeded generator, so a failure names the seed that made it. */
  const random = (seed: number) => () => ((seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32);

  it("never skips or repeats a task", () => {
    const seen = { pressed: 0, carried: 0, letGo: 0, ended: 0 };
    for (let seed = 1; seed <= 120; seed++) {
      const next = random(seed);
      let all = index(40 + Math.floor(next() * 120));
      let list = newest(all);
      let made = all.length;
      const why = (step: number) => `seed ${seed}, step ${step}`;
      for (let step = 0; step < 40; step++) {
        const roll = next();
        if (roll < 0.35) {
          // tasks are made (usually a few; sometimes a burst, which lets the older pages go)
          const n = next() < 0.1 ? 40 + Math.floor(next() * 40) : 1 + Math.floor(next() * 6);
          all = [...all, ...index(n, made + 1)];
          made += n;
        } else if (roll < 0.7) {
          const was = list;
          list = keepOlder(was, newest(all));
          if (was.older && list.older) seen.carried += 1;
          if (was.older && !list.older) seen.letGo += 1;
        } else if (nextCursor(list) !== null) {
          list = press(all, list);
          seen.pressed += 1;
          if (olderOf(list) === "end") seen.ended += 1;
        }
        const shown = ids(list);
        const first = all.indexOf(shown[0]);
        const last = all.indexOf(list.tasks.at(-1)!.id);
        expect(first, why(step)).toBeGreaterThanOrEqual(0);
        // what is shown is the shop's tasks from the oldest one shown to the newest the last read saw, each once, in order
        expect(shown, why(step)).toEqual(all.slice(first, last + 1));
        // the cursor names the oldest task shown, and a list with no cursor left shows the shop's oldest task
        if (nextCursor(list) !== null) expect(nextCursor(list), why(step)).toBe(shown[0]);
        else expect(shown[0], why(step)).toBe(all[0]);
        expect(shown.length, why(step)).toBeGreaterThanOrEqual(Math.min(LISTED_TASKS, last + 1));
      }
    }
    // the walk reached every case it is there to check
    expect(seen.pressed).toBeGreaterThan(200);
    expect(seen.carried).toBeGreaterThan(100);
    expect(seen.letGo).toBeGreaterThan(5);
    expect(seen.ended).toBeGreaterThan(5);
  });
});
