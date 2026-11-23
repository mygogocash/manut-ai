// History's rules: every thread of the team, newest first, grouped by the day of its last activity (Today, Yesterday,
// then dates), and a search box that filters by title.
import { describe, expect, it } from "vitest";
import { byDay, dayBand, fullDate, historyEntries, jobLane, lanesPresent, matchTitle, matchWords, threadLane } from "./history";
import type { ThreadRow } from "../threads/types";

/** Sunday 22 November 2026, 15:00 on this computer's clock. */
const NOW = new Date(2026, 10, 22, 15, 0).getTime();
/** Seconds since epoch of a local time. */
const sec = (month: number, day: number, h = 9, min = 0, year = 2026) => new Date(year, month, day, h, min).getTime() / 1000;

const row = (thread: string, title: string, started_at: number, last?: number): ThreadRow => ({
  thread,
  title,
  cwd: "",
  started_at,
  running: false,
  needs: false,
  message_count: 0,
  ...(last === undefined ? {} : { last }),
});

const threads = {
  buddy: [row("b1", "Discount for a bulk order", sec(10, 22, 9, 12)), row("b2", "Translate a supplier's message", sec(10, 21, 11, 30))],
  nam: [row("n1", "Replies about late parcels", sec(10, 20, 8, 0), sec(10, 22, 9, 20)), row("n2", "20% discount code", sec(10, 18, 10, 5))],
  kit: [row("k1", "", sec(10, 17, 16, 40))],
};
const members = ["buddy", "nam", "kit"];

describe("History's entries", () => {
  it("are every thread of the listed members, newest activity first", () => {
    expect(historyEntries(threads, members).map((e) => [e.bot, e.row.thread])).toEqual([
      ["nam", "n1"],
      ["buddy", "b1"],
      ["buddy", "b2"],
      ["nam", "n2"],
      ["kit", "k1"],
    ]);
  });

  it("leave out a member who is not listed", () => {
    expect(historyEntries(threads, ["buddy"]).map((e) => e.row.thread)).toEqual(["b1", "b2"]);
  });
});

describe("History's days", () => {
  it("are Today, Yesterday, then each earlier date, newest first", () => {
    const days = byDay(historyEntries(threads, members), NOW);
    expect(days.map((d) => d.when)).toEqual(["today", "yesterday", "earlier", "earlier"]);
    expect(days.map((d) => d.entries.map((e) => e.row.thread))).toEqual([["n1", "b1"], ["b2"], ["n2"], ["k1"]]);
    expect(days.map((d) => d.day)).toEqual([new Date(2026, 10, 22).getTime(), new Date(2026, 10, 21).getTime(), new Date(2026, 10, 18).getTime(), new Date(2026, 10, 17).getTime()]);
  });

  it("put a thread on the day of its last activity, not the day it started", () => {
    const [today] = byDay(historyEntries(threads, ["nam"]), NOW);
    expect(today.entries.map((e) => e.row.thread)).toEqual(["n1"]);
  });

  it("begin at midnight on this computer's clock", () => {
    const edge = { buddy: [row("a", "just after midnight", sec(10, 22, 0, 0)), row("b", "just before midnight", sec(10, 21, 23, 59))] };
    expect(byDay(historyEntries(edge, ["buddy"]), NOW).map((d) => [d.when, d.entries.map((e) => e.row.thread)])).toEqual([
      ["today", ["a"]],
      ["yesterday", ["b"]],
    ]);
  });

  it("are none when the team has no thread", () => {
    expect(byDay([], NOW)).toEqual([]);
  });
});

describe("History's search", () => {
  const entries = historyEntries(threads, members);

  it("keeps the threads whose title holds the words, in any case", () => {
    expect(matchTitle(entries, "DISCOUNT", "New thread").map((e) => e.row.thread)).toEqual(["b1", "n2"]);
  });

  it("ignores spaces around the words; an empty box keeps every thread", () => {
    expect(matchTitle(entries, "  parcels ", "New thread").map((e) => e.row.thread)).toEqual(["n1"]);
    expect(matchTitle(entries, "   ", "New thread")).toEqual(entries);
  });

  it("finds a thread with no title by the name the page shows for it", () => {
    expect(matchTitle(entries, "new thr", "New thread").map((e) => e.row.thread)).toEqual(["k1"]);
  });

  it("finds nothing when no title holds the words", () => {
    expect(matchTitle(entries, "refund", "New thread")).toEqual([]);
  });
});

