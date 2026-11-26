// Settings › Developer › Sign in by email, drawn with react-dom/server from a given state (EmailSignIn.tsx), and its handlers
// read without a DOM, as CustomizePage.test.tsx reads its forms': the view uses no hooks, so it can be called as a plain
// function and its elements walked, which shows the handlers a render to a string leaves out.
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../i18n";
import type { EmailFailure } from "../runtime/http/session";
import { EmailSignIn, EmailSignInView, noticeWords, type EmailSignInViewProps } from "./EmailSignIn";
import type { EmailFlowState, Notice } from "./emailFlow";

const words = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** The whole opening tag of the element with this test id. */
const tag = (html: string, id: string) => html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
const ADDRESS = "fon@example.com";
const NOW = Date.UTC(2026, 11, 1, 5, 0, 0);

const STATE: EmailFlowState = { step: "email", email: "", code: "", sentTo: null, busy: null, wait: null, live: false, notice: null };
const CODE_STEP: EmailFlowState = { ...STATE, step: "code", email: ADDRESS, sentTo: ADDRESS, live: true, wait: { address: ADDRESS, until: NOW + 42_000 } };

function props(state: Partial<EmailFlowState> = {}, over: Partial<EmailSignInViewProps> = {}): EmailSignInViewProps {
  return {
    state: { ...STATE, ...state },
    now: NOW,
    practice: false,
    held: false,
    onEmail: vi.fn(),
    onCode: vi.fn(),
    onSend: vi.fn(),
    onSignIn: vi.fn(),
    onAnother: vi.fn(),
    ...over,
  };
}

function draw(state: Partial<EmailFlowState> = {}, over: Partial<EmailSignInViewProps> = {}) {
  setLang("en");
  return renderToString(<EmailSignInView {...props(state, over)} />);
}

/** Every element a view draws, with its own components expanded (CustomizePage.test.tsx `drawn`). */
function drawn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(drawn);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function") return drawn((el.type as (props: unknown) => ReactNode)(el.props));
  return [...(typeof el.type === "string" ? [el] : []), ...drawn(el.props.children as ReactNode)];
}

/** The one element with this test id, which must be there exactly once. */
function byId(p: EmailSignInViewProps, id: string) {
  const found = drawn(EmailSignInView(p)).filter((e) => e.props["data-testid"] === id);
  expect(found, id).toHaveLength(1);
  return found[0];
}

afterEach(() => setLang("en"));

describe("the first step: an address and Send code", () => {
  it("asks for an email, with the system's own help for one, and offers Send code", () => {
    const html = draw();
    expect(html).toMatch(/<form[^>]*aria-label="Sign in by email"[^>]*data-testid="dev-email"[^>]*data-step="email"/);
    const box = tag(html, "dev-email-address");
    expect(box).toMatch(/^<input type="email"/);
    expect(box).toMatch(/placeholder="name@example.com"/);
    expect(box).toMatch(/aria-label="Email"/);
    expect(box).toMatch(/autocomplete="email"/i);
    expect(html).toMatch(/<button type="submit" class="st-btn" data-testid="dev-email-send">Send code<\/button>/);
    expect(words(html)).toContain("We email you a code of six digits. Type it here to sign in.");
    // nothing of the second step yet
    expect(html).not.toContain('data-testid="dev-email-code"');
    expect(html).not.toContain('data-testid="dev-email-again"');
    // no Practice note in a real flow
    expect(words(html)).not.toContain("Practice:");
  });

  it("holds Send code while an answer is awaited, and says it is sending", () => {
    const html = draw({ busy: "sending" });
    expect(html).toMatch(/<button type="submit" class="st-btn" disabled=""[^>]*data-testid="dev-email-send">Sending…<\/button>/);
  });

  it("holds Send code while another sign-in runs", () => {
    expect(draw({}, { held: true })).toMatch(/disabled=""[^>]*data-testid="dev-email-send"/);
  });

  it("counts the wait down on the button when too many codes were asked for this address, and holds it", () => {
    const html = draw({ email: ADDRESS, wait: { address: ADDRESS, until: NOW + 125_000 }, notice: { kind: "wait", retryAfter: 125 } });
    expect(html).toMatch(/disabled=""[^>]*data-testid="dev-email-send">Send code in 2:05<\/button>/);
    expect(words(html)).toContain("Too many codes for this address. Try again in 3 minutes.");
  });

  it("does not hold the button for another address, nor keep saying the wait once it is over", () => {
    const other = draw({ email: "noi@example.com", wait: { address: ADDRESS, until: NOW + 125_000 } });
    expect(other).toMatch(/<button type="submit" class="st-btn" data-testid="dev-email-send">Send code<\/button>/);
    const over = draw({ email: ADDRESS, wait: { address: ADDRESS, until: NOW - 1 }, notice: { kind: "wait", retryAfter: 125 } });
    expect(words(over)).not.toContain("Too many codes");
    expect(over).toMatch(/<button type="submit" class="st-btn" data-testid="dev-email-send">Send code<\/button>/);
  });
});

