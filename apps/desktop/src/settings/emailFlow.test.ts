// The flow of signing in by a code sent by email, without a screen (emailFlow.ts): what is typed, what each answer
// says, when a new code may be asked for, and Practice's pretend backend. A fake backend answers and a fake clock moves.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeAsk, CodeTry, EmailFailure } from "../runtime/http/session";
import {
  codeFrom,
  countdown,
  EmailFlow,
  PRACTICE_CODE,
  practiceBackend,
  secondsLeft,
  span,
  targetOf,
  type CodeBackend,
  type EmailFlowState,
} from "./emailFlow";

const ADDRESS = "fon@example.com";
const CODE = "482915";
const SENT: CodeAsk = { kind: "sent", expiresIn: 600, resendIn: 60 };

function clock(start = Date.UTC(2026, 10, 24, 5, 0, 0)) {
  const c = { ms: start, now: () => c.ms, pass: (ms: number) => void (c.ms += ms) };
  return c;
}

const defer = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

/** A backend that answers what it is told, one answer to each call and the last again, and records what it was asked. */
function fakeBackend(asks: CodeAsk[] = [SENT], tries: CodeTry[] = []) {
  const asked: string[] = [];
  const tried: { email: string; code: string }[] = [];
  const backend: CodeBackend = {
    async requestCode(email) {
      asked.push(email);
      return asks.length > 1 ? asks.shift()! : asks[0];
    },
    async signInWithCode(email, code) {
      tried.push({ email, code });
      return tries.length > 1 ? tries.shift()! : tries[0];
    },
  };
  return { backend, asked, tried };
}

function flowOf(backend: CodeBackend, c = clock(), practice = false) {
  const flow = new EmailFlow({ backend, now: c.now, practice });
  return { flow, c };
}

/** Types an address and asks for a code, which the backend answers. */
async function sentTo(flow: EmailFlow, email = ADDRESS) {
  flow.setEmail(email);
  await flow.send();
}

describe("the code a text holds", () => {
  it("is the digits typed, at most six, whatever else is in the box", () => {
    expect(codeFrom("")).toBe("");
    expect(codeFrom("4")).toBe("4");
    expect(codeFrom("48a2")).toBe("482");
    expect(codeFrom("4829151")).toBe("482915");
    expect(codeFrom("48 29 15")).toBe("482915");
    expect(codeFrom("abc")).toBe("");
  });

  it("is the six-digit run in what was pasted, wherever it sits, rather than the first digits", () => {
    expect(codeFrom("Your Manut AI sign-in code is 482915.")).toBe("482915");
    expect(codeFrom("It works for 10 minutes. Code: 482915, do not share it")).toBe("482915");
    expect(codeFrom("10 minutes, 482915")).toBe("482915");
    // two runs: the first six-digit one
    expect(codeFrom("482915 then 000000")).toBe("482915");
  });

  it("reads full-width digits, as an input method types them", () => {
    expect(codeFrom("４８２９１５")).toBe("482915");
    expect(codeFrom("４８ 29１5")).toBe("482915");
  });
});

describe("waits, as a clock and as words", () => {
  it("counts a wait up as 0:42, 12:05 and, past an hour, 19:58:12", () => {
    expect(countdown(42)).toBe("0:42");
    expect(countdown(60)).toBe("1:00");
    expect(countdown(725)).toBe("12:05");
    expect(countdown(3600)).toBe("1:00:00");
    expect(countdown(71_892)).toBe("19:58:12");
    expect(countdown(0)).toBe("0:00");
    expect(countdown(-3)).toBe("0:00");
    // never shown shorter than it is
    expect(countdown(41.2)).toBe("0:42");
  });

  it("says a wait in whole minutes up to two hours, and in hours after, always rounded up", () => {
    expect(span(1)).toEqual({ unit: "minute", n: 1 });
    expect(span(41)).toEqual({ unit: "minute", n: 1 });
    expect(span(60)).toEqual({ unit: "minute", n: 1 });
    expect(span(61)).toEqual({ unit: "minute", n: 2 });
    expect(span(600)).toEqual({ unit: "minute", n: 10 });
    expect(span(119 * 60)).toEqual({ unit: "minute", n: 119 });
    expect(span(119 * 60 + 1)).toEqual({ unit: "hour", n: 2 });
    expect(span(7200)).toEqual({ unit: "hour", n: 2 });
    expect(span(86_399)).toEqual({ unit: "hour", n: 24 });
    expect(span(86_400)).toEqual({ unit: "hour", n: 24 });
    expect(span(0)).toEqual({ unit: "minute", n: 1 });
  });
});

