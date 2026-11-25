// A job's page, as the design canvas draws it (Job.dc.html, "A job, two depths"). On top, for the owner: what was asked
// for, how it went from proposal to check, what happened, who it went to, what it cost and how long it took, and three
// ways to go on. Beside it, for developers, under the hood: the same job step by step, every tool call, model and cost.
// It is opened from a job in History, on Home or on a member's page, and returns to where it was opened from.
//
// The page shows what the runtime says of the job and nothing else. A runtime that cannot say (the connected one, for
// now) gets the unavailable state with its own words. An action that is not wired yet says "not yet" when pressed; the
// question goes to the member who did the job, through the one path Home's ask box uses.
import { Fragment, useEffect, useState } from "react";
import "./mission.css";
import { t } from "../i18n";
import { holdImeEnter } from "../lib/ime";
import type { Job } from "../runtime/mission";
import { getStore, useStore } from "../state/store";
import { ArrowLeft, IconButton } from "../ui";
import { MenuPageFrame } from "./MenuPage";
import { sendAsk } from "./home";
import { initialOf, recipientTag, resultWord, satangText, timeline, tokensText, tookText, traceRows, traceText, traceTotal } from "./job";
import { LOADING, load, type Load } from "./load";
import { Loading } from "./Loading";

/** The actions that do nothing yet. They say so when pressed instead of pretending. */
export type Unwired = "wrong" | "again" | "replay";

export interface JobViewProps {
  load: Load<Job>;
  /** the member who does the job, as the app names them */
  who: string;
  nowMs: number;
  onBack: () => void;
  /** Under the hood is open */
  hood: boolean;
  onHood: () => void;
  /** the action pressed that is not wired yet: its "not yet" line shows */
  unwired: Unwired | null;
  onUnwired: (which: Unwired) => void;
  /** the question typed about the job, and why the last one did not go (the box keeps its words) */
  ask: string;
  onAsk: (text: string) => void;
  onSubmitAsk: () => void;
  askError?: string | null;
  asking?: boolean;
  onCopy: () => void;
  /** how the last Copy trace went */
  copy: "idle" | "done" | "failed";
}

/** The question as the member reads it: the owner's words, with the job they are about. */
export const jobQuestion = (title: string, question: string): string => t("job.askAbout", { title, question: question.trim() });

function Chevron() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.5 4.5L10 8l-3.5 3.5" />
    </svg>
  );
}
function SendGlyph() {
  return (
    <svg className="ic" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 13V3M4 7l4-4 4 4" />
    </svg>
  );
}

