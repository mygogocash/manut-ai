// The routines half of Customize, as rules without a page: how a routine's next run is said, which kinds of work the New
// routine form offers and what it builds from what the owner chose, how the form moves, and how a refusal reaches the owner.
// What a routine is, when it runs and that one which replies or sends always asks first are @manut/routine-rules' rules,
// which the runtime applies; the form asks the package itself, so it can never disagree with the runtime.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoutine, type ActionKind } from "@manut/routine-rules";
import { LANGS, setLang, t } from "../i18n";
import { MockHost, MockRuntime } from "../runtime/mock";
import type { RoutineRow } from "../runtime/routines";
import {
  FORM_ACTIONS,
  FORM_START,
  FORM_WHENS,
  formAsksFirst,
  formParams,
  formProblem,
  formTrigger,
  nameLine,
  nextLine,
  problemText,
  ROUTINES_START,
  routineDo,
  routineStep,
  routinesReduce,
  withRoutine,
  type RoutineCalls,
  type RoutineForm,
  type RoutinesUi,
} from "./routines";

/** Seconds at `h:min` in Bangkok (UTC+7, no daylight saving) on a day of November 2026. */
const bkk = (day: number, h: number, min = 0) => Date.UTC(2026, 10, day, h - 7, min) / 1000;
/** Sunday 22 November 2026, 10:00 in Bangkok. */
const NOW = bkk(22, 10) * 1000;

const row = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  id: "r1",
  name: "Morning brief",
  when: "Every day at 08:00",
  action: "brief",
  asksFirst: false,
  enabled: true,
  next: bkk(23, 8),
  timeZone: "Asia/Bangkok",
  ...over,
});

beforeEach(() => setLang("en"));
afterEach(() => setLang("en"));

describe("when a routine next runs, said quietly", () => {
  const next = (over: Partial<RoutineRow>, now = NOW) => nextLine(row(over), now);

  it("says a run later today, Today, and the time on the 24-hour clock", () => {
    expect(next({ next: bkk(22, 21) })).toBe("Next: Today 21:00");
  });

  it("says a run in the coming days by the day's name: Next: Monday 08:00", () => {
    expect(next({ next: bkk(23, 8) })).toBe("Next: Monday 08:00");
    expect(next({ next: bkk(28, 8) })).toBe("Next: Saturday 08:00");
  });

  it("says a run a week or more away by its date, so that a weekday never means two different days", () => {
    expect(next({ next: bkk(29, 10) })).toBe("Next: 29 November 10:00");
    expect(next({ next: bkk(30, 18) })).toBe("Next: 30 November 18:00");
  });

  it("adds the year when the run is in another year", () => {
    expect(next({ next: Date.UTC(2027, 0, 15, 2, 0) / 1000 })).toBe("Next: 15 January 2027 09:00");
  });

  it("counts the day in the routine's own zone, not the computer's", () => {
    // 03:00 on Monday in Bangkok is still Sunday evening in UTC.
    const now = Date.UTC(2026, 10, 22, 20, 0);
    expect(next({ next: bkk(23, 8) }, now)).toBe("Next: Today 08:00");
    expect(next({ next: Date.UTC(2026, 10, 23, 1, 0) / 1000, timeZone: "UTC" }, now)).toBe("Next: Monday 01:00");
  });

  it("says nothing for a routine that is off, for an event that has no next run, or for one the runtime cannot time", () => {
    expect(next({ enabled: false })).toBeNull();
    expect(next({ next: null })).toBeNull();
    expect(next({ enabled: false, next: null })).toBeNull();
  });

  it("does not stop at a time zone it cannot read, and still says the time", () => {
    for (const timeZone of ["", "Not/AZone"]) expect(next({ timeZone }), timeZone).toMatch(/^Next: .*\d\d:\d\d$/);
  });

  it("says it in each language: its own label, the day in that language's words, and the same clock", () => {
    const days: Record<string, string> = { en: "Monday", ko: "월요일", ja: "月曜日", zh: "星期一" };
    for (const l of LANGS) {
      setLang(l);
      const said = next({ next: bkk(23, 8) });
      expect(said, l).toBe(t("routines.next", { when: `${days[l]} 08:00` }));
      expect(said, l).toContain("08:00");
    }
  });
});

