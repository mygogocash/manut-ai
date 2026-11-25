import { afterEach, describe, expect, it, vi } from "vitest";
import { describeTrigger, nextRun } from "@manut/routine-rules";
import { ApiError, MAX_ROUTINES, ROUTINE_WORK, type Team } from "../src/api";
import {
  asksFirstOf,
  blankForm,
  checkForm,
  fieldOfRefusal,
  MEMBERS,
  problemOfRefusal,
  readForm,
  reviewOf,
  triggerOf,
  TRIGGER_KINDS,
  WEEK,
  withMember,
  zoneNames,
  type FormValues,
} from "../src/ops/makeRoutine";
import { MAKE_REFUSALS, makeErrorText, makeNextText, makeRoutineWords as W, routineActionText } from "../src/ops/words";
// The sources the console's rules are held to, read as text: the rules package the API makes every routine with, and the API's own
// handlers. They cannot be imported (the API's run in the Worker), and a rule the console copied is only as good as its last check
// against them.
import routineRulesSource from "../../../packages/routine-rules/src/index.ts?raw";
import routineSetupSource from "../../api/src/routine-setup.ts?raw";
import routineStoreSource from "../../api/src/routine-store.ts?raw";
import routinesSource from "../../api/src/routines.ts?raw";

// 10:00 on Monday 23 November in Bangkok.
const NOW = Date.parse("2026-11-23T03:00:00Z");
const TEAM_ON: Team = { paused: false, since: null, members: ["nam", "pim", "ton"] };

/// A form that is right, for a test to spoil one part of.
const right = (change: Partial<FormValues> = {}): FormValues => ({ ...blankForm(), name: "Morning brief", at: "08:00", ...change });

const TIME_WORDS = "Write the time as two digits, a colon and two digits on a 24-hour clock, like 08:00 or 21:30.";
const NAME_WORDS = "A name takes 1 to 80 characters, not counting spaces at either end.";