export function JobView(p: JobViewProps) {
  const job = p.load.kind === "ready" ? p.load.value : null;
  const back = (
    <IconButton label={t("page.back")} className="head-back" onClick={p.onBack} data-testid="page-back">
      <ArrowLeft />
    </IconButton>
  );
  const frame = (body: React.ReactNode, acts?: React.ReactNode) => (
    <MenuPageFrame page="job" title={job?.title ?? t("job.title")} lead={back} middle={job && p.who ? <span className="tag">{p.who}</span> : undefined} acts={acts}>
      {body}
    </MenuPageFrame>
  );

  if (p.load.kind === "loading")
    return frame(
      <Loading label={t("job.loading")} testId="job-loading" strip={false} />,
    );
  if (p.load.kind === "unavailable")
    return frame(
      <div className="jobv-off" role="alert" data-testid="job-unavailable">
        <h2>{t("job.unavailable")}</h2>
        <p>{p.load.message}</p>
      </div>,
    );

  const j = p.load.value;
  const { day, chips } = timeline(j.steps, p.nowMs);
  const rows = traceRows(j.trace);
  const total = traceTotal(j.trace);
  const going = j.recipients.some((r) => r.status === "waiting");
  const unwiredLabel = p.unwired === "wrong" ? t("job.wrong") : p.unwired === "again" ? t("job.again", { when: j.again ?? "" }) : p.unwired === "replay" ? t("job.replay") : "";

  return frame(
    <div className="jobv" data-arrive="job" data-arrive-rows=".to .rowl, .trace .tr:not(.total)" data-testid="job-body">
      <div className="main">
        <div className="col">
          <div className="you" data-testid="job-goal">
            {j.goal}
          </div>
          <div className="steps" data-testid="job-timeline">
            {day && <span className="mut">{day}</span>}
            {chips.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <Chevron />}
                <span className={c.cls}>{c.text}</span>
              </Fragment>
            ))}
          </div>
          <div className="prose" data-testid="job-summary">
            <p>{j.summary}</p>
          </div>
          {j.recipients.length > 0 && (
            <div className="to" data-testid="job-recipients">
              <div className="band">
                <span>{going ? t("job.goingTo") : t("job.sentTo")}</span>
                <span>{j.recipients.length === 1 ? t("job.customer1") : t("job.customers", { n: j.recipients.length })}</span>
              </div>
              {j.recipients.map((r, i) => {
                const tag = recipientTag(r.status);
                return (
                  <div key={i} className="rowl">
                    <span className={`av c${i % 4}`} aria-hidden="true">
                      {initialOf(r.name)}
                    </span>
                    <span className="grow">{r.name}</span>
                    <span className={tag.cls}>{t(tag.word)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="acrow">
            <span>
              <span className="mut">{t("job.cost")}</span> <span className="v" data-testid="job-cost">{satangText(j.costSatang)}</span>
            </span>
            {j.tookSeconds !== null && (
              <span>
                <span className="mut">{t("job.took")}</span> <span className="v" data-testid="job-took">{tookText(j.tookSeconds)}</span>
              </span>
            )}
            <button type="button" className="chip first" onClick={() => p.onUnwired("wrong")} data-testid="job-wrong">
              {t("job.wrong")}
            </button>
            {j.again && (
              <button type="button" className="chip" onClick={() => p.onUnwired("again")} data-testid="job-again">
                {t("job.again", { when: j.again })}
              </button>
            )}
          </div>
          {p.unwired && (
            <p className="hint" role="status" data-testid="job-notyet">
              {t("job.notYet", { action: unwiredLabel })}
            </p>
          )}
        </div>
        <form
          className="ask follow"
          onKeyDown={holdImeEnter}
          onSubmit={(e) => {
            e.preventDefault();
            p.onSubmitAsk();
          }}
        >
          <label className="vh" htmlFor="job-follow">
            {t("job.ask")}
          </label>
          <input
            id="job-follow"
            className="askin"
            type="text"
            autoComplete="off"
            value={p.ask}
            placeholder={t("job.ask")}
            onChange={(e) => p.onAsk(e.target.value)}
            data-testid="job-ask"
          />
          <div className="askrow">
            <button type="submit" className="send" aria-label={t("cmp.send")} title={t("cmp.send")} disabled={!p.ask.trim() || p.asking} data-testid="job-ask-send">
              <SendGlyph />
            </button>
          </div>
          {p.askError && (
            <p className="err" role="alert" data-testid="job-ask-error">
              {t("card.notSent", { error: p.askError })}
            </p>
          )}
        </form>
      </div>
      {p.hood && (
        <aside className="side2" aria-label={t("job.hood")} data-testid="job-hoodpanel">
          <div className="hoodh">
            <h2 className="h2">{t("job.hood")}</h2>
            <span className="tag">{t("job.forDevs")}</span>
          </div>
          <p className="hint">{t("job.hoodHint")}</p>
          <div className="box mono trace" data-testid="job-trace">
            {rows.map((r, i) => (
              <div key={i} className="tr" data-testid="job-trace-row">
                <span className="tool">{r.tool}</span>
                <span className="mut found">{r.found}</span>
                <span className="mut">{r.time}</span>
                {r.cost && <span className="mut">{r.cost}</span>}
                {r.result && <span className={`res ${r.result}`}>{t(resultWord(r.result))}</span>}
              </div>
            ))}
            <div className="tr total" data-testid="job-total">
              <span className="found">{t("job.total")}</span>
              {total.tokens !== null && <span>{tokensText(total.tokens)}</span>}
              <span>{satangText(total.costSatang)}</span>
            </div>
          </div>
          <div className="chips">
            <button type="button" className="btn" onClick={p.onCopy} data-testid="job-copy">
              {t("job.copy")}
            </button>
            <button type="button" className="btn" onClick={() => p.onUnwired("replay")} data-testid="job-replay">
              {t("job.replay")}
            </button>
          </div>
          {p.copy === "done" && (
            <p className="hint" role="status">
              {t("copy.done")}
            </p>
          )}
          {p.copy === "failed" && (
            <p className="err" role="alert">
              {t("job.copyFailed")}
            </p>
          )}
        </aside>
      )}
    </div>,
    <button type="button" className="btn" aria-expanded={p.hood} onClick={p.onHood} data-testid="job-hood">
      {p.hood ? t("job.hoodClose") : t("job.hoodOpen")}
    </button>,
  );
}

export function JobPage() {
  const s = useStore();
  const id = s.ui.job;
  const [state, setState] = useState<Load<Job>>(LOADING);
  const [hood, setHood] = useState(true);
  const [unwired, setUnwired] = useState<Unwired | null>(null);
  const [ask, setAsk] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  // Pausing or resuming the team moves a running job to paused and back, so the page reads the job again.
  const paused = s.bots.some((b) => b.paused);

  useEffect(() => {
    setState(LOADING);
    setUnwired(null);
    setCopy("idle");
  }, [id]);
  useEffect(() => {
    // A page opened with no job to show says so, in the runtime's own "not here" words, instead of waiting for ever.
    if (!id) {
      setState({ kind: "unavailable", code: "not_found", message: t("rt.notFound") });
      return;
    }
    let live = true;
    void load(() => getStore().actions.missionJob(id)).then((r) => {
      if (live) setState(r);
    });
    return () => {
      live = false;
    };
  }, [id, paused]);

  const job = state.kind === "ready" ? state.value : null;

  const submit = async () => {
    const words = ask.trim();
    if (!job || !words || asking) return;
    setAsking(true);
    setAskError(null);
    // The store reports a failed request only through lastError: clear it, then look after the call, as Home does.
    const store = getStore();
    store.dispatch({ type: "error", message: null });
    const sent = await sendAsk(s, { to: "thread", bot: job.bot }, jobQuestion(job.title, words));
    setAsking(false);
    if (sent) setAsk("");
    else setAskError(store.getState().lastError || t("card.notTaken"));
  };

  const copyTrace = async () => {
    if (!job) return;
    const ok = await (navigator.clipboard?.writeText(traceText(job)).then(
      () => true,
      () => false,
    ) ?? Promise.resolve(false));
    setCopy(ok ? "done" : "failed");
  };

  return (
    <JobView
      load={state}
      who={job ? (s.bots.find((b) => b.name === job.bot)?.display_name ?? job.bot) : ""}
      nowMs={Date.now()}
      onBack={() => s.closeSettings()}
      hood={hood}
      onHood={() => setHood((h) => !h)}
      unwired={unwired}
      onUnwired={setUnwired}
      ask={ask}
      onAsk={(words) => {
        setAsk(words);
        setAskError(null);
      }}
      onSubmitAsk={() => void submit()}
      askError={askError}
      asking={asking}
      onCopy={() => void copyTrace()}
      copy={copy}
    />
  );
}
