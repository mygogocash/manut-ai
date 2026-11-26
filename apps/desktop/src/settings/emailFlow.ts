// Signing in by a code sent by email, as Settings › Developer does it (docs/sign-in-options.md, "The desktop"), without
// the screen: what is typed, what each answer says, and when a new code may be asked for. EmailSignIn.tsx draws it.
//
// The flow has three steps. `email`: type an address and ask for a code. `code`: a code was asked for, so type it and
// sign in, or ask for a new one once the API's wait has passed. `done`: signed in, which only Practice's pretend flow
// ever stays on (a real sign-in replaces this whole section with the signed-in row).
//
// What it asks goes through a `CodeBackend`: the real one is `ApiSession` (runtime/http/session.ts), which has the two
// calls, and Practice's is `practiceBackend` below, which has no network, no keychain and no email in it at all, so
// nothing the Practice screen does can reach anyone. That is by what it is made of, not by a check that could be missed.
//
// Rules this module keeps:
// - A code is never kept anywhere but the box it is typed in: not in a state a log could print, not in a notice, not
//   after it is used or has ended. A notice names the address, which the person typed, and never the code (Practice's
//   pretend code is the one thing a notice says, because the screen is saying it aloud on purpose).
// - A wait the API asks for is counted from when its answer arrived, on this computer's clock, for the address it was
//   asked about only: another address has limits of its own.
// - An answer that arrives after the person moved on (`another`) is dropped, not applied to a screen it is not for.
import type { Key } from "../i18n";
import { CODE_LENGTH, normalizeEmail, type CodeAsk, type CodeTry, type EmailFailure } from "../runtime/http/session";

/** What the flow needs from a session: `ApiSession` has both calls, and so does Practice's pretend one. */
export interface CodeBackend {
  requestCode(email: string): Promise<CodeAsk>;
  signInWithCode(email: string, code: string): Promise<CodeTry>;
}

export type EmailStep = "email" | "code" | "done";

/** What the line under the boxes says: the last answer, as data, so the words are the screen's and the rules are tested
 *  without them. */
export type Notice =
  /** a code is on its way and works for `life` seconds */
  | { kind: "sent"; life: number }
  /** Practice: the pretend code, said aloud, and that no email was sent */
  | { kind: "practice"; code: string }
  /** a wrong code, and how many more tries it takes; at 0 it has ended */
  | { kind: "wrong"; triesLeft: number }
  | { kind: "ended" }
  /** too many codes for this address: try again in `retryAfter` seconds */
  | { kind: "wait"; retryAfter: number }
  /** the box does not hold an address, which is said before the API is asked */
  | { kind: "badAddress" }
  | { kind: "failed"; failure: Exclude<EmailFailure, "busy"> };

export interface EmailFlowState {
  step: EmailStep;
  /** what is typed in the Email box, as typed */
  email: string;
  /** what is typed in the Code box: digits only, at most six */
  code: string;
  /** the address, as the API reads it, that the code in hand was sent to: the one Sign in answers for */
  sentTo: string | null;
  /** what the flow is waiting on the API for */
  busy: "sending" | "checking" | null;
  /** when a new code may be asked for the address, on this computer's clock (ms since the epoch) */
  wait: { address: string; until: number } | null;
  /** whether the code in hand can still be tried: false once it has ended, so Sign in waits for a new one */
  live: boolean;
  notice: Notice | null;
}

const START: EmailFlowState = { step: "email", email: "", code: "", sentTo: null, busy: null, wait: null, live: false, notice: null };

/** The code a text holds. A six-digit run is the code, wherever it sits in what was pasted ("Your code is 482915."), so a
 *  paste of the whole line works; otherwise the first six digits are, which is what typing one digit at a time makes,
 *  and what an input method's full-width digits ("４８２９１５") or a code with a space ("482 915") become. */
