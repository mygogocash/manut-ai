// The reach cards (item 102k; `docs/several-agents.md`, "5. What an agent may do to other chats"): what a coding chat's agent asked of
// another chat, shown under its answer. Each shows exactly what would happen, whole: a read shows the text Kit would get (item 97's,
// built with no model), a send shows the words that would go, an open shows the lane's agent, title and brief. Each is one approval
// of the asking chat, settled once through approval-core (`reachAsks.ts`): the no first, so the left-most answer is the safe one,
// then the yes, the card's one black button. Once settled, or once the chat's turn moved on, it collapses to one line.
//
// Buddy's cards on the Connected runtime (item 102l-3, `buddyReach.ts`) are the same cards in Buddy's words: a read of another of the
// shop's conversations, a message sent on to one, and a new conversation with its first message. Each press there is one message to
// the API's chat, billed to the shop's monthly limit, and the card says so in a line of its own before the press.
//
// `ReachCardView` draws from props alone, so a test renders each state; `ReachAskCard` is the timeline's, which presses through the
// sessions store (a coding chat's) or Buddy's reach cards (Connected). A message and a brief are masked as they are shown, and what
// goes is what was shown.
import "./helpers.css";
import "./reach.css";
import { useState } from "react";
import { t, type Key } from "../i18n";
import { maskSecrets, revealHidden } from "../lib/secrets";
import { getSessions } from "../sessions/sessions";
import { getStore } from "../state/store";
import type { ReachAskItem } from "../state/types";
import { TEAM } from "../runtime/http/view";
import { isBuddyAsk, type BuddyAsk, type ReachAsk } from "./reachAsks";
import { rowAgentWords } from "./HelpersCard";
import { folderName } from "../sessions/agents";
import { buddyRefusedWords } from "./buddyReach";
import { getBuddyReach } from "./buddyReachApp";

/** The press refusals the card can say. */
const REFUSALS = ["already_decided", "superseded", "notListed", "gone", "self", "shop", "account", "notCoding", "notRunning", "agent"] as const;

/** The words of a refused press, in the person's language. `buddy`: a refusal of one of Buddy's cards, which has some of its own. */
export function reachRefusedWords(code: string, buddy = false): string {
  const own = buddy ? buddyRefusedWords(code) : null;
  if (own) return own;
  return (REFUSALS as readonly string[]).includes(code) ? t(`reach.refusal.${code}` as Key) : t("reach.refusal.other", { code });
}

/** The card's title: what is asked, naming the chat it would reach. */
export function reachTitle(ask: ReachAsk | BuddyAsk): string {
  const buddy = isBuddyAsk(ask);
  if (ask.kind === "open") return t(buddy ? "reach.buddy.open.ask" : "reach.open.ask");
  return t(ask.kind === "read" ? (buddy ? "reach.buddy.read.ask" : "reach.read.ask") : "reach.send.ask", { title: revealHidden(ask.target.title) });
}

/** The line a settled card collapses to. */
function doneWords(ask: ReachAsk | BuddyAsk, done: NonNullable<ReachAskItem["done"]>): string {
  if (isBuddyAsk(ask)) {
    const title = revealHidden(ask.kind === "open" ? ask.title : ask.target.title);
    const own: Partial<Record<string, Key>> = {
      "read.yes": "reach.buddy.read.yes",
      "read.no": "reach.buddy.read.no",
      "send.yes": "reach.buddy.send.yes",
      "open.yes": "reach.buddy.open.yes",
      "open.no": "reach.buddy.open.no",
      "open.gone": "reach.buddy.open.gone",
    };
    return t(own[`${ask.kind}.${done}`] ?? (`reach.${ask.kind}.${done}` as Key), { title });
  }
  const title = ask.kind === "open" ? revealHidden(ask.lane.title) : revealHidden(ask.target.title);
  return t(`reach.${ask.kind}.${done}` as Key, { title });
}

export interface ReachCardViewProps {
  ask: ReachAsk | BuddyAsk;
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
  /** a started lane's, or a started conversation's, Open */
  onOpenLane?: () => void;
}

/** What one of Buddy's cards shows above its buttons: what would go, whole, a line on what it does, and a line saying the press is one
 *  message billed to the shop's monthly limit. */