describe("asking for a code", () => {
  it("asks for the address as the API reads it, moves to the code step and says the code is on its way", async () => {
    const { backend, asked } = fakeBackend();
    const { flow, c } = flowOf(backend);
    await sentTo(flow, `  ${ADDRESS.toUpperCase()} `);
    expect(asked).toEqual([ADDRESS]);
    expect(flow.get()).toEqual<EmailFlowState>({
      step: "code",
      email: `  ${ADDRESS.toUpperCase()} `,
      code: "",
      sentTo: ADDRESS,
      busy: null,
      wait: { address: ADDRESS, until: c.now() + 60_000 },
      live: true,
      notice: { kind: "sent", life: 600 },
    });
  });

  it("says first that the box holds no address, and asks the API nothing", async () => {
    const { backend, asked } = fakeBackend();
    const { flow } = flowOf(backend);
    await flow.send();
    expect(flow.get().notice).toEqual({ kind: "badAddress" });
    for (const bad of ["fon", "fon@", "@example.com", "a b@c.d"]) {
      flow.setEmail(bad);
      await flow.send();
      expect(flow.get().notice, bad).toEqual({ kind: "badAddress" });
    }
    expect(asked).toEqual([]);
    expect(flow.get().step).toBe("email");
  });

  it("asks once while an answer is awaited, however often it is pressed", async () => {
    const hold = defer<CodeAsk>();
    const asked: string[] = [];
    const { flow } = flowOf({
      requestCode: async (email) => {
        asked.push(email);
        return hold.promise;
      },
      signInWithCode: async () => ({ kind: "code_ended" }),
    });
    flow.setEmail(ADDRESS);
    const first = flow.send();
    expect(flow.get().busy).toBe("sending");
    await flow.send();
    await flow.send();
    hold.resolve(SENT);
    await first;
    expect(asked).toEqual([ADDRESS]);
    expect(flow.get().busy).toBeNull();
  });

  it("holds a new code back for the wait the API named, counted from its answer, and asks again once it has passed", async () => {
    const { backend, asked } = fakeBackend([SENT, SENT]);
    const { flow, c } = flowOf(backend);
    await sentTo(flow);
    expect(secondsLeft(flow.get(), c.now())).toBe(60);
    c.pass(20_500);
    expect(secondsLeft(flow.get(), c.now())).toBe(40);
    // pressed too soon: nothing is asked, and nothing changes
    const before = flow.get();
    await flow.send();
    expect(asked).toEqual([ADDRESS]);
    expect(flow.get()).toBe(before);
    c.pass(39_500);
    expect(secondsLeft(flow.get(), c.now())).toBe(0);
    await flow.send();
    expect(asked).toEqual([ADDRESS, ADDRESS]);
  });

  it("makes a new code replace the one before: what was typed for the old one goes, and the new one can be tried", async () => {
    const { backend } = fakeBackend([SENT, SENT], [{ kind: "wrong_code", triesLeft: 0 }]);
    const { flow, c } = flowOf(backend);
    await sentTo(flow);
    flow.setCode(CODE);
    await flow.signIn();
    expect(flow.get().live).toBe(false);
    c.pass(60_000);
    await flow.send();
    expect(flow.get()).toMatchObject({ step: "code", code: "", live: true, notice: { kind: "sent", life: 600 } });
  });

  it("asks a new code for the address the code in hand went to, not for what the Email box was changed to", async () => {
    const { backend, asked } = fakeBackend([SENT, SENT]);
    const { flow, c } = flowOf(backend);
    await sentTo(flow);
    flow.setEmail("someone-else@example.com"); // the box is not shown on this step: it changes nothing
    expect(flow.get().email).toBe(ADDRESS);
    c.pass(60_000);
    await flow.send();
    expect(asked).toEqual([ADDRESS, ADDRESS]);
  });

  it("says too many codes with the wait, keeps the step, and holds the button for that address only", async () => {
    const { backend, asked } = fakeBackend([{ kind: "wait", retryAfter: 41 }, SENT]);
    const { flow, c } = flowOf(backend);
    await sentTo(flow);
    expect(flow.get()).toMatchObject({ step: "email", busy: null, notice: { kind: "wait", retryAfter: 41 }, wait: { address: ADDRESS, until: c.now() + 41_000 } });
    expect(secondsLeft(flow.get(), c.now())).toBe(41);
    // pressed again at once: held
    await flow.send();
    expect(asked).toEqual([ADDRESS]);
    // another address has limits of its own
    flow.setEmail("noi@example.com");
    expect(secondsLeft(flow.get(), c.now())).toBe(0);
    await flow.send();
    expect(asked).toEqual([ADDRESS, "noi@example.com"]);
    expect(flow.get().step).toBe("code");
  });

  it("says why when it fails, in the API's few kinds, and keeps the step so the person can try again", async () => {
    const failures: Exclude<EmailFailure, "busy">[] = ["not_configured", "invalid_request", "rate_limited", "offline", "unavailable", "keychain", "no_keychain"];
    for (const failure of failures) {
      const { backend } = fakeBackend([{ kind: "failed", failure }]);
      const { flow } = flowOf(backend);
      await sentTo(flow);
      expect(flow.get(), failure).toMatchObject({ step: "email", busy: null, notice: { kind: "failed", failure }, sentTo: null, wait: null });
    }
    // another sign-in running is what the screen already shows, so it says nothing more
    const busy = flowOf(fakeBackend([{ kind: "failed", failure: "busy" }]).backend);
    await sentTo(busy.flow);
    expect(busy.flow.get().notice).toBeNull();
  });

  it("clears what an answer said once the address is edited", async () => {
    const { backend } = fakeBackend([{ kind: "failed", failure: "offline" }]);
    const { flow } = flowOf(backend);
    await sentTo(flow);
    expect(flow.get().notice).not.toBeNull();
    flow.setEmail(`${ADDRESS}m`);
    expect(flow.get().notice).toBeNull();
  });
});

