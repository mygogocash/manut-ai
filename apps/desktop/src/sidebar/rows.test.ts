// The row marks (item 76): reading a saved record (an older build's, one with a field this build does not know, a broken one), the
// places a row goes, that an ask always brings a snoozed or settled row back, and what is kept across a restart. Item 94: undo.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actOnRows, applyRow, applyRows, arrange, changedFrom, DAY_MS, finishAll, pickedTime, settleDue, settleRows, type SettleRow, getRowMarks, getRowUndo, markRow, nextWake, parseRowMarks, placeOf, resetRowMarks, restoreRows, ROWS_KEY, setRowMarks, snoozeUntil, sweep, threadRowKey, sessionRowKey, undoRows, UNDO_MS, wakeAll, wakeRows, type RowAction, type RowMark, type RowMarks } from "./rows";

const HOUR = 3_600_000;
const T = threadRowKey("buddy", "t1");

describe("reading a saved record", () => {
  it("reads a record from a build before marks (none, an empty object, null, a list) as no marks", () => {
    for (const raw of [null, "", "{}", "null", "[]", "5", "not json"]) expect(parseRowMarks(raw), String(raw)).toEqual({});
  });

  it("keeps the marks of a chat and drops a field this build does not know without failing", () => {
    const raw = JSON.stringify({ [T]: { pinned: 5, colour: "red", pinnedBy: "x" }, "thread:buddy:t2": { settled: true, future: { a: 1 } }, "thread:buddy:t3": { snoozed: 9 } });
    expect(parseRowMarks(raw)).toEqual({ [T]: { pinned: 5 }, "thread:buddy:t2": { settled: true }, "thread:buddy:t3": { snoozed: 9 } });
  });

  it("drops a mark of the wrong type, a row with no mark left and a key that is not a chat's, a lane's or a terminal's", () => {
    const raw = JSON.stringify({ [T]: { pinned: "yes", snoozed: -1, settled: false }, "job:s1": { pinned: 1 }, x: { pinned: 1 }, "thread:b:t": 5 });
    expect(parseRowMarks(raw)).toEqual({});
  });

  it("puts a row in one place when a hand-edited record names several: archived, then pinned, snoozed, settled", () => {
    expect(parseRowMarks(JSON.stringify({ [T]: { pinned: 1, snoozed: 2, settled: true, archived: 3 } }))).toEqual({ [T]: { archived: 3 } });
    expect(parseRowMarks(JSON.stringify({ [T]: { snoozed: 2, settled: true } }))).toEqual({ [T]: { snoozed: 2 } });
  });
});

describe("where a row goes", () => {
  const NOW = 1_000_000;
  it("is normal with no mark", () => expect(placeOf(undefined, false, NOW)).toBe("normal"));
  it("is pinned, snoozed until its time, settled or archived by its mark", () => {
    expect(placeOf({ pinned: 1 }, false, NOW)).toBe("pinned");
    expect(placeOf({ snoozed: NOW + 1 }, false, NOW)).toBe("snoozed");
    expect(placeOf({ snoozed: NOW }, false, NOW)).toBe("normal");
    expect(placeOf({ settled: true }, false, NOW)).toBe("settled");
    expect(placeOf({ archived: 1 }, false, NOW)).toBe("archived");
  });

  it("never hides an ask: a snoozed or settled row that needs the person is in its normal place", () => {
    expect(placeOf({ snoozed: NOW + HOUR }, true, NOW)).toBe("normal");
    expect(placeOf({ settled: true }, true, NOW)).toBe("normal");
    // pinned stays on top; archived is the person's own word, and Needs you still lists its ask
    expect(placeOf({ pinned: 1 }, true, NOW)).toBe("pinned");
    expect(placeOf({ archived: 1 }, true, NOW)).toBe("archived");
  });

  it("orders the pinned by when they were pinned, first pinned on top, and keeps every other order", () => {
    const items = ["a", "b", "c", "d", "e"].map((key) => ({ key }));
    const marks: RowMarks = { c: { pinned: 20 }, a: { pinned: 30 }, e: { settled: true }, d: { snoozed: NOW + HOUR } };
    const p = arrange(items, marks, NOW);
    expect(p.pinned.map((x) => x.key)).toEqual(["c", "a"]);
    expect(p.normal.map((x) => x.key)).toEqual(["b"]);
    expect(p.settled.map((x) => x.key)).toEqual(["e"]);
    expect(p.snoozed.map((x) => x.key)).toEqual(["d"]);
  });
});

