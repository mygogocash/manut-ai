import { useEffect, useRef, useState } from "react";
// The API's own name for the answer is `RoutinesView`, which this page's component is also called, so the type is read under another.
import { ApiError, useApi, type Routine, type RoutinesView as RoutinesRead, type Shop, type Team } from "../api";
import { MakeRoutineForm } from "./MakeRoutineForm";
import type { Review } from "./makeRoutine";
import { Failed, Question, Said, type Problem } from "./RoutinesParts";
import { useLoad, type Loaded } from "./useLoad";
import {
  errorText,
  isAuthError,
  makeErrorText,
  makeRoutineWords as M,
  nextRunText,
  routineTag,
  routinesErrorText,
  ROUTINES_MOVED_ON,
  routinesWords as W,
  runTag,
  runText,
  teamTag,
} from "./words";

/// The Routines page: what Buddy's team does for one shop on its own schedule, as the operator's routes list it (`GET
/// /v1/admin/routines`; docs/pilot-api.md, "Routines"). A pilot shop's tenant is never a session, so until its owner's account is
/// linked its routines are the operator's, and this is where they are read: the team's state (on, or paused since when) and each
/// routine with whose job it is, when it runs, its next run in Bangkok time or why there is none, whether it asks the owner first, the
/// template it came from and how its last run ended. The shop is chosen on the page, starting from the one in the side menu, as on
/// the Connections and Model spend pages.
///
/// A routine only ever makes a draft for the owner to read, so nothing here sends, posts or pays anything. The operator may do six
/// things, and each one asks first, in words that name exactly what will happen, and sends nothing until it is answered yes: pause a
/// routine, resume one, remove one (each in its row), pause or resume the whole team (Pause everyone), and make a routine, from the form
/// under the list (MakeRoutineForm.tsx), whose question says the new routine in the API's own words. One change runs at a time, so a
/// double press sends one request, and a refusal that says the list moved on (the routine was removed meanwhile by another operator)
/// reads it again. A routine that was made joins the list as the API answered it, until the list is read again.
///
/// The team and the routines come in one answer, so one failure to read them is said once, where the routines would be, with its own
/// way to try again, and the page draws neither half from an answer it did not get.

/// The one question open in the board, and what it is about. Asking another closes this one, so two are never open at once.
type Asking =
  | { kind: "pause" | "resume" | "remove"; id: string }
  | { kind: "pause-team" | "resume-team" }
  | { kind: "make"; review: Review };

/// Which part of the board a change, its notice or its refusal belongs to.
type Place = "team" | "routines" | "make";
type Notice = { place: Place; text: string };

const listStyle = { listStyle: "none", margin: 0, padding: 0 } as const;
const sectionStyle = { display: "flex", flexDirection: "column", gap: 10 } as const;
const rowStyle = { borderTop: "1px solid var(--line)", flexWrap: "wrap", alignItems: "flex-start" } as const;
const lines = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 } as const;
const quiet = { fontSize: 13, overflowWrap: "anywhere" } as const;
const outcome = { ...quiet, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 } as const;