describe("signing in with the code", () => {
  async function onCodeStep(tries: CodeTry[]) {
    const fake = fakeBackend([SENT], tries);
    const { flow, c } = flowOf(fake.backend);
    await sentTo(flow);
    return { ...fake, flow, c };
  }

  it("keeps only the digits typed, and signs in with the six of them for the address the code went to", async () => {
    const { flow, tried } = await onCodeStep([{ kind: "signed_in", tenant: "email:abc", signedInAt: 1 }]);
    flow.setCode("48 29");
    expect(flow.get().code).toBe("4829");
    flow.setCode("Your code is 482915.");
    expect(flow.get().code).toBe(CODE);
    await flow.signIn();
    expect(tried).toEqual([{ email: ADDRESS, code: CODE }]);
    // done: the code is not kept anywhere, used or not
    expect(flow.get()).toMatchObject({ step: "done", code: "", busy: null, live: false, notice: null });
    expect(JSON.stringify(flow.get())).not.toContain(CODE);
  });

  it("asks nothing until there are six digits and a code that can still be tried", async () => {
    const { flow, tried } = await onCodeStep([{ kind: "wrong_code", triesLeft: 0 }]);
    await flow.signIn();
    flow.setCode("48291");
    await flow.signIn();
    expect(tried).toEqual([]);
    flow.setCode(CODE);
    await flow.signIn();
    expect(tried).toHaveLength(1);
    // the code ended on its fifth wrong try: nothing more is asked for it, though six digits are typed again
    flow.setCode(CODE);
    await flow.signIn();
    expect(tried).toHaveLength(1);
  });

  it("says a wrong code is wrong with the tries it has left, empties the box and lets the person try again", async () => {
    const { flow } = await onCodeStep([{ kind: "wrong_code", triesLeft: 4 }, { kind: "wrong_code", triesLeft: 1 }]);
    flow.setCode("000000");
    await flow.signIn();
    expect(flow.get()).toMatchObject({ step: "code", code: "", live: true, busy: null, notice: { kind: "wrong", triesLeft: 4 } });
    flow.setCode("000001");
    await flow.signIn();
    expect(flow.get()).toMatchObject({ code: "", live: true, notice: { kind: "wrong", triesLeft: 1 } });
    expect(JSON.stringify(flow.get())).not.toContain("00000");
  });

  it("ends the code on the fifth wrong try: Sign in waits for a new one", async () => {
    const { flow } = await onCodeStep([{ kind: "wrong_code", triesLeft: 0 }]);
    flow.setCode("000000");
    await flow.signIn();
    expect(flow.get()).toMatchObject({ step: "code", code: "", live: false, notice: { kind: "wrong", triesLeft: 0 } });
  });

  it("says when the code has ended: ask for a new one", async () => {
    const { flow } = await onCodeStep([{ kind: "code_ended" }]);
    flow.setCode(CODE);
    await flow.signIn();
    expect(flow.get()).toMatchObject({ step: "code", code: "", live: false, notice: { kind: "ended" } });
  });

  it("says why when it fails, and keeps the typed code, so a try that never reached the API is one press away", async () => {
    for (const failure of ["not_configured", "invalid_request", "rate_limited", "offline", "unavailable", "keychain", "no_keychain"] as const) {
      const { flow } = await onCodeStep([{ kind: "failed", failure }]);
      flow.setCode(CODE);
      await flow.signIn();
      expect(flow.get(), failure).toMatchObject({ step: "code", code: CODE, live: true, busy: null, notice: { kind: "failed", failure } });
    }
    const { flow } = await onCodeStep([{ kind: "failed", failure: "busy" }]);
    flow.setCode(CODE);
    await flow.signIn();
    expect(flow.get().notice).toBeNull();
  });

  it("tries once while an answer is awaited", async () => {
    const hold = defer<CodeTry>();
    let tries = 0;
    const { flow } = flowOf({
      requestCode: async () => SENT,
      signInWithCode: async () => {
        tries += 1;
        return hold.promise;
      },
    });
    await sentTo(flow);
    flow.setCode(CODE);
    const first = flow.signIn();
    expect(flow.get().busy).toBe("checking");
    await flow.signIn();
    hold.resolve({ kind: "code_ended" });
    await first;
    expect(tries).toBe(1);
  });

  it("never puts the code in a notice, whatever the answer", async () => {
    const answers: CodeTry[] = [
      { kind: "wrong_code", triesLeft: 3 },
      { kind: "wrong_code", triesLeft: 0 },
      { kind: "code_ended" },
      { kind: "failed", failure: "offline" },
      { kind: "failed", failure: "invalid_request" },
    ];
    for (const answer of answers) {
      const { flow } = await onCodeStep([answer]);
      flow.setCode(CODE);
      await flow.signIn();
      expect(JSON.stringify(flow.get().notice), JSON.stringify(answer)).not.toContain(CODE);
    }
  });
});