export function codeFrom(text: string): string {
  const plain = text.normalize("NFKC");
  // Runs of digits are found by their length, with no lookbehind: the webview on an older macOS cannot parse one, and a
  // pattern it cannot parse would fail the whole page at load.
  for (const run of plain.matchAll(/\d+/g)) if (run[0].length === CODE_LENGTH) return run[0];
  return plain.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/** The address a request would go to: the one the code was sent to once there is a code, else the one typed, as the API
 *  reads it. Null while the box holds no address. */
export function targetOf(s: Pick<EmailFlowState, "step" | "sentTo" | "email">): string | null {
  return s.step === "code" ? s.sentTo : normalizeEmail(s.email);
}

/** Whole seconds before another code may be asked for the address the screen would ask for, rounded up so the button
 *  is never enabled early. */
export function secondsLeft(s: EmailFlowState, now: number): number {
  const w = s.wait;
  if (!w || w.address !== targetOf(s)) return 0;
  return Math.max(0, Math.ceil((w.until - now) / 1000));
}

/** A wait as a clock: "0:42", "12:05", and "19:58:12" for the hours a day's limit can ask for. */
export function countdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** A wait as a person says it: whole minutes up to two hours and whole hours after, rounded up so it is never shorter
 *  than it is. */
export function span(seconds: number): { unit: "minute" | "hour"; n: number } {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes < 120 ? { unit: "minute", n: minutes } : { unit: "hour", n: Math.ceil(minutes / 60) };
}

/** The words a failure has: the key, or null for the one the screen already shows (another sign-in running). */
export const FAILURE_KEY: Record<EmailFailure, Key | null> = {
  not_configured: "dev.mail.fail.not_configured",
  invalid_request: "dev.mail.fail.invalid_request",
  rate_limited: "dev.fail.rate_limited",
  offline: "dev.fail.offline",
  unavailable: "dev.fail.unavailable",
  keychain: "dev.fail.keychain",
  no_keychain: "dev.noKeychain",
  busy: null,
};

export interface EmailFlowOptions {
  backend: CodeBackend;
  /** the clock; a test passes its own */
  now?: () => number;
  /** this is Practice's pretend flow, so the answer to asking for a code says the pretend code aloud */
  practice?: boolean;
}

/** The flow's state and what it does, outside React: `useSyncExternalStore` reads `get` and `subscribe`, as it reads a
 *  session's state, and a test drives it with a fake backend and a fake clock. Every method is safe to call at any time:
 *  one that does not apply (Sign in with no code typed, a press while an answer is awaited) does nothing. */
export class EmailFlow {
  private state: EmailFlowState = START;
  private readonly backend: CodeBackend;
  private readonly now: () => number;
  private readonly practice: boolean;
  private readonly listeners = new Set<() => void>();
  /** Moves on whenever the person goes back to the first step, so an answer for the step they left is dropped. */
  private ticket = 0;

  constructor(opts: EmailFlowOptions) {
    this.backend = opts.backend;
    this.now = opts.now ?? Date.now;
    this.practice = opts.practice ?? false;
  }

  /** The state as of now; the same object until something changes. An arrow, so it can be handed to React as it is. */
  readonly get = (): EmailFlowState => this.state;

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Typing in the Email box. What an earlier answer said was about the address that was there, so it goes. */
  readonly setEmail = (text: string): void => {
    if (this.state.step !== "email") return;
    this.set({ email: text, notice: null });
  };

  /** Typing or pasting in the Code box: only its digits are kept, at most six. */
  readonly setCode = (text: string): void => {
    if (this.state.step !== "code") return;
    this.set({ code: codeFrom(text) });
  };

  /** Send code, and Send a new code: asks for a code for the address (the typed one, or the one the code in hand went
   *  to), unless an answer is awaited or the API's wait for that address has not passed. */
  readonly send = async (): Promise<void> => {
    const s = this.state;
    if (s.busy || s.step === "done") return;
    const address = targetOf(s);
    if (!address) return void this.set({ notice: { kind: "badAddress" } });
    if (secondsLeft(s, this.now()) > 0) return;
    const ticket = this.ticket;
    this.set({ busy: "sending", notice: null });
    const answer = await this.backend.requestCode(address);
    if (ticket !== this.ticket) return;
    const at = this.now();
    if (answer.kind === "sent") {
      this.set({
        step: "code",
        sentTo: address,
        // a new code replaces the one before, which no longer works, so what was typed for it goes
        code: "",
        live: true,
        busy: null,
        wait: { address, until: at + answer.resendIn * 1000 },
        notice: this.practice ? { kind: "practice", code: PRACTICE_CODE } : { kind: "sent", life: answer.expiresIn },
      });
    } else if (answer.kind === "wait") {
      this.set({ busy: null, wait: { address, until: at + answer.retryAfter * 1000 }, notice: { kind: "wait", retryAfter: answer.retryAfter } });
    } else {
      this.set({ busy: null, notice: answer.failure === "busy" ? null : { kind: "failed", failure: answer.failure } });
    }
  };

  /** Sign in: gives the API the six digits for the address the code was sent to. Nothing is asked until there are six
   *  digits and a code that can still be tried. */
  readonly signIn = async (): Promise<void> => {
    const s = this.state;
    if (s.busy || s.step !== "code" || !s.live || !s.sentTo || s.code.length !== CODE_LENGTH) return;
    const ticket = this.ticket;
    this.set({ busy: "checking", notice: null });
    const answer = await this.backend.signInWithCode(s.sentTo, s.code);
    if (ticket !== this.ticket) return;
    if (answer.kind === "signed_in") {
      this.set({ step: "done", code: "", busy: null, live: false, notice: null });
    } else if (answer.kind === "wrong_code") {
      // The box is emptied for the next try; at 0 tries the code has ended, so Sign in waits for a new one.
      this.set({ busy: null, code: "", live: answer.triesLeft > 0, notice: { kind: "wrong", triesLeft: answer.triesLeft } });
    } else if (answer.kind === "code_ended") {
      this.set({ busy: null, code: "", live: false, notice: { kind: "ended" } });
    } else {
      // The typed code stays, so a try that never reached the API (offline) can be pressed again without typing it.
      this.set({ busy: null, notice: answer.failure === "busy" ? null : { kind: "failed", failure: answer.failure } });
    }
  };

  /** Use another email, and Practice's Sign out: back to the first step. The API's wait for the address stays, for that
   *  address only, so asking for it again at once is still held. */
  readonly another = (): void => {
    this.ticket += 1;
    this.set({ step: "email", sentTo: null, code: "", busy: null, live: false, notice: null });
  };

  private set(patch: Partial<EmailFlowState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn();
  }
}

// ---- Practice -----------------------------------------------------------------------------------------------------------

/** The code Practice says aloud. Any address, and this one code. */
export const PRACTICE_CODE = "123456";

/** The API's own numbers (apps/api/src/email-code.ts), so Practice behaves as the real one does: a code works for ten
 *  minutes, one a minute for an address, and five wrong tries end it. The ten codes a day are not pretended. */
const CODE_LIFE_SECONDS = 600;
const RESEND_SECONDS = 60;
const MAX_WRONG_TRIES = 5;

/** The pretend backend Practice's screen asks. It has no network, no keychain and no email: it keeps one code in memory
 *  and answers as the API does, so the screens can be tried, every answer of them, with nothing sent to anyone. */
export function practiceBackend(now: () => number = Date.now): CodeBackend {
  let live: { address: string; endsAt: number; wrong: number } | null = null;
  let last: { address: string; at: number } | null = null;
  return {
    async requestCode(email) {
      const address = normalizeEmail(email);
      if (!address) return { kind: "failed", failure: "invalid_request" };
      const at = now();
      if (last && last.address === address && at - last.at < RESEND_SECONDS * 1000) {
        return { kind: "wait", retryAfter: Math.max(1, Math.ceil((last.at + RESEND_SECONDS * 1000 - at) / 1000)) };
      }
      last = { address, at };
      live = { address, endsAt: at + CODE_LIFE_SECONDS * 1000, wrong: 0 };
      return { kind: "sent", expiresIn: CODE_LIFE_SECONDS, resendIn: RESEND_SECONDS };
    },
    async signInWithCode(email, code) {
      const address = normalizeEmail(email);
      if (!address || code.length !== CODE_LENGTH || !/^\d+$/.test(code)) return { kind: "failed", failure: "invalid_request" };
      const at = now();
      if (!live || live.address !== address || at >= live.endsAt) return { kind: "code_ended" };
      if (code === PRACTICE_CODE) {
        live = null;
        return { kind: "signed_in", tenant: "practice", signedInAt: at };
      }
      live.wrong += 1;
      const triesLeft = Math.max(0, MAX_WRONG_TRIES - live.wrong);
      if (triesLeft === 0) live = null;
      return { kind: "wrong_code", triesLeft };
    },
  };
}
