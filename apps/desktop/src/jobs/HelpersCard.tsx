// The Start helpers card (item 102e; `docs/several-agents.md`, "4. Helper lanes a lane asks for"): the round of helper lanes a lead
// lane's agent asked for at the end of its answer, shown under that answer in the lane's chat. Every helper's brief is whole, as a
// workflow's steps are, with the agent, model and effort it would run on, and what the app already knows will not start. It is one
// approval of the lead lane, settled once through approval-core (`helperAsks.ts`): Not now first, so the left-most answer is the
// safe one, then Start helpers, the card's one black button. Once settled, or once the lead's turn moved on, it collapses to one
// line. Once the person pressed Start helpers, the round's helper lanes start (item 102h) and the Helpers card with their rows,
// their Stop and Stop all follows the line (`HelperRunCard.tsx`).
//
// `HelpersCardView` draws from props alone, so a test renders each state; `HelpersAskCard` is the timeline's, which presses through
// the sessions store.
import "./helpers.css";
import { useEffect, useState, useSyncExternalStore } from "react";
import { t, type Key } from "../i18n";
import { maskSecrets, revealHidden } from "../lib/secrets";
import { agentDef } from "../sessions/agents";
import { getSessions } from "../sessions/sessions";
import type { HelpersAskItem } from "../state/types";
import type { HelperRow, HelpersAsk } from "./helperAsks";
import { HelperRunCard } from "./HelperRunCard";
import { BUDGET, MAX_ROUNDS, ROUND_MAX } from "./rules";

/** What a row says about where the helper lane runs: its agent, then its model and effort, or why it will not start. */
export function rowAgentWords(row: HelperRow): string {
  if (row.problem === "unknown") return t("helpers.unknownAgent", { name: revealHidden(row.asked ?? row.agent) });
  const label = agentDef(row.agent).label;
  if (row.problem === "notInstalled") return `${label}: ${t("helpers.notInstalled")}`;
  if (row.problem === "noAsks") return `${label}: ${t("helpers.noAsks")}`;
  const model = row.model
    ? row.modelUnlisted
      ? t("helpers.modelUnlisted", { name: revealHidden(row.model) })
      : revealHidden(row.model)
    : row.own
      ? t("helpers.leadModel")
      : t("helpers.defaultModel");
  const effort = row.effort ? (row.effortUnlisted ? t("helpers.effortUnlisted", { name: revealHidden(row.effort) }) : revealHidden(row.effort)) : "";
  return [label, model, effort].filter(Boolean).join(" · ");
}

/** The words of a refused press, in the person's language. */
export function refusedWords(code: string): string {
  if (code === "already_decided" || code === "superseded") return t(`helpers.refusal.${code}` as Key);
  if (code === "roundsSpent") return t("helpers.refusal.roundsSpent", { max: MAX_ROUNDS });
  return t("helpers.refusal.other", { code });
}

const DONE_LINE: Record<NonNullable<HelpersAskItem["done"]>, Key> = {
  started: "helpers.started",
  notNow: "helpers.declined",
  gone: "helpers.gone",
};

export interface HelpersCardViewProps {
  ask: HelpersAsk;
  /** what became of it; none while it waits */
  done?: HelpersAskItem["done"];
  /** a press is on its way */
  busy?: boolean;
  /** why the last press was not taken */
  error?: string | null;
  /** how many helper lanes run at once on this Mac, once its memory was read (item 102h) */
  atOnce?: number | null;
  onStart?: () => void;
  onNotNow?: () => void;
}

/** The card from props alone: open with its rows and buttons, or settled into one line. */
export function HelpersCardView({ ask, done, busy, error, atOnce, onStart, onNotNow }: HelpersCardViewProps) {
  const n = ask.rows.length;
  const title = n === 1 ? t("helpers.ask.one") : t("helpers.ask.many", { n });
  if (done) {
    const ok = done === "started";
    return (
      <div className={`line card-line${ok ? " ok" : ""}`} data-testid="helpers-line" data-done={done}>
        <span className="line-ic">{ok ? "✓" : "–"}</span>
        <span className="line-t">
          {t(DONE_LINE[done])}
          <span className="card-line-d"> · {title}</span>
        </span>
      </div>
    );
  }
  return (
    <div className="card hl-card" data-testid="helpers-card" role="group" aria-label={title}>
      <div className="card-title">{title}</div>
      <ol className="hl-rows">
        {ask.rows.map((row, i) => (
          <li key={i} className={`hl-row${row.problem ? " off" : ""}`} data-testid="helpers-row">
            <div className="hl-head">
              <span className="hl-n">{t("helpers.row", { n: i + 1 })}</span>
              <span className="hl-sep" aria-hidden="true">
                ·
              </span>
              <span className="hl-agent" data-testid="helpers-agent">
                {rowAgentWords(row)}
              </span>
            </div>
            <div className="hl-title" data-testid="helpers-title">
              {revealHidden(row.title)}
            </div>
            {/* the brief whole, its lines kept: a key in it is masked and a character that does not show is a visible mark (item
                121); a long one scrolls in its own box */}
            <div className="hl-brief" data-testid="helpers-brief" tabIndex={-1} aria-label={t("helpers.briefLabel", { n: i + 1 })}>
              {revealHidden(maskSecrets(row.brief))}
            </div>
          </li>
        ))}
      </ol>
      <p className="hl-lines">{t("helpers.lines", { minutes: BUDGET.stopMs / 60_000, steps: BUDGET.stopSteps })}</p>
      {/* this Mac's cap (rule R7), said only once the shell read the memory and only when the round is more than it runs at once */}
      {atOnce && n > atOnce ? (
        <p className="hl-at-once" data-testid="helpers-at-once">
          {t("helpers.atOnce", { n: atOnce })}
        </p>
      ) : null}
      {ask.heldBack > 0 && (
        <p className="card-note hl-held" data-testid="helpers-held" role="note">
          {t("helpers.heldBack", { asked: n + ask.heldBack, max: ROUND_MAX, left: ask.heldBack })}
        </p>
      )}
      <div className="card-acts">
        <button type="button" className="card-btn soft" disabled={busy} onClick={onNotNow} data-testid="helpers-not-now">
          {t("helpers.notNow")}
        </button>
        <button type="button" className="card-btn primary" disabled={busy} onClick={onStart} data-testid="helpers-start">
          {t("helpers.start")}
        </button>
        {error && (
          <span className="card-err" data-testid="helpers-error">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/** The timeline's card: each press goes to the sessions store, which settles the card's approval once and reads the lead's turn
 *  itself. A press that is refused leaves the card as the store has it and says why under the buttons. Once Start helpers is taken,
 *  the round's Helpers card follows its line (item 102h). */
export function HelpersAskCard({ item }: { item: HelpersAskItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ss = getSessions();
  const atOnce = useSyncExternalStore(ss.onHelperRuns, ss.helpersAtOnce, ss.helpersAtOnce);
  const open = !item.done;
  useEffect(() => {
    // the card says this Mac's cap while it waits: the shell's memory read, once a run of the app
    if (open) void ss.readHelpersAtOnce().catch(() => undefined);
  }, [open, ss]);
  const press = async (start: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await getSessions().answerHelpers(item.ask.lead, item.id, start);
    setBusy(false);
    if (!r.ok) setError(refusedWords(r.refused));
  };
  const view = <HelpersCardView ask={item.ask} done={item.done} busy={busy} error={error} atOnce={atOnce} onStart={() => void press(true)} onNotNow={() => void press(false)} />;
  if (item.done !== "started") return view;
  return (
    <>
      {view}
      <HelperRunCard round={item.id} />
    </>
  );
}