describe("going back", () => {
  it("returns to the first step with the code box empty, and drops an answer that was still on its way", async () => {
    const hold = defer<CodeAsk>();
    let calls = 0;
    const { flow, c } = flowOf({
      requestCode: async () => {
        calls += 1;
        return calls === 1 ? SENT : hold.promise;
      },
      signInWithCode: async () => ({ kind: "code_ended" }),
    });
    await sentTo(flow);
    flow.setCode(CODE);
    c.pass(60_000);
    const sending = flow.send();
    expect(flow.get().busy).toBe("sending");
    flow.another();
    expect(flow.get()).toMatchObject({ step: "email", sentTo: null, code: "", busy: null, live: false, notice: null });
    hold.resolve(SENT);
    await sending;
    // the answer was for a screen the person left
    expect(flow.get()).toMatchObject({ step: "email", sentTo: null, busy: null, notice: null });
  });

  it("keeps the wait for the address it was for, so asking for it again at once is still held", async () => {
    const { backend, asked } = fakeBackend([SENT, SENT]);
    const { flow, c } = flowOf(backend);
    await sentTo(flow);
    flow.another();
    expect(flow.get().email).toBe(ADDRESS);
    expect(secondsLeft(flow.get(), c.now())).toBe(60);
    await flow.send();
    expect(asked).toEqual([ADDRESS]);
    c.pass(60_000);
    await flow.send();
    expect(asked).toEqual([ADDRESS, ADDRESS]);
  });

  it("is also how Practice signs out of its pretend sign-in", async () => {
    const { flow } = flowOf(practiceBackend(), clock(), true);
    await sentTo(flow);
    flow.setCode(PRACTICE_CODE);
    await flow.signIn();
    expect(flow.get().step).toBe("done");
    flow.another();
    expect(flow.get()).toMatchObject({ step: "email", sentTo: null, code: "", live: false });
  });
});