describe("changing a row", () => {
  it("pins once (a second pin keeps its place), and unpins", () => {
    const a = applyRow({}, "k", { do: "pin" }, 5);
    expect(a).toEqual({ k: { pinned: 5 } });
    expect(applyRow(a, "k", { do: "pin" }, 9)).toBe(a);
    // the row is on its own place again, from 9 (item 94: when a mark left it)
    expect(applyRow(a, "k", { do: "unpin" }, 9)).toEqual({ k: { back: 9 } });
    expect(applyRow({}, "k", { do: "unpin" }, 9)).toEqual({});
  });

  it("keeps a row in one place: each of snooze, settle and archive replaces a pin, and a pin replaces a snooze", () => {
    const pinned: RowMarks = { k: { pinned: 1 } };
    expect(applyRow(pinned, "k", { do: "snooze", until: 50 }, 2)).toEqual({ k: { snoozed: 50 } });
    expect(applyRow(pinned, "k", { do: "settle" }, 2)).toEqual({ k: { settled: true } });
    expect(applyRow(pinned, "k", { do: "archive" }, 2)).toEqual({ k: { archived: 2 } });
    expect(applyRow({ k: { snoozed: 50 } }, "k", { do: "pin" }, 2)).toEqual({ k: { pinned: 2 } });
  });

  it("does not pin, snooze or settle an archived row; restore brings it back and nothing more", () => {
    const gone: RowMarks = { k: { archived: 1 } };
    for (const a of [{ do: "pin" }, { do: "snooze", until: 5 }, { do: "settle" }] as const) expect(applyRow(gone, "k", a, 9), a.do).toBe(gone);
    expect(applyRow(gone, "k", { do: "restore" }, 9)).toEqual({ k: { back: 9 } });
    expect(applyRow({ k: { pinned: 1 } }, "k", { do: "restore" }, 9)).toEqual({ k: { pinned: 1 } });
  });

  it("wakes a snoozed or settled row and leaves a pin alone; opening clears a settle but not a snooze", () => {
    expect(applyRow({ k: { snoozed: 50 } }, "k", { do: "wake" }, 1)).toEqual({ k: { back: 1 } });
    expect(applyRow({ k: { settled: true } }, "k", { do: "wake" }, 1)).toEqual({ k: { back: 1 } });
    const pinned: RowMarks = { k: { pinned: 1 } };
    expect(applyRow(pinned, "k", { do: "wake" }, 1)).toBe(pinned);
    expect(applyRow({ k: { settled: true } }, "k", { do: "open" }, 1)).toEqual({ k: { back: 1 } });
    // a row with only that note is on its own place, and waking or opening it changes nothing
    const back: RowMarks = { k: { back: 1 } };
    expect(placeOf(back.k, false, 5)).toBe("normal");
    expect(applyRow(back, "k", { do: "wake" }, 5)).toBe(back);
    expect(applyRow(back, "k", { do: "open" }, 5)).toBe(back);
    const snoozed: RowMarks = { k: { snoozed: 50 } };
    expect(applyRow(snoozed, "k", { do: "open" }, 1)).toBe(snoozed);
  });

  it("wakes every row an ask came to", () => {
    const marks: RowMarks = { a: { settled: true }, b: { snoozed: 99 }, c: { pinned: 1 }, d: { settled: true } };
    expect(wakeAll(marks, ["a", "b", "c"], 1)).toEqual({ a: { back: 1 }, b: { back: 1 }, c: { pinned: 1 }, d: { settled: true } });
  });
});

