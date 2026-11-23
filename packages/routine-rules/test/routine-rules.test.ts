import { describe, expect, it } from "vitest";
import {
  checkRoutine,
  createRoutine,
  describeTrigger,
  inWindow,
  nextRun,
  toSchedule,
  type Routine,
  type RoutineInput,
  type Trigger,
} from "../src/index";

function make(trigger: Trigger, extra: Partial<RoutineInput> = {}): Routine {
  const r = createRoutine({ id: "r1", name: "Test", action: "brief", trigger, ...extra });
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.routine;
}
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
// Bangkok is UTC+7 all year, so 08:00 there is 01:00Z.
const BKK = (s: string) => Date.parse(`${s}+07:00`);

describe("createRoutine", () => {
  it("defaults the zone to Asia/Bangkok and trims name and id", () => {
    const r = createRoutine({ id: " a ", name: "  Morning brief ", action: "brief", trigger: { kind: "daily", at: "08:00" } });
    expect(r).toEqual({
      ok: true,
      routine: { id: "a", name: "Morning brief", action: "brief", timeZone: "Asia/Bangkok", trigger: { kind: "daily", at: "08:00" }, asksFirst: false },
    });
  });

  it.each(["reply", "send", "pay", "delete"] as const)("%s always asks first", (action) => {
    const ok = createRoutine({ id: "a", name: "x", action, trigger: { kind: "daily", at: "08:00" } });
    expect(ok.ok && ok.routine.asksFirst).toBe(true);
    const refused = createRoutine({ id: "a", name: "x", action, asksFirst: false, trigger: { kind: "daily", at: "08:00" } });
    expect(refused).toEqual({ ok: false, reason: "must_ask_first" });
  });

  it.each(["brief", "draft"] as const)("%s may run without asking, or ask", (action) => {
    const a = createRoutine({ id: "a", name: "x", action, trigger: { kind: "daily", at: "08:00" } });
    expect(a.ok && a.routine.asksFirst).toBe(false);
    const b = createRoutine({ id: "a", name: "x", action, asksFirst: true, trigger: { kind: "daily", at: "08:00" } });
    expect(b.ok && b.routine.asksFirst).toBe(true);
  });

  const daily: Trigger = { kind: "daily", at: "08:00" };
  const bad = (input: Partial<RoutineInput> | Record<string, unknown>, reason: string) =>
    expect(createRoutine({ id: "a", name: "x", action: "brief", trigger: daily, ...input } as RoutineInput)).toEqual({ ok: false, reason });

  it("refuses each bad field", () => {
    bad({ id: "  " }, "invalid_id");
    bad({ name: "" }, "invalid_name");
    bad({ name: "   " }, "invalid_name");
    bad({ name: "x".repeat(81) }, "invalid_name");
    bad({ action: "fly" }, "invalid_action");
    bad({ timeZone: "Mars/Base" }, "invalid_time_zone");
    bad({ timeZone: "" }, "invalid_time_zone");
    bad({ trigger: { kind: "hourly" } }, "invalid_trigger");
    bad({ trigger: null }, "invalid_trigger");
    bad({ trigger: { kind: "daily", at: "8:00" } }, "invalid_time");
    bad({ trigger: { kind: "daily", at: "24:00" } }, "invalid_time");
    bad({ trigger: { kind: "daily", at: "08:60" } }, "invalid_time");
    bad({ trigger: { kind: "weekly", weekdays: [], at: "08:00" } }, "invalid_weekdays");
    bad({ trigger: { kind: "weekly", weekdays: [7], at: "08:00" } }, "invalid_weekdays");
    bad({ trigger: { kind: "weekly", weekdays: [1.5], at: "08:00" } }, "invalid_weekdays");
    bad({ trigger: { kind: "monthly", day: 0, at: "08:00" } }, "invalid_day");
    bad({ trigger: { kind: "monthly", day: 29, at: "08:00" } }, "invalid_day");
    bad({ trigger: { kind: "monthly", day: "first", at: "08:00" } }, "invalid_day");
    bad({ trigger: { kind: "window", from: "09:00", to: "09:00" } }, "invalid_window");
    bad({ trigger: { kind: "window", from: "09:00", to: "x" } }, "invalid_time");
    bad({ trigger: { kind: "stockBelow", threshold: 0 } }, "invalid_threshold");
    bad({ trigger: { kind: "stockBelow", threshold: 2.5 } }, "invalid_threshold");
    bad({ trigger: { kind: "stockBelow", threshold: NaN } }, "invalid_threshold");
  });

  it("counts a name in characters and never throws on junk", () => {
    const thai = "ก".repeat(80);
    expect(createRoutine({ id: "a", name: thai, action: "brief", trigger: daily }).ok).toBe(true);
    expect(createRoutine(null as never)).toEqual({ ok: false, reason: "invalid_id" });
    expect(checkRoutine(undefined)).not.toBeNull();
  });
});