describe("what a subscriber hears", () => {
  it("is told of each change, with the same state object in between, and not after it lets go", async () => {
    const { backend } = fakeBackend();
    const { flow } = flowOf(backend);
    const seen: EmailFlowState[] = [];
    const stop = flow.subscribe(() => seen.push(flow.get()));
    const first = flow.get();
    expect(flow.get()).toBe(first);
    flow.setEmail(ADDRESS);
    expect(seen).toHaveLength(1);
    await flow.send();
    expect(seen.map((s) => s.busy)).toEqual([null, "sending", null]);
    stop();
    flow.setEmail("x");
    flow.another();
    expect(seen).toHaveLength(3);
  });

  it("ignores typing where there is no box for it", () => {
    const { backend } = fakeBackend();
    const { flow } = flowOf(backend);
    flow.setCode(CODE);
    expect(flow.get().code).toBe("");
  });
});

describe("the address a request would go to", () => {
  it("is the typed one on the first step, as the API reads it, and the one the code went to after", () => {
    expect(targetOf({ step: "email", sentTo: null, email: "  Fon@Example.com " })).toBe(ADDRESS);
    expect(targetOf({ step: "email", sentTo: null, email: "fon" })).toBeNull();
    expect(targetOf({ step: "code", sentTo: "a@b.co", email: ADDRESS })).toBe("a@b.co");
  });
});