describe("the second step: the code, Sign in and a new code", () => {
  it("says where the code went, takes six digits with the system's one-time-code autofill, and holds Sign in until there are six", () => {
    const html = draw({ ...CODE_STEP, code: "4829" });
    expect(html).toMatch(/data-step="code"/);
    expect(words(html)).toContain("The six digits we sent to fon@example.com.");
    const box = tag(html, "dev-email-code");
    expect(box).toMatch(/type="text"/);
    expect(box).toMatch(/inputmode="numeric"/i);
    expect(box).toMatch(/pattern="\[0-9\]\*"/);
    expect(box).toMatch(/autocomplete="one-time-code"/i);
    expect(box).toMatch(/aria-label="Code"/);
    expect(box).toMatch(/value="4829"/);
    // no Email box any more: the code is for the address it went to
    expect(html).not.toContain('data-testid="dev-email-address"');
    expect(html).toMatch(/<button type="submit" class="st-btn" disabled=""[^>]*data-testid="dev-email-sign-in">Sign in<\/button>/);
    expect(draw({ ...CODE_STEP, code: "482915" })).toMatch(/<button type="submit" class="st-btn" data-testid="dev-email-sign-in">Sign in<\/button>/);
  });

  it("holds Sign in for a code that has ended, while a try is awaited, and while another sign-in runs, and says it is signing in", () => {
    expect(draw({ ...CODE_STEP, code: "482915", live: false })).toMatch(/disabled=""[^>]*data-testid="dev-email-sign-in"/);
    expect(draw({ ...CODE_STEP, code: "482915", busy: "checking" })).toMatch(/disabled=""[^>]*data-testid="dev-email-sign-in">Signing in…<\/button>/);
    expect(draw({ ...CODE_STEP, code: "482915" }, { held: true })).toMatch(/disabled=""[^>]*data-testid="dev-email-sign-in"/);
  });

  it("offers a new code once the wait the API named has passed, and shows the time until then", () => {
    expect(draw(CODE_STEP)).toMatch(/disabled=""[^>]*data-testid="dev-email-again">Send a new code in 0:42<\/button>/);
    const ready = draw({ ...CODE_STEP, wait: { address: ADDRESS, until: NOW - 1 } });
    expect(ready).toMatch(/<button type="button" class="st-btn" data-testid="dev-email-again">Send a new code<\/button>/);
    expect(draw({ ...CODE_STEP, wait: { address: ADDRESS, until: NOW - 1 }, busy: "sending" })).toMatch(/disabled=""[^>]*data-testid="dev-email-again">Sending…<\/button>/);
    // a wait of hours, as ten codes in a day can ask for
    expect(draw({ ...CODE_STEP, wait: { address: ADDRESS, until: NOW + 71_892_000 } })).toContain("Send a new code in 19:58:12");
  });

  it("offers another email", () => {
    expect(draw(CODE_STEP)).toMatch(/<button type="button" class="st-btn" data-testid="dev-email-another">Use another email<\/button>/);
  });
});