describe("nextRun: daily", () => {
  const r = make({ kind: "daily", at: "08:00" });
  it("is later today before the time and tomorrow at or after it", () => {
    expect(nextRun(r, BKK("2026-11-23T07:59:00"))).toBe(BKK("2026-11-23T08:00:00"));
    expect(nextRun(r, BKK("2026-11-23T08:00:00"))).toBe(BKK("2026-11-24T08:00:00"));
    expect(nextRun(r, BKK("2026-11-23T08:00:01"))).toBe(BKK("2026-11-24T08:00:00"));
  });
  it("around midnight", () => {
    const m = make({ kind: "daily", at: "00:00" });
    expect(iso(nextRun(m, BKK("2026-11-23T23:59:59")))).toBe(iso(BKK("2026-11-24T00:00:00")));
    expect(iso(nextRun(m, BKK("2026-11-24T00:00:00")))).toBe(iso(BKK("2026-11-25T00:00:00")));
    const late = make({ kind: "daily", at: "23:59" });
    expect(nextRun(late, BKK("2026-12-31T23:59:00"))).toBe(BKK("2027-01-01T23:59:00"));
  });
  it("uses the routine's zone for the date, not UTC's", () => {
    // 20:00Z on the 22nd is already 03:00 on the 23rd in Bangkok.
    expect(nextRun(r, Date.parse("2026-11-22T20:00:00Z"))).toBe(BKK("2026-11-23T08:00:00"));
  });
});

describe("nextRun: weekly", () => {
  it("picks the nearest listed weekday (0 is Sunday)", () => {
    const r = make({ kind: "weekly", weekdays: [1, 4], at: "09:30" });
    // 23 Nov 2026 is a Monday.
    expect(nextRun(r, BKK("2026-11-23T09:29:00"))).toBe(BKK("2026-11-23T09:30:00"));
    expect(nextRun(r, BKK("2026-11-23T09:30:00"))).toBe(BKK("2026-11-26T09:30:00"));
    expect(nextRun(r, BKK("2026-11-26T10:00:00"))).toBe(BKK("2026-11-30T09:30:00"));
  });
  it("Sunday is 0 and a repeated day changes nothing", () => {
    const r = make({ kind: "weekly", weekdays: [0, 0], at: "00:00" });
    expect(nextRun(r, BKK("2026-11-23T12:00:00"))).toBe(BKK("2026-11-29T00:00:00"));
  });
});