describe("a routine's name, and that it asks first", () => {
  it("adds Asks first. to a routine that always asks: Send the books to FlowAccount. Asks first.", () => {
    expect(nameLine(row({ name: "Send the books to FlowAccount", asksFirst: true }))).toBe("Send the books to FlowAccount. Asks first.");
  });

  it("says only the name for a routine that does not ask first", () => {
    expect(nameLine(row({ name: "Morning brief", asksFirst: false }))).toBe("Morning brief");
  });

  it("says nothing either way when the runtime cannot say whether it asks, rather than a claim that it does not", () => {
    expect(nameLine(row({ name: "Morning brief", asksFirst: null }))).toBe("Morning brief");
    expect(nameLine(row({ name: "Morning brief", asksFirst: null }))).not.toMatch(/ask/i);
  });

  it("does not double a full stop the name already ends with", () => {
    expect(nameLine(row({ name: "Answer order-status questions.", asksFirst: true }))).toBe("Answer order-status questions. Asks first.");
    expect(nameLine(row({ name: "Answer questions...", asksFirst: true }))).toBe("Answer questions. Asks first.");
  });

  it("says it in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      const said = nameLine(row({ name: "Send the books", asksFirst: true }));
      expect(said, l).toContain("Send the books");
      expect(said, l).not.toBe("Send the books");
    }
  });
});

