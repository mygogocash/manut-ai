import { useMemo, useState, type FormEvent } from "react";
import { ROUTINE_WORK, type RoutineAction, type Shop, type Team } from "../api";
import {
  asksFirstOf,
  blankForm,
  MEMBERS,
  mustAskFirst,
  problemOfRefusal,
  readForm,
  reviewOf,
  TRIGGER_KINDS,
  WEEK,
  withMember,
  zoneNames,
  type Field,
  type FormValues,
  type Problems,
  type Review,
  type TriggerKind,
} from "./makeRoutine";
import { Question } from "./RoutinesParts";
import { makeNextText, makeRoutineWords as W, routinesWords } from "./words";

/// The form that makes a routine for the shop chosen on the Routines page (`POST /v1/admin/routines`; docs/pilot-api.md, "Routines"): its
/// name, whose job it is, what it does (only what that member may run), when it runs, in which zone, and whether it asks the owner first,
/// which is always on for a reply, a send, a payment and a deletion and is shown so, not offered.
///
/// Nothing is sent while the form is filled in. Making it checks every field by `@manut/routine-rules`' own rules and says what is wrong
/// beside each field that is wrong. A form with nothing wrong asks first, in a question that says the routine in the API's own words
/// (`describeTrigger`, and its next run from `nextRun`: none while everyone is paused or its member is off the team, and a stock routine
/// says it waits until stock levels are connected), and sends only on yes, and then the body the question was worked out from. While the
/// question is open the fields are locked, so what was read is what is sent; "Keep editing" closes it and leaves everything as it was.
///
/// What the API refuses is said beside the field it is about (`problemOfRefusal`), and the form keeps every word that was typed, so the
/// operator mends one field and makes it again. A refusal no field is to blame for (the shop's limit, an answer that did not come) is
/// said above the form by the page, and leaves the question open. The page owns the question and the one change at a time; this form
/// only says what to ask, what to send and where a refusal goes.