describe("snoozing", () => {
  // Wednesday 25 November 2026, 14:30 on this computer's clock
  const wed = new Date(2026, 10, 25, 14, 30).getTime();
  it("offers an hour, tomorrow morning at 9:00 and next Monday at 9:00", () => {
    expect(snoozeUntil("hour", wed)).toBe(wed + HOUR);
    expect(new Date(snoozeUntil("tomorrow", wed))).toEqual(new Date(2026, 10, 26, 9));
    expect(new Date(snoozeUntil("week", wed))).toEqual(new Date(2026, 10, 30, 9));
  });
  it("makes next week a full week from a Monday", () => {
    const mon = new Date(2026, 10, 23, 8).getTime();
    expect(new Date(snoozeUntil("week", mon))).toEqual(new Date(2026, 10, 30, 9));
    const sun = new Date(2026, 10, 29, 20).getTime();
    expect(new Date(snoozeUntil("week", sun))).toEqual(new Date(2026, 10, 30, 9));
  });
  it("names the next time a snooze ends, and drops one that has ended and a closed session's marks", () => {
    const marks: RowMarks = { a: { snoozed: 500 }, b: { snoozed: 300 }, c: { pinned: 1 }, "session:s1": { pinned: 2 }, "session:s2": { settled: true } };
    expect(nextWake(marks, 100)).toBe(300);
    expect(nextWake({ c: { pinned: 1 } }, 100)).toBeNull();
    // an ended snooze leaves the time it was due (item 94), and a closed session's marks go whole
    expect(sweep(marks, 400, (k) => k !== "session:s2")).toEqual({ a: { snoozed: 500 }, b: { back: 300 }, c: { pinned: 1 }, "session:s1": { pinned: 2 } });
    // nothing to drop: the same object
    expect(sweep(marks, 100, () => true)).toBe(marks);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("what is kept", () => {
  const disk = new Map<string, string>();
  beforeEach(() => {
    disk.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v) });
    resetRowMarks({});
  });

  it("keys a lane by its own folder and a terminal by its link id, never by the session's number (item 94)", () => {
    expect(sessionRowKey({ id: "s3", linkId: "k7m2p9q4", lane: { worktree: "/Users/me/.manut/lanes/web-app/promptpay-qr" } })).toBe("lane:/Users/me/.manut/lanes/web-app/promptpay-qr");
    expect(sessionRowKey({ id: "s3", linkId: "k7m2p9q4" })).toBe("session:k7m2p9q4");
    // a lane that made no folder of its own is known by its link id, as a terminal is
    expect(sessionRowKey({ id: "s3", linkId: "k7m2p9q4", lane: {} })).toBe("session:k7m2p9q4");
    // the same session after a restart (same folder, same link id, perhaps another number) has the same key
    expect(sessionRowKey({ id: "s1", linkId: "k7m2p9q4" })).toBe(sessionRowKey({ id: "s3", linkId: "k7m2p9q4" }));
  });

  it("keeps the marks of a chat, a lane and a terminal across a restart (item 94)", () => {
    const lane = sessionRowKey({ id: "s2", linkId: "aaaa2222", lane: { worktree: "/Users/me/.manut/lanes/web-app/promptpay-qr" } });
    const term = sessionRowKey({ id: "s5", linkId: "bbbb5555" });
    markRow(T, { do: "pin" }, 7);
    markRow(lane, { do: "settle" }, 8);
    markRow(term, { do: "snooze", until: 9e12 }, 9);
    const kept = { [T]: { pinned: 7 }, [lane]: { settled: true }, [term]: { snoozed: 9e12 } };
    expect(JSON.parse(localStorage.getItem(ROWS_KEY) ?? "{}")).toEqual(kept);
    // a restart reads what was kept
    resetRowMarks(parseRowMarks(localStorage.getItem(ROWS_KEY)));
    expect(getRowMarks()).toEqual(kept);
  });

  it("clears a mark when an ask wakes the row, and says nothing for a row with none", () => {
    setRowMarks({ [T]: { settled: true } });
    wakeRows([T, "thread:buddy:other"], 70);
    expect(getRowMarks()).toEqual({ [T]: { back: 70 } });
  });
});

describe("undo (item 94)", () => {
  const disk = new Map<string, string>();
  beforeEach(() => {
    disk.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v) });
    resetRowMarks({});
  });
  afterEach(() => vi.useRealTimers());

  const A = threadRowKey("buddy", "a");
  const B = threadRowKey("buddy", "b");

  it("takes back each of Pin, Snooze, Done for now and Archive, putting back exactly the mark the row had", () => {
    const had: (RowMark | undefined)[] = [undefined, { pinned: 3 }, { snoozed: 9e12 }, { settled: true }];
    const acts: RowAction[] = [{ do: "pin" }, { do: "snooze", until: 8e12 }, { do: "settle" }, { do: "archive" }];
    for (const was of had)
      for (const a of acts) {
        const start: RowMarks = was ? { [A]: was, [B]: { pinned: 1 } } : { [B]: { pinned: 1 } };
        resetRowMarks(start);
        actOnRows([A], a, "Weekend sale post", 50);
        if (getRowMarks()[A] === start[A]) continue; // pinning a pinned row changes nothing, and nothing is held to undo
        expect(getRowUndo()?.kind, `${JSON.stringify(was)} ${a.do}`).toBe(a.do);
        expect(undoRows()).toBe(true);
        expect(getRowMarks(), `${JSON.stringify(was)} ${a.do}`).toEqual(start);
        expect(getRowUndo()).toBeNull();
      }
  });

  it("holds nothing for an action that changed nothing, and for unpin, bring back and restore", () => {
    resetRowMarks({ [A]: { pinned: 1 } });
    actOnRows([A], { do: "pin" }, "x", 5);
    expect(getRowUndo()).toBeNull();
    actOnRows([A], { do: "unpin" }, "x", 5);
    expect(getRowUndo()).toBeNull();
    expect(undoRows()).toBe(false);
  });

  it("takes back a whole bulk action, each row to its own mark, and keeps only the newest action", () => {
    resetRowMarks({ [A]: { pinned: 2 }, [B]: { snoozed: 9e12 } });
    const C = threadRowKey("buddy", "c");
    actOnRows([A, B, C], { do: "settle" }, "3 chats", 10);
    expect(getRowMarks()).toEqual({ [A]: { settled: true }, [B]: { settled: true }, [C]: { settled: true } });
    actOnRows([C], { do: "archive" }, "c", 11);
    // the newest is the one Undo holds
    expect(undoRows()).toBe(true);
    expect(getRowMarks()[C]).toEqual({ settled: true });
    expect(undoRows()).toBe(false);
    // the bulk settle again, then its undo: every row back as it was
    resetRowMarks({ [A]: { pinned: 2 }, [B]: { snoozed: 9e12 } });
    actOnRows([A, B, C], { do: "settle" }, "3 chats", 10);
    undoRows();
    expect(getRowMarks()).toEqual({ [A]: { pinned: 2 }, [B]: { snoozed: 9e12 } });
  });

  it("goes after a few seconds", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    actOnRows([A], { do: "settle" }, "a");
    expect(getRowUndo()?.until).toBe(1_000_000 + UNDO_MS);
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(getRowUndo()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(getRowUndo()).toBeNull();
    expect(undoRows()).toBe(false);
  });

  it("restores exactly: a row that had no mark loses the one it was given, the others keep theirs", () => {
    const marks: RowMarks = { [A]: { settled: true }, [B]: { pinned: 4 } };
    expect(restoreRows(marks, { [A]: undefined })).toEqual({ [B]: { pinned: 4 } });
    expect(restoreRows(marks, { [A]: { snoozed: 7 } })).toEqual({ [A]: { snoozed: 7 }, [B]: { pinned: 4 } });
    // nothing to put back: the same object
    expect(restoreRows(marks, { [B]: marks[B] })).toBe(marks);
    expect(changedFrom(marks, applyRows(marks, [A, B], { do: "settle" }, 1), [A, B])).toEqual({ [B]: { pinned: 4 } });
  });
});

