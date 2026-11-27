// A program outside Manut AI asks to reach the chats the person listed (item 103, `docs/mcp-threads.md`, rule M6): one card
// for each program waiting, over whatever is showing, as Bring over's offer and the snapshot's notice are. It names the
// program as the shell read it from the kernel, with its whole path, and what the program calls itself only as its own words.
// Let in lasts while that program runs; No holds for the rest of its run. A card whose call is gone reads "No longer open".
//
// `LetInCardsView` draws from props alone, so a test renders it; `LetInCards` is the app's, over `store.ts`.
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { revealHidden } from "../lib/secrets";
import { getMcp, useMcp, type LetInCard } from "./store";
import "./threadsMcp.css";

export interface LetInCardsViewProps {
  cards: readonly LetInCard[];
  onAnswer: (id: string, yes: boolean) => void;
  onDismiss: (id: string) => void;
}

export function LetInCardsView({ cards, onAnswer, onDismiss }: LetInCardsViewProps) {
  if (!cards.length) return null;
  return (
    <div className="tm-cards" role="region" aria-label={t("tm.cards")} data-testid="tm-cards">
      {cards.map((c) => (
        <div key={c.id} className={`tm-card${c.gone ? " gone" : ""}`} role="alertdialog" aria-labelledby={`tm-${c.id}`} data-testid="tm-card" data-id={c.id}>
          <div className="tm-head">
            <Icon name="plug" size={14} />
            <b id={`tm-${c.id}`}>{t("tm.letIn.title", { name: revealHidden(c.program.name) })}</b>
          </div>
          {c.program.path && (
            <div className="tm-path" title={revealHidden(c.program.path)} data-testid="tm-path">
              {revealHidden(c.program.path)}
            </div>
          )}
          {c.program.callsItself && (
            <div className="tm-own" data-testid="tm-own">
              {t("tm.letIn.callsItself", { words: revealHidden(c.program.callsItself) })}
            </div>
          )}
          {c.gone ? (
            <div className="tm-row">
              <span className="tm-note" role="status">
                {t("tm.gone")}
              </span>
              <button type="button" className="st-btn" onClick={() => onDismiss(c.id)} data-testid="tm-dismiss">
                {t("tm.close")}
              </button>
            </div>
          ) : (
            <>
              <div className="tm-note">{t("tm.letIn.what")}</div>
              <div className="tm-row">
                <button type="button" className="st-btn" onClick={() => onAnswer(c.id, false)} data-testid="tm-no">
                  {t("tm.letIn.no")}
                </button>
                <button type="button" className="st-btn dark" onClick={() => onAnswer(c.id, true)} data-testid="tm-yes">
                  {t("tm.letIn.yes")}
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

export function LetInCards() {
  const { cards } = useMcp();
  return <LetInCardsView cards={cards} onAnswer={(id, yes) => void getMcp().letIn(id, yes)} onDismiss={(id) => getMcp().dismiss(id)} />;
}