describe("what each answer says", () => {
  const say = (notice: Notice, state: Partial<EmailFlowState> = CODE_STEP) => words(draw({ ...state, notice }));

  it("says the code is on its way and for how long it works", () => {
    expect(say({ kind: "sent", life: 600 })).toContain("The code is on its way. It works for 10 minutes.");
    expect(say({ kind: "sent", life: 60 })).toContain("It works for 1 minute.");
  });

  it("says a wrong code is wrong with the tries it has left, and that the fifth ends it", () => {
    expect(say({ kind: "wrong", triesLeft: 4 })).toContain("That code is not right. 4 tries left.");
    expect(say({ kind: "wrong", triesLeft: 1 })).toContain("That code is not right. 1 try left.");
    expect(say({ kind: "wrong", triesLeft: 0 })).toContain("That code is not right, and it has ended. Ask for a new one.");
  });

  it("says when the code has ended: ask for a new one", () => {
    expect(say({ kind: "ended" })).toContain("That code has ended. Ask for a new one.");
  });

  it("says too many codes with the wait in minutes, and in hours when it is long", () => {
    const at = (retryAfter: number) => say({ kind: "wait", retryAfter }, { ...CODE_STEP, wait: { address: ADDRESS, until: NOW + retryAfter * 1000 } });
    expect(at(41)).toContain("Too many codes for this address. Try again in 1 minute.");
    expect(at(600)).toContain("Try again in 10 minutes.");
    expect(at(7140)).toContain("Try again in 119 minutes.");
    expect(at(86_399)).toContain("Try again in 24 hours.");
  });

  it("says plainly that signing in by email isn't on yet, and what to do instead today", () => {
    expect(say({ kind: "failed", failure: "not_configured" }, STATE)).toContain(
      "Signing in by email isn't on yet. For now, use Practice above, or sign in with Apple below.",
    );
  });

  it("says the API's own invalid request, being offline, the API not answering, and the rest", () => {
    const at = (failure: Exclude<EmailFailure, "busy">) => say({ kind: "failed", failure }, STATE);
    expect(at("invalid_request")).toContain("The API did not accept that address or code. Check it and try again.");
    expect(at("offline")).toContain("The API cannot be reached.");
    expect(at("unavailable")).toContain("The API is not answering right now.");
    expect(at("rate_limited")).toContain("Too many tries. Wait a minute, then try again.");
    expect(at("keychain")).toContain("The keychain did not keep the session.");
    expect(at("no_keychain")).toContain("This computer cannot keep a session yet");
  });

  it("asks for an address when the box holds none, before the API is asked", () => {
    expect(say({ kind: "badAddress" }, STATE)).toContain("Type your email address, like name@example.com.");
    expect(draw({ ...STATE, email: "fon", notice: { kind: "badAddress" } })).toMatch(/aria-invalid="true"/);
  });

  it("tells the screen reader at once of what went wrong, and quietly of what is fine", () => {
    expect(draw({ ...CODE_STEP, notice: { kind: "wrong", triesLeft: 3 } })).toMatch(/<span id="dev-email-note" class="dev-err" role="alert" data-testid="dev-email-notice">/);
    expect(draw({ ...CODE_STEP, notice: { kind: "sent", life: 600 } })).toMatch(/<span id="dev-email-note" role="status" data-testid="dev-email-notice">/);
    // the boxes are described by the line, so it is read with them
    expect(tag(draw({ ...CODE_STEP, notice: { kind: "ended" } }), "dev-email-code")).toMatch(/aria-describedby="dev-email-note"/);
    expect(tag(draw(CODE_STEP), "dev-email-code")).not.toMatch(/aria-describedby/);
  });

  it("draws no line at all when there is nothing to say", () => {
    expect(draw(CODE_STEP)).not.toContain('data-testid="dev-email-notice"');
    expect(draw(STATE)).not.toContain('data-testid="dev-email-notice"');
  });
});

describe("Practice", () => {
  it("says it is a pretend sign-in that sends and keeps nothing", () => {
    const html = draw({}, { practice: true });
    expect(words(html)).toContain("Practice: nothing is sent and nothing is kept. Try signing in with a pretend code.");
  });

  it("says the pretend code aloud when it is asked for one, and that no email was sent", () => {
    const html = draw({ ...CODE_STEP, notice: { kind: "practice", code: "123456" } }, { practice: true });
    expect(words(html)).toContain("Practice: your code is 123456. No email was sent.");
  });

  it("shows being signed in, and offers to sign out, which only goes back to the start", () => {
    const html = draw({ ...CODE_STEP, step: "done", live: false }, { practice: true });
    expect(words(html)).toContain("Practice: signed in");
    expect(words(html)).toContain("You are signed in as fon@example.com. Nothing was sent and nothing is kept.");
    expect(html).toMatch(/<button type="button" class="st-btn" data-testid="dev-email-out">Sign out<\/button>/);
  });

  it("draws nothing for a finished sign-in that is not Practice's: a real one is the signed-in row's to show", () => {
    expect(draw({ ...CODE_STEP, step: "done", live: false })).toBe("");
  });
});