describe("a day's full date", () => {
  it("names the weekday, the day and the month, as the canvas writes them in English", () => {
    expect(fullDate(new Date(2026, 10, 22).getTime(), NOW, "en")).toBe("Sunday 22 November");
  });

  it("adds the year only for a day in another year", () => {
    expect(fullDate(new Date(2025, 10, 22).getTime(), NOW, "en")).toContain("2025");
    expect(fullDate(new Date(2026, 0, 3).getTime(), NOW, "en")).not.toContain("2026");
  });

  it("follows the language", () => {
    expect(fullDate(new Date(2026, 10, 22).getTime(), NOW, "ko")).toBe("11월 22일 일요일");
  });
});

describe("a day band, for any list that groups by day", () => {
  const now = new Date(2026, 10, 22, 12, 0).getTime();
  const ts = (day: number) => new Date(2026, 10, day, 9, 0).getTime() / 1000;

  it("groups entries of any shape that carry a time, newest first, as threads are grouped", () => {
    const days = byDay([{ ts: ts(22), id: "a" }, { ts: ts(22) - 60, id: "b" }, { ts: ts(21), id: "c" }, { ts: ts(14), id: "d" }], now);
    expect(days.map((d) => [d.when, d.entries.map((e) => e.id)])).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
      ["earlier", ["d"]],
    ]);
  });

  it("names a day as History's bands do: Today or Yesterday with its date beside, or the date alone", () => {
    const [today, yesterday, earlier] = byDay([{ ts: ts(22) }, { ts: ts(21) }, { ts: ts(14) }], now);
    expect(dayBand(today, now)).toEqual({ label: "Today", date: "Sunday 22 November" });
    expect(dayBand(yesterday, now)).toEqual({ label: "Yesterday", date: "Saturday 21 November" });
    expect(dayBand(earlier, now)).toEqual({ label: "Saturday 14 November", date: null });
  });
});

// History's three kinds, as the canvas's filter chips name them: Chat, Team and Code.
describe("History's kinds", () => {
  const who = { home: "buddy", kit: "kit" };

  it("put a thread with the lead under Chat, one with the engineer under Code, and the rest of the team's under Team", () => {
    expect(threadLane("buddy", who)).toBe("chat");
    expect(threadLane("kit", who)).toBe("code");
    expect(["nam", "pim", "ton"].map((b) => threadLane(b, who))).toEqual(["team", "team", "team"]);
  });

  it("put every job under Team except the engineer's, which are Code, whoever the lead is", () => {
    expect(jobLane("nam", who)).toBe("team");
    expect(jobLane("buddy", who)).toBe("team");
    expect(jobLane("kit", who)).toBe("code");
  });

  it("have no Code while the team has no engineer, and no Chat while it has no lead", () => {
    expect(threadLane("nam", { home: "buddy", kit: null })).toBe("team");
    expect(threadLane("buddy", { home: null, kit: null })).toBe("team");
  });

  it("offer the kinds that have an entry, in the order the chips show them", () => {
    expect(lanesPresent(["code", "team", "team", "chat"])).toEqual(["chat", "team", "code"]);
    expect(lanesPresent(["team", "team"])).toEqual(["team"]);
    expect(lanesPresent([])).toEqual([]);
  });
});

// The search box finds a thread by the words the runtime lists for it: its title, the last thing said in it and who it is with.
describe("History's search", () => {
  const e = { title: "Discount for a bulk order", preview: "We can do 8% off for twenty candles.", who: "Buddy" };

  it("matches the words of the title, of the last message and of the member's name, in any case and with the spaces around ignored", () => {
    for (const q of ["bulk", "  DISCOUNT ", "twenty candles", "8% off", "buddy"]) expect(matchWords(e, q, "Untitled"), q).toBe(true);
  });

  it("matches nothing for words that are in none of them, and everything for none", () => {
    expect(matchWords(e, "refund", "Untitled")).toBe(false);
    expect(matchWords(e, "", "Untitled")).toBe(true);
    expect(matchWords(e, "   ", "Untitled")).toBe(true);
  });

  it("matches a thread with no title yet by the name the page shows for it, and one with no last message by its title", () => {
    expect(matchWords({ title: "", who: "Kit" }, "untitled", "Untitled thread")).toBe(true);
    expect(matchWords({ title: "Thai date format", who: "Kit" }, "date", "Untitled thread")).toBe(true);
  });
});
