// A program outside Manut AI asks something of the person (item 103, `docs/mcp-threads.md`): one card for each ask waiting, over
// whatever is showing, as Bring over's offer and the snapshot's notice are. Every card names the program as the shell read it
// from the kernel, with its whole path; what the program calls itself is shown only as its own words.
//
// - Let in (M6): it may reach the chats the person listed while it runs. Let in while it runs, or No.
// - A read (103c): exactly the text that would go, item 97's, masked and capped. Let it read, or No.
// - A message (103c): the words whole, masked as they will go, and the chat they would go to. Send there, or Keep out.
// - A new lane (103d): its title, agent and project folder, and the brief whole. Start lane, or Not now.
//
// A card whose call is gone reads "No longer open", with Close and nothing to answer.
//
// `McpCardsView` draws from props alone, so a test renders it; `McpCards` is the app's, over `store.ts`.
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { revealHidden } from "../lib/secrets";
import { getMcp, useMcp, type McpCard } from "./store";
import "./threadsMcp.css";

export interface McpCardsViewProps {
  cards: readonly McpCard[];
  onAnswer: (card: McpCard, yes: boolean) => void;
  onDismiss: (id: string) => void;
}

function words(c: McpCard): { title: string; yes: string; no: string } {
  const name = revealHidden(c.program.name);
  if (c.kind === "read") return { title: t("tm.read.title", { name, title: revealHidden(c.chat.title) }), yes: t("tm.read.yes"), no: t("tm.read.no") };
  if (c.kind === "send") return { title: t("tm.send.title", { name, title: revealHidden(c.chat.title) }), yes: t("tm.send.yes"), no: t("tm.send.no") };
  if (c.kind === "open") return { title: t("tm.open.title", { name, title: revealHidden(c.chat.title) }), yes: t("tm.open.yes"), no: t("tm.open.no") };
  return { title: t("tm.letIn.title", { name }), yes: t("tm.letIn.yes"), no: t("tm.letIn.no") };
}

export function McpCardsView({ cards, onAnswer, onDismiss }: McpCardsViewProps) {
  if (!cards.length) return null;
  return (
    <div className="tm-cards" role="region" aria-label={t("tm.cards")} data-testid="tm-cards">
      {cards.map((c) => {
        const w = words(c);
        return (
          <div key={c.id} className={`tm-card${c.gone ? " gone" : ""}`} role="alertdialog" aria-labelledby={`tm-${c.id}`} data-testid="tm-card" data-id={c.id} data-kind={c.kind}>
            <div className="tm-head">
              <Icon name="plug" />
              <b id={`tm-${c.id}`}>{w.title}</b>
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
            {c.kind === "read" && (
              <pre className="tm-text" data-testid="tm-text">
                {revealHidden(c.text)}
              </pre>
            )}
            {c.kind === "send" && (
              <pre className="tm-text" data-testid="tm-text">
                {revealHidden(c.message)}
              </pre>
            )}
            {c.kind === "open" && (
              <>
                <div className="tm-own" data-testid="tm-lane">
                  {t("tm.open.lane", { title: revealHidden(c.title), agent: c.agentLabel, folder: revealHidden(c.cwd) })}
                </div>
                <pre className="tm-text" data-testid="tm-text">
                  {revealHidden(c.brief)}
                </pre>
              </>
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
                <div className="tm-note">{c.kind === "read" ? t("tm.read.what") : c.kind === "send" ? t("tm.send.what", { name: revealHidden(c.program.name) }) : c.kind === "open" ? t("tm.open.what", { agent: c.agentLabel }) : t("tm.letIn.what")}</div>
                <div className="tm-row">
                  <button type="button" className="st-btn" onClick={() => onAnswer(c, false)} data-testid="tm-no">
                    {w.no}
                  </button>
                  <button type="button" className="st-btn dark" onClick={() => onAnswer(c, true)} data-testid="tm-yes">
                    {w.yes}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function McpCards() {
  const { cards } = useMcp();
  return (
    <McpCardsView
      cards={cards}
      onAnswer={(c, yes) => void (c.kind === "letIn" ? getMcp().letIn(c.id, yes) : getMcp().answer(c.id, yes))}
      onDismiss={(id) => getMcp().dismiss(id)}
    />
  );
}
