import {
  createRoutine as ruleRoutine,
  DEFAULT_TIME_ZONE,
  describeTrigger,
  mustAskFirst,
  nextRun,
  type Routine as RuleRoutine,
  type RoutineInput,
} from "@manut/routine-rules";
import { ApiError, ROUTINE_WORK, type NewRoutine, type RoutineAction, type RoutineTrigger, type Team, type WorkerMember } from "../api";
import { MAKE_REFUSALS } from "./words";

/// Whether a kind of work always asks the owner first, by routine-rules' own rule: a reply, a send, a payment and a deletion do.
export { mustAskFirst };

/// What the Make a routine form (MakeRoutineForm.tsx) knows, apart from how it looks: what the operator has typed, whether it makes a
/// routine the API would take, and the routine in the API's own words before anything is sent.
///
/// The rules are `@manut/routine-rules`', the package the API makes every routine with, so the form refuses what the API would refuse in
/// the same words, and `describeTrigger` and `nextRun` say the routine as the list will. Whose job each kind of work is comes from the
/// console's copy of "Who runs it" (`ROUTINE_WORK`), which a test holds to the API's own table.

export type TriggerKind = RoutineTrigger["kind"];

/// The kinds of trigger, in the order the form offers them.
export const TRIGGER_KINDS: readonly TriggerKind[] = ["daily", "weekly", "monthly", "window", "stockBelow"];

/// The members whose job a routine may be, in the order the form offers them.
export const MEMBERS: readonly WorkerMember[] = ["nam", "pim", "ton"];

/// The week as the form lists it, Monday first, in routine-rules' own numbers: Sunday is 0.
export const WEEK: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/// What the operator has typed, all of it text but the choices, so that a refusal never costs them a word: every kind of trigger keeps
/// its own fields while another is chosen, and the whole is built into a routine only at the moment it is checked.
export type FormValues = {
  name: string;
  member: WorkerMember;
  action: RoutineAction;
  kind: TriggerKind;
  /// A time of day, "HH:MM", for a daily, weekly or monthly routine.
  at: string;
  /// The days a weekly routine runs on, 0 for Sunday.
  weekdays: number[];
  /// "1" to "28" or "last" for a monthly routine, and "" until one is chosen.
  day: string;
  /// A window's two times, "HH:MM".
  from: string;
  to: string;
  /// A stock routine's number, as typed.
  threshold: string;
  timeZone: string;
  /// Whether the operator asked for it to ask the owner first. It counts only for a brief and a draft: a reply, a send, a payment and a
  /// deletion always ask, whatever this holds, and it is kept so that choosing one of those and back loses nothing.
  asksFirst: boolean;
};

/// The form as it starts: Ton's brief, every day, in Bangkok's zone. Nothing is chosen that the operator has not read: a brief only makes
/// a draft for the owner, and the name and the time are left empty for them to fill in.
export function blankForm(): FormValues {
  return {
    name: "", member: "ton", action: "brief", kind: "daily", at: "", weekdays: [], day: "", from: "", to: "", threshold: "",
    timeZone: DEFAULT_TIME_ZONE, asksFirst: false,
  };
}

/// Another member's job. The kind of work stays when that member does it, and is otherwise the first of theirs, so the form never holds a
/// pair the API would refuse as `wrong_member`.
export function withMember(values: FormValues, member: WorkerMember): FormValues {
  const work = ROUTINE_WORK[member];
  return { ...values, member, action: work.includes(values.action) ? values.action : work[0]! };
}

/// Whether the routine asks the owner first: always for a reply, a send, a payment and a deletion, and as the operator chose for the rest.
export function asksFirstOf(values: Pick<FormValues, "action" | "asksFirst">): boolean {
  return mustAskFirst(values.action) || values.asksFirst;
}

/// The parts of the form a problem is said beside. A window's two times share one, as do the weekdays, which are a group of boxes.
export type Field =
  | "name" | "member" | "action" | "kind" | "at" | "weekdays" | "day" | "window" | "threshold" | "timeZone" | "asksFirst";