describe("the routines after one changes", () => {
  it("puts a routine where it stood, or last when the list did not have it, and leaves the list it was given alone", () => {
    const list = [row({ id: "a" }), row({ id: "b" })];
    expect(withRoutine(list, row({ id: "b", enabled: false })).map((r) => [r.id, r.enabled])).toEqual([["a", true], ["b", false]]);
    expect(withRoutine(list, row({ id: "c" })).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("what the New routine form offers", () => {
  it("offers four kinds of work: a brief, a draft, a reply and a send", () => {
    expect([...FORM_ACTIONS]).toEqual(["brief", "draft", "reply", "send"]);
  });

  it("offers no payment, refund or deletion, since payment work is parked and nothing is deleted on a schedule", () => {
    for (const parked of ["pay", "delete", "refund"]) expect(FORM_ACTIONS as readonly string[]).not.toContain(parked);
  });

  it("offers the five times of the canvas: daily, chosen days, monthly, a window and a stock number", () => {
    expect([...FORM_WHENS]).toEqual(["daily", "weekly", "monthly", "window", "stock"]);
  });

  it("starts as a brief every day at 08:00, with no name, so that it cannot be added by accident", () => {
    expect(FORM_START).toMatchObject({ name: "", action: "brief", when: "daily", at: "08:00" });
    expect(formProblem(FORM_START)).toBe("invalid_name");
  });

  it("says in all four languages what each kind and each time is called", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const a of FORM_ACTIONS) expect(t(`routines.kind.${a}` as never).trim(), `${l} ${a}`).not.toBe("");
      for (const w of FORM_WHENS) expect(t(`routines.when.${w}` as never).trim(), `${l} ${w}`).not.toBe("");
    }
  });
});

describe("what the form builds from what the owner chose", () => {
  const form = (over: Partial<RoutineForm>): RoutineForm => ({ ...FORM_START, name: "Remind me", ...over });

  it("builds every day at a time", () => {
    expect(formTrigger(form({ when: "daily", at: "09:30" }))).toEqual({ kind: "daily", at: "09:30" });
  });

  it("builds the chosen days of the week, in order, at a time", () => {
    expect(formTrigger(form({ when: "weekly", weekdays: [4, 1], at: "09:30" }))).toEqual({ kind: "weekly", weekdays: [1, 4], at: "09:30" });
  });

  it("builds a day of the month as a number, or the last day, at a time", () => {
    expect(formTrigger(form({ when: "monthly", day: "15", at: "09:00" }))).toEqual({ kind: "monthly", day: 15, at: "09:00" });
    expect(formTrigger(form({ when: "monthly", day: "last", at: "18:00" }))).toEqual({ kind: "monthly", day: "last", at: "18:00" });
  });

  it("builds a window from one time to another, which may run past midnight", () => {
    expect(formTrigger(form({ when: "window", from: "21:00", to: "08:00" }))).toEqual({ kind: "window", from: "21:00", to: "08:00" });
  });

  it("builds a stock number as a number", () => {
    expect(formTrigger(form({ when: "stock", threshold: "5" }))).toEqual({ kind: "stockBelow", threshold: 5 });
  });

  it("does not keep a field that its kind of time does not use", () => {
    expect(Object.keys(formTrigger(form({ when: "daily", weekdays: [1, 2], day: "3", from: "01:00", threshold: "9" }))).sort()).toEqual(["at", "kind"]);
  });

  it("sends the name, the kind of work and the time, and never says whether to ask first, so the package decides", () => {
    const params = formParams(form({ name: "  Remind me  ", action: "reply" }));
    expect(Object.keys(params).sort()).toEqual(["action", "name", "trigger"]);
    expect(params).toMatchObject({ name: "  Remind me  ", action: "reply" });
  });
});

describe("what is wrong with the form, as the package says it", () => {
  const form = (over: Partial<RoutineForm>): RoutineForm => ({ ...FORM_START, name: "Remind me", ...over });

  it("finds nothing wrong with a form that says what, when and at what time", () => {
    expect(formProblem(form({}))).toBeNull();
    for (const when of FORM_WHENS) expect(formProblem(form({ when })), when).toBeNull();
  });

  it("asks for a name of 1 to 80 characters", () => {
    expect(formProblem(form({ name: "   " }))).toBe("invalid_name");
    expect(formProblem(form({ name: "x".repeat(81) }))).toBe("invalid_name");
    expect(formProblem(form({ name: "x".repeat(80) }))).toBeNull();
  });

  it("asks for at least one day of the week", () => {
    expect(formProblem(form({ when: "weekly", weekdays: [] }))).toBe("invalid_weekdays");
  });

  it("asks for a time written HH:MM, such as an empty time field would not give", () => {
    expect(formProblem(form({ when: "daily", at: "" }))).toBe("invalid_time");
    expect(formProblem(form({ when: "window", from: "", to: "08:00" }))).toBe("invalid_time");
  });

  it("asks for a window that starts and ends at different times", () => {
    expect(formProblem(form({ when: "window", from: "09:00", to: "09:00" }))).toBe("invalid_window");
  });

  it("asks for a stock number that is a whole number from 1", () => {
    for (const threshold of ["", "0", "2.5", "abc", "-3"]) expect(formProblem(form({ when: "stock", threshold })), JSON.stringify(threshold)).toBe("invalid_threshold");
    expect(formProblem(form({ when: "stock", threshold: "1" }))).toBeNull();
  });

  it("ignores what a kind of time that was not chosen holds, so an old entry cannot block the form", () => {
    expect(formProblem(form({ when: "daily", weekdays: [], threshold: "abc", from: "", to: "" }))).toBeNull();
  });

  it("says each thing that can be wrong in every language, and anything else in general words", () => {
    for (const l of LANGS) {
      setLang(l);
      for (const reason of ["invalid_name", "invalid_weekdays", "invalid_time", "invalid_window", "invalid_threshold", "invalid_day"] as const) {
        expect(problemText(reason).trim(), `${l} ${reason}`).not.toBe("");
      }
      expect(problemText("invalid_trigger").trim(), l).not.toBe("");
      expect(problemText("invalid_name"), l).not.toBe(problemText("invalid_weekdays"));
    }
  });
});

describe("the asks-first rule in the form", () => {
  const form = (action: ActionKind): RoutineForm => ({ ...FORM_START, name: "Remind me", action: action as RoutineForm["action"] });

  it("shows Asks first for a routine that replies or sends, and not for a brief or a draft", () => {
    expect(formAsksFirst(form("reply"))).toBe(true);
    expect(formAsksFirst(form("send"))).toBe(true);
    expect(formAsksFirst(form("brief"))).toBe(false);
    expect(formAsksFirst(form("draft"))).toBe(false);
  });

  it("agrees, for every kind the form offers, with what the package makes of the same routine", () => {
    for (const action of FORM_ACTIONS) {
      const f = form(action);
      const made = createRoutine({ id: "preview", ...formParams(f) });
      expect(made.ok, action).toBe(true);
      if (made.ok) expect(formAsksFirst(f), action).toBe(made.routine.asksFirst);
    }
  });

  it("says so in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      expect(t("routines.form.asks").trim(), l).not.toBe("");
      expect(t("routines.asksFirst").trim(), l).not.toBe("");
    }
  });
});