describe("the handlers, read without a DOM", () => {
  const type = (value: string) => ({ target: { value } });
  const submit = () => ({ preventDefault: vi.fn() });

  it("passes what is typed in the Email and Code boxes on", () => {
    const first = props();
    (byId(first, "dev-email-address").props.onChange as (e: unknown) => void)(type("fon@example.com"));
    expect(first.onEmail).toHaveBeenCalledWith("fon@example.com");
    const second = props(CODE_STEP);
    (byId(second, "dev-email-code").props.onChange as (e: unknown) => void)(type("48 29"));
    expect(second.onCode).toHaveBeenCalledWith("48 29");
  });

  it("takes a paste into the code box whole, without the browser pasting it as typed", () => {
    const p = props(CODE_STEP);
    const e = { preventDefault: vi.fn(), clipboardData: { getData: vi.fn(() => "Your Manut AI sign-in code is 482915.") } };
    (byId(p, "dev-email-code").props.onPaste as (e: unknown) => void)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.clipboardData.getData).toHaveBeenCalledWith("text");
    expect(p.onCode).toHaveBeenCalledWith("Your Manut AI sign-in code is 482915.");
  });

  it("sends the code when the form is submitted on the first step, and signs in when it is on the second, never both", () => {
    const first = props();
    const e1 = submit();
    (byId(first, "dev-email").props.onSubmit as (e: unknown) => void)(e1);
    expect(e1.preventDefault).toHaveBeenCalledTimes(1);
    expect(first.onSend).toHaveBeenCalledTimes(1);
    expect(first.onSignIn).not.toHaveBeenCalled();

    const second = props({ ...CODE_STEP, code: "482915" });
    const e2 = submit();
    (byId(second, "dev-email").props.onSubmit as (e: unknown) => void)(e2);
    expect(e2.preventDefault).toHaveBeenCalledTimes(1);
    expect(second.onSignIn).toHaveBeenCalledTimes(1);
    expect(second.onSend).not.toHaveBeenCalled();

    // Practice's finished sign-in has no form button: a submit does neither
    const done = props({ ...CODE_STEP, step: "done" }, { practice: true });
    const e3 = submit();
    (byId(done, "dev-email").props.onSubmit as (e: unknown) => void)(e3);
    expect(e3.preventDefault).toHaveBeenCalledTimes(1);
    expect(done.onSend).not.toHaveBeenCalled();
    expect(done.onSignIn).not.toHaveBeenCalled();
  });

  it("asks for a new code, goes back to another email, and signs out of Practice, each from its own button", () => {
    const p = props({ ...CODE_STEP, wait: null });
    (byId(p, "dev-email-again").props.onClick as () => void)();
    expect(p.onSend).toHaveBeenCalledTimes(1);
    (byId(p, "dev-email-another").props.onClick as () => void)();
    expect(p.onAnother).toHaveBeenCalledTimes(1);

    const done = props({ ...CODE_STEP, step: "done" }, { practice: true });
    (byId(done, "dev-email-out").props.onClick as () => void)();
    expect(done.onAnother).toHaveBeenCalledTimes(1);
  });

  it("holds back an Enter that only commits what an input method is composing, as every form does", () => {
    type Key = { key: string; isComposing?: boolean; keyCode?: number; preventDefault(): void };
    const key = (k: string, over: { isComposing?: boolean; keyCode?: number } = {}): Key => ({ key: k, preventDefault: vi.fn(), ...over });
    for (const state of [STATE, CODE_STEP]) {
      const form = byId(props(state), "dev-email").props.onKeyDown as (e: Key) => void;
      for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
        const e = key("Enter", composing);
        form(e);
        expect(e.preventDefault, `${state.step} ${JSON.stringify(composing)}`).toHaveBeenCalledTimes(1);
      }
      const plain = key("Enter");
      form(plain);
      expect(plain.preventDefault, `${state.step} plain`).not.toHaveBeenCalled();
    }
  });
});

describe("the words in the app's other languages", () => {
  it("speaks Korean, Japanese and Chinese, with the code, the address and the wait filled in", () => {
    const cases = [
      ["ko", "코드가 맞지 않아요. 4번 남았어요."],
      ["ja", "コードが違います。あと 4 回試せます。"],
      ["zh", "验证码不对，还可以再试 4 次。"],
    ] as const;
    for (const [lang, wrong] of cases) {
      setLang(lang);
      const html = renderToString(<EmailSignInView {...props({ ...CODE_STEP, notice: { kind: "wrong", triesLeft: 4 } })} />);
      expect(words(html), lang).toContain(wrong);
      expect(words(html), lang).toContain(ADDRESS);
      expect(html, lang).not.toMatch(/\{(email|n|time|code)\}/);
    }
    setLang("ko");
    expect(words(renderToString(<EmailSignInView {...props({ ...CODE_STEP })} />))).toContain("0:42 뒤에 새 코드 보내기");
    setLang("zh");
    expect(words(renderToString(<EmailSignInView {...props({ ...CODE_STEP })} />))).toContain("0:42 后可重新发送验证码");
  });
});

describe("the section, with its flow", () => {
  it("starts on the first step in Practice, saying so", () => {
    setLang("en");
    const html = renderToString(<EmailSignIn origin={null} held={false} />);
    expect(html).toMatch(/data-step="email"/);
    expect(words(html)).toContain("Practice: nothing is sent and nothing is kept.");
  });

  it("starts on the first step for an API, which it asks through that API's session, saying nothing of Practice", () => {
    setLang("en");
    const html = renderToString(<EmailSignIn origin="https://dev.manut.xyz" held={false} />);
    expect(html).toMatch(/data-step="email"/);
    expect(words(html)).not.toContain("Practice:");
    expect(html).toContain('data-testid="dev-email-send"');
  });
});
