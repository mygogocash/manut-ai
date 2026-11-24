import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, useApiSetup, type JoinAnswer } from "../api";
import { CODE_LENGTH, normalizeEmail } from "../api/email";
import { PRACTICE_SIGN_IN_CODE } from "../api/fake";
import { BrandMark, BrokenLinkIcon, CheckIcon, ClockIcon, CloudOffIcon, PeopleIcon, useColorScheme } from "../ui/marks";
import { Loading, Notice, OWNER_CARD as CARD, Pulse } from "../ui/owner";
import { codeFrom, maskEmail, visitDeviceId, waitText, waitWords } from "./code";
import { joinStrings, type JoinStrings } from "./strings";

/// The page an invite link opens (`/join/{token}`, docs/people.md, "Invites"). The person signs in with a code sent to
/// their email, the page accepts the invite with that sign-in, and it says what the answer means and what comes next.
///
/// The first screen cannot name the shop: the API names it, and its owner, only to a signed-in accept, and never the
/// account an invite is for. So it says that someone invited the person to help, and asks them to sign in with the
/// address the invite went to.
///
/// What the page holds, it holds in memory for this visit only: the sign-in's access token lives in a ref, never in
/// `localStorage`, `sessionStorage`, a cookie or a URL, and a reload means signing in again (a web session that lasts is
/// December item 17's to design). Once the invite has its answer the page has no more use for the sign-in, or for the
/// helper session a join gives (the web has no helper screens yet), so it ends both at once and forgets them.
///
/// The invite token stays in the page's own path and goes in one place only: the accept's body. The page loads nothing
/// from another origin (App.tsx loads the brand's fonts on every other page) and sends no Referer (index.html and the
/// pages Worker both set `no-referrer`).

type Busy = null | "send" | "signIn" | "resend";

/// An answer as the page keeps it: a join without the helper session it carried, which the page ends at once.
type ShownAnswer = Exclude<JoinAnswer, { answer: "joined" }> | Omit<Extract<JoinAnswer, { answer: "joined" }>, "session">;

type Step =
  | { name: "email" }
  /// A code went to `sentTo`; `life` is how many seconds it works.
  | { name: "code"; sentTo: string; life: number }
  /// Signed in as `email`, and the accept is on its way, or did not get an answer.
  | { name: "joining"; email: string }
  | { name: "joinError"; email: string }
  /// Signing in by email is off (`email_not_configured`).
  | { name: "off" }
  | { name: "answered"; answer: ShownAnswer; email: string };

/// What the line under the code box says. `invalid` marks the box itself; `ended` means the code can no longer be tried,
/// so the page offers a new one instead of Sign in.
type CodeError = { text: string; invalid: boolean; ended: boolean };

/// The sign-in this visit made: the address it is for, and the access token the accept is sent with.
type HeldSignIn = { email: string; accessToken: string };