describe("nextRun: monthly", () => {
  it("on a numbered day, rolling into the next month and year", () => {
    const r = make({ kind: "monthly", day: 15, at: "09:00" });
    expect(nextRun(r, BKK("2026-11-15T08:00:00"))).toBe(BKK("2026-11-15T09:00:00"));
    expect(nextRun(r, BKK("2026-11-15T09:00:00"))).toBe(BKK("2026-12-15T09:00:00"));
    expect(nextRun(r, BKK("2026-12-15T10:00:00"))).toBe(BKK("2027-01-15T09:00:00"));
    expect(nextRun(make({ kind: "monthly", day: 28, at: "09:00" }), BKK("2027-02-27T10:00:00"))).toBe(BKK("2027-02-28T09:00:00"));
  });
  it.each([
    ["2026-02-10T00:00:00", "2026-02-28T18:00:00"], // 28 days
    ["2028-02-10T00:00:00", "2028-02-29T18:00:00"], // 29 days, 29 February 2028
    ["2026-04-10T00:00:00", "2026-04-30T18:00:00"], // 30 days
    ["2026-01-10T00:00:00", "2026-01-31T18:00:00"], // 31 days
  ])("the last day from %s is %s", (from, expected) => {
    const r = make({ kind: "monthly", day: "last", at: "18:00" });
    expect(nextRun(r, BKK(from))).toBe(BKK(expected));
  });
  it("the last day after its own run moves to the next month's last day", () => {
    const r = make({ kind: "monthly", day: "last", at: "18:00" });
    expect(nextRun(r, BKK("2028-02-29T18:00:00"))).toBe(BKK("2028-03-31T18:00:00"));
    expect(nextRun(r, BKK("2026-01-31T18:00:00"))).toBe(BKK("2026-02-28T18:00:00"));
    expect(nextRun(r, BKK("2026-12-31T18:00:00"))).toBe(BKK("2027-01-31T18:00:00"));
  });
});

describe("window and stockBelow", () => {
  const night = make({ kind: "window", from: "21:00", to: "08:00" });
  const day = make({ kind: "window", from: "09:00", to: "17:00" });
  it("next run is the next start of the window", () => {
    expect(nextRun(night, BKK("2026-11-23T10:00:00"))).toBe(BKK("2026-11-23T21:00:00"));
    expect(nextRun(night, BKK("2026-11-23T22:00:00"))).toBe(BKK("2026-11-24T21:00:00"));
    expect(nextRun(day, BKK("2026-11-23T17:00:00"))).toBe(BKK("2026-11-24T09:00:00"));
  });
  it("inWindow across midnight and inside one day, start inclusive and end exclusive", () => {
    expect(inWindow(night, BKK("2026-11-23T20:59:00"))).toBe(false);
    expect(inWindow(night, BKK("2026-11-23T21:00:00"))).toBe(true);
    expect(inWindow(night, BKK("2026-11-23T23:59:00"))).toBe(true);
    expect(inWindow(night, BKK("2026-11-24T00:00:00"))).toBe(true);
    expect(inWindow(night, BKK("2026-11-24T07:59:00"))).toBe(true);
    expect(inWindow(night, BKK("2026-11-24T08:00:00"))).toBe(false);
    expect(inWindow(day, BKK("2026-11-23T08:59:00"))).toBe(false);
    expect(inWindow(day, BKK("2026-11-23T09:00:00"))).toBe(true);
    expect(inWindow(day, BKK("2026-11-23T17:00:00"))).toBe(false);
  });
  it("inWindow is false for other kinds and junk", () => {
    expect(inWindow(make({ kind: "daily", at: "08:00" }), Date.now())).toBe(false);
    expect(inWindow(night, NaN)).toBe(false);
    expect(inWindow(null as never, 0)).toBe(false);
  });
  it("stockBelow is an event and has no next run", () => {
    expect(nextRun(make({ kind: "stockBelow", threshold: 5 }), Date.now())).toBeNull();
  });
  it("nextRun is null for junk", () => {
    expect(nextRun(null as never, 0)).toBeNull();
    expect(nextRun(night, NaN)).toBeNull();
    expect(nextRun({ ...night, timeZone: "Nope/Zone" }, 0)).toBeNull();
  });
});

