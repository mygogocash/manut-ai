import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { CODE_LENGTH, normalizeEmail } from "../api/email";
import type { PilotApi } from "../api/types";
import { codeFrom, waitWords } from "../join/code";
import type { JoinStrings } from "../join/strings";

/// Signing in with a code sent by email, as a page shows it: an address, then the code (docs/pilot-api.md, "Signing in by
/// email"). The join page (`/join/{token}`) and the owner's app (`/app/`) both sign in this way, with the same steps, waits
/// and words; each says what signing in does (`exchange`) and what comes after it (`onSignedIn`). It was the join page's
/// own until the app needed it too.
///
/// What it keeps, it keeps in memory: the address being typed, the code, and when a new code may be asked for. The code is
/// emptied once it has signed someone in.

export type Busy = null | "send" | "signIn" | "resend";

/// Where the sign-in stands: asking for an address, or for the code that went to `sentTo`, which works `life` seconds.
export type CodeStepState = { name: "email" } | { name: "code"; sentTo: string; life: number };

/// What the line under the code box says. `invalid` marks the box itself; `ended` means the code can no longer be tried,
/// so the page offers a new one instead of Sign in.
export type CodeError = { text: string; invalid: boolean; ended: boolean };

export type CodeSignInOptions = {
  api: Pick<PilotApi, "requestEmailCode">;
  /// Signs in with the code, rejecting as the exchange does (`wrong_code`, `code_ended` and the rest).
  exchange: (address: string, code: string) => Promise<void>;
  /// Called once `exchange` has resolved and the code is used up, outside the step's busy state.
  onSignedIn: (address: string) => void;
  /// Signing in by email is off (`email_not_configured`), whichever step heard it.
  onOff: () => void;
};

export function useCodeSignIn(s: JoinStrings, options: CodeSignInOptions) {
  const [step, setStep] = useState<CodeStepState>({ name: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<CodeError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The first press wins. State lands after a render, so a second press in the same moment would still see an enabled
  // button; this ref closes that gap synchronously, as the owner's approval page does.
  const inFlight = useRef(false);

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
        const sent = await options.api.requestEmailCode(address);
        setCode("");
        setCodeError(null);
        setNotice(null);
        startWait(sent.resendIn);
        setStep({ name: "code", sentTo: address, life: sent.expiresIn });
      } catch (err) {
        if (isOff(err)) options.onOff();
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
        const sent = await options.api.requestEmailCode(address);
        // A new code replaces the one before, so the box empties and the old answer goes with it.
        setCode("");
        setCodeError(null);
        setNotice(s.newCodeSent);
        startWait(sent.resendIn);
        setStep({ name: "code", sentTo: address, life: sent.expiresIn });
      } catch (err) {
        if (isOff(err)) return options.onOff();
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
    let signedIn = false;
    return once("signIn", async () => {
      setCodeError(null);
      setNotice(null);
      try {
        await options.exchange(address, typed);
        signedIn = true;
      } catch (err) {
        if (isOff(err)) options.onOff();
        else setCodeError(codeFailure(s, err));
        return;
      }
      // The code is used up: it is never kept once it has signed someone in.
      setCode("");
    }).then(() => (signedIn ? options.onSignedIn(address) : undefined));
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

  function typeEmail(text: string): void {
    setEmail(text);
    setEmailError(null);
  }

  /// Back to the address, keeping what was typed there.
  function anotherEmail(): void {
    setCode("");
    setCodeError(null);
    setNotice(null);
    setStep({ name: "email" });
  }

  /// Back to the start, with `note` over the address when given (a sign-in that ended, for one).
  function reset(nextNote: string | null = null): void {
    setCode("");
    setCodeError(null);
    setNotice(null);
    setEmailError(null);
    setNote(nextNote);
    setStep({ name: "email" });
  }

  return {
    step, email, code, busy, emailError, codeError, notice, note, waitLeft,
    sendCode, resend, signIn, typeCode, typeEmail, anotherEmail, reset,
  };
}

export type CodeSignIn = ReturnType<typeof useCodeSignIn>;

export function isOff(err: unknown): boolean {
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