/// What is wrong with each part of the form, in words.
export type Problems = Partial<Record<Field, string>>;

/// The part of the form a refusal of the API is about, or null for one that no field is to blame for: the shop's limit, an object the API
/// could not reach, a request it did not understand. A time that is no time is the one time of the day, or a window's, and a window that
/// starts where it ends is about the window.
export function fieldOfRefusal(code: string, kind: TriggerKind): Field | null {
  switch (code) {
    case "invalid_name":
      return "name";
    case "invalid_action":
    case "wrong_member":
      return "action";
    case "unknown_member":
      return "member";
    case "invalid_time_zone":
      return "timeZone";
    case "invalid_trigger":
      return "kind";
    case "invalid_time":
      return kind === "window" ? "window" : "at";
    case "invalid_window":
      return "window";
    case "invalid_weekdays":
      return "weekdays";
    case "invalid_day":
      return "day";
    case "invalid_threshold":
      return "threshold";
    case "must_ask_first":
      return "asksFirst";
    default:
      return null;
  }
}

/// A refusal of the API that is about one field, as that field's problem; null for any other, which is said above the form. Only a 400 is
/// one: the API refuses a field before it writes anything, so nothing was made. `fieldOfRefusal` knows exactly the codes that
/// `MAKE_REFUSALS` has words for (a test holds both to the API's own lists), so a code with a field always has its words.
export function problemOfRefusal(error: unknown, about: Pick<FormValues, "kind" | "member" | "action">): Problems | null {
  if (!(error instanceof ApiError) || error.status !== 400) return null;
  const field = fieldOfRefusal(error.code, about.kind);
  return field === null ? null : { [field]: MAKE_REFUSALS[error.code]!({ member: about.member, action: about.action }) };
}

/// A whole number from digits alone, or NaN, which routine-rules refuses as no day and no threshold: text such as "5.5", "1e3" or "0x10"
/// is not read as a number it was not typed as.
function wholeNumber(text: string): number {
  const digits = text.trim();
  return /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
}

/// The trigger the fields of the chosen kind say, with the times as typed (less the spaces round them) for routine-rules to read. A
/// kind's other fields are left behind.
export function triggerOf(values: FormValues): RoutineTrigger {
  const at = values.at.trim();
  switch (values.kind) {
    case "daily":
      return { kind: "daily", at };
    case "weekly":
      return { kind: "weekly", weekdays: [...new Set(values.weekdays)].sort((a, b) => a - b), at };
    case "monthly":
      return { kind: "monthly", day: values.day === "last" ? "last" : wholeNumber(values.day), at };
    case "window":
      return { kind: "window", from: values.from.trim(), to: values.to.trim() };
    case "stockBelow":
      return { kind: "stockBelow", threshold: wholeNumber(values.threshold) };
  }
}

/// A routine that is right in every field, so that changing one field of it shows whether that field alone is refused.
const RIGHT: RoutineInput = {
  id: "rt-form", name: "Name", action: "brief", trigger: { kind: "daily", at: "08:00" }, timeZone: DEFAULT_TIME_ZONE, asksFirst: false,
};

/// Why routine-rules refuses a routine that is right but for these fields, or null.
function refusedFor(change: Partial<RoutineInput>): string | null {
  const made = ruleRoutine({ ...RIGHT, ...change });
  return made.ok ? null : made.reason;
}