describe("Practice's pretend backend", () => {
  it("says the pretend code aloud when it is asked for one, and only then", async () => {
    const { flow } = flowOf(practiceBackend(), clock(), true);
    await sentTo(flow);
    expect(flow.get().notice).toEqual({ kind: "practice", code: "123456" });
    expect(PRACTICE_CODE).toBe("123456");
  });

  it("signs in with the pretend code and no other, for the address that asked", async () => {
    const c = clock();
    const backend = practiceBackend(c.now);
    expect(await backend.requestCode(` ${ADDRESS.toUpperCase()}`)).toEqual({ kind: "sent", expiresIn: 600, resendIn: 60 });
    expect(await backend.signInWithCode(ADDRESS, PRACTICE_CODE)).toEqual({ kind: "signed_in", tenant: "practice", signedInAt: c.now() });
    // one code, one sign-in, as the API's: it is used up
    expect(await backend.signInWithCode(ADDRESS, PRACTICE_CODE)).toEqual({ kind: "code_ended" });
  });

  it("counts five wrong tries as the API does, then the code has ended", async () => {
    const backend = practiceBackend(clock().now);
    await backend.requestCode(ADDRESS);
    const left: unknown[] = [];
    for (let i = 0; i < 5; i += 1) left.push(await backend.signInWithCode(ADDRESS, "000000"));
    expect(left).toEqual([4, 3, 2, 1, 0].map((triesLeft) => ({ kind: "wrong_code", triesLeft })));
    expect(await backend.signInWithCode(ADDRESS, PRACTICE_CODE)).toEqual({ kind: "code_ended" });
  });

  it("ends a code after ten minutes, and for any address but the one it was asked for", async () => {
    const c = clock();
    const backend = practiceBackend(c.now);
    await backend.requestCode(ADDRESS);
    expect(await backend.signInWithCode("noi@example.com", PRACTICE_CODE)).toEqual({ kind: "code_ended" });
    c.pass(599_000);
    expect((await backend.signInWithCode(ADDRESS, "000000")).kind).toBe("wrong_code");
    c.pass(1_000);
    expect(await backend.signInWithCode(ADDRESS, PRACTICE_CODE)).toEqual({ kind: "code_ended" });
  });

  it("holds a second code for the same address for a minute, as the API does, and a new code replaces the old", async () => {
    const c = clock();
    const backend = practiceBackend(c.now);
    await backend.requestCode(ADDRESS);
    c.pass(18_400);
    expect(await backend.requestCode(ADDRESS)).toEqual({ kind: "wait", retryAfter: 42 });
    expect((await backend.requestCode("noi@example.com")).kind).toBe("sent");
    c.pass(60_000);
    expect((await backend.requestCode(ADDRESS)).kind).toBe("sent");
    // the first code's wrong tries do not carry over to the new one
    const left = await backend.signInWithCode(ADDRESS, "000000");
    expect(left).toEqual({ kind: "wrong_code", triesLeft: 4 });
  });

  it("refuses what is not an address or six digits, as the API refuses it as a request", async () => {
    const backend = practiceBackend(clock().now);
    expect(await backend.requestCode("fon")).toEqual({ kind: "failed", failure: "invalid_request" });
    await backend.requestCode(ADDRESS);
    for (const bad of ["", "12345", "1234567", "12345a"]) {
      expect(await backend.signInWithCode(ADDRESS, bad), bad).toEqual({ kind: "failed", failure: "invalid_request" });
    }
    expect(await backend.signInWithCode("fon", PRACTICE_CODE)).toEqual({ kind: "failed", failure: "invalid_request" });
  });

  describe("sends nothing to anyone", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("through a whole Practice sign-in, no request, socket or beacon is made", async () => {
      const fetchSpy = vi.fn();
      const socket = vi.fn();
      const beacon = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      vi.stubGlobal("WebSocket", socket);
      vi.stubGlobal("XMLHttpRequest", socket);
      vi.stubGlobal("navigator", { sendBeacon: beacon });
      const { flow, c } = flowOf(practiceBackend(), clock(), true);
      await sentTo(flow);
      flow.setCode("000000");
      await flow.signIn();
      c.pass(60_000);
      await flow.send();
      flow.setCode(PRACTICE_CODE);
      await flow.signIn();
      expect(flow.get().step).toBe("done");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(socket).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
    });

    it("and the module has no way to: it reaches for no session, no shell and no network", () => {
      const source = readFileSync(join(__dirname, "emailFlow.ts"), "utf8");
      // what it imports from the runtime is a type and one pure rule (`normalizeEmail`), never a session or a request
      const imports = source.split("\n").filter((l) => l.startsWith("import "));
      expect(imports.filter((l) => l.includes("runtime"))).toEqual([
        'import { CODE_LENGTH, normalizeEmail, type CodeAsk, type CodeTry, type EmailFailure } from "../runtime/http/session";',
      ]);
      for (const word of ["fetch(", "invoke(", "sessionFor", "XMLHttpRequest", "WebSocket", "sendBeacon", "api_request", "shellFetch"]) {
        expect(source, word).not.toContain(word);
      }
    });
  });
});