export function RoutinesView({ shops, tenant: chosen, onForget }: {
  shops: Shop[] | null;
  tenant: string | null;
  onForget: () => void;
}) {
  const api = useApi();
  const [tenant, setTenant] = useState(() => chosen ?? shops?.[0]?.tenant ?? "");
  const shop = shops?.find((s) => s.tenant === tenant) ?? null;
  const routines = useLoad(shop ? () => api.getRoutines(shop.tenant) : null, `routines:${shop?.tenant ?? ""}`);

  // Keeps the chosen shop while the list still has it; one deleted meanwhile gives way to the first.
  useEffect(() => {
    if (!shops) return;
    setTenant((current) => (shops.some((s) => s.tenant === current) ? current : (shops[0]?.tenant ?? "")));
  }, [shops]);

  return (
    <>
      <div className="top">
        <h1>{W.title}</h1>
        {shops && shops.length > 0 && (
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <label htmlFor="routines-shop" className="mut" style={{ fontSize: 13 }}>
              {W.shopLabel}
            </label>
            <select id="routines-shop" className="input" value={tenant} onChange={(event) => setTenant(event.target.value)}>
              {shops.map((s) => (
                <option key={s.tenant} value={s.tenant}>
                  {s.name}
                </option>
              ))}
            </select>
          </span>
        )}
        <div className="acts">
          <button type="button" className="btn ghost" onClick={routines.reload}>
            {W.refresh}
          </button>
        </div>
      </div>
      {isAuthError(routines.error) ? (
        // A key the API refused stops the read, so it is said once, at the top, with the way out.
        <div style={{ padding: "16px 16px 0" }}>
          <div className="banner err" role="alert">
            <span className="grow">{errorText(routines.error)}</span>
            <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
              {W.anotherKey}
            </button>
          </div>
        </div>
      ) : null}
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 20, maxWidth: 880 }}>
        <p className="hint" style={{ margin: 0 }}>
          {W.intro}
        </p>
        {shops && shops.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            {W.noShops}
          </p>
        ) : !shop ? (
          <div className="skel" style={{ height: 120 }} aria-label={W.loading} />
        ) : (
          // Keyed by the shop, so a question or a notice that one shop's page was holding is never carried over to another's.
          <RoutinesBoard key={shop.tenant} shop={shop} routines={routines} onForget={onForget} />
        )}
      </div>
    </>
  );
}