describe("daylight saving in Europe/London", () => {
  const zone = { timeZone: "Europe/London" };
  it("a time inside the spring gap runs at the first minute after it", () => {
    // 29 March 2026: clocks go from 01:00 GMT to 02:00 BST, so 01:30 never shows.
    const r = make({ kind: "daily", at: "01:30" }, zone);
    expect(iso(nextRun(r, Date.parse("2026-03-27T12:00:00Z")))).toBe("2026-03-28T01:30:00.000Z");
    expect(iso(nextRun(r, Date.parse("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:00:00.000Z"); // 02:00 BST
    expect(iso(nextRun(r, Date.parse("2026-03-29T00:00:00Z")))).toBe("2026-03-29T01:00:00.000Z"); // 02:00 BST
    // The day after is an ordinary 01:30 BST, which is 00:30Z.
    expect(iso(nextRun(r, Date.parse("2026-03-29T01:00:00Z")))).toBe("2026-03-30T00:30:00.000Z");
  });
  it("a time that happens twice runs once, at the first", () => {
    // 25 October 2026: 02:00 BST goes back to 01:00 GMT, so 01:30 shows twice.
    const r = make({ kind: "daily", at: "01:30" }, zone);
    expect(iso(nextRun(r, Date.parse("2026-10-24T12:00:00Z")))).toBe("2026-10-25T00:30:00.000Z"); // first, BST
    expect(iso(nextRun(r, Date.parse("2026-10-25T00:30:00Z")))).toBe("2026-10-26T01:30:00.000Z"); // not the second
  });
});

describe("toSchedule", () => {
  it("daily runs every day, with the API's Sunday-is-1 weekdays", () => {
    expect(toSchedule(make({ kind: "daily", at: "08:05" }))).toEqual({
      hour: 8, minute: 5, weekdays: [1, 2, 3, 4, 5, 6, 7], timeZone: "Asia/Bangkok",
    });
  });
  it("weekly shifts a routine's 0..6 to the API's 1..7, sorted and without repeats", () => {
    expect(toSchedule(make({ kind: "weekly", weekdays: [4, 1, 1, 0], at: "21:45" }, { timeZone: "Europe/London" }))).toEqual({
      hour: 21, minute: 45, weekdays: [1, 2, 5], timeZone: "Europe/London",
    });
  });
  it("is null for what the API cannot express", () => {
    expect(toSchedule(make({ kind: "monthly", day: 3, at: "08:00" }))).toBeNull();
    expect(toSchedule(make({ kind: "window", from: "21:00", to: "08:00" }))).toBeNull();
    expect(toSchedule(make({ kind: "stockBelow", threshold: 5 }))).toBeNull();
    expect(toSchedule(null as never)).toBeNull();
  });
});

describe("describeTrigger", () => {
  it.each<[Trigger, string]>([
    [{ kind: "daily", at: "08:00" }, "Every day at 08:00"],
    [{ kind: "weekly", weekdays: [1], at: "08:00" }, "Every Monday at 08:00"],
    [{ kind: "weekly", weekdays: [4, 1], at: "09:30" }, "Every Monday and Thursday at 09:30"],
    [{ kind: "weekly", weekdays: [5, 1, 3], at: "09:30" }, "Every Monday, Wednesday and Friday at 09:30"],
    [{ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], at: "07:00" }, "Every day at 07:00"],
    [{ kind: "weekly", weekdays: [0], at: "07:00" }, "Every Sunday at 07:00"],
    [{ kind: "monthly", day: 15, at: "09:00" }, "On the 15th of each month at 09:00"],
    [{ kind: "monthly", day: 1, at: "09:00" }, "On the 1st of each month at 09:00"],
    [{ kind: "monthly", day: 2, at: "09:00" }, "On the 2nd of each month at 09:00"],
    [{ kind: "monthly", day: 3, at: "09:00" }, "On the 3rd of each month at 09:00"],
    [{ kind: "monthly", day: 11, at: "09:00" }, "On the 11th of each month at 09:00"],
    [{ kind: "monthly", day: 22, at: "09:00" }, "On the 22nd of each month at 09:00"],
    [{ kind: "monthly", day: "last", at: "18:00" }, "On the last day of the month at 18:00"],
    [{ kind: "window", from: "21:00", to: "08:00" }, "Every night after 21:00"],
    [{ kind: "window", from: "09:00", to: "17:00" }, "Every day from 09:00 to 17:00"],
    [{ kind: "stockBelow", threshold: 5 }, "When stock drops under 5"],
  ])("%j reads %s", (trigger, text) => {
    expect(describeTrigger(make(trigger))).toBe(text);
  });
  it("is empty for junk", () => {
    expect(describeTrigger(null as never)).toBe("");
  });
});