function BuddyCardBody({ ask }: { ask: BuddyAsk }) {
  const label = ask.kind === "read" ? "reach.buddy.read.textLabel" : ask.kind === "send" ? "reach.send.textLabel" : "reach.buddy.open.textLabel";
  const text = ask.kind === "read" ? ask.text : ask.kind === "send" ? ask.message : ask.brief;
  const note = ask.kind === "read" ? t("reach.buddy.read.sees") : ask.kind === "send" ? t("reach.buddy.send.note") : t("reach.buddy.open.note", { title: revealHidden(ask.title) });
  const cost = ask.kind === "read" ? "reach.buddy.read.cost" : ask.kind === "send" ? "reach.buddy.send.cost" : "reach.buddy.open.cost";
  return (
    <>
      {/* exactly what goes: item 97's text as it was built, or Buddy's words masked as they were kept */}
      <div className="hl-brief rc-text" data-testid="reach-text" tabIndex={-1} aria-label={t(label)}>
        {revealHidden(text)}
      </div>
      <p className="hl-lines">{note}</p>
      <p className="hl-lines" data-testid="reach-cost">
        {t(cost)}
      </p>
    </>
  );
}

/** The card from props alone: open with what it would do and its two buttons, or settled into one line. */
export function ReachCardView({ ask, done, failed, busy, error, onYes, onNo, onOpenLane }: ReachCardViewProps) {
  const title = reachTitle(ask);
  const buddy = isBuddyAsk(ask);
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
  const [no, yes]: readonly [Key, Key] =
    ask.kind === "read"
      ? ["reach.read.noBtn", buddy ? "reach.buddy.read.yesBtn" : "reach.read.yesBtn"]
      : ask.kind === "send"
        ? ["reach.send.noBtn", "reach.send.yesBtn"]
        : ["reach.open.noBtn", buddy ? "reach.buddy.open.yesBtn" : "reach.open.yesBtn"];
  const cantStart = ask.kind === "open" && !buddy && !!ask.lane.problem;
  return (
    <div className="card hl-card rc-card" data-testid="reach-card" data-kind={ask.kind} data-buddy={buddy || undefined} role="group" aria-label={title}>
      <div className="card-title">{title}</div>
      {buddy && <BuddyCardBody ask={ask} />}
      {!buddy && ask.kind === "read" && (
        <>
          {/* exactly what Let Kit read sends: item 97's text, already masked and capped as it was built */}
          <div className="hl-brief rc-text" data-testid="reach-text" tabIndex={-1} aria-label={t("reach.read.textLabel")}>
            {revealHidden(ask.text)}
          </div>
          <p className="hl-lines">{t("reach.read.sees")}</p>
        </>
      )}
      {!buddy && ask.kind === "send" && (
        <>
          <div className="hl-brief rc-text" data-testid="reach-text" tabIndex={-1} aria-label={t("reach.send.textLabel")}>
            {revealHidden(maskSecrets(ask.message))}
          </div>
          <p className="hl-lines">{t("reach.send.note")}</p>
        </>
      )}
      {!buddy && ask.kind === "open" && (
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

/** The timeline's card: each press goes to the sessions store (a coding chat's card) or to Buddy's reach cards (one of Buddy's on
 *  Connected), which checks again, settles the card's approval once and reads the asking chat's turn itself. A press that is refused
 *  leaves the card as the store has it and says why under the buttons. */
export function ReachAskCard({ item }: { item: ReachAskItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buddy = isBuddyAsk(item.ask);
  const press = async (yes: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = buddy ? await getBuddyReach().answer(item.ask.asker, item.id, yes) : await getSessions().answerReach(item.ask.asker, item.id, yes);
    setBusy(false);
    if (!r.ok) setError(reachRefusedWords(r.refused, buddy));
  };
  const open = buddy ? (item.thread ? () => void getStore().actions.openThread(TEAM, item.thread!) : undefined) : item.lane ? () => getStore().actions.openSession(item.lane!) : undefined;
  return (
    <ReachCardView
      ask={item.ask}
      done={item.done}
      failed={item.error}
      busy={busy}
      error={error}
      onYes={() => void press(true)}
      onNo={() => void press(false)}
      onOpenLane={open}
    />
  );
}
