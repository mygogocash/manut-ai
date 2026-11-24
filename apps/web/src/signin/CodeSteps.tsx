import type { FormEvent } from "react";
import { CODE_LENGTH, normalizeEmail } from "../api/email";
import { PRACTICE_SIGN_IN_CODE } from "../api/fake";
import { maskEmail, waitText, waitWords } from "../join/code";
import type { JoinStrings } from "../join/strings";
import { OWNER_CARD as CARD, Pulse } from "../ui/owner";
import type { CodeSignIn } from "./useCodeSignIn";

/// The two steps of signing in with a code sent by email, as the canvas draws them ("States: sign-in, files and forms"):
/// the address, then the code. The join page and the owner's app show them alike; each gives the first step its own
/// title and words, and its own ids for the titles and fields.

export function EmailStep({
  s,
  flow,
  title,
  body,
  titleId,
  idPrefix,
}: {
  s: JoinStrings;
  flow: CodeSignIn;
  title: string;
  body: string;
  titleId: string;
  idPrefix: string;
}) {
  const busy = flow.busy === "send";
  const ready = normalizeEmail(flow.email) !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void flow.sendCode();
  };
  return (
    <article className="box" style={CARD} aria-labelledby={titleId}>
      <h2 className="big" id={titleId}>
        {title}
      </h2>
      <p style={{ margin: 0 }}>{body}</p>
      {flow.note && (
        <div className="banner warn" role="status">
          <span className="grow">{flow.note}</span>
        </div>
      )}
      <form noValidate onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label htmlFor={`${idPrefix}-email`}>{s.emailLabel}</label>
          <input
            id={`${idPrefix}-email`}
            className="input"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={flow.email}
            // Read-only rather than disabled while the code is asked for, so the field keeps its focus and a phone its
            // keyboard.
            readOnly={busy}
            aria-invalid={flow.emailError ? true : undefined}
            aria-describedby={`${idPrefix}-email-help`}
            onChange={(event) => flow.typeEmail(event.target.value)}
            // 16px keeps a phone from zooming in on the field.
            style={{ fontSize: 16 }}
          />
          {flow.emailError ? (
            <span key="error" id={`${idPrefix}-email-help`} className="help err" role="alert">
              {flow.emailError}
            </span>
          ) : (
            <span key="help" id={`${idPrefix}-email-help`} className="help">
              {s.emailHelp}
            </span>
          )}
        </div>
        <button
          type="submit"
          className="btn dark"
          style={{ minHeight: 44, ...(busy ? { opacity: 0.75 } : {}) }}
          disabled={!ready || busy}
          aria-busy={busy || undefined}
        >
          {busy ? (
            <>
              <Pulse />
              {s.sendingCode}
            </>
          ) : (
            s.sendCode
          )}
        </button>
      </form>
    </article>
  );
}

export function CodeStep({
  s,
  flow,
  practice,
  titleId,
  idPrefix,
}: {
  s: JoinStrings;
  flow: CodeSignIn;
  practice: boolean;
  titleId: string;
  idPrefix: string;
}) {
  if (flow.step.name !== "code") return null;
  const { sentTo, life } = flow.step;
  const { busy, code, codeError: error, notice, waitLeft } = flow;
  const ended = error?.ended ?? false;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void flow.signIn();
  };
  // A timer, so the page's live region does not read the count out every second.
  const waiting = waitLeft > 0 ? (
    <p className="hint" role="timer" aria-live="off" style={{ margin: 0 }}>
      {s.resendIn(waitText(waitLeft, s))}
    </p>
  ) : null;
  return (
    <article className="box rise" style={CARD} aria-labelledby={titleId}>
      <h2 className="big" id={titleId}>
        {s.codeTitle}
      </h2>
      <p style={{ margin: 0 }}>{s.codeSentTo(maskEmail(sentTo), waitWords(life, s))}</p>
      {practice && (
        <div className="banner info" role="note">
          <span className="grow">{s.practiceCode(PRACTICE_SIGN_IN_CODE)}</span>
        </div>
      )}
      {notice && (
        <div className="banner info" role="status">
          <span className="grow">{notice}</span>
        </div>
      )}
      <form noValidate onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label htmlFor={`${idPrefix}-code`}>{s.codeLabel}</label>
          <input
            id={`${idPrefix}-code`}
            className="input mono"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            // Read-only rather than disabled while waiting, so after a wrong code the box still has the focus to fix a digit.
            readOnly={busy !== null}
            aria-invalid={error?.invalid ? true : undefined}
            aria-describedby={error ? `${idPrefix}-code-error` : undefined}
            onChange={(event) => flow.typeCode(event.target.value)}
            style={{ fontSize: 16, letterSpacing: ".3em" }}
          />
          {error && (
            <span id={`${idPrefix}-code-error`} className="help err" role="alert">
              {error.text}
            </span>
          )}
        </div>
        {ended ? (
          <button
            type="button"
            className="btn dark"
            style={{ minHeight: 44, ...(busy === "resend" ? { opacity: 0.75 } : {}) }}
            disabled={busy !== null || waitLeft > 0}
            aria-busy={busy === "resend" || undefined}
            onClick={() => void flow.resend()}
          >
            {busy === "resend" ? (
              <>
                <Pulse />
                {s.resending}
              </>
            ) : (
              s.resend
            )}
          </button>
        ) : (
          <button
            type="submit"
            className="btn dark"
            style={{ minHeight: 44, ...(busy === "signIn" ? { opacity: 0.75 } : {}) }}
            disabled={busy !== null || code.length !== CODE_LENGTH}
            aria-busy={busy === "signIn" || undefined}
          >
            {busy === "signIn" ? (
              <>
                <Pulse />
                {s.signingIn}
              </>
            ) : (
              s.signIn
            )}
          </button>
        )}
      </form>
      {waiting ??
        (!ended && (
          <div>
            <button type="button" className="lk" disabled={busy !== null} onClick={() => void flow.resend()}>
              {busy === "resend" ? s.resending : s.resend}
            </button>
          </div>
        ))}
      <div>
        <button type="button" className="lk" disabled={busy !== null} onClick={flow.anotherEmail}>
          {s.anotherEmail}
        </button>
      </div>
    </article>
  );
}
