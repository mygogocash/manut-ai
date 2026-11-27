// The card a lead lane's chat shows when the app closed during a round of its helper lanes (item 102j-2; `docs/several-agents.md`,
// rule R11): the helpers of the rounds put back, each with where its work is, and two presses, Land what they did and Report to Kit.
// Nothing lands and nothing goes to the lead before a press; each press is once. Report to Kit without Land what they did leaves the
// work in the helpers' own lanes and says so to the lead. Once reported, the card settles into one line.
//
// `HelpersRestartView` draws from props alone, so a test renders each state; `HelpersRestartCard` reads the sessions store.
import "./helpers.css";
import { useSyncExternalStore } from "react";
import { t } from "../i18n";
import { revealHidden } from "../lib/secrets";
import { getSessions } from "../sessions/sessions";
import { landingWords } from "./HelperRunCard";
import type { LandingView, RestartView } from "./helperLanding";

export interface RestartRow {
  readonly n: number;
  readonly title: string;
  readonly landing: LandingView | null;
}

export interface HelpersRestartViewProps {
  readonly view: RestartView;
  readonly rows: readonly RestartRow[];
  onLand?: () => void;
  onReport?: () => void;
}

export function HelpersRestartView({ view, rows, onLand, onReport }: HelpersRestartViewProps) {
  if (view.state === "reported") {
    return (
      <div className="line card-line ok" data-testid="helpers-restart-line">
        <span className="line-ic">✓</span>
        <span className="line-t">{t("helpers.restart.done")}</span>
      </div>
    );
  }
  const reporting = view.state === "reporting";
  return (
    <div className="card hl-card" data-testid="helpers-restart" data-state={view.state} role="group" aria-label={t("helpers.restart.title")}>
      <div className="card-title">{t("helpers.restart.title")}</div>
      {/* true only until a press: after Land what they did the rows say what landed */}
      {view.state === "offered" && <p className="hl-lines">{t("helpers.restart.lead")}</p>}
      <ol className="hl-rows">
        {rows.map((r) => (
          <li key={r.n} className="hl-row" data-testid="helpers-restart-row">
            <div className="hl-title">{t("helpers.run.link", { n: r.n, title: revealHidden(r.title) })}</div>
            {r.landing && (
              <div className="hl-lines" data-testid="helpers-restart-landing">
                {landingWords(r.landing)}
              </div>
            )}
          </li>
        ))}
      </ol>
      {reporting && (
        <p className="card-note" role="status" data-testid="helpers-restart-reporting">
          {t("helpers.restart.reporting")}
        </p>
      )}
      <div className="card-acts">
        <button type="button" className="card-btn soft" disabled={!view.canLand || reporting} onClick={onLand} data-testid="helpers-restart-land">
          {t("helpers.restart.land")}
        </button>
        <button type="button" className="card-btn primary" disabled={reporting} onClick={onReport} data-testid="helpers-restart-report">
          {t("helpers.restart.report")}
        </button>
      </div>
    </div>
  );
}

export function HelpersRestartCard({ lead }: { lead: string }) {
  const ss = getSessions();
  const view = useSyncExternalStore(ss.subscribeLandings, () => ss.restartOf(lead), () => ss.restartOf(lead));
  const landings = useSyncExternalStore(ss.subscribeLandings, ss.landingSnapshot, ss.landingSnapshot);
  if (!view) return null;
  const rows = view.helpers.map((h) => ({ n: h.index + 1, title: h.title, landing: landings.get(`${h.round}:${h.index}`) ?? null }));
  return <HelpersRestartView view={view} rows={rows} onLand={() => ss.landRestored(lead)} onReport={() => ss.reportRestored(lead)} />;
}
