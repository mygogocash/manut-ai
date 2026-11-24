// Settings › Developer › Sign in by email: type an address, Send code, type the six digits, Sign in, and Send a new code
// once the API's wait has passed, with the time shown (docs/sign-in-options.md, "The desktop"). The rules, and what each
// answer does to the screen, are in emailFlow.ts; this file draws them in words.
//
// `EmailSignInView` draws a given state and uses no hooks, so a test calls it as a plain function and reads the
// handlers a render to a string leaves out (EmailSignIn.test.tsx). `EmailSignIn` is the part with hooks: it owns the
// flow, ticks the clock while a wait runs, and moves the focus where the next thing to type is.
//
// Two flavours share it. With an origin, it asks that API through its session, and a real sign-in replaces the whole
// section with the signed-in row (DeveloperPage.tsx). With none, which is Practice, it asks `practiceBackend`, which has
// no network in it, says a pretend code aloud, and "signs in" only on this screen: nothing is sent and nothing is kept.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type Ref, type RefObject } from "react";
import { t, type Key } from "../i18n";
import { holdImeEnter } from "../lib/ime";
import { sessionFor } from "../runtime/http";
import { Row } from "./DevRow";
import {
  countdown,
  EmailFlow,
  FAILURE_KEY,
  practiceBackend,
  secondsLeft,
  span,
  type EmailFlowState,
  type Notice,
} from "./emailFlow";

export interface EmailSignInViewProps {
  state: EmailFlowState;
  /** the time now, which counts a wait down (ms since the epoch) */
  now: number;
  /** Practice's pretend flow: says so, and what it does */
  practice: boolean;
  /** another sign-in (Apple's) is running, so none may start here */
  held: boolean;
  formRef?: Ref<HTMLFormElement>;
  onEmail: (text: string) => void;
  onCode: (text: string) => void;
  onSend: () => void;
  onSignIn: () => void;
  onAnother: () => void;
}

/** A wait in the words a person says it in: "1 minute", "10 minutes", "2 hours". */
function spanText(seconds: number): string {
  const { unit, n } = span(seconds);
  const key: Key = unit === "minute" ? (n === 1 ? "dev.mail.min.one" : "dev.mail.min.many") : n === 1 ? "dev.mail.hour.one" : "dev.mail.hour.many";
  return t(key, { n });
}

/** The words of a notice, and whether it is something that went wrong. */
export function noticeWords(n: Notice): { text: string; error: boolean } {
  switch (n.kind) {
    case "sent":
      return { text: t("dev.mail.sent", { time: spanText(n.life) }), error: false };
    case "practice":
      return { text: t("dev.mail.practiceCode", { code: n.code }), error: false };
    case "wrong":
      if (n.triesLeft === 0) return { text: t("dev.mail.wrongLast"), error: true };
      return { text: n.triesLeft === 1 ? t("dev.mail.wrong.one") : t("dev.mail.wrong.many", { n: n.triesLeft }), error: true };
    case "ended":
      return { text: t("dev.mail.ended"), error: true };
    case "wait":
      return { text: t("dev.mail.wait", { time: spanText(n.retryAfter) }), error: true };
    case "badAddress":
      return { text: t("dev.mail.badAddress"), error: true };
    case "failed": {
      const key = FAILURE_KEY[n.failure];
      return { text: key ? t(key) : "", error: true };
    }
  }
}

/** The label of the button that asks for a code: it says what it does, and while a wait runs it counts the wait down. */
function sendLabel(s: EmailFlowState, left: number): string {
  if (s.busy === "sending") return t("dev.mail.sending");
  if (left > 0) return t(s.step === "code" ? "dev.mail.againIn" : "dev.mail.sendIn", { time: countdown(left) });
  return t(s.step === "code" ? "dev.mail.again" : "dev.mail.send");
}