export function MakeRoutineForm({ shop, team, review, locked, busy, onReview, onKeep, onMake }: {
  shop: Shop;
  team: Team;
  /// The routine the question is open about, or null while none is.
  review: Review | null;
  /// A change, this one or another, is on its way: nothing can be pressed or typed.
  locked: boolean;
  /// It is this form's own change that is on its way.
  busy: boolean;
  onReview: (review: Review) => void;
  onKeep: () => void;
  /// Sends the review's body. `refused` is asked of a refusal first and answers whether it was put beside a field; `made` is told when
  /// the API made the routine, and clears the form.
  onMake: (review: Review, handlers: { refused: (error: unknown) => boolean; made: () => void }) => void;
}) {
  const [values, setValues] = useState<FormValues>(blankForm);
  const [problems, setProblems] = useState<Problems>({});
  const zones = useMemo(zoneNames, []);
  // While the question is open the fields are locked, so what the question says is what is sent.
  const off = locked || review !== null;
  const asksLocked = mustAskFirst(values.action);

  /// Changes some of what was typed. A problem said beside a field goes when the field is changed, since it was about what was there.
  function update(patch: Partial<FormValues>, clears: Field[]): void {
    setValues((current) => ({ ...current, ...patch }));
    setProblems((current) => {
      if (!clears.some((field) => current[field] !== undefined)) return current;
      const next = { ...current };
      for (const field of clears) delete next[field];
      return next;
    });
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (off) return;
    const read = readForm(values, shop.tenant);
    if ("problems" in read) {
      setProblems(read.problems);
      return;
    }
    setProblems({});
    onReview(reviewOf(read.body, team, Date.now()));
  }

  /// What is under a field: its help, or what is wrong with it, and the ids that tie the two to the field. A field with neither has no
  /// description to point at.
  function under(field: Field, help: string) {
    const failed = problems[field] !== undefined;
    const text = problems[field] ?? help;
    return {
      id: `make-${field}-help`,
      text,
      failed,
      describedBy: text === "" ? undefined : `make-${field}-help`,
      invalid: failed ? (true as const) : undefined,
    };
  }

  const name = under("name", W.nameHelp);
  const member = under("member", W.memberHelp);
  const action = under("action", W.actionHelp(values.action));
  const kind = under("kind", "");
  const at = under("at", W.timeHelp);
  const weekdays = under("weekdays", W.weekdaysHelp);
  const day = under("day", W.dayHelp);
  const window = under("window", W.windowHelp);
  const threshold = under("threshold", W.thresholdHelp);
  const zone = under("timeZone", W.zoneHelp);
  const asks = under("asksFirst", asksLocked ? W.asksLocked : W.asksOptional);

  /// A time of day typed as text, "HH:MM", for the field it belongs to.
  function timeField(field: "at" | "from" | "to", label: string, shown: typeof at) {
    const typed = (value: string) => update(field === "at" ? { at: value } : field === "from" ? { from: value } : { to: value },
      [field === "at" ? "at" : "window"]);
    return (
      <>
        <label htmlFor={`make-${field}`}>{label}</label>
        <input id={`make-${field}`} className="input" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="08:00"
          value={values[field]} disabled={off} aria-invalid={shown.invalid} aria-describedby={shown.describedBy}
          onChange={(event) => typed(event.target.value)} />
      </>
    );
  }

  return (
    <form noValidate onSubmit={submit} aria-labelledby="routines-make" style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560 }}>
      <div className="field">
        <label htmlFor="make-name">{W.nameLabel}</label>
        <input id="make-name" className="input" autoComplete="off" value={values.name} disabled={off} aria-invalid={name.invalid}
          aria-describedby={name.describedBy} onChange={(event) => update({ name: event.target.value }, ["name"])} />
        <Under shown={name} />
      </div>

      <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} aria-describedby={member.describedBy}>
        <legend className="lab" style={{ padding: 0, marginBottom: 6 }}>{W.memberLegend}</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          {MEMBERS.map((one) => (
            <label key={one} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="radio" name="make-member" value={one} checked={values.member === one} disabled={off} style={{ accentColor: "var(--pri)" }}
                onChange={() => {
                  // The kind of work stays when this member does it too, and is otherwise the first of theirs.
                  const next = withMember(values, one);
                  update({ member: next.member, action: next.action }, ["member", "action", "asksFirst"]);
                }} />
              {W.member(one)}
            </label>
          ))}
        </div>
        <Under shown={member} />
      </fieldset>

      <div className="field">
        <label htmlFor="make-action">{W.actionLabel}</label>
        <select id="make-action" className="input" value={values.action} disabled={off} aria-invalid={action.invalid}
          aria-describedby={action.describedBy}
          onChange={(event) => update({ action: event.target.value as RoutineAction }, ["action", "asksFirst"])}>
          {/* Only what this member may run, as the API's "Who runs it" says, so a pair it would refuse is never made. */}
          {ROUTINE_WORK[values.member].map((one) => (
            <option key={one} value={one}>
              {W.action(one)}
            </option>
          ))}
        </select>
        <Under shown={action} />
      </div>

      <div className="field">
        <label htmlFor="make-kind">{W.kindLabel}</label>
        <select id="make-kind" className="input" value={values.kind} disabled={off} aria-invalid={kind.invalid}
          aria-describedby={kind.describedBy}
          onChange={(event) => update({ kind: event.target.value as TriggerKind }, ["kind", "at", "weekdays", "day", "window", "threshold"])}>
          {TRIGGER_KINDS.map((one) => (
            <option key={one} value={one}>
              {W.kinds[one]}
            </option>
          ))}
        </select>
        {kind.failed && <Under shown={kind} />}
      </div>

      {values.kind === "weekly" && (
        <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }} aria-describedby={weekdays.describedBy}>
          <legend className="lab" style={{ padding: 0, marginBottom: 6 }}>{W.weekdaysLegend}</legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {WEEK.map((number) => (
              <label key={number} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={values.weekdays.includes(number)} disabled={off} style={{ accentColor: "var(--pri)" }}
                  onChange={(event) => {
                    const on = event.target.checked;
                    update({ weekdays: on ? [...values.weekdays, number] : values.weekdays.filter((one) => one !== number) }, ["weekdays"]);
                  }} />
                {W.weekdayNames[number]}
              </label>
            ))}
          </div>
          <Under shown={weekdays} />
        </fieldset>
      )}

      {values.kind === "monthly" && (
        <div className="field">
          <label htmlFor="make-day">{W.dayLabel}</label>
          <select id="make-day" className="input" value={values.day} disabled={off} aria-invalid={day.invalid}
            aria-describedby={day.describedBy} onChange={(event) => update({ day: event.target.value }, ["day"])}>
            <option value="">{W.dayNone}</option>
            {Array.from({ length: 28 }, (_, index) => index + 1).map((number) => (
              <option key={number} value={String(number)}>
                {number}
              </option>
            ))}
            <option value="last">{W.dayLast}</option>
          </select>
          <Under shown={day} />
        </div>
      )}

      {(values.kind === "daily" || values.kind === "weekly" || values.kind === "monthly") && (
        <div className="field">
          {timeField("at", W.atLabel, at)}
          <Under shown={at} />
        </div>
      )}

      {values.kind === "window" && (
        <div className="field">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <div className="field" style={{ flex: "1 1 160px" }}>{timeField("from", W.fromLabel, window)}</div>
            <div className="field" style={{ flex: "1 1 160px" }}>{timeField("to", W.toLabel, window)}</div>
          </div>
          <Under shown={window} />
        </div>
      )}

      {values.kind === "stockBelow" && (
        <div className="field">
          <label htmlFor="make-threshold">{W.thresholdLabel}</label>
          <input id="make-threshold" className="input" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="5"
            value={values.threshold} disabled={off} aria-invalid={threshold.invalid} aria-describedby={threshold.describedBy}
            onChange={(event) => update({ threshold: event.target.value }, ["threshold"])} />
          <Under shown={threshold} />
        </div>
      )}

      <div className="field">
        <label htmlFor="make-timeZone">{W.zoneLabel}</label>
        <input id="make-timeZone" className="input" autoComplete="off" spellCheck={false} list="make-zones" value={values.timeZone} disabled={off}
          aria-invalid={zone.invalid} aria-describedby={zone.describedBy}
          onChange={(event) => update({ timeZone: event.target.value }, ["timeZone"])} />
        <datalist id="make-zones">
          {zones.map((one) => (
            <option key={one} value={one} />
          ))}
        </datalist>
        <Under shown={zone} />
      </div>

      <div className="field">
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 500 }}>
          {/* A reply, a send, a payment and a deletion always ask: the box is ticked and cannot be changed, so it is shown and not offered. */}
          <input type="checkbox" checked={asksFirstOf(values)} disabled={off || asksLocked} style={{ accentColor: "var(--pri)" }}
            aria-invalid={asks.invalid} aria-describedby={asks.describedBy}
            onChange={(event) => update({ asksFirst: event.target.checked }, ["asksFirst"])} />
          {W.asksLabel}
        </label>
        <Under shown={asks} />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button type="submit" className="btn dark" disabled={off}>
          {W.submit}
        </button>
      </div>

      {review && (
        <Question id="make-question" title={W.questionTitle(review.body.name, shop.name)} yes={W.yes(review.body.name)} no={W.no}
          busyLabel={W.making} busy={busy} locked={locked}
          onYes={() => onMake(review, {
            // A refusal of one field is put beside it, which closes the question; any other is the page's to say.
            refused: (error) => {
              const problem = problemOfRefusal(error, values);
              if (!problem) return false;
              setProblems(problem);
              return true;
            },
            made: () => {
              setValues(blankForm());
              setProblems({});
            },
          })}
          onNo={onKeep}>
          <p style={{ margin: 0, fontWeight: 500, overflowWrap: "anywhere" }}>{review.body.name}</p>
          <p className="mut" style={{ margin: 0 }}>{routinesWords.jobOf(review.body.member)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.does(review.body.action)}</p>
          <p style={{ margin: 0 }}>{routinesWords.when({ when: review.when, timeZone: review.body.timeZone })}</p>
          <p style={{ margin: 0 }}>{makeNextText({ next: review.next, member: review.body.member, ...(review.waitsFor ? { waitsFor: review.waitsFor } : {}) }, team, review.now)}</p>
          <p className="mut" style={{ margin: 0 }}>{routinesWords.asksFirst(review.body.asksFirst)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.startsOn}</p>
        </Question>
      )}
    </form>
  );
}

/// What is under a field: what it is for, or, in its place, what is wrong with it.
function Under({ shown }: { shown: { id: string; text: string; failed: boolean } }) {
  return (
    <div id={shown.id} className={shown.failed ? "help err" : "help"}>
      {shown.text}
    </div>
  );
}
