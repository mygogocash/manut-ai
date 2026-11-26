import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, isSending, useApiSetup, type ApprovalState, type ApprovalView } from "../api";
import { formatClock, langOf } from "../format";
import { Face, type FaceState } from "../ui/Face";
import { BrandMark, BrokenLinkIcon, CheckIcon, ClockIcon, CloudOffIcon, useColorScheme } from "../ui/marks";
import {
  Loading,
  Notice,
  OWNER_CARD as CARD,
  OWNER_MAIN as MAIN,
  OWNER_TAP as TAP,
  OWNER_TOUCH as TOUCH,
  Pulse,
  whenText,
} from "../ui/owner";
import { ownerStrings, type OwnerStrings } from "./strings";

/// The owner's page, opened from a link in LINE. It shows one request and takes one answer. Approving may
/// first need the shop's one-time consent; once a send has begun, the page polls until it settles.

export const POLL_MS = 2000;

type Phase = "loading" | "loadError" | "invalid" | "linkExpired" | "ready";
type Busy = null | "approve" | "decline" | "consent";

export function ApprovePage({ token, pollMs = POLL_MS }: { token: string; pollMs?: number }) {
  const { api, mode } = useApiSetup();
  const s = ownerStrings();
  const scheme = useColorScheme();
  const [phase, setPhase] = useState<Phase>("loading");
  const [view, setView] = useState<ApprovalView | null>(null);
  const [step, setStep] = useState<"card" | "consent">("card");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [alreadyAnswered, setAlreadyAnswered] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pollAttempt, setPollAttempt] = useState(0);
  // The first press wins. State updates land after a render, so a second tap in the same moment would still
  // see enabled buttons; this ref closes that gap synchronously.
  const inFlight = useRef(false);

  useEffect(() => {
    document.title = s.documentTitle;
  }, [s]);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    api.getApproval(token).then(
      (next) => {
        if (cancelled) return;
        setView(next);
        setPhase("ready");
      },
      (err: unknown) => {
        if (!cancelled) setPhase(phaseOf(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, token, loadAttempt]);

  // While the send is under way, read the request again every two seconds until it settles. A failed read
  // just tries again; a link that stops answering leaves us unsure, and the page says so.
  useEffect(() => {
    if (phase !== "ready" || !view || !isSending(view.state)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.getApproval(token).then(
        (next) => {
          if (!cancelled) setView(next);
        },
        (err: unknown) => {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 404 || err.status === 410)) {
            setView((current) => (current ? { ...current, state: "unknown" } : current));
          } else {
            setPollAttempt((n) => n + 1);
          }
        },
      );
    }, pollMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, token, phase, view, pollAttempt, pollMs]);

  async function sendDecision(approve: boolean): Promise<void> {
    try {
      const next = await api.decide(token, approve);
      setView(next);
      setStep("card");
    } catch (err) {
      await recoverFromDecisionError(err);
    }
  }

  async function recoverFromDecisionError(err: unknown): Promise<void> {
    if (err instanceof ApiError) {
      if (err.status === 409) {
        const decided = err.view ?? (await api.getApproval(token).catch(() => null));
        if (decided) {
          setView(decided);
          setAlreadyAnswered(true);
          setStep("card");
          return;
        }
      }
      if (err.status === 403 && err.code === "consent_required") {
        setView((current) => (current ? { ...current, needsConsent: true } : current));
        setStep("consent");
        setError(s.consentNeeded);
        return;
      }
      if (err.status === 410) return setPhase("linkExpired");
      if (err.status === 404) return setPhase("invalid");
    }
    // The answer may or may not have landed. Ask before letting the owner press again; a second press is safe
    // anyway, because the backend settles a decision once.
    try {
      const current = await api.getApproval(token);
      setView(current);
      setStep("card");
      if (current.state === "proposed") setError(s.decisionFailed);
    } catch {
      setError(s.decisionUnclear);
    }
  }

  async function answer(approve: boolean): Promise<void> {
    if (inFlight.current || !view) return;
    if (approve && view.needsConsent) {
      setError(null);
      setStep("consent");
      return;
    }
    inFlight.current = true;
    setBusy(approve ? "approve" : "decline");
    setError(null);
    try {
      await sendDecision(approve);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  async function allowAndSend(): Promise<void> {
    if (inFlight.current || !view) return;
    inFlight.current = true;
    setBusy("consent");
    setError(null);
    try {
      let consented: ApprovalView;
      try {
        consented = await api.giveConsent(token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 410) setPhase("linkExpired");
        else if (err instanceof ApiError && err.status === 404) setPhase("invalid");
        else setError(s.consentFailed);
        return;
      }
      setView(consented);
      setStep("card");
      setBusy("approve");
      await sendDecision(true);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  let body: ReactNode;
  if (phase === "loading") body = <Loading label={s.loading} />;
  else if (phase === "loadError")
    body = (
      <Notice icon={<CloudOffIcon />} title={s.loadErrorTitle} body={s.loadErrorBody}>
        <button type="button" className="btn" style={TAP} onClick={() => setLoadAttempt((n) => n + 1)}>
          {s.tryAgain}
        </button>
      </Notice>
    );
  else if (phase === "invalid") body = <Notice icon={<BrokenLinkIcon />} title={s.linkInvalidTitle} body={s.linkInvalidBody} />;
  else if (phase === "linkExpired") body = <Notice icon={<ClockIcon />} title={s.linkExpiredTitle} body={s.linkExpiredBody} />;
  else if (view) {
    body = (
      <>
        {alreadyAnswered && view.state !== "proposed" && (
          <div className="banner info" role="status">
            <span className="grow">
              {alreadyAnsweredText(s, view)}
              {approvedStates.has(view.state) ? ` ${s.nothingSentTwice}` : ""}
            </span>
          </div>
        )}
        {view.state === "proposed" && step === "consent" ? (
          <ConsentStep
            s={s}
            view={view}
            busy={busy}
            error={error}
            onAllow={() => void allowAndSend()}
            onNotNow={() => {
              setError(null);
              setStep("card");
            }}
          />
        ) : (
          <StateCard s={s} view={view} busy={busy} error={error} onAnswer={(approve) => void answer(approve)} />
        )}
      </>
    );
  }

  return (
    <div className="r" data-t={scheme} style={{ minHeight: "100vh" }}>
      <main className="col" style={MAIN}>
        <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark />
          <div style={{ minWidth: 0, lineHeight: 1.3 }}>
            <div style={{ fontWeight: 600 }}>{view?.shopName ?? s.brand}</div>
            {view && (
              <div className="mut" style={{ fontSize: 12.5 }}>
                {s.brand}
              </div>
            )}
          </div>
        </header>
        <h1 className="vh">{s.documentTitle}</h1>
        {mode === "fake" && (
          <div className="banner info" role="note">
            <span className="grow">{s.practiceMode}</span>
          </div>
        )}
        <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {body}
        </div>
      </main>
    </div>
  );
}

const approvedStates = new Set<ApprovalState>(["approved", "dispatching", "confirmed", "failed", "unknown"]);

/// The helper who decided, when one did. Anything but a name (an empty string, a stray value) reads as the owner's own
/// decision, which is what the page said before helpers could decide.
function helperOf(view: ApprovalView): string | null {
  return typeof view.decidedByHelper === "string" && view.decidedByHelper.trim() ? view.decidedByHelper : null;
}

function clockOf(s: OwnerStrings, view: ApprovalView): string | null {
  return view.decidedAt ? formatClock(view.decidedAt, s.locale) : null;
}

/// The banner over an outcome the owner's own press did not decide: who did, when known, and when.
function alreadyAnsweredText(s: OwnerStrings, view: ApprovalView): string {
  const helper = helperOf(view);
  return helper
    ? s.alreadyAnsweredBy(helper, approvedStates.has(view.state), clockOf(s, view))
    : s.alreadyAnswered(clockOf(s, view));
}

function phaseOf(err: unknown): Phase {
  if (err instanceof ApiError && err.status === 404) return "invalid";
  if (err instanceof ApiError && err.status === 410) return "linkExpired";
  return "loadError";
}

function Asker({ s, view, face, tag }: { s: OwnerStrings; view: ApprovalView; face: FaceState; tag: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Face name={view.memberName} state={face} />
      <span className="mut" style={{ fontSize: 13 }}>
        {s.memberLine(view.memberName, view.memberRole)}
      </span>
      <span style={{ marginLeft: "auto" }}>{tag}</span>
    </div>
  );
}

function CustomerQuote({ s, view }: { s: OwnerStrings; view: ApprovalView }) {
  return (
    <figure style={{ margin: 0, paddingLeft: 12, borderLeft: "3px solid var(--line)" }}>
      <figcaption className="mut" style={{ fontSize: 12.5, fontWeight: 500 }}>
        {s.customerWrote(view.customerName)}
      </figcaption>
      <blockquote
        lang={langOf(view.customerMessage)}
        style={{ margin: "2px 0 0", fontSize: 15, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {view.customerMessage}
      </blockquote>
    </figure>
  );
}

function ReplyQuote({ label, text }: { label: string; text: string }) {
  return (
    <div style={{ padding: "12px 14px", borderRadius: "var(--rad)", background: "var(--soft)" }}>
      <div className="mut" style={{ fontSize: 12.5, fontWeight: 500 }}>
        {label}
      </div>
      <p
        className="prose"
        lang={langOf(text)}
        data-testid="reply-text"
        style={{ margin: "4px 0 0", fontSize: 16, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {text}
      </p>
    </div>
  );
}

function StateCard({
  s,
  view,
  busy,
  error,
  onAnswer,
}: {
  s: OwnerStrings;
  view: ApprovalView;
  busy: Busy;
  error: string | null;
  onAnswer: (approve: boolean) => void;
}) {
  const customer = view.customerName;
  const reply = <ReplyQuote label={s.replyLabel(view.memberName)} text={view.replyText} />;
  const helper = helperOf(view);
  const clock = clockOf(s, view);
  // Who answered and when. A helper's decision always says so, on every outcome, since the owner did not make it; the
  // owner's own answer keeps the plain time it showed before, on the outcomes that showed one.
  const byHelper = helper ? (
    <p className="hint" style={{ margin: 0 }}>
      {approvedStates.has(view.state) ? s.approvedBy(helper, clock) : s.declinedBy(helper, clock)}
    </p>
  ) : null;
  const answeredAt =
    byHelper ??
    (clock ? (
      <p className="hint" style={{ margin: 0 }}>
        {s.answeredAt(clock)}
      </p>
    ) : null);

  switch (view.state) {
    case "proposed":
      return (
        <article className="box" style={CARD} aria-labelledby="request-title">
          <Asker s={s} view={view} face="ask" tag={<span className="tag">{s.kindLineReply}</span>} />
          <p className="big" id="request-title">
            {s.consequence(customer)}
          </p>
          <CustomerQuote s={s} view={view} />
          {reply}
          {error && (
            <div className="banner err" role="alert">
              <span className="grow">{error}</span>
            </div>
          )}
          <div className="chips">
            <button
              type="button"
              className="btn dark"
              style={{ ...TOUCH, ...(busy === "approve" ? { opacity: 0.75 } : {}) }}
              disabled={busy !== null}
              aria-busy={busy === "approve" ? true : undefined}
              onClick={() => onAnswer(true)}
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
              disabled={busy !== null}
              aria-busy={busy === "decline" ? true : undefined}
              onClick={() => onAnswer(false)}
            >
              {busy === "decline" ? (
                <>
                  <Pulse />
                  {s.declining}
                </>
              ) : (
                s.no
              )}
            </button>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {s.expiresHint(whenText(s, view.expiresAt))}
          </p>
        </article>
      );
    case "approved":
    case "dispatching":
      return (
        <article className="box" style={CARD}>
          <Asker s={s} view={view} face="do" tag={<span className="tag run">{s.sendingTag}</span>} />
          <p className="big">{s.sendingTitle(customer)}</p>
          {reply}
          {byHelper}
          <p className="hint" style={{ margin: 0 }}>
            {s.sendingHint}
          </p>
        </article>
      );
    case "confirmed":
      return (
        <article className="box pop" style={CARD}>
          <Asker
            s={s}
            view={view}
            face="done"
            tag={
              <span className="tag ok">
                <CheckIcon />
                {s.sentTag}
              </span>
            }
          />
          <p className="big">{s.sentTitle(view.memberName, customer)}</p>
          <ReplyQuote label={s.sentLabel} text={view.replyText} />
          {answeredAt}
        </article>
      );
    case "rejected":
      return (
        <article className="box pop" style={CARD}>
          <Asker s={s} view={view} face="idle" tag={<span className="tag">{s.declinedTag}</span>} />
          <p style={{ margin: 0 }}>{helper ? s.helperDeclinedTitle(helper, customer) : s.declinedTitle(customer)}</p>
          {!helper && (
            <p className="hint" style={{ margin: 0 }}>
              {s.declinedHint(view.memberName)}
            </p>
          )}
          {answeredAt}
        </article>
      );
    case "expired":
      return (
        <article className="box" style={CARD}>
          <Asker s={s} view={view} face="idle" tag={<span className="tag">{s.expiredTag}</span>} />
          <p style={{ margin: 0 }}>{s.expiredTitle(view.memberName, customer)}</p>
        </article>
      );
    case "failed":
      return (
        <article className="box" style={CARD}>
          <Asker s={s} view={view} face="stuck" tag={<span className="tag err">{s.failedTag}</span>} />
          <div className="banner err" role="alert">
            <span className="grow">{helper ? s.helperFailedTitle(helper, customer) : s.failedTitle(customer)}</span>
          </div>
          {reply}
          <p className="hint" style={{ margin: 0 }}>
            {s.failedHint(view.memberName)}
          </p>
        </article>
      );
    case "unknown":
      return (
        <article className="box" style={CARD}>
          <Asker s={s} view={view} face="stuck" tag={<span className="tag warn">{s.unknownTag}</span>} />
          <div className="banner warn" role="alert">
            <span className="grow">{s.unknownTitle}</span>
          </div>
          {reply}
          {byHelper}
        </article>
      );
  }
}

function ConsentStep({
  s,
  view,
  busy,
  error,
  onAllow,
  onNotNow,
}: {
  s: OwnerStrings;
  view: ApprovalView;
  busy: Busy;
  error: string | null;
  onAllow: () => void;
  onNotNow: () => void;
}) {
  return (
    <article className="box rise" style={CARD} aria-labelledby="consent-title">
      <h2 className="big" id="consent-title">
        {s.consentTitle(view.shopName)}
      </h2>
      <p style={{ margin: 0 }}>{s.consentIntro(view.memberName, view.shopName)}</p>
      <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
        {s.consentPoints(view.shopName).map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <ReplyQuote label={s.replyLabel(view.memberName)} text={view.replyText} />
      {error && (
        <div className="banner warn" role="alert">
          <span className="grow">{error}</span>
        </div>
      )}
      <div className="chips">
        <button
          type="button"
          className="btn dark"
          style={{ ...TOUCH, ...(busy === "consent" ? { opacity: 0.75 } : {}) }}
          disabled={busy !== null}
          aria-busy={busy === "consent" ? true : undefined}
          onClick={onAllow}
        >
          {busy === "consent" ? (
            <>
              <Pulse />
              {s.consentAllowing}
            </>
          ) : (
            s.consentAllow
          )}
        </button>
        <button type="button" className="btn" style={TOUCH} disabled={busy !== null} onClick={onNotNow}>
          {s.consentNotNow}
        </button>
      </div>
    </article>
  );
}