export function EmailSignInView(p: EmailSignInViewProps) {
  const s = p.state;
  if (s.step === "done" && !p.practice) return null;
  const left = secondsLeft(s, p.now);
  const idle = !p.held && s.busy === null;
  // A line about too many codes is about a wait, so once the wait is over it is no longer true and goes.
  const notice = s.notice && !(s.notice.kind === "wait" && left <= 0) ? noticeWords(s.notice) : null;
  const note = notice && notice.text ? notice : null;
  const describe = note ? "dev-email-note" : undefined;
  return (
    <form
      className="dev-mail"
      ref={p.formRef}
      noValidate
      aria-label={t("dev.mail.title")}
      data-testid="dev-email"
      data-step={s.step}
      onSubmit={(e) => {
        e.preventDefault();
        if (s.step === "email") p.onSend();
        else if (s.step === "code") p.onSignIn();
      }}
      // Enter that only commits what an input method is composing is not a press of the form's button.
      onKeyDown={holdImeEnter}
    >
      {p.practice && <Row hint={t("dev.mail.practice")} />}
      {s.step === "email" && (
        <Row title={t("dev.mail.email")} hint={t("dev.mail.hint")}>
          <span className="st-pair">
            <input
              type="email"
              className="dev-in dev-addr"
              value={s.email}
              onChange={(e) => p.onEmail(e.target.value)}
              placeholder={t("dev.mail.emailPh")}
              aria-label={t("dev.mail.email")}
              aria-describedby={describe}
              aria-invalid={s.notice?.kind === "badAddress" || undefined}
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              data-testid="dev-email-address"
            />
            <button type="submit" className="st-btn" disabled={!idle || left > 0} data-testid="dev-email-send">
              {sendLabel(s, left)}
            </button>
          </span>
        </Row>
      )}
      {s.step === "code" && (
        <>
          <Row title={t("dev.mail.code")} hint={t("dev.mail.codeHint", { email: s.sentTo ?? "" })}>
            <span className="st-pair">
              {/* One box that takes six digits: typed, pasted, or filled in by the system's one-time-code autofill, which
                  gives it all at once. A paste of the whole email line works too (emailFlow.ts `codeFrom`). */}
              <input
                type="text"
                className="dev-in dev-code"
                value={s.code}
                onChange={(e) => p.onCode(e.target.value)}
                onPaste={(e) => {
                  e.preventDefault();
                  p.onCode(e.clipboardData.getData("text"));
                }}
                aria-label={t("dev.mail.code")}
                aria-describedby={describe}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                data-testid="dev-email-code"
              />
              <button type="submit" className="st-btn" disabled={!idle || !s.live || s.code.length !== 6} data-testid="dev-email-sign-in">
                {s.busy === "checking" ? t("dev.signingIn") : t("dev.signIn")}
              </button>
            </span>
          </Row>
        </>
      )}
      {s.step === "done" && (
        <Row title={t("dev.mail.practiceIn")} hint={t("dev.mail.practiceInHint", { email: s.sentTo ?? "" })}>
          <button type="button" className="st-btn" onClick={p.onAnother} data-testid="dev-email-out">
            {t("dev.signOut")}
          </button>
        </Row>
      )}
      {note && (
        <div className="st-row">
          <div className="st-k">
            <span id="dev-email-note" className={note.error ? "dev-err" : undefined} role={note.error ? "alert" : "status"} data-testid="dev-email-notice">
              {note.text}
            </span>
          </div>
        </div>
      )}
      {s.step === "code" && (
        <Row>
          <span className="st-pair">
            <button type="button" className="st-btn" disabled={!idle || left > 0} onClick={p.onSend} data-testid="dev-email-again">
              {sendLabel(s, left)}
            </button>
            <button type="button" className="st-btn" onClick={p.onAnother} data-testid="dev-email-another">
              {t("dev.mail.another")}
            </button>
          </span>
        </Row>
      )}
    </form>
  );
}

/** The time now, ticking once a second while a wait is running (until `until`, ms since the epoch), and still otherwise.
 *  The clock is read again before the screen is painted when a wait starts, so a wait that has just begun is never shown
 *  longer than it is for the one frame the clock of a minute ago would give. */
function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useLayoutEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    if (Date.now() >= until) return;
    const id = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [until]);
  return now;
}

/** Puts the keyboard where the next thing to type is: the code box once a code is on its way and again after each try
 *  that did not sign in, and the Email box when the person goes back or an ask for a code did not go through. Only when
 *  the flow moves, never when the section first appears, so it takes nothing from whatever the person was doing. */
function useFocusMoves(form: RefObject<HTMLFormElement | null>, s: EmailFlowState): void {
  const before = useRef(s);
  useEffect(() => {
    const was = before.current;
    before.current = s;
    const root = form.current;
    if (!root || was === s) return;
    const box = (id: string) => root.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);
    if (s.step === "code" && s.busy === null && (was.step !== "code" || was.busy !== null)) box("dev-email-code")?.focus();
    else if (s.step === "email" && s.busy === null && (was.step !== "email" || was.busy === "sending")) box("dev-email-address")?.focus();
  }, [form, s]);
}

/** The origin is the saved API's (a real sign-in through its session) or null (Practice). `held` is another sign-in running. */
export function EmailSignIn({ origin, held }: { origin: string | null; held: boolean }) {
  const practice = origin === null;
  const [flow] = useState(() => new EmailFlow({ backend: origin === null ? practiceBackend() : sessionFor(origin), practice }));
  const state = useSyncExternalStore(flow.subscribe, flow.get, flow.get);
  const now = useNow(state.wait?.until ?? null);
  const form = useRef<HTMLFormElement>(null);
  useFocusMoves(form, state);
  return (
    <EmailSignInView
      state={state}
      now={now}
      practice={practice}
      held={held}
      formRef={form}
      onEmail={flow.setEmail}
      onCode={flow.setCode}
      onSend={() => void flow.send()}
      onSignIn={() => void flow.signIn()}
      onAnother={flow.another}
    />
  );
}