function RoutinesBoard({ shop, routines, onForget }: {
  shop: Shop;
  routines: Loaded<RoutinesRead>;
  onForget: () => void;
}) {
  const api = useApi();
  const [asking, setAsking] = useState<Asking | null>(null);
  // The change on its way, by what it is for, and a guard that holds even between two presses that arrive before the page has drawn
  // the first one's answer.
  const [busy, setBusy] = useState<string | null>(null);
  const running = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [errors, setErrors] = useState<Record<Place, Problem | null>>({ team: null, routines: null, make: null });
  // The routines this page has made since the list it holds was read, as the API answered each, with the list that was held when it
  // answered. They are listed after it at once, so a routine that was made is never missing while the page reads again, or when that read
  // fails. The next read says what the API now keeps, so it replaces them, whether it lists them or not. A routine is listed once: a read
  // that landed while it was being made (Refresh is never locked) may already list it.
  const [made, setMade] = useState<{ after: RoutinesRead; routines: Routine[] } | null>(null);
  const locked = busy !== null;
  const now = Date.now();
  const view = routines.data;
  const latest = useRef(view);
  latest.current = view;
  const joined = view !== null && made !== null && made.after === view
    ? made.routines.filter((one) => !view.routines.some((known) => known.id === one.id))
    : [];
  const list = [...(view?.routines ?? []), ...joined];
  // The template a routine came from is named by the API's own list of templates, which is read only once a routine names one (so the
  // key changes with that, and the read starts when the routines arrive). A name it cannot read is shown as the id the API sent, so
  // nothing is lost when that read fails.
  const namesTemplates = list.some((routine) => routine.template !== undefined);
  const names = useLoad(namesTemplates ? () => api.listTemplates() : null, `templates:${namesTemplates}`);
  const templateName = (id: string) => names.data?.find((template) => template.id === id)?.name ?? id;

  /// One change. `work` makes the call and answers what to say when it is done. A refusal is said in the part of the board the change
  /// belongs to and leaves the question open, so it can be tried again or kept; one that means the list moved on closes it and reads
  /// the list again. A change may take a refusal first (`refused`, which answers whether it said it, beside a field of a form: the
  /// question is then closed, since what it asked is no longer right) and may say its failures in words of its own (`say`).
  async function change(place: Place, key: string, work: () => Promise<string>,
    how: { refused?: (error: unknown) => boolean; say?: (error: unknown) => string } = {}): Promise<void> {
    if (running.current) return;
    running.current = true;
    setBusy(key);
    setNotice(null);
    setErrors((current) => ({ ...current, [place]: null }));
    try {
      const text = await work();
      setAsking(null);
      setNotice({ place, text });
      routines.reload();
    } catch (error) {
      if (how.refused?.(error)) {
        setAsking(null);
        return;
      }
      setErrors((current) => ({
        ...current,
        [place]: { text: (how.say ?? ((failed) => routinesErrorText(failed, "change")))(error), refused: isAuthError(error) },
      }));
      if (error instanceof ApiError && ROUTINES_MOVED_ON.has(error.code)) {
        setAsking(null);
        routines.reload();
      }
    } finally {
      running.current = false;
      setBusy(null);
    }
  }

  const team = view?.team ?? null;
  const pauseRoutine = (routine: Routine) =>
    change("routines", `pause:${routine.id}`, async () => {
      await api.pauseRoutine({ tenant: shop.tenant, routineId: routine.id });
      return W.paused(routine.name);
    });
  const resumeRoutine = (routine: Routine) =>
    change("routines", `resume:${routine.id}`, async () => {
      const answer = await api.resumeRoutine({ tenant: shop.tenant, routineId: routine.id });
      // What the API answers, which is the routine as it now stands: its next run worked out from now, or why it has none.
      return W.resumed(answer, team ?? { paused: false, since: null, members: ["nam", "pim", "ton"] }, Date.now());
    });
  const removeRoutine = (routine: Routine) =>
    change("routines", `remove:${routine.id}`, async () => {
      await api.removeRoutine({ tenant: shop.tenant, routineId: routine.id });
      return W.removed(routine.name);
    });
  const pauseTeam = () =>
    change("team", "pause-team", async () => {
      await api.pauseTeam({ tenant: shop.tenant });
      return W.teamPausedDone(shop.name);
    });
  const resumeTeam = () =>
    change("team", "resume-team", async () => {
      await api.resumeTeam({ tenant: shop.tenant });
      return W.teamResumedDone(shop.name);
    });
  // Making a routine sends exactly the body the question was worked out from. What the API answers is the routine as it made it, which
  // is listed as it is (above) and said in the notice in its own words; the form is cleared only once it is made.
  const makeRoutine = (review: Review, handlers: { refused: (error: unknown) => boolean; made: () => void }) =>
    change("make", "make", async () => {
      const answer = await api.createRoutine(review.body);
      // After the list the page holds now, which is not the one it held when yes was pressed if a read landed in between.
      const after = latest.current;
      if (after) setMade((current) => ({ after, routines: [...(current?.after === after ? current.routines : []), answer] }));
      handlers.made();
      return M.made(answer, team ?? { paused: false, since: null, members: ["nam", "pim", "ton"] }, Date.now());
    }, { refused: handlers.refused, say: (error) => makeErrorText(error, shop.name) });

  const readFailed = routines.error != null && !isAuthError(routines.error);
  const pausedCount = list.filter((routine) => routine.paused).length;

  return (
    <>
      {/* The team comes in the same answer as the routines, so it is drawn only from one, and its failure is said below, in the
          routines' part, once. */}
      {(view !== null || routines.error == null) && (
        <section aria-labelledby="routines-team" style={sectionStyle}>
          <div className="band">
            <h2 id="routines-team" className="h2" style={{ fontSize: 13, color: "inherit" }}>
              {W.teamTitle(shop.name)}
            </h2>
          </div>
          {notice?.place === "team" && <Said text={notice.text} />}
          {errors.team && <Failed problem={errors.team} onForget={onForget} />}
          {!view || !team ? (
            <div className="skel" style={{ height: 72 }} aria-label={W.teamLoading} />
          ) : (
            <TeamRow shop={shop} team={team} now={now} asking={asking} locked={locked} busy={busy}
              onAsk={(kind) => setAsking({ kind })} onKeep={() => setAsking(null)} onPause={() => void pauseTeam()}
              onResume={() => void resumeTeam()} />
          )}
        </section>
      )}

      <section aria-labelledby="routines-list" style={sectionStyle}>
        <div className="band">
          <h2 id="routines-list" className="h2" style={{ fontSize: 13, color: "inherit" }}>
            {W.routinesTitle(shop.name)}
          </h2>
          {view && <span>{W.routinesCount(list.length, pausedCount)}</span>}
        </div>
        {notice?.place === "routines" && <Said text={notice.text} />}
        {errors.routines && <Failed problem={errors.routines} onForget={onForget} />}
        {readFailed && <ReadFailed text={routinesErrorText(routines.error, "read")} onRetry={routines.reload} />}
        {!view || !team ? (
          routines.error ? null : <div className="skel" style={{ height: 72 }} aria-label={W.routinesLoading} />
        ) : list.length === 0 ? (
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {W.routinesEmpty}
          </p>
        ) : (
          <ul aria-label={W.routinesLabel(shop.name)} style={listStyle}>
            {list.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                team={team}
                now={now}
                asking={asking}
                locked={locked}
                busy={busy}
                templateName={routine.template === undefined ? null : templateName(routine.template)}
                onAsk={(kind) => setAsking({ kind, id: routine.id })}
                onKeep={() => setAsking(null)}
                onPause={() => void pauseRoutine(routine)}
                onResume={() => void resumeRoutine(routine)}
                onRemove={() => void removeRoutine(routine)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* The form is offered once the routines are read, since a routine that was made joins that list, and what the question says (its
          next run) depends on the team. */}
      {view && team && (
        <section aria-labelledby="routines-make" style={sectionStyle}>
          <div className="band">
            <h2 id="routines-make" className="h2" style={{ fontSize: 13, color: "inherit" }}>
              {M.title(shop.name)}
            </h2>
          </div>
          <p className="hint" style={{ margin: 0, padding: "0 10px" }}>
            {M.intro}
          </p>
          {notice?.place === "make" && <Said text={notice.text} />}
          {errors.make && <Failed problem={errors.make} onForget={onForget} />}
          <div style={{ padding: "0 10px" }}>
            <MakeRoutineForm
              shop={shop}
              team={team}
              review={asking?.kind === "make" ? asking.review : null}
              locked={locked}
              busy={busy === "make"}
              onReview={(review) => setAsking({ kind: "make", review })}
              onKeep={() => setAsking(null)}
              onMake={(review, handlers) => void makeRoutine(review, handlers)}
            />
          </div>
        </section>
      )}
    </>
  );
}

/// The routines that could not be read, in their own part of the page, with their own way to try again.
function ReadFailed({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="banner err" role="alert">
      <span className="grow">{text}</span>
      <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onRetry}>
        {W.tryAgain}
      </button>
    </div>
  );
}

/// The team: whether everyone is on, or paused since when, who is on, and Pause everyone or Resume, which asks first.
function TeamRow({ shop, team, now, asking, locked, busy, onAsk, onKeep, onPause, onResume }: {
  shop: Shop;
  team: Team;
  now: number;
  asking: Asking | null;
  locked: boolean;
  busy: string | null;
  onAsk: (kind: "pause-team" | "resume-team") => void;
  onKeep: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const tag = teamTag(team.paused);
  const open = asking && "id" in asking ? null : (asking?.kind ?? null);
  return (
    <div className="rowl" style={rowStyle}>
      <span className="grow" style={lines}>
        <span style={{ fontWeight: 500 }}>{team.paused ? W.teamPaused(team.since, now) : W.teamOn}</span>
        {team.paused && <span style={quiet}>{W.teamPausedEffect}</span>}
        <span className="mut" style={quiet}>{W.membersOn(team.members)}</span>
      </span>
      <span className={tag.className}>{tag.label}</span>
      {team.paused ? (
        <button type="button" className="btn ghost" disabled={locked} aria-label={W.resumeTeamLabel(shop.name)}
          onClick={() => onAsk("resume-team")}>
          {W.resumeTeamButton}
        </button>
      ) : (
        <button type="button" className="btn ghost" disabled={locked} aria-label={W.pauseTeamLabel(shop.name)}
          onClick={() => onAsk("pause-team")}>
          {W.pauseTeamButton}
        </button>
      )}
      {open === "pause-team" && (
        <Question id="pause-team" title={W.pauseTeamTitle(shop.name)} yes={W.pauseTeamYes} no={W.pauseTeamNo}
          busyLabel={W.pausing} busy={busy === "pause-team"} locked={locked} danger onYes={onPause} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.pauseTeamEffect}</p>
          <p className="mut" style={{ margin: 0 }}>{W.pauseTeamNote}</p>
        </Question>
      )}
      {open === "resume-team" && (
        <Question id="resume-team" title={W.resumeTeamTitle(shop.name)} yes={W.resumeTeamYes} no={W.resumeTeamNo}
          busyLabel={W.resuming} busy={busy === "resume-team"} locked={locked} onYes={onResume} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.resumeTeamEffect}</p>
          <p className="mut" style={{ margin: 0 }}>{W.resumeTeamNote}</p>
        </Question>
      )}
    </div>
  );
}

/// A routine: its name and whose job it is, when it runs, its next run or why there is none, whether it asks the owner first, the
/// template it came from, and how its last run ended and why. "Pause" or "Resume" and "Remove" each open a question in the row.
function RoutineRow({ routine, team, now, asking, locked, busy, templateName, onAsk, onKeep, onPause, onResume, onRemove }: {
  routine: Routine;
  team: Team;
  now: number;
  asking: Asking | null;
  locked: boolean;
  busy: string | null;
  templateName: string | null;
  onAsk: (kind: "pause" | "resume" | "remove") => void;
  onKeep: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
}) {
  const tag = routineTag(routine.paused);
  const open = asking && "id" in asking && asking.id === routine.id ? asking.kind : null;
  const last = routine.lastRun;
  const lastTag = last ? runTag(last.status) : null;
  const lastText = last ? runText(last) : "";
  return (
    <li className="rowl" style={rowStyle}>
      <span className="grow" style={lines}>
        <span style={{ fontWeight: 500 }}>{routine.name}</span>
        <span className="mut" style={quiet}>{W.jobOf(routine.member)}</span>
        <span className="mut" style={quiet}>{W.when(routine)}</span>
        <span style={quiet}>{nextRunText(routine, team, now)}</span>
        <span className="mut" style={quiet}>{W.asksFirst(routine.asksFirst)}</span>
        {templateName !== null && <span className="mut" style={quiet}>{W.fromTemplate(templateName)}</span>}
        {last && lastTag ? (
          <>
            <span className="mut" style={quiet}>{W.lastRun(last.instant, now)}</span>
            <span style={outcome}>
              <span className={lastTag.className}>{lastTag.label}</span>
              {lastText !== "" && <span>{lastText}</span>}
            </span>
          </>
        ) : (
          <span className="mut" style={quiet}>{W.neverRan}</span>
        )}
      </span>
      <span className={tag.className}>{tag.label}</span>
      {routine.paused ? (
        <button type="button" className="btn ghost" disabled={locked} aria-label={W.resumeLabel(routine.name)}
          onClick={() => onAsk("resume")}>
          {W.resumeButton}
        </button>
      ) : (
        <button type="button" className="btn ghost" disabled={locked} aria-label={W.pauseLabel(routine.name)}
          onClick={() => onAsk("pause")}>
          {W.pauseButton}
        </button>
      )}
      <button type="button" className="btn ghost" disabled={locked} aria-label={W.removeLabel(routine.name)}
        onClick={() => onAsk("remove")}>
        {W.removeButton}
      </button>
      {open === "pause" && (
        <Question id={`pause-${routine.id}`} title={W.pauseTitle(routine.name)} yes={W.pauseYes(routine.name)} no={W.pauseNo}
          busyLabel={W.pausing} busy={busy === `pause:${routine.id}`} locked={locked} onYes={onPause} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.pauseEffect(routine)}</p>
        </Question>
      )}
      {open === "resume" && (
        <Question id={`resume-${routine.id}`} title={W.resumeTitle(routine.name)} yes={W.resumeYes(routine.name)} no={W.resumeNo}
          busyLabel={W.resuming} busy={busy === `resume:${routine.id}`} locked={locked} onYes={onResume} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.resumeEffect(routine, team)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.resumeNote}</p>
        </Question>
      )}
      {open === "remove" && (
        <Question id={`remove-${routine.id}`} title={W.removeTitle(routine.name)} yes={W.removeYes(routine.name)} no={W.removeNo}
          busyLabel={W.removing} busy={busy === `remove:${routine.id}`} locked={locked} danger onYes={onRemove} onNo={onKeep}>
          <p style={{ margin: 0 }}>{W.removeEffect(routine.name)}</p>
          <p className="mut" style={{ margin: 0 }}>{W.removeNote}</p>
        </Question>
      )}
    </li>
  );
}