describe("how the form and the switches move", () => {
  const start = ROUTINES_START;
  const act = (s: RoutinesUi, ...as: Parameters<typeof routinesReduce>[1][]) => as.reduce(routinesReduce, s);

  it("starts with the form closed and nothing on its way", () => {
    expect(start).toEqual({ form: null, problem: null, saving: false, switching: null, error: null });
  });

  it("opens the form as a fresh one each time, and closes it", () => {
    const open = act(start, { type: "open" });
    expect(open.form).toEqual(FORM_START);
    const edited = act(open, { type: "set", patch: { name: "Remind me" } }, { type: "close" }, { type: "open" });
    expect(edited.form).toEqual(FORM_START);
    expect(act(open, { type: "close" }).form).toBeNull();
  });

  it("never lets one form change the next one's starting point", () => {
    const open = act(start, { type: "open" }, { type: "weekday", day: 3 });
    expect(FORM_START.weekdays).toEqual([1]);
    expect(open.form?.weekdays).toEqual([1, 3]);
  });

  it("follows what the owner chooses and types, and forgets an old complaint as it does", () => {
    const s = act(start, { type: "open" }, { type: "problem", reason: "invalid_name" }, { type: "set", patch: { name: "R" } });
    expect(s.form?.name).toBe("R");
    expect(s.problem).toBeNull();
  });

  it("switches a day of the week on and off, keeping the days in order", () => {
    const s = act(start, { type: "open" }, { type: "set", patch: { when: "weekly", weekdays: [] } }, { type: "weekday", day: 4 }, { type: "weekday", day: 1 }, { type: "weekday", day: 0 });
    expect(s.form?.weekdays).toEqual([0, 1, 4]);
    expect(act(s, { type: "weekday", day: 1 }).form?.weekdays).toEqual([0, 4]);
  });

  it("keeps the form's complaint until the owner changes something", () => {
    const s = act(start, { type: "open" }, { type: "problem", reason: "invalid_name" });
    expect(s.problem).toBe("invalid_name");
  });

  it("closes the form once the routine is added, and keeps it, with the reason, when the runtime would not", () => {
    const saving = act(start, { type: "open" }, { type: "set", patch: { name: "R" } }, { type: "begin", what: "save" });
    expect(saving.saving).toBe(true);
    expect(act(saving, { type: "done", what: "save" })).toEqual(start);
    const refused = act(saving, { type: "failed", message: "Not yet: Connected mode only reads for now." });
    expect(refused.saving).toBe(false);
    expect(refused.form?.name).toBe("R");
    expect(refused.error).toBe("Not yet: Connected mode only reads for now.");
  });

  it("holds the form while it is being saved, so a routine is not added twice", () => {
    const saving = act(start, { type: "open" }, { type: "begin", what: "save" });
    expect(act(saving, { type: "close" })).toBe(saving);
    expect(act(saving, { type: "open" })).toBe(saving);
    expect(act(saving, { type: "set", patch: { name: "late" } })).toBe(saving);
    expect(act(saving, { type: "begin", what: "save" })).toBe(saving);
  });

  it("marks one switch as on its way, ends it, and says why a switch did not go", () => {
    const busy = act(start, { type: "begin", what: "switch", routine: "r1" });
    expect(busy.switching).toBe("r1");
    expect(act(busy, { type: "begin", what: "switch", routine: "r2" })).toBe(busy);
    expect(act(busy, { type: "done", what: "switch" })).toEqual(start);
    expect(act(busy, { type: "failed", message: "no" })).toEqual({ ...start, error: "no" });
  });

  it("forgets the last complaint when the owner tries again", () => {
    const failed = act(start, { type: "begin", what: "switch", routine: "r1" }, { type: "failed", message: "no" });
    expect(act(failed, { type: "begin", what: "switch", routine: "r1" }).error).toBeNull();
    expect(act(failed, { type: "open" }).error).toBeNull();
  });
});

describe("turning a call into words the page can show", () => {
  it("passes an answer through, and shows a refusal in the runtime's own words", async () => {
    expect(await routineStep(async () => 7)).toEqual({ ok: true, value: 7 });
    expect(
      await routineStep(async () => {
        throw { code: "not_yet", message: "Not yet: Connected mode only reads for now." };
      }),
    ).toEqual({ ok: false, code: "not_yet", message: "Not yet: Connected mode only reads for now." });
    expect(
      await routineStep(async () => {
        throw new Error("the socket closed");
      }),
    ).toEqual({ ok: false, code: "internal", message: "the socket closed" });
  });
});

