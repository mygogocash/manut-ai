// When a workflow runs by itself (item 77b): due, not due, missed while the app was closed or the Mac asleep, the zone, and a
// workflow's times before its file was first seen.
import { afterEach, describe, expect, it } from "vitest";
import { pinComputerZone } from "../lib/zone";
import type { Workflow } from "./file";
import { clockStep, GRACE_MS, nextAt, zoneOf } from "./schedule";

const wf = (over: Partial<Workflow> = {}): Workflow => ({
  file: "nightly.json",
  name: "Nightly tests",
  project: "/w/shop",
  agent: "claude",
  steps: ["Run the tests."],
  schedule: { kind: "daily", at: "02:00" },
  timeZone: "Asia/Bangkok",
  digest: "0".repeat(64),
  ...over,
});
/** 02:00 in Bangkok (UTC+7) on 25 November 2026 is 19:00 UTC the day before. */
const DUE = Date.UTC(2026, 10, 24, 19, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const step = (o: { last: number | null; now: number; loadedAt?: number; list?: Workflow[]; seenAt?: number }) =>
  clockStep({ last: o.last, now: o.now, loadedAt: o.loadedAt ?? o.last ?? 0, list: (o.list ?? [wf()]).map((workflow) => ({ workflow, seenAt: o.seenAt ?? 0 })) });

afterEach(() => pinComputerZone(null));

describe("the clock", () => {
  it("runs a time that fell due since the last look, and nothing before or after it", () => {
    expect(step({ last: DUE - 30_000, now: DUE + 1_000 })).toEqual({ run: [{ file: "nightly.json", due: DUE }], skip: [] });
    // not yet
    expect(step({ last: DUE - 60_000, now: DUE - 30_000 })).toEqual({ run: [], skip: [] });
    // already looked at past it: not run twice
    expect(step({ last: DUE + 1_000, now: DUE + 31_000 })).toEqual({ run: [], skip: [] });
  });

  it("still runs a time read a little late, within the grace", () => {
    expect(step({ last: DUE - 30_000, now: DUE + GRACE_MS }).run).toEqual([{ file: "nightly.json", due: DUE }]);
  });

  it("does not make up a time missed while the app was closed: it is skipped, with why", () => {
    const opened = DUE + 3 * 60 * MIN;
    // the app closed the evening before and opened three hours after the time
    expect(step({ last: DUE - 5 * 60 * MIN, loadedAt: opened, now: opened })).toEqual({ run: [], skip: [{ file: "nightly.json", due: DUE, why: "closed" }] });
    // closed for three days: three times missed, each kept
    expect(step({ last: DUE - 60 * MIN, loadedAt: DUE + 2 * DAY + 60 * MIN, now: DUE + 2 * DAY + 60 * MIN }).skip.map((s) => s.due)).toEqual([DUE, DUE + DAY, DUE + 2 * DAY]);
  });

  it("says the Mac was asleep for a time missed while the app was open", () => {
    const loaded = DUE - 10 * 60 * MIN;
    expect(step({ last: DUE - 60 * MIN, loadedAt: loaded, now: DUE + 30 * MIN })).toEqual({ run: [], skip: [{ file: "nightly.json", due: DUE, why: "asleep" }] });
  });

  it("runs a time that fell due just now after a long sleep, and skips the ones before", () => {
    const loaded = DUE - 3 * DAY;
    const r = step({ last: DUE - 2 * DAY + 60 * MIN, loadedAt: loaded, now: DUE + 30_000 });
    expect(r.skip).toEqual([{ file: "nightly.json", due: DUE - DAY, why: "asleep" }]);
    expect(r.run).toEqual([{ file: "nightly.json", due: DUE }]);
  });

  it("does nothing at the first look, or when the clock went back", () => {
    expect(step({ last: null, now: DUE + 1_000 })).toEqual({ run: [], skip: [] });
    expect(step({ last: DUE + DAY, now: DUE + 1_000 })).toEqual({ run: [], skip: [] });
  });

  it("never counts a time before the app first saw the file", () => {
    const seen = DUE + DAY - 60 * MIN;
    const r = step({ last: DUE - 60 * MIN, loadedAt: DUE + 2 * DAY, now: DUE + 2 * DAY + 30_000, seenAt: seen });
    expect(r.skip.map((s) => s.due)).toEqual([DUE + DAY]);
    expect(r.run).toEqual([{ file: "nightly.json", due: DUE + 2 * DAY }]);
  });

  it("leaves a workflow without a schedule alone: it runs only when Run now is pressed", () => {
    expect(step({ last: DUE - DAY, now: DUE + DAY, list: [wf({ schedule: undefined })] })).toEqual({ run: [], skip: [] });
    expect(nextAt(wf({ schedule: undefined }), DUE)).toBeNull();
  });
});

describe("the zone", () => {
  it("reads the time in the workflow's own zone", () => {
    expect(nextAt(wf(), DUE - MIN)).toBe(DUE);
    // 02:00 in New York (UTC-5 in November) is 07:00 UTC
    expect(nextAt(wf({ timeZone: "America/New_York" }), Date.UTC(2026, 10, 25, 6, 0))).toBe(Date.UTC(2026, 10, 25, 7, 0));
  });

  it("reads it in this computer's zone when the workflow names none", () => {
    pinComputerZone("Europe/London");
    const london = wf({ timeZone: undefined });
    expect(zoneOf(london)).toBe("Europe/London");
    expect(nextAt(london, Date.UTC(2026, 10, 25, 1, 0))).toBe(Date.UTC(2026, 10, 25, 2, 0));
    expect(zoneOf(wf())).toBe("Asia/Bangkok");
  });

  it("follows a weekly and a monthly time", () => {
    // 25 November 2026 is a Wednesday; the next Friday 09:00 in Bangkok is 27 November, 02:00 UTC
    expect(nextAt(wf({ schedule: { kind: "weekly", weekdays: [5], at: "09:00" } }), Date.UTC(2026, 10, 25, 0, 0))).toBe(Date.UTC(2026, 10, 27, 2, 0));
    expect(nextAt(wf({ schedule: { kind: "monthly", day: "last", at: "08:00" } }), Date.UTC(2026, 10, 25, 0, 0))).toBe(Date.UTC(2026, 10, 30, 1, 0));
  });
});
