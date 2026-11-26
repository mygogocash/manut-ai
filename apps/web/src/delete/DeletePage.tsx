import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, useApiSetup, type DeletionView } from "../api";
import { formatClock } from "../format";
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
import { deleteStrings, type DeleteStrings } from "./strings";

/// The owner's deletion page, opened from a link in LINE, built like the approval page. It asks one thing: may
/// Manut AI delete everything it stores for the shop. It says what goes and that it can't be undone, and takes one
/// answer. The yes is the last step of something that can't be undone, so it is a `btn danger solid`, beside
/// "Keep my data".
///
/// After a yes the backend deletes at once, so the page usually lands straight on "deleted". If the deletion is
/// still under way it reads the request again every two seconds, for a while: a deletion that stopped part way is
/// finished by the Manut AI team, and the page says so, so it never needs to stay open.

export const POLL_MS = 2000;
/// About a minute of reads. The page stops after these and its words already say that Manut AI finishes the job.
export const MAX_POLLS = 30;

type Phase = "loading" | "loadError" | "invalid" | "linkExpired" | "ready";
type Busy = null | "delete" | "keep";

export function DeletePage({
  token,
  pollMs = POLL_MS,
  maxPolls = MAX_POLLS,
}: {
  token: string;
  pollMs?: number;
  maxPolls?: number;
}) {
  const { api, mode } = useApiSetup();
  const s = deleteStrings();
  const scheme = useColorScheme();
  const [phase, setPhase] = useState<Phase>("loading");
  const [view, setView] = useState<DeletionView | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [alreadyAnswered, setAlreadyAnswered] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [polls, setPolls] = useState(0);
  // The first press wins. State updates land after a render, so a second tap in the same moment would still see
  // enabled buttons; this ref closes that gap synchronously.
  const inFlight = useRef(false);

  useEffect(() => {
    document.title = s.documentTitle;
  }, [s]);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    api.getDeletion(token).then(
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

  // While the deletion is under way, read the request again until it is done or the reads run out. A failed read
  // counts as one; the words on the card hold either way.
  useEffect(() => {
    if (phase !== "ready" || view?.state !== "deleting" || polls >= maxPolls) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api.getDeletion(token).then(
        (next) => {
          if (cancelled) return;
          setView(next);
          setPolls((n) => n + 1);
        },
        () => {
          if (!cancelled) setPolls((n) => n + 1);
        },
      );
    }, pollMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, token, phase, view, polls, pollMs, maxPolls]);

  async function recoverFromDecisionError(err: unknown): Promise<void> {
    if (err instanceof ApiError) {
      if (err.status === 409) {
        const decided = err.deletionView ?? (await api.getDeletion(token).catch(() => null));
        if (decided) {
          setView(decided);
          setAlreadyAnswered(true);
          return;
        }
      }
      if (err.status === 410) return setPhase("linkExpired");
      if (err.status === 404) return setPhase("invalid");
    }
    // The answer may or may not have landed. Ask before letting the owner press again; a second press is safe
    // anyway, because the backend settles a decision once.
    try {
      const current = await api.getDeletion(token);
      setView(current);
      if (current.state === "awaiting_owner") setError(s.decisionFailed);
    } catch {
      setError(s.decisionUnclear);
    }
  }

  async function answer(approve: boolean): Promise<void> {
    if (inFlight.current || !view) return;
    inFlight.current = true;
    setBusy(approve ? "delete" : "keep");
    setError(null);
    try {
      setView(await api.decideDeletion(token, approve));
    } catch (err) {
      await recoverFromDecisionError(err);
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
        {alreadyAnswered && view.state !== "awaiting_owner" && (
          <div className="banner info" role="status">
            <span className="grow">{s.alreadyAnswered(view.decidedAt ? formatClock(view.decidedAt, s.locale) : null)}</span>
          </div>
        )}
        <StateCard s={s} view={view} busy={busy} error={error} onAnswer={(approve) => void answer(approve)} />
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

function phaseOf(err: unknown): Phase {
  if (err instanceof ApiError && err.status === 404) return "invalid";
  if (err instanceof ApiError && err.status === 410) return "linkExpired";
  return "loadError";
}

/// What goes, naming only what the shop has: its details always, each count above zero, and the LINE connection
/// when there is one.
function goesList(s: DeleteStrings, view: DeletionView): string[] {
  const { goes } = view;
  return [
    s.goesDetails,
    ...(goes.messages > 0 ? [s.goesMessages(goes.messages)] : []),
    ...(goes.replies > 0 ? [s.goesReplies(goes.replies)] : []),
    ...(goes.payments > 0 ? [s.goesPayments(goes.payments)] : []),
    ...(goes.lineConnected ? [s.goesLine] : []),
  ];
}

function StateCard({
  s,
  view,
  busy,
  error,
  onAnswer,
}: {
  s: DeleteStrings;
  view: DeletionView;
  busy: Busy;
  error: string | null;
  onAnswer: (approve: boolean) => void;
}) {
  const answeredAt = view.decidedAt ? (
    <p className="hint" style={{ margin: 0 }}>
      {s.answeredAt(formatClock(view.decidedAt, s.locale))}
    </p>
  ) : null;

  switch (view.state) {
    case "awaiting_owner":
      return (
        <article className="box" style={CARD} aria-labelledby="delete-title">
          <div>
            <span className="tag">{s.kindTag}</span>
          </div>
          <h2 className="big" id="delete-title" style={{ margin: 0 }}>
            {s.title(view.shopName)}
          </h2>
          <p style={{ margin: 0 }}>{s.intro}</p>
          <div>
            <p style={{ margin: 0, fontWeight: 500 }}>{s.whatGoes}</p>
            <ul style={{ margin: "6px 0 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
              {goesList(s, view).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <p style={{ margin: 0, fontWeight: 500 }}>{s.cantUndo}</p>
          {error && (
            <div className="banner err" role="alert">
              <span className="grow">{error}</span>
            </div>
          )}
          <div className="chips">
            <button
              type="button"
              className="btn danger solid"
              style={{ ...TOUCH, ...(busy === "delete" ? { opacity: 0.75 } : {}) }}
              disabled={busy !== null}
              aria-busy={busy === "delete" ? true : undefined}
              onClick={() => onAnswer(true)}
            >
              {busy === "delete" ? (
                <>
                  <Pulse />
                  {s.deleting}
                </>
              ) : (
                s.deleteAll
              )}
            </button>
            <button
              type="button"
              className="btn"
              style={{ ...TOUCH, ...(busy === "keep" ? { opacity: 0.75 } : {}) }}
              disabled={busy !== null}
              aria-busy={busy === "keep" ? true : undefined}
              onClick={() => onAnswer(false)}
            >
              {busy === "keep" ? (
                <>
                  <Pulse />
                  {s.keeping}
                </>
              ) : (
                s.keep
              )}
            </button>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {s.expiresHint(whenText(s, view.expiresAt))}
          </p>
        </article>
      );
    case "deleting":
      return (
        <article className="box" style={CARD}>
          <div>
            <span className="tag run">{s.deletingTag}</span>
          </div>
          <p className="big" style={{ margin: 0 }}>
            {s.deletingTitle(view.shopName)}
          </p>
          <p className="hint" style={{ margin: 0 }}>
            {s.deletingHint}
          </p>
        </article>
      );
    case "deleted":
      return (
        <article className="box pop" style={CARD}>
          <div>
            <span className="tag ok">
              <CheckIcon />
              {s.deletedTag}
            </span>
          </div>
          <p className="big" style={{ margin: 0 }}>
            {s.deletedTitle(view.shopName)}
          </p>
          <p style={{ margin: 0 }}>{s.deletedBody}</p>
          {answeredAt}
        </article>
      );
    case "declined":
      return (
        <article className="box pop" style={CARD}>
          <div>
            <span className="tag">{s.keptTag}</span>
          </div>
          <p style={{ margin: 0 }}>{s.keptTitle}</p>
          <p className="hint" style={{ margin: 0 }}>
            {s.keptHint}
          </p>
          {answeredAt}
        </article>
      );
    case "expired":
      return (
        <article className="box" style={CARD}>
          <div>
            <span className="tag">{s.expiredTag}</span>
          </div>
          <p style={{ margin: 0 }}>{s.expiredTitle}</p>
          <p className="hint" style={{ margin: 0 }}>
            {s.expiredHint}
          </p>
        </article>
      );
  }
}