describe("the form's own state", () => {
  it("starts as Ton's brief, every day, in Bangkok's zone, with the name and the times left for the operator", () => {
    expect(blankForm()).toEqual({
      name: "", member: "ton", action: "brief", kind: "daily", at: "", weekdays: [], day: "", from: "", to: "", threshold: "",
      timeZone: "Asia/Bangkok", asksFirst: false,
    });
    // Each asking gives a form of its own: nothing is shared between two.
    expect(blankForm().weekdays).not.toBe(blankForm().weekdays);
  });

  it("changes whose job it is without ever holding a pair the API would refuse", () => {
    for (const member of MEMBERS) {
      for (const from of MEMBERS) {
        for (const action of ROUTINE_WORK[from]) {
          const next = withMember({ ...blankForm(), member: from, action }, member);
          expect(next.member).toBe(member);
          expect(ROUTINE_WORK[member], `${from} ${action} to ${member}`).toContain(next.action);
          // The work stays when the new member does it, and is otherwise their first.
          expect(next.action).toBe(ROUTINE_WORK[member].includes(action) ? action : ROUTINE_WORK[member][0]);
        }
      }
    }
    // Everything else typed is kept.
    expect(withMember({ ...right({ name: "Keep me", weekdays: [1] }), member: "ton" }, "nam")).toMatchObject({ name: "Keep me", weekdays: [1], at: "08:00" });
  });

  it("asks first always for a reply, a send, a payment and a deletion, and as chosen for a brief and a draft", () => {
    for (const action of ["reply", "send", "pay", "delete"] as const) {
      expect(asksFirstOf({ action, asksFirst: false }), action).toBe(true);
      expect(asksFirstOf({ action, asksFirst: true }), action).toBe(true);
    }
    for (const action of ["brief", "draft"] as const) {
      expect(asksFirstOf({ action, asksFirst: false }), action).toBe(false);
      expect(asksFirstOf({ action, asksFirst: true }), action).toBe(true);
    }
  });

  it("builds the trigger from the chosen kind's fields alone, as routine-rules reads them", () => {
    const everything = { ...right(), at: " 09:15 ", weekdays: [5, 1, 5, 0], day: "7", from: " 21:00", to: "08:00 ", threshold: " 4 " };
    expect(triggerOf({ ...everything, kind: "daily" })).toEqual({ kind: "daily", at: "09:15" });
    // The weekdays go once each, in order, whatever order they were ticked in.
    expect(triggerOf({ ...everything, kind: "weekly" })).toEqual({ kind: "weekly", weekdays: [0, 1, 5], at: "09:15" });
    expect(triggerOf({ ...everything, kind: "monthly" })).toEqual({ kind: "monthly", day: 7, at: "09:15" });
    expect(triggerOf({ ...everything, kind: "monthly", day: "last" })).toEqual({ kind: "monthly", day: "last", at: "09:15" });
    expect(triggerOf({ ...everything, kind: "window" })).toEqual({ kind: "window", from: "21:00", to: "08:00" });
    expect(triggerOf({ ...everything, kind: "stockBelow" })).toEqual({ kind: "stockBelow", threshold: 4 });
    for (const kind of TRIGGER_KINDS) expect(Object.keys(triggerOf({ ...everything, kind }))).toEqual(
      { daily: ["kind", "at"], weekly: ["kind", "weekdays", "at"], monthly: ["kind", "day", "at"], window: ["kind", "from", "to"],
        stockBelow: ["kind", "threshold"] }[kind]);
  });

  it("reads a day and a number from digits alone, and leaves anything else as the no-number routine-rules refuses", () => {
    const monthly = (day: string) => triggerOf(right({ kind: "monthly", day })) as { day: number | "last" };
    const stock = (threshold: string) => triggerOf(right({ kind: "stockBelow", threshold })) as { threshold: number };
    expect([monthly("1").day, monthly("28").day, monthly("last").day]).toEqual([1, 28, "last"]);
    for (const text of ["", "x", "5.5", "-1", "1e3", "0x10", "5 pieces", "٣"]) {
      expect(monthly(text).day, text).toBeNaN();
      expect(stock(text).threshold, text).toBeNaN();
    }
    expect([stock("5").threshold, stock(" 12 ").threshold, stock("007").threshold, stock("0").threshold]).toEqual([5, 12, 7, 0]);
  });

  it("lists the week Monday first, each day once, in routine-rules' own numbers", () => {
    expect([...WEEK].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(WEEK[0]).toBe(1);
    expect(WEEK.at(-1)).toBe(0);
  });
});

describe("what the form says is wrong, by routine-rules' own rules", () => {
  it("has nothing to say about a form that is right, of any kind of trigger", () => {
    expect(checkForm(right())).toEqual({});
    expect(checkForm(right({ kind: "weekly", weekdays: [1, 5] }))).toEqual({});
    expect(checkForm(right({ kind: "monthly", day: "last" }))).toEqual({});
    expect(checkForm(right({ kind: "monthly", day: "28" }))).toEqual({});
    expect(checkForm(right({ kind: "window", from: "21:00", to: "08:00" }))).toEqual({});
    expect(checkForm(right({ kind: "stockBelow", threshold: "5" }))).toEqual({});
    expect(checkForm(right({ member: "nam", action: "reply" }))).toEqual({});
  });

  it("says a blank form's name and time at once, each in its own part", () => {
    expect(checkForm(blankForm())).toEqual({ name: NAME_WORDS, at: TIME_WORDS });
  });

  it("says each part of a trigger by itself, so that every part that is wrong is said", () => {
    expect(checkForm(right({ kind: "weekly", weekdays: [], at: "8am" }))).toEqual({ at: TIME_WORDS, weekdays: "Choose at least one day of the week." });
    expect(checkForm(right({ kind: "monthly", day: "", at: "" }))).toEqual({
      at: TIME_WORDS, day: "Choose a day from the 1st to the 28th, or the last day of the month." });
    expect(checkForm(right({ kind: "window", from: "9am", to: "17:00" }))).toEqual({ window: TIME_WORDS });
    expect(checkForm(right({ kind: "window", from: "09:00", to: "5pm" }))).toEqual({ window: TIME_WORDS });
    expect(checkForm(right({ kind: "window", from: "09:00", to: "09:00" })))
      .toEqual({ window: "A window must start and end at different times. It may cross midnight, like 21:00 to 08:00." });
    expect(checkForm(right({ kind: "stockBelow", threshold: "" }))).toEqual({ threshold: "Write a whole number from 1 up, like 5." });
    expect(checkForm(right({ name: " ", timeZone: "Mars/Olympus", kind: "stockBelow", threshold: "0" }))).toEqual({
      name: NAME_WORDS, threshold: "Write a whole number from 1 up, like 5.",
      timeZone: "That is not a time zone the API knows. Write one like Asia/Bangkok or Asia/Tokyo." });
  });

  it("looks only at the fields of the kind chosen: what another kind holds is never a problem", () => {
    const rubbish = { from: "nope", to: "nope", threshold: "abc", day: "", weekdays: [] as number[] };
    expect(checkForm(right({ kind: "daily", ...rubbish }))).toEqual({});
    expect(checkForm(right({ kind: "window", at: "", from: "21:00", to: "08:00", threshold: "abc", day: "" }))).toEqual({});
    expect(checkForm(right({ kind: "stockBelow", at: "", from: "", to: "", threshold: "3", weekdays: [] }))).toEqual({});
  });

  it("accepts exactly the times routine-rules accepts: every HH:MM of a day, and none of the near misses", () => {
    for (let hour = 0; hour < 24; hour++) {
      for (let minute = 0; minute < 60; minute++) {
        const at = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        expect(checkForm(right({ at })), at).toEqual({});
      }
    }
    for (const at of ["24:00", "23:60", "99:99", "8:00", "08:0", "0800", "08:00:00", "08-00", "", " ", "ab:cd", "08:00pm", "-1:00", "١٢:٠٠"]) {
      expect(checkForm(right({ at })), at).toEqual({ at: TIME_WORDS });
    }
    // The spaces round a time are the operator's slip and not the time's: they are taken off before it is read.
    expect(checkForm(right({ at: " 08:00 " }))).toEqual({});
  });

  it("counts a name by characters as a person does, trimmed, from 1 to 80", () => {
    for (const name of ["a", "x".repeat(80), "🌸".repeat(80), "ไก่".repeat(26), "  padded  "]) expect(checkForm(right({ name })), name).toEqual({});
    for (const name of ["", "   ", "x".repeat(81), "🌸".repeat(81), `${"x".repeat(80)}y`]) expect(checkForm(right({ name })), name).toEqual({ name: NAME_WORDS });
  });

  it("says a member nobody is, and work that is not the member's, after the routine's own fields, as the API checks them", () => {
    expect(checkForm(right({ member: "kit" as never }))).toEqual({ member: "Choose Nam, Pim or Ton." });
    expect(checkForm(right({ member: "ton", action: "reply" }))).toEqual({ action: "Ton does not do that kind of work. Ton can: brief the owner, draft something, send something out, pay something and delete something." });
    expect(checkForm(right({ member: "nam", action: "brief" }))).toEqual({ action: "Nam does not do that kind of work. Nam can: reply to a customer." });
    expect(checkForm(right({ member: "pim", action: "pay" }))).toEqual({ action: "Pim does not do that kind of work. Pim can: draft something and send something out." });
    // A kind of work nobody knows is the action's own refusal, said once.
    expect(checkForm(right({ action: "buy" as never }))).toEqual({ action: "Choose what it does from the list." });
  });

  it("builds the body the route takes, every field given, from a form that is right, and says what is wrong with one that is not", () => {
    expect(readForm(right({ name: "  Friday post ", member: "pim", action: "send", kind: "weekly", weekdays: [5, 1], at: " 10:00 ", timeZone: " Asia/Bangkok " }), "t1"))
      .toEqual({ body: { tenant: "t1", name: "Friday post", action: "send", trigger: { kind: "weekly", weekdays: [1, 5], at: "10:00" },
        timeZone: "Asia/Bangkok", asksFirst: true, member: "pim" } });
    expect(Object.keys((readForm(right(), "t1") as { body: object }).body)).toEqual(["tenant", "name", "action", "trigger", "timeZone", "asksFirst", "member"]);
    // A brief asks when the operator said so, and not otherwise.
    expect((readForm(right({ asksFirst: true }), "t1") as { body: { asksFirst: boolean } }).body.asksFirst).toBe(true);
    expect((readForm(right({ asksFirst: false }), "t1") as { body: { asksFirst: boolean } }).body.asksFirst).toBe(false);
    expect(readForm(blankForm(), "t1")).toEqual({ problems: { name: NAME_WORDS, at: TIME_WORDS } });
  });
});

describe("the routine as the question says it, before anything is sent", () => {
  const body = (change: Partial<FormValues> = {}) => (readForm(right(change), "t1") as { body: Parameters<typeof reviewOf>[0] }).body;

  it("says its trigger in routine-rules' words and its next run from nextRun, as an instant", () => {
    const review = reviewOf(body(), TEAM_ON, NOW);
    expect(review).toEqual({ body: body(), when: "Every day at 08:00", next: "2026-11-24T01:00:00.000Z", now: NOW });
    expect(review).not.toHaveProperty("waitsFor");
    const weekly = body({ kind: "weekly", weekdays: [1, 5], at: "17:30" });
    const rules = { id: "rt-x", name: weekly.name, action: weekly.action, timeZone: weekly.timeZone, trigger: weekly.trigger, asksFirst: weekly.asksFirst };
    expect(reviewOf(weekly, TEAM_ON, NOW)).toMatchObject({ when: describeTrigger(rules), next: new Date(nextRun(rules, NOW)!).toISOString() });
  });

  it("works a routine in another zone out in that zone, and says the instant it is", () => {
    expect(reviewOf(body({ timeZone: "Asia/Tokyo" }), TEAM_ON, NOW).next).toBe("2026-11-23T23:00:00.000Z");
  });

  it("has no next run while everyone is paused or while the member is off the team, as the API's list works it", () => {
    expect(reviewOf(body(), { ...TEAM_ON, paused: true }, NOW).next).toBeNull();
    expect(reviewOf(body({ member: "pim", action: "draft" }), { ...TEAM_ON, members: ["nam", "ton"] }, NOW).next).toBeNull();
    expect(reviewOf(body({ member: "pim", action: "draft" }), { ...TEAM_ON, members: ["nam", "pim"] }, NOW).next).not.toBeNull();
    // It still says when it would run: the words do not depend on the team.
    expect(reviewOf(body(), { ...TEAM_ON, paused: true }, NOW).when).toBe("Every day at 08:00");
  });

  it("waits for stock for a stock routine, which has no clock, whatever the team", () => {
    const review = reviewOf(body({ kind: "stockBelow", threshold: "5" }), TEAM_ON, NOW);
    expect(review).toMatchObject({ when: "When stock drops under 5", next: null, waitsFor: "stock_feed" });
  });

  it("keeps the moment it was worked out at, and the body it will send, whole", () => {
    const sent = body();
    const review = reviewOf(sent, TEAM_ON, NOW);
    expect(review.body).toBe(sent);
    expect(review.now).toBe(NOW);
  });

  it("says the next run in words, and why there is none, as the page says it in a list", () => {
    expect(makeNextText({ next: "2026-11-24T01:00:00.000Z", member: "ton" }, TEAM_ON, NOW)).toBe("Next run on 24 November at 08:00.");
    expect(makeNextText({ next: "2026-11-23T10:30:00.000Z", member: "ton" }, TEAM_ON, NOW)).toBe("Next run at 17:30.");
    expect(makeNextText({ next: null, member: "ton" }, { ...TEAM_ON, paused: true }, NOW)).toBe("No next run: everyone is paused.");
    expect(makeNextText({ next: null, member: "pim" }, { ...TEAM_ON, members: ["nam", "ton"] }, NOW)).toBe("No next run: Pim is not on this shop's team.");
    expect(makeNextText({ next: null, member: "pim" }, { paused: true, since: null, members: ["nam", "ton"] }, NOW))
      .toBe("No next run: everyone is paused and Pim is not on this shop's team.");
  });

  it("says a stock routine waits until stock levels are connected, and what else would keep it from running", () => {
    const stock = "It waits until stock levels are connected: Manut AI has no stock feed yet, so it does not run before then.";
    expect(makeNextText({ next: null, member: "ton", waitsFor: "stock_feed" }, TEAM_ON, NOW)).toBe(stock);
    expect(makeNextText({ next: null, member: "ton", waitsFor: "stock_feed" }, { ...TEAM_ON, paused: true }, NOW))
      .toBe(`${stock} It will also not run: everyone is paused.`);
    expect(makeNextText({ next: null, member: "pim", waitsFor: "stock_feed" }, { paused: true, since: null, members: ["ton"] }, NOW))
      .toBe(`${stock} It will also not run: everyone is paused and Pim is not on this shop's team.`);
    expect(W.stockWaits).toBe(stock);
  });
});

describe("which field each refusal is about, and what is said of it", () => {
  it("puts every refusal of a field beside its field, and a time that is no time beside the time the kind has", () => {
    const fields: Record<string, string> = {
      invalid_name: "name", invalid_action: "action", wrong_member: "action", unknown_member: "member", invalid_time_zone: "timeZone",
      invalid_trigger: "kind", invalid_window: "window", invalid_weekdays: "weekdays", invalid_day: "day", invalid_threshold: "threshold",
      must_ask_first: "asksFirst",
    };
    for (const [code, field] of Object.entries(fields)) for (const kind of TRIGGER_KINDS) expect(fieldOfRefusal(code, kind), `${code} ${kind}`).toBe(field);
    for (const kind of TRIGGER_KINDS) expect(fieldOfRefusal("invalid_time", kind)).toBe(kind === "window" ? "window" : "at");
  });

  it("puts no refusal beside a field that no field is to blame for: the limit, an object not reached, a request not understood, a code not known", () => {
    for (const code of ["full", "invalid_request", "tenant_required", "routines_unavailable", "clock_unavailable", "shop_unavailable", "shop_not_found",
      "not_found", "invalid_id", "something_new", "", "toString", "constructor", "__proto__"]) {
      for (const kind of TRIGGER_KINDS) expect(fieldOfRefusal(code, kind), `${code} ${kind}`).toBeNull();
    }
  });

  it("takes a refusal of a field as that field's problem only when it is a 400 with a code of one of the form's fields", () => {
    const about = { kind: "daily", member: "ton", action: "brief" } as const;
    expect(problemOfRefusal(new ApiError(400, "invalid_name"), about)).toEqual({ name: NAME_WORDS });
    expect(problemOfRefusal(new ApiError(400, "invalid_time"), about)).toEqual({ at: TIME_WORDS });
    expect(problemOfRefusal(new ApiError(400, "invalid_time"), { ...about, kind: "window" })).toEqual({ window: TIME_WORDS });
    expect(problemOfRefusal(new ApiError(400, "wrong_member"), { kind: "daily", member: "pim", action: "pay" }))
      .toEqual({ action: "Pim does not do that kind of work. Pim can: draft something and send something out." });
    for (const error of [
      new ApiError(500, "invalid_name"), new ApiError(409, "invalid_name"), new ApiError(404, "invalid_name"), new ApiError(0, "invalid_name"),
      new ApiError(400, "invalid_request"), new ApiError(400, "full"), new ApiError(400, "toString"), new ApiError(400, "constructor"),
      new ApiError(400, "__proto__"), new ApiError(409, "full"), new Error("invalid_name"), "invalid_name", null, undefined,
    ]) expect(problemOfRefusal(error, about), String(error)).toBeNull();
  });

  it("names the member the work is not for, and what they do; a member this console does not know is named as the API sent them", () => {
    expect(MAKE_REFUSALS.wrong_member!({ member: "nam", action: "brief" })).toBe("Nam does not do that kind of work. Nam can: reply to a customer.");
    expect(MAKE_REFUSALS.wrong_member!({ member: "kit", action: "brief" })).toBe("kit does not do that kind of work.");
    expect(MAKE_REFUSALS.wrong_member!({ member: "toString", action: "brief" })).toBe("toString does not do that kind of work.");
  });

  it("says each kind of work in the form's words, and one it does not know as it is", () => {
    expect(["brief", "draft", "reply", "send", "pay", "delete"].map(routineActionText)).toEqual([
      "Brief the owner", "Draft something", "Reply to a customer", "Send something out", "Pay something", "Delete something"]);
    expect(routineActionText("buy")).toBe("buy");
    expect(routineActionText("toString")).toBe("toString");
    expect(W.actionHelp("toString")).toBe("");
    expect(W.action("pay")).toBe("Pay something");
  });

  it("says a failure no field is to blame for in words that say whether the routine may exist", () => {
    expect(makeErrorText(new ApiError(409, "full"), "Baan Mali"))
      .toBe("Baan Mali already has 50 routines, which is the most a shop may have. Remove one, then make this one. What you typed is kept.");
    expect(makeErrorText(new ApiError(503, "routines_unavailable"), "Baan Mali"))
      .toBe("The API could not reach this shop's routines, so this routine may or may not have been made. Press Refresh and look at the list before making it again.");
    expect(makeErrorText(new ApiError(503, "clock_unavailable"), "Baan Mali"))
      .toBe("The API could not set this routine's clock, so nothing was made. What you typed is kept. Try again.");
    expect(makeErrorText(new ApiError(0, "network"), "Baan Mali"))
      .toBe("Could not reach the API. This routine may or may not have been made: press Refresh and look at the list before making it again.");
    expect(makeErrorText(new ApiError(404, "shop_not_found"), "Baan Mali")).toBe("This is not one of the pilot's shops, so it has no routines. It may have been deleted.");
    expect(makeErrorText(new ApiError(503, "shop_unavailable"), "Baan Mali"))
      .toBe("The API could not read this shop's record, so it cannot say whether it is a pilot shop. Nothing was changed. Try again.");
    expect(makeErrorText(new ApiError(403, "forbidden"), "Baan Mali")).toContain("The API refused the operator key");
    expect(makeErrorText(new ApiError(0, "operator_key_missing"), "Baan Mali")).toContain("The API refused the operator key");
    expect(makeErrorText(new ApiError(400, "invalid_request"), "Baan Mali")).toBe("The API did not accept this (invalid_request).");
    expect(makeErrorText(new Error("boom"), "Baan Mali")).toBe("Something unexpected went wrong. Try again.");
  });
});

describe("the console's copy of the API's rules, held to the API's own text", () => {
  /// The string literals of a union of them, `| "a" | "b"` after a type's name, up to its semicolon.
  function unionOf(source: string, name: string): string[] {
    const start = source.indexOf(`export type ${name} =`);
    const end = source.indexOf(";", start);
    if (start < 0 || end < 0) throw new Error(`no "export type ${name} =" in the source: teach this test where it went`);
    return [...source.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!);
  }

  it("has words and a field for every refusal of a field that routine-rules and the API's builder can give, and none the API cannot", () => {
    const rules = unionOf(routineRulesSource, "RoutineRefusal");
    const build = unionOf(routineSetupSource, "BuildRefusal").filter((code) => !rules.includes(code));
    expect(rules).toContain("invalid_name");
    expect(build.sort()).toEqual(["invalid_request", "unknown_member", "wrong_member"]);
    // A routine's id is the API's to give, so the form is never refused one; `invalid_request` is no field's.
    const codes = [...rules, ...build].filter((code) => code !== "invalid_id" && code !== "invalid_request");
    for (const code of codes) {
      expect(Object.hasOwn(MAKE_REFUSALS, code), `words for ${code}`).toBe(true);
      expect(fieldOfRefusal(code, "daily"), `a field for ${code}`).not.toBeNull();
    }
    // The console says nothing of a code the API does not give.
    expect(Object.keys(MAKE_REFUSALS).sort()).toEqual([...codes].sort());
  });

  it("knows the refusals the API's route gives that no field is to blame for, and where in the API they come from", () => {
    expect(routineStoreSource).toContain('refuse(409, "full")');
    expect(routinesSource).toContain('json({ error: "clock_unavailable" }, 503)');
    expect(routinesSource).toContain('json({ error: "routines_unavailable" }, 503)');
    expect(routinesSource).toContain('json({ error: "shop_not_found" }, 404)');
    expect(routinesSource).toContain('json({ error: "shop_unavailable" }, 503)');
    expect(routinesSource).toContain('json({ error: "tenant_required" }, 400)');
    expect(routineStoreSource).toContain(`export const MAX_ROUTINES = ${MAX_ROUTINES};`);
  });

  it("offers the kinds of trigger routine-rules has, and no other", () => {
    const start = routineRulesSource.indexOf("export type Trigger =");
    const end = routineRulesSource.indexOf(";", routineRulesSource.indexOf("stockBelow", start));
    const kinds = [...routineRulesSource.slice(start, end).matchAll(/kind: "(\w+)"/g)].map((match) => match[1]);
    expect(kinds).toEqual([...TRIGGER_KINDS]);
  });

  it("holds the limits it tells the operator to the ones routine-rules has: 80 characters, days 1 to 28, a time of HH:MM, a number from 1", () => {
    expect(routineRulesSource).toContain("[...name.trim()].length > 80");
    expect(routineRulesSource).toContain("d >= 1 && d <= 28");
    expect(routineRulesSource).toContain("/^([01]\\d|2[0-3]):([0-5]\\d)$/");
    expect(routineRulesSource).toContain("t.threshold >= 1");
    expect(routineRulesSource).toContain("d >= 0 && d <= 6");
    // And the words say the same numbers.
    expect(W.nameHelp).toContain("1 to 80");
    expect(MAKE_REFUSALS.invalid_day!({ member: "ton", action: "brief" })).toContain("1st to the 28th");
    expect(MAKE_REFUSALS.invalid_threshold!({ member: "ton", action: "brief" })).toContain("from 1 up");
    expect(W.weekdayNames).toEqual(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  });
});

describe("the time zones the form suggests", () => {
  const original = Object.getOwnPropertyDescriptor(Intl, "supportedValuesOf");
  afterEach(() => {
    if (original) Object.defineProperty(Intl, "supportedValuesOf", original);
    else delete (Intl as { supportedValuesOf?: unknown }).supportedValuesOf;
  });

  it("lists the zones the browser knows, with Asia/Bangkok among them", () => {
    const names = zoneNames();
    expect(names).toContain("Asia/Bangkok");
    expect(names).toContain("Asia/Tokyo");
    expect(new Set(names).size).toBe(names.length);
  });

  it("puts Asia/Bangkok first when the browser's list lacks it, and offers it alone when the browser cannot list zones, or fails to", () => {
    Object.defineProperty(Intl, "supportedValuesOf", { configurable: true, writable: true, value: () => ["Asia/Tokyo"] });
    expect(zoneNames()).toEqual(["Asia/Bangkok", "Asia/Tokyo"]);
    Object.defineProperty(Intl, "supportedValuesOf", { configurable: true, writable: true, value: undefined });
    expect(zoneNames()).toEqual(["Asia/Bangkok"]);
    Object.defineProperty(Intl, "supportedValuesOf", { configurable: true, writable: true, value: vi.fn(() => { throw new RangeError("no"); }) });
    expect(zoneNames()).toEqual(["Asia/Bangkok"]);
  });
});