export function JoinPage({ token }: { token: string }) {
  const { api, mode } = useApiSetup();
  const s = joinStrings();
  const scheme = useColorScheme();
  const [step, setStep] = useState<Step>({ name: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<CodeError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [deviceId] = useState(visitDeviceId);
  const held = useRef<HeldSignIn | null>(null);
  // The first press wins. State lands after a render, so a second press in the same moment would still see an enabled
  // button; this ref closes that gap synchronously, as the owner's approval page does.
  const inFlight = useRef(false);

  useEffect(() => {
    document.title = s.documentTitle;
  }, [s]);

  // Leaving the page while signed in ends the sign-in: nothing else would ever use it.
  useEffect(
    () => () => {
      const session = held.current;
      held.current = null;
      if (session) void api.signOut(session.accessToken).catch(() => undefined);
    },
    [api],
  );

  // The wait before a new code may be asked for counts down each second, from when the API's answer arrived.
  useEffect(() => {
    if (resendAt === null) return;
    setNowMs(Date.now());
    const timer = setInterval(() => {
      const at = Date.now();
      setNowMs(at);
      if (at >= resendAt) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendAt]);
  const waitLeft = resendAt === null ? 0 : Math.max(0, Math.ceil((resendAt - nowMs) / 1000));

  /// A wait the API asked for, counted from now: the clock and the end move together, so the first count is the API's.
  function startWait(seconds: number): void {
    const at = Date.now();
    setNowMs(at);
    setResendAt(at + seconds * 1000);
  }

  async function once(kind: Busy, work: () => Promise<void>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function sendCode(): Promise<void> {
    const address = normalizeEmail(email);
    if (!address) return Promise.resolve();
    return once("send", async () => {
      setEmailError(null);
      setNote(null);
      try {
        const sent = await api.requestEmailCode(address);
        setCode("");
        setCodeError(null);
        setNotice(null);
        startWait(sent.resendIn);
        setStep({ name: "code", sentTo: address, life: sent.expiresIn });
      } catch (err) {
        if (isOff(err)) setStep({ name: "off" });
        else setEmailError(sendFailure(s, err));
      }
    });
  }

  function resend(): Promise<void> {
    if (step.name !== "code") return Promise.resolve();
    const address = step.sentTo;
    return once("resend", async () => {
      setNotice(null);
      try {
        const sent = await api.requestEmailCode(address);
        // A new code replaces the one before, so the box empties and the old answer goes with it.
        setCode("");
        setCodeError(null);
        setNotice(s.newCodeSent);
        startWait(sent.resendIn);
        setStep({ name: "code", sentTo: address, life: sent.expiresIn });
      } catch (err) {
        if (isOff(err)) return setStep({ name: "off" });
        if (err instanceof ApiError && err.code === "too_many_codes" && err.retryAfter !== undefined) {
          startWait(err.retryAfter);
        }
        setCodeError((current) => ({ text: sendFailure(s, err), invalid: false, ended: current?.ended ?? false }));
      }
    });
  }

  function signIn(typed: string = code): Promise<void> {
    if (step.name !== "code" || typed.length !== CODE_LENGTH || codeError?.ended) return Promise.resolve();
    const address = step.sentTo;
    return once("signIn", async () => {
      setCodeError(null);
      setNotice(null);
      try {
        const session = await api.exchangeEmailCode({ email: address, code: typed, deviceId });
        held.current = { email: address, accessToken: session.accessToken };
      } catch (err) {
        if (isOff(err)) setStep({ name: "off" });
        else setCodeError(codeFailure(s, err));
        return;
      }
      // The code is used up: it is never kept once it has signed someone in.
      setCode("");
    }).then(() => (held.current ? accept() : undefined));
  }

  async function accept(): Promise<void> {
    const session = held.current;
    if (!session || inFlight.current) return;
    inFlight.current = true;
    setStep({ name: "joining", email: session.email });
    try {
      finish(await api.acceptInvite({ accessToken: session.accessToken, inviteToken: token }), session);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The sign-in ended before the invite was answered (its hour passed, or it was ended elsewhere): forget it.
        held.current = null;
        setNote(s.sessionEnded);
        setStep({ name: "email" });
      } else {
        setStep({ name: "joinError", email: session.email });
      }
    } finally {
      inFlight.current = false;
    }
  }

  /// The invite has its answer, so the page ends the sign-in, and the helper session a join gave, and forgets both.
  /// Ending is best effort: one that fails leaves a session nobody holds, to run out by itself.
  function finish(answer: JoinAnswer, session: HeldSignIn): void {
    held.current = null;
    void api.signOut(session.accessToken).catch(() => undefined);
    if (answer.answer === "joined") {
      void api.endShopSession(answer.session.accessToken).catch(() => undefined);
      setStep({ name: "answered", answer: { answer: "joined", shop: answer.shop, helper: answer.helper }, email: session.email });
    } else {
      setStep({ name: "answered", answer, email: session.email });
    }
  }

  /// Switch account: whatever sign-in the page still holds is ended and forgotten, and the person signs in again.
  function switchAccount(): void {
    const session = held.current;
    held.current = null;
    if (session) void api.signOut(session.accessToken).catch(() => undefined);
    setCode("");
    setCodeError(null);
    setNotice(null);
    setEmailError(null);
    setNote(null);
    setStep({ name: "email" });
  }

  function anotherEmail(): void {
    setCode("");
    setCodeError(null);
    setNotice(null);
    setStep({ name: "email" });
  }

  /// Typing or pasting in the code box. The sixth digit signs in with no extra press, as the canvas has it; a box that was
  /// already full and is changed waits for Sign in, so fixing one digit never spends a try by surprise.
  function typeCode(text: string): void {
    const next = codeFrom(text);
    const completed = next.length === CODE_LENGTH && code.length !== CODE_LENGTH;
    setCode(next);
    if (next !== code) setCodeError((current) => (current?.ended ? current : null));
    if (completed && !codeError?.ended) void signIn(next);
  }

  let body: ReactNode;
  switch (step.name) {
    case "email":
      body = (
        <EmailStep
          s={s}
          email={email}
          error={emailError}
          note={note}
          busy={busy === "send"}
          onEmail={(text) => {
            setEmail(text);
            setEmailError(null);
          }}
          onSend={() => void sendCode()}
        />
      );
      break;
    case "code":
      body = (
        <CodeStep
          s={s}
          practice={mode === "fake"}
          sentTo={step.sentTo}
          life={step.life}
          code={code}
          busy={busy}
          error={codeError}
          notice={notice}
          waitLeft={waitLeft}
          onCode={typeCode}
          onSignIn={() => void signIn()}
          onResend={() => void resend()}
          onAnotherEmail={anotherEmail}
        />
      );
      break;
    case "joining":
      body = (
        <>
          <SignedIn s={s} email={step.email} />
          <Loading label={s.joining} />
        </>
      );
      break;
    case "joinError":
      body = (
        <>
          <SignedIn s={s} email={step.email} />
          <Notice icon={<CloudOffIcon />} title={s.joinFailedTitle} body={s.joinFailed}>
            <button type="button" className="btn" style={{ minHeight: 44 }} onClick={() => void accept()}>
              {s.tryAgain}
            </button>
          </Notice>
        </>
      );
      break;
    case "off":
      body = <Notice icon={<CloudOffIcon />} title={s.offTitle} body={s.offBody} />;
      break;
    case "answered":
      body = <Answer s={s} answer={step.answer} email={step.email} onSwitch={switchAccount} />;
      break;
  }

  const shopName = step.name === "answered" && "shop" in step.answer ? step.answer.shop.name : null;
  return (
    <div className="r" data-t={scheme} style={{ minHeight: "100vh" }}>
      <main className="col" style={{ maxWidth: 560, padding: "16px 16px 40px", gap: 16 }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark />
          <div style={{ minWidth: 0, lineHeight: 1.3 }}>
            <div style={{ fontWeight: 600 }}>{shopName ?? s.brand}</div>
            {shopName && (
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

function isOff(err: unknown): boolean {
  return err instanceof ApiError && err.code === "email_not_configured";
}

/// What a refusal of asking for a code says. Only the API's own codes have words of their own; anything else is the
/// API not answering as it should, said plainly.
export function sendFailure(s: JoinStrings, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return s.offline;
    if (err.code === "too_many_codes") return s.tooManyCodes(waitWords(err.retryAfter ?? 60, s));
    if (err.code === "rate_limited") return s.tooManyTries(waitWords(err.retryAfter ?? 60, s));
    if (err.code === "invalid_request") return s.badAddress;
  }
  return s.failed;
}

/// What a refusal of a code says, whether it is the code's fault, and whether the code has ended.
export function codeFailure(s: JoinStrings, err: unknown): CodeError {
  if (err instanceof ApiError) {
    if (err.status === 0) return { text: s.offline, invalid: false, ended: false };
    if (err.code === "wrong_code") {
      const left = err.triesLeft ?? null;
      return { text: s.wrongCode(left), invalid: true, ended: left !== null && left <= 0 };
    }
    if (err.code === "code_ended") return { text: s.codeEnded, invalid: true, ended: true };
    if (err.code === "rate_limited") return { text: s.tooManyTries(waitWords(err.retryAfter ?? 60, s)), invalid: false, ended: false };
    if (err.code === "invalid_request") return { text: s.badCode, invalid: true, ended: false };
  }
  return { text: s.failed, invalid: false, ended: false };
}

function SignedIn({ s, email }: { s: JoinStrings; email: string }) {
  return (
    <div className="banner ok" role="status">
      <span className="grow">{s.signedInAs(email)}</span>
    </div>
  );
}

function EmailStep({
  s,
  email,
  error,
  note,
  busy,
  onEmail,
  onSend,
}: {
  s: JoinStrings;
  email: string;
  error: string | null;
  note: string | null;
  busy: boolean;
  onEmail: (text: string) => void;
  onSend: () => void;
}) {
  const ready = normalizeEmail(email) !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSend();
  };
  return (
    <article className="box" style={CARD} aria-labelledby="invite-title">
      <h2 className="big" id="invite-title">
        {s.inviteTitle}
      </h2>
      <p style={{ margin: 0 }}>{s.inviteBody}</p>
      {note && (
        <div className="banner warn" role="status">
          <span className="grow">{note}</span>
        </div>
      )}
      <form noValidate onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="field">
          <label htmlFor="join-email">{s.emailLabel}</label>
          <input
            id="join-email"
            className="input"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            disabled={busy}
            aria-invalid={error ? true : undefined}
            aria-describedby="join-email-help"
            onChange={(event) => onEmail(event.target.value)}
            // 16px keeps a phone from zooming in on the field.
            style={{ fontSize: 16 }}
          />
          {error ? (
            <span key="error" id="join-email-help" className="help err" role="alert">
              {error}
            </span>
          ) : (
            <span key="help" id="join-email-help" className="help">
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

function CodeStep({
  s,
  practice,
  sentTo,
  life,
  code,
  busy,
  error,
  notice,
  waitLeft,
  onCode,
  onSignIn,
  onResend,
  onAnotherEmail,
}: {
  s: JoinStrings;
  practice: boolean;
  sentTo: string;
  life: number;
  code: string;
  busy: Busy;
  error: CodeError | null;
  notice: string | null;
  waitLeft: number;
  onCode: (text: string) => void;
  onSignIn: () => void;
  onResend: () => void;
  onAnotherEmail: () => void;
}) {
  const ended = error?.ended ?? false;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSignIn();
  };
  const waiting = waitLeft > 0 ? (
    <p className="hint" style={{ margin: 0 }}>
      {s.resendIn(waitText(waitLeft, s))}
    </p>
  ) : null;
  return (
    <article className="box rise" style={CARD} aria-labelledby="code-title">
      <h2 className="big" id="code-title">
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
          <label htmlFor="join-code">{s.codeLabel}</label>
          <input
            id="join-code"
            className="input mono"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            disabled={busy !== null}
            aria-invalid={error?.invalid ? true : undefined}
            aria-describedby={error ? "join-code-error" : undefined}
            onChange={(event) => onCode(event.target.value)}
            style={{ fontSize: 16, letterSpacing: ".3em" }}
          />
          {error && (
            <span id="join-code-error" className="help err" role="alert">
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
            onClick={onResend}
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
            <button type="button" className="lk" disabled={busy !== null} onClick={onResend}>
              {busy === "resend" ? s.resending : s.resend}
            </button>
          </div>
        ))}
      <div>
        <button type="button" className="lk" disabled={busy !== null} onClick={onAnotherEmail}>
          {s.anotherEmail}
        </button>
      </div>
    </article>
  );
}

function Answer({ s, answer, email, onSwitch }: { s: JoinStrings; answer: ShownAnswer; email: string; onSwitch: () => void }) {
  switch (answer.answer) {
    case "joined":
      return (
        <article className="box pop" style={CARD} aria-labelledby="joined-title">
          <div>
            <span className="tag ok">
              <CheckIcon />
              {s.joinedTag}
            </span>
          </div>
          <h2 className="big" id="joined-title">
            {s.joinedTitle(answer.shop.name)}
          </h2>
          <p style={{ margin: 0 }}>{s.joinedBody(answer.shop.ownerName)}</p>
          <h3 style={{ margin: "4px 0 0", fontSize: 15, fontWeight: 600 }}>{s.nextTitle}</h3>
          <p style={{ margin: 0 }}>{s.nextBody(email, answer.shop.name)}</p>
          <p className="hint" style={{ margin: 0 }}>
            {s.joinedHint}
          </p>
        </article>
      );
    case "wrong_account": {
      const line = answer.invitedOn === "line";
      return (
        <section style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-label={s.switchAccount}>
          <div className="banner warn" role="alert">
            <span className="grow">
              {line ? s.wrongLineTitle(answer.shop.name, email) : s.wrongEmailTitle(answer.shop.name, email)}
            </span>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            {line ? s.wrongLineHint(answer.shop.ownerName) : s.wrongEmailHint(answer.shop.ownerName)}
          </p>
          <div>
            <button type="button" className="btn" style={{ minHeight: 44 }} onClick={onSwitch}>
              {s.switchAccount}
            </button>
          </div>
        </section>
      );
    }
    case "expired":
      return <Notice icon={<ClockIcon />} title={s.expiredTitle} body={s.expiredBody} />;
    case "revoked":
      return <Notice icon={<BrokenLinkIcon />} title={s.revokedTitle} body={s.revokedBody} />;
    case "already_used":
      return <Notice icon={<PeopleIcon />} title={s.usedTitle} body={s.usedBody} />;
    case "unknown":
      return <Notice icon={<BrokenLinkIcon />} title={s.unknownTitle} body={s.unknownBody} />;
  }
}
