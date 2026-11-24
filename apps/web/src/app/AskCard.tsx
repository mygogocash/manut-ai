import { isUnknown, mayDecide, type OptionEffect } from "@manut/approval-core";
import { langOf } from "../format";
import { CheckIcon } from "../ui/marks";
import { OWNER_CARD as CARD, OWNER_TOUCH as TOUCH, Pulse, whenText } from "../ui/owner";
import { answerable, detailOf, type Outcome } from "./asks";
import { whoDecided, type Ask } from "./needs";
import type { AppStrings } from "./strings";

/// One request on the owner's phone, as the phone board draws one: who asks and where, what approving does in one sentence,
/// and the exact words or action it names, then Approve and Decline for someone who may decide it. What a request shows is
/// its own: a LINE reply's text exactly as it will be sent, or the control plane's sentence for a browser write or Ton's
/// books, never words this app makes up. The view uses no hooks, so a test can call it as a plain function.

export type Tone = "ok" | "info" | "warn" | "err";

/// The words a request shows: its tag, what approving it does, and its exact words with what they are.
export function askParts(s: AppStrings, ask: Ask): { tag: string; consequence: string; label: string | null; words: string } {
  const request = ask.approval.record.request;
  const kind = isUnknown(request.kind) ? request.kind.raw : request.kind;
  const detail = detailOf(request);
  const operation = detail.operationType;
  const tag = s.kindTag(kind, operation);
  const consequence = s.consequence(kind, operation);
  if (operation === "line.message.push" && detail.text !== undefined) return { tag, consequence, label: s.replyLabel, words: detail.text };
  if (detail.text !== undefined && detail.text.trim() !== "") return { tag, consequence, label: s.sentenceLabel, words: detail.text };
  if (operation && detail.targetResourceId) return { tag, consequence, label: null, words: s.otherAction(operation, detail.targetResourceId) };
  return { tag, consequence, label: null, words: operation || kind };
}

/// What an outcome says, and how it looks.
export function outcomeWords(s: AppStrings, outcome: Outcome, ask: Ask, now: number = Date.now()): { text: string; tone: Tone } {
  const request = ask.approval.record.request;
  const kind = isUnknown(request.kind) ? request.kind.raw : request.kind;
  const line = detailOf(request).operationType === "line.message.push";
  const when = (ms: number | null) => (ms === null ? null : whenText(s, new Date(ms).toISOString(), now));
  switch (outcome.kind) {
    case "decided":
      if (!outcome.approved) return { text: s.declined, tone: "info" };
      if (outcome.action === "confirmed") return { text: s.sent, tone: "ok" };
      if (outcome.action === "failed") return { text: s.sendFailed(line), tone: "err" };
      if (outcome.action === "unknown") return { text: s.sendUnknown, tone: "warn" };
      return { text: s.sending, tone: "info" };
    case "already": {
      const approved = request.options.some((option) => option.id === outcome.decision.optionId && option.effect === "approve");
      const text = s.already(whoDecided(outcome.decision, ask.shop), approved, when(outcome.decision.decidedAt || null));
      return { text: approved ? `${text} ${s.nothingSentTwice}` : text, tone: "info" };
    }
    case "changed":
      return { text: s.changed, tone: "warn" };
    case "superseded":
      return { text: s.superseded(outcome.reason), tone: "info" };
    case "expired":
      return { text: s.expired(when(outcome.at)), tone: "info" };
    case "not_permitted":
      return { text: `${s.ownerOnly(kind)} ${s.waitsFor(ask.shop.ownerName)}`, tone: "warn" };
    case "not_offered":
      return { text: s.notOffered, tone: "warn" };
    case "consent_required":
      return { text: s.consentRequired(ask.shop.name), tone: "warn" };
    case "switched_off":
      return { text: s.switchedOff, tone: "warn" };
    case "gone":
      return { text: s.gone, tone: "info" };
    case "session_ended":
      return { text: s.shopNotReady, tone: "warn" };
    case "left":
      return { text: s.shopLeft(ask.shop.name, outcome.left.why, when(outcome.left.at)), tone: "err" };
    case "unclear":
      return { text: s.unclear, tone: "warn" };
  }
}

/// How an answered request reads in "Answered lately": who decided and when, or that nobody did in time.
export function answeredWords(s: AppStrings, ask: Ask, now: number = Date.now()): string {
  const standing = ask.approval.standing;
  const when = (ms: number) => whenText(s, new Date(ms).toISOString(), now);
  if (standing.state === "decided") {
    const approved = ask.approval.record.request.options.some((option) =>
      option.id === standing.decision.optionId && option.effect === "approve");
    return s.answeredBy(whoDecided(standing.decision, ask.shop), approved, standing.decision.decidedAt ? when(standing.decision.decidedAt) : null);
  }
  if (standing.state === "expired") return s.ranOut(standing.expiredAt ? when(standing.expiredAt) : null);
  return s.noLongerAsked;
}