describe("an action the owner takes, applied to the routines the page shows", () => {
  /** The demo runtime, as the store's own actions reach it, with its clock pinned to Sunday 22 November, 10:00 in Bangkok. */
  async function demo(): Promise<{ calls: RoutineCalls; rows: RoutineRow[] }> {
    const rt = new MockRuntime(new MockHost({ now: () => NOW / 1000 }));
    await rt.connect();
    const calls: RoutineCalls = {
      routineCreate: (params) => rt.request("routine.create", params),
      routinePause: (routine) => rt.request("routine.pause", { routine }),
      routineResume: (routine) => rt.request("routine.resume", { routine }),
    };
    return { calls, rows: (await rt.request("routine.list", {})).routines };
  }
  const refuses = (code: string, message: string): RoutineCalls => {
    const no = async (): Promise<never> => {
      throw { code, message };
    };
    return { routineCreate: no, routinePause: no, routineResume: no };
  };
  const filled = (over: Partial<RoutineForm> = {}): RoutineForm => ({ ...FORM_START, name: "Remind me about parcels", ...over });

  it("adds the routine the form describes at the end of the list, and ends the form", async () => {
    const { calls, rows } = await demo();
    const step = await routineDo(calls, rows, { what: "save", form: filled({ when: "weekly", weekdays: [1, 4], at: "09:30" }) });
    expect(step.rows.map((r) => r.name)).toEqual([...rows.map((r) => r.name), "Remind me about parcels"]);
    expect(step.rows.at(-1)).toMatchObject({ when: "Every Monday and Thursday at 09:30", enabled: true, asksFirst: false });
    expect(step.action).toEqual({ type: "done", what: "save" });
  });

  it("adds a routine that replies or sends with Asks first, which the runtime and the package decide, not the form", async () => {
    const { calls, rows } = await demo();
    for (const action of ["reply", "send"] as const) {
      const step = await routineDo(calls, rows, { what: "save", form: filled({ action }) });
      expect(step.rows.at(-1), action).toMatchObject({ action, asksFirst: true });
    }
  });

  it("keeps the list, and says the runtime's own words, when the runtime says not yet", async () => {
    const { rows } = await demo();
    const calls = refuses("not_yet", "Not yet: Connected mode only reads for now.");
    for (const todo of [
      { what: "save", form: filled() },
      { what: "switch", row: rows[0] },
    ] as const) {
      const step = await routineDo(calls, rows, todo);
      expect(step.rows, todo.what).toEqual(rows);
      expect(step.action, todo.what).toEqual({ type: "failed", message: "Not yet: Connected mode only reads for now." });
    }
  });

  it("pauses a routine that is on, where it stands, and resumes one that is off", async () => {
    const { calls, rows } = await demo();
    const paused = await routineDo(calls, rows, { what: "switch", row: rows[0] });
    expect(paused.rows.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(paused.rows[0]).toMatchObject({ id: rows[0].id, enabled: false, next: null });
    expect(paused.rows.slice(1)).toEqual(rows.slice(1));
    expect(paused.action).toEqual({ type: "done", what: "switch" });
    const resumed = await routineDo(calls, paused.rows, { what: "switch", row: paused.rows[0] });
    expect(resumed.rows).toEqual(rows);
  });

  it("drops a routine the runtime says is gone, and says so", async () => {
    const { calls, rows } = await demo();
    const ghost: RoutineRow = { ...rows[0], id: "no-such-routine", name: "A routine that is already gone" };
    const step = await routineDo(calls, [...rows, ghost], { what: "switch", row: ghost });
    expect(step.rows).toEqual(rows);
    expect(step.action).toMatchObject({ type: "failed" });
  });

  it("does not change the list it was given", async () => {
    const { calls, rows } = await demo();
    const before = JSON.stringify(rows);
    await routineDo(calls, rows, { what: "switch", row: rows[0] });
    await routineDo(calls, rows, { what: "save", form: filled() });
    expect(JSON.stringify(rows)).toBe(before);
  });
});