describe("snooze until a picked time, or until it finishes (item 94)", () => {
  const NOW = new Date(2026, 10, 26, 14, 30).getTime();
  const K = "thread:buddy:k";

  it("takes a real time ahead from the date and time fields, and nothing else", () => {
    expect(pickedTime("2026-11-27", "09:30", NOW)).toBe(new Date(2026, 10, 27, 9, 30).getTime());
    expect(pickedTime("2026-11-26", "15:00", NOW)).toBe(new Date(2026, 10, 26, 15).getTime());
    // passed, or now
    expect(pickedTime("2026-11-26", "14:30", NOW)).toBeNull();
    expect(pickedTime("2026-11-25", "09:00", NOW)).toBeNull();
    // a date that does not exist, or a malformed field
    expect(pickedTime("2027-02-31", "09:00", NOW)).toBeNull();
    for (const [d, tm] of [["", "09:00"], ["2026-11-27", ""], ["27/11/2026", "09:00"], ["2026-11-27", "9:00"], ["2026-11-27", "25:00"]]) expect(pickedTime(d!, tm!, NOW), `${d} ${tm}`).toBeNull();
  });

  it("is snoozed while its turn runs and back once it ends", () => {
    const marks = applyRow({}, K, { do: "snoozeTurn" }, NOW);
    expect(marks).toEqual({ [K]: { untilDone: NOW } });
    expect(placeOf(marks[K], false, NOW, true)).toBe("snoozed");
    expect(placeOf(marks[K], false, NOW, false)).toBe("normal");
    // the watcher clears it for a row whose turn is not running, and leaves every other mark alone
    const others: RowMarks = { ...marks, a: { snoozed: NOW + HOUR }, b: { settled: true } };
    expect(finishAll(others, [K, "a", "b"], NOW + 5)).toEqual({ a: { snoozed: NOW + HOUR }, b: { settled: true }, [K]: { back: NOW + 5 } });
    expect(finishAll(others, ["a"], NOW)).toBe(others);
  });

  it("is woken at once by an ask, whether snoozed until a picked time or until it finishes", () => {
    const picked = applyRow({}, K, { do: "snooze", until: pickedTime("2026-11-27", "09:30", NOW)! }, NOW);
    const turn = applyRow({}, K, { do: "snoozeTurn" }, NOW);
    for (const m of [picked, turn]) {
      expect(placeOf(m[K], true, NOW, true)).toBe("normal");
      expect(placeOf(wakeAll(m, [K], NOW)[K], false, NOW, true)).toBe("normal");
    }
  });

  it("reads and keeps a snooze until it finishes, and undoes it as a snooze", () => {
    expect(parseRowMarks(JSON.stringify({ [K]: { untilDone: 5 } }))).toEqual({ [K]: { untilDone: 5 } });
    expect(parseRowMarks(JSON.stringify({ [K]: { untilDone: 5, settled: true } }))).toEqual({ [K]: { untilDone: 5 } });
    resetRowMarks({ [K]: { pinned: 1 } });
    actOnRows([K], { do: "snoozeTurn" }, "k", NOW);
    expect(getRowUndo()?.kind).toBe("snooze");
    undoRows();
    expect(getRowMarks()).toEqual({ [K]: { pinned: 1 } });
  });
});