export function AskCard({
  s,
  ask,
  outcome,
  busy,
  live,
  waiting = false,
  onAnswer,
  now = Date.now(),
}: {
  s: AppStrings;
  ask: Ask;
  /// What the person's answer came to, once they answered.
  outcome: { outcome: Outcome; tone: Tone; text: string } | null;
  busy: OptionEffect | null;
  /// Whether the card may be answered at all now: false offline, when what it shows may have changed.
  live: boolean;
  /// Another card's answer is on its way: this card's buttons wait for it.
  waiting?: boolean;
  onAnswer: (effect: OptionEffect) => void;
  now?: number;
}) {
  const request = ask.approval.record.request;
  const kind = isUnknown(request.kind) ? request.kind.raw : request.kind;
  const parts = askParts(s, ask);
  // approval-core's own rule for the person's role there; a kind this build does not know is decided by nobody here.
  const known = !isUnknown(request.kind);
  const permitted = !isUnknown(request.kind) && mayDecide(ask.shop.role, request.kind);
  const decides = permitted && answerable(ask.approval) !== null;
  const settled = outcome !== null && outcome.outcome.kind !== "unclear" && outcome.outcome.kind !== "not_offered" &&
    outcome.outcome.kind !== "consent_required" && outcome.outcome.kind !== "switched_off" && outcome.outcome.kind !== "session_ended";
  const offers = decides && live && !settled && outcome?.outcome.kind !== "not_permitted";
  const titleId = `ask-${encodeURIComponent(ask.shop.id)}-${encodeURIComponent(request.id)}`;
  return (
    <article className="box" style={CARD} aria-labelledby={titleId} data-ask={request.id}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="tag">{parts.tag}</span>
        <span className="mut" style={{ fontSize: 13, minWidth: 0, overflowWrap: "anywhere" }}>
          {s.askedIn(ask.shop.name, whenText(s, new Date(request.createdAt).toISOString(), now))}
        </span>
      </div>
      <p className="big" id={titleId}>
        {parts.consequence}
      </p>
      <div style={{ padding: "12px 14px", borderRadius: "var(--rad)", background: "var(--soft)" }}>
        {parts.label && (
          <div className="mut" style={{ fontSize: 12.5, fontWeight: 500 }}>
            {parts.label}
          </div>
        )}
        <p
          className="prose"
          lang={langOf(parts.words)}
          data-testid="ask-words"
          style={{ margin: parts.label ? "4px 0 0" : 0, fontSize: 16, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
        >
          {parts.words}
        </p>
      </div>
      {ask.approval.passedOn && (
        <p className="hint" style={{ margin: 0 }}>
          {s.passedOn(ask.approval.passedOn.name, ask.approval.passedOn.note)}
        </p>
      )}
      {outcome && (
        <div className={`banner ${outcome.tone}`} role={outcome.tone === "err" || outcome.tone === "warn" ? "alert" : "status"}>
          {outcome.tone === "ok" && <CheckIcon />}
          <span className="grow">{outcome.text}</span>
        </div>
      )}
      {!settled && known && !permitted && (
        <div className="banner warn" role="note">
          <span className="grow">{`${s.ownerOnly(kind)} ${s.waitsFor(ask.shop.ownerName)}`}</span>
        </div>
      )}
      {!settled && (!known || (permitted && !decides)) && (
        <p className="hint" style={{ margin: 0 }}>
          {s.outdated}
        </p>
      )}
      {offers && (
        <div className="chips">
          <button
            type="button"
            className="btn dark"
            style={{ ...TOUCH, ...(busy === "approve" ? { opacity: 0.75 } : {}) }}
            disabled={busy !== null || waiting}
            aria-busy={busy === "approve" ? true : undefined}
            onClick={() => onAnswer("approve")}
          >
            {busy === "approve" ? (
              <>
                <Pulse />
                {s.approving}
              </>
            ) : (
              s.approve
            )}
          </button>
          <button
            type="button"
            className="btn"
            style={{ ...TOUCH, ...(busy === "decline" ? { opacity: 0.75 } : {}) }}
            disabled={busy !== null || waiting}
            aria-busy={busy === "decline" ? true : undefined}
            onClick={() => onAnswer("decline")}
          >
            {busy === "decline" ? (
              <>
                <Pulse />
                {s.declining}
              </>
            ) : (
              s.decline
            )}
          </button>
        </div>
      )}
      {!settled && request.expiresAt !== undefined && (
        <p className="hint" style={{ margin: 0 }}>
          {s.expiresHint(whenText(s, new Date(request.expiresAt).toISOString(), now))}
        </p>
      )}
    </article>
  );
}
