// The reach cards (item 102k; `docs/several-agents.md`, "5. What an agent may do to other chats"): what a coding chat's agent asked of
// another chat, shown under its answer. Each shows exactly what would happen, whole: a read shows the text Kit would get (item 97's,
// built with no model), a send shows the words that would go, an open shows the lane's agent, title and brief. Each is one approval
// of the asking chat, settled once through approval-core (`reachAsks.ts`): the no first, so the left-most answer is the safe one,
// then the yes, the card's one black button. Once settled, or once the chat's turn moved on, it collapses to one line.
//
// `ReachCardView` draws from props alone, so a test renders each state; `ReachAskCard` is the timeline's, which presses through the
// sessions store. A message and a brief are masked as they are shown, and the store sends them masked, so what goes is what was read.
import "./helpers.css";
import "./reach.css";
import { useState } from "react";
import { t, type Key } from "../i18n";
import { maskSecrets, revealHidden } from "../lib/secrets";
import { getSessions } from "../sessions/sessions";
import { getStore } from "../state/store";
import type { ReachAskItem } from "../state/types";
import type { ReachAsk } from "./reachAsks";
import { rowAgentWords } from "./HelpersCard";
import { folderName } from "../sessions/agents";

/** The press refusals the card can say. */
const REFUSALS = ["already_decided", "superseded", "notListed", "gone", "self", "shop", "account", "notCoding", "notRunning", "agent"] as const;

/** The words of a refused press, in the person's language. */
export function reachRefusedWords(code: string): string {
  return (REFUSALS as readonly string[]).includes(code) ? t(`reach.refusal.${code}` as Key) : t("reach.refusal.other", { code });
}

/** The card's title: what is asked, naming the chat it would reach. */
export function reachTitle(ask: ReachAsk): string {
  if (ask.kind === "open") return t("reach.open.ask");
  return t(ask.kind === "read" ? "reach.read.ask" : "reach.send.ask", { title: revealHidden(ask.target.title) });
}

/** The line a settled card collapses to. */
function doneWords(ask: ReachAsk, done: NonNullable<ReachAskItem["done"]>): string {
  const title = ask.kind === "open" ? revealHidden(ask.lane.title) : revealHidden(ask.target.title);
  return t(`reach.${ask.kind}.${done}` as Key, { title });
}

export interface ReachCardViewProps {
  ask: ReachAsk;
  /** what became of it; none while it waits */
  done?: ReachAskItem["done"];
  /** after a yes: what went wrong doing it */
  failed?: string;
  /** a press is on its way */
  busy?: boolean;
  /** why the last press was not taken */
  error?: string | null;
  onYes?: () => void;
  onNo?: () => void;
  /** a started lane's Open */
  onOpenLane?: () => void;
}

/** The card from props alone: open with what it would do and its two buttons, or settled into one line. */
export function ReachCardView({ ask, done, failed, busy, error, onYes, onNo, onOpenLane }: ReachCardViewProps) {
  const title = reachTitle(ask);
  if (done) {
    const ok = done === "yes" && !failed;
    return (
      <div className={`line card-line${ok ? " ok" : ""}`} data-testid="reach-line" data-done={done} data-kind={ask.kind}>
        <span className="line-ic">{ok ? "✓" : done === "yes" ? "!" : "–"}</span>
        <span className="line-t">
          {failed ? t("reach.failed", { error: failed }) : doneWords(ask, done)}
          {ok && ask.kind === "open" && onOpenLane && (
            <>
              {" "}
              <button type="button" className="rc-open" onClick={onOpenLane} data-testid="reach-open-lane">
                {t("reach.open.go")}
              </button>
            </>
          )}
        </span>
      </div>
    );
  }
  const [no, yes] =
    ask.kind === "read" ? (["reach.read.noBtn", "reach.read.yesBtn"] as const) : ask.kind === "send" ? (["reach.send.noBtn", "reach.send.yesBtn"] as const) : (["reach.open.noBtn", "reach.open.yesBtn"] as const);
  const cantStart = ask.kind === "open" && !!ask.lane.problem;
  return (
    <div className="card hl-card rc-card" data-testid="reach-card" data-kind={ask.kind} role="group" aria-label={title}>
      <div className="card-title">{title}</div>
      {ask.kind === "read" && (
        <>
          {/* exactly what Let Kit read sends: item 97's text, already masked and capped as it was built */}
          <div className="hl-brief rc-text" data-testid="reach-text" tabIndex={-1} aria-label={t("reach.read.textLabel")}>
            {revealHidden(ask.text)}
          </div>
          <p className="hl-lines">{t("reach.read.sees")}</p>
        </>
      )}
      {ask.kind === "send" && (
        <>
          <div className="hl-brief rc-text" data-testid="reach-text" tabIndex={-1} aria-label={t("reach.send.textLabel")}>
            {revealHidden(maskSecrets(ask.message))}
          </div>
          <p className="hl-lines">{t("reach.send.note")}</p>
        </>
      )}
      {ask.kind === "open" && (
        <>
          <div className={`hl-row${ask.lane.problem ? " off" : ""}`}>
            <div className="hl-head">
              <span className="hl-agent" data-testid="reach-agent">
                {rowAgentWords(ask.lane)}
              </span>
            </div>
            <div className="hl-title" data-testid="reach-lane-title">
              {revealHidden(ask.lane.title)}
            </div>
            <div className="hl-brief" data-testid="reach-text" tabIndex={-1} aria-label={t("reach.open.textLabel")}>
              {revealHidden(maskSecrets(ask.lane.brief))}
            </div>
          </div>
          <p className="hl-lines">{t("reach.open.note", { folder: folderName(ask.cwd) })}</p>
        </>
      )}
      <div className="card-acts">
        <button type="button" className="card-btn soft" disabled={busy} onClick={onNo} data-testid="reach-no">
          {t(no)}
        </button>
        <button type="button" className="card-btn primary" disabled={busy || cantStart} onClick={onYes} data-testid="reach-yes">
          {t(yes)}
        </button>
        {error && (
          <span className="card-err" data-testid="reach-error">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/** The timeline's card: each press goes to the sessions store, which checks again, settles the card's approval once and reads the
 *  asking chat's turn itself. A press that is refused leaves the card as the store has it and says why under the buttons. */
export function ReachAskCard({ item }: { item: ReachAskItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = async (yes: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await getSessions().answerReach(item.ask.asker, item.id, yes);
    setBusy(false);
    if (!r.ok) setError(reachRefusedWords(r.refused));
  };
  return (
    <ReachCardView
      ask={item.ask}
      done={item.done}
      failed={item.error}
      busy={busy}
      error={error}
      onYes={() => void press(true)}
      onNo={() => void press(false)}
      onOpenLane={item.lane ? () => getStore().actions.openSession(item.lane!) : undefined}
    />
  );
}