describe("settling by itself (item 94)", () => {
  const NOW = 100 * DAY_MS;
  const rules = { quietDays: 3, merged: true };
  const quiet = (key: string, daysAgo: number, over: Partial<SettleRow> = {}): SettleRow => ({ key, last: NOW - daysAgo * DAY_MS, needs: false, working: false, ...over });

  it("settles a row untouched for the days set, counted on the clock given, and says why", () => {
    const due = settleDue([quiet("a", 3), quiet("b", 2.9), quiet("c", 10)], {}, NOW, rules);
    expect(due).toEqual([
      { key: "a", action: { do: "autoSettle", why: "quiet", days: 3 } },
      { key: "c", action: { do: "autoSettle", why: "quiet", days: 3 } },
    ]);
    const marks = applyRow({}, "a", due[0]!.action, NOW);
    expect(marks.a).toEqual({ settled: true, why: "quiet", days: 3 });
    expect(placeOf(marks.a, false, NOW)).toBe("settled");
  });

  it("is off at 0 days", () => {
    expect(settleDue([quiet("a", 400)], {}, NOW, { quietDays: 0, merged: true })).toEqual([]);
  });

  it("never settles a row with an ask waiting, one whose turn runs, the one open, or one the app has no time for", () => {
    expect(settleDue([quiet("a", 9, { needs: true }), quiet("b", 9, { working: true }), quiet("c", 9), quiet("d", 9, { last: null })], {}, NOW, rules, "c")).toEqual([]);
  });

  it("never settles over the person's own mark, and counts from when a row was last brought back", () => {
    const marks: RowMarks = { a: { pinned: 1 }, b: { snoozed: NOW + 1 }, c: { settled: true }, d: { archived: 1 }, e: { untilDone: 1 }, f: { back: NOW - DAY_MS } };
    expect(settleDue(["a", "b", "c", "d", "e", "f"].map((k) => quiet(k, 30)), marks, NOW, rules)).toEqual([]);
    // brought back four days ago and quiet since: it settles again
    expect(settleDue([quiet("f", 30)], { f: { back: NOW - 4 * DAY_MS } }, NOW, rules).map((d) => d.key)).toEqual(["f"]);
  });

  it("is back, with nothing lost, when it is opened or asks, and is not settled again until it has been quiet as long again", () => {
    const settled = applyRow({}, "a", { do: "autoSettle", why: "quiet", days: 3 }, NOW);
    const opened = applyRow(settled, "a", { do: "open" }, NOW + 1);
    expect(opened).toEqual({ a: { back: NOW + 1 } });
    expect(settleDue([quiet("a", 30)], opened, NOW + 2, rules)).toEqual([]);
    expect(settleDue([quiet("a", 30)], opened, NOW + 1 + 3 * DAY_MS, rules).map((d) => d.key)).toEqual(["a"]);
    const asked = applyRow(settled, "a", { do: "wake" }, NOW + 1);
    expect(placeOf(asked.a, false, NOW + 1)).toBe("normal");
  });

  it("settles a lane whose pull request the host said merged, only with that setting on, and says so", () => {
    const lane = quiet("lane:/l/a", 0, { merged: true });
    expect(settleDue([lane], {}, NOW, rules)).toEqual([{ key: "lane:/l/a", action: { do: "autoSettle", why: "merged" } }]);
    expect(settleDue([lane], {}, NOW, { quietDays: 3, merged: false })).toEqual([]);
    // not merged: nothing, however it looks
    expect(settleDue([quiet("lane:/l/b", 0, { merged: false })], {}, NOW, rules)).toEqual([]);
    // and never with an ask waiting
    expect(settleDue([quiet("lane:/l/a", 0, { merged: true, needs: true })], {}, NOW, rules)).toEqual([]);
  });

  it("is not something Undo holds: the person did not do it", () => {
    resetRowMarks({});
    settleRows(settleDue([quiet("a", 9)], {}, NOW, rules), NOW);
    expect(getRowMarks()).toEqual({ a: { settled: true, why: "quiet", days: 3 } });
    expect(getRowUndo()).toBeNull();
  });

  it("reads why a row settled, and drops a why that does not fit", () => {
    expect(parseRowMarks(JSON.stringify({ [T]: { settled: true, why: "quiet", days: 3 } }))).toEqual({ [T]: { settled: true, why: "quiet", days: 3 } });
    expect(parseRowMarks(JSON.stringify({ [T]: { settled: true, why: "merged", days: 3 } }))).toEqual({ [T]: { settled: true, why: "merged" } });
    expect(parseRowMarks(JSON.stringify({ [T]: { settled: true, why: "bored" } }))).toEqual({ [T]: { settled: true } });
    expect(parseRowMarks(JSON.stringify({ [T]: { why: "quiet" } }))).toEqual({});
    expect(parseRowMarks(JSON.stringify({ [T]: { back: 5 } }))).toEqual({ [T]: { back: 5 } });
    expect(parseRowMarks(JSON.stringify({ [T]: { back: 5, pinned: 2 } }))).toEqual({ [T]: { pinned: 2 } });
  });
});