/// What is wrong with the form, in words, every part at once: each field is put to routine-rules by itself, in a routine that is right in
/// every other, so a form with a name and a time both wrong says both and not only the first the API would. A part with nothing wrong has
/// no entry.
export function checkForm(values: FormValues): Problems {
  const problems: Problems = {};
  const about = { member: values.member, action: values.action };
  const say = (field: Field, code: string | null) => {
    if (code !== null && problems[field] === undefined) problems[field] = MAKE_REFUSALS[code]!(about);
  };
  const at = values.at.trim();
  say("name", refusedFor({ name: values.name }));
  switch (values.kind) {
    case "daily":
      say("at", refusedFor({ trigger: { kind: "daily", at } }));
      break;
    case "weekly":
      say("at", refusedFor({ trigger: { kind: "daily", at } }));
      say("weekdays", refusedFor({ trigger: { kind: "weekly", weekdays: values.weekdays, at: "08:00" } }));
      break;
    case "monthly":
      say("at", refusedFor({ trigger: { kind: "daily", at } }));
      say("day", refusedFor({ trigger: { kind: "monthly", day: values.day === "last" ? "last" : wholeNumber(values.day), at: "08:00" } }));
      break;
    case "window": {
      const { from, to } = { from: values.from.trim(), to: values.to.trim() };
      say("window", refusedFor({ trigger: { kind: "daily", at: from } }) ?? refusedFor({ trigger: { kind: "daily", at: to } })
        ?? refusedFor({ trigger: { kind: "window", from, to } }));
      break;
    }
    case "stockBelow":
      say("threshold", refusedFor({ trigger: triggerOf(values) }));
      break;
  }
  say("timeZone", refusedFor({ timeZone: values.timeZone.trim() }));
  // What the API checks after the routine's own fields: the member, and that it is their work.
  if (!MEMBERS.includes(values.member)) {
    say("member", "unknown_member");
  } else {
    say("action", refusedFor({ action: values.action, asksFirst: asksFirstOf(values) }));
    if (!ROUTINE_WORK[values.member].includes(values.action)) say("action", "wrong_member");
  }
  return problems;
}

/// The body `POST /v1/admin/routines` takes, with every field given, so that what the operator reads before saying yes is what is sent
/// and never what a default would decide.
export type RoutineBody = Required<NewRoutine>;

/// The routine the form says, or what is wrong with it. The name goes as it will be kept, without the spaces round it.
export function readForm(values: FormValues, tenant: string): { body: RoutineBody } | { problems: Problems } {
  const problems = checkForm(values);
  if (Object.keys(problems).length > 0) return { problems };
  return {
    body: {
      tenant,
      name: values.name.trim(),
      action: values.action,
      trigger: triggerOf(values),
      timeZone: values.timeZone.trim(),
      asksFirst: asksFirstOf(values),
      member: values.member,
    },
  };
}

/// The routine as the question puts it before it is made, worked out once, when the question opens, so that it says what it said when it
/// was read: the body that goes on yes, the trigger in routine-rules' words, and the next run, which is none while everyone is paused or
/// the member is off the team (as the API's list works it) and for a routine that waits for stock.
export type Review = {
  body: RoutineBody;
  when: string;
  /// The instant of its next run, or null.
  next: string | null;
  /// Set for a stock routine, which has no clock and waits for stock levels, as the API's list says it (`waitsFor`).
  waitsFor?: "stock_feed";
  now: number;
};

export function reviewOf(body: RoutineBody, team: Team, now: number): Review {
  const rules: RuleRoutine = { id: "rt-review", name: body.name, action: body.action, timeZone: body.timeZone, trigger: body.trigger,
    asksFirst: body.asksFirst };
  const runs = !team.paused && team.members.includes(body.member);
  const next = runs ? nextRun(rules, now) : null;
  return {
    body,
    when: describeTrigger(rules),
    next: next === null ? null : new Date(next).toISOString(),
    ...(body.trigger.kind === "stockBelow" ? { waitsFor: "stock_feed" as const } : {}),
    now,
  };
}

/// The time zones the browser knows, to suggest as the operator types. The field takes any name routine-rules accepts, so this is only help;
/// a browser that cannot list them suggests Bangkok's alone.
export function zoneNames(): string[] {
  const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    const names = list ? list.call(Intl, "timeZone") : [];
    return names.includes(DEFAULT_TIME_ZONE) ? names : [DEFAULT_TIME_ZONE, ...names];
  } catch {
    return [DEFAULT_TIME_ZONE];
  }
}
