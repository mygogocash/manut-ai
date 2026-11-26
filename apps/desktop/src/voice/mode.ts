// Voice mode (item 81): the box listens, sends what was said when the person pauses, the same agent answers in the same
// chat with the same asks, the answer is read aloud, and then it listens again. One press stops it. An ask (an approval
// card, or a question) is never answered by voice: voice mode stops listening and reading, says there is something to
// approve, and waits while the person decides with the card as always; then it goes on with the answer.
//
// `step` is the whole of it as a pure state machine, which mode.test.ts walks event by event; `createVoiceMode` runs its
// effects through the Ears and the Mouth (engine.ts) and a clock, which the tests replace with stand-ins.
import type { Ears, Hearing, Mouth } from "./engine";
import { refusalOf, speakable, type Refusal, type Route, type Spoken } from "./voice";

/** The person stopped speaking this long ago (no new words): what they said is sent. */
export const PAUSE_MS = 1_800;
/** How often the clock looks for that pause. */
export const TICK_MS = 250;
/** A message sent whose turn never started this long after (the send failed, the agent is gone): listen again. */
export const WAIT_START_MS = 20_000;

export type Phase = "off" | "starting" | "listening" | "finishing" | "waiting" | "speaking" | "paused";

export interface ModeState {
  phase: Phase;
  /** The words heard in this listening, shown over the box. */
  heard: string;
  /** When the words last changed. */
  wordsAt: number;
  /** Where the recognition runs, while it listens. */
  route: Route | null;
  /** Waiting: since when, and whether the turn was seen running, so a turn that has not started yet is not taken for one
   *  that ended. */
  since: number;
  sawRun: boolean;
  /** Why voice mode stopped, or a note while it goes on. */
  note: Refusal | "noAnswer" | null;
}

export const OFF: ModeState = { phase: "off", heard: "", wordsAt: 0, route: null, since: 0, sawRun: false, note: null };

export type ModeEvent =
  | { type: "start"; running: boolean; asking: boolean; at: number }
  | { type: "listening"; route: Route }
  | { type: "heard"; text: string; at: number }
  | { type: "tick"; at: number }
  | { type: "ended"; error?: string; at: number }
  /** The chat now: a turn runs, an ask waits, and the answer that came since the mark (null: none yet). */
  | { type: "chat"; running: boolean; asking: boolean; answer: string | null; at: number }
  | { type: "spoken" }
  | { type: "stop" }
  | { type: "failed"; why: Refusal };

export type ModeEffect =
  | { type: "listen" }
  /** Finish listening: the last words come, then `ended`. */
  | { type: "finish" }
  /** Drop listening at once. */
  | { type: "drop" }
  /** Take the chat's answers so far as read, so only what comes after is read aloud. */
  | { type: "mark" }
  | { type: "send"; text: string }
  | { type: "speak"; text: string }
  | { type: "hush" }
  /** Say there is something to approve. */
  | { type: "announceAsk" };

type Step = { state: ModeState; effects: ModeEffect[] };

const listenAgain = (note: ModeState["note"] = null): Step => ({
  state: { ...OFF, phase: "starting", note },
  effects: [{ type: "listen" }],
});
const waiting = (s: ModeState, at: number, sawRun: boolean): ModeState => ({ ...s, phase: "waiting", heard: "", route: null, since: at, sawRun });

export function step(s: ModeState, e: ModeEvent): Step {
  if (e.type === "stop") return { state: OFF, effects: s.phase === "off" ? [] : [{ type: "drop" }, { type: "hush" }] };
  if (s.phase === "off") {
    if (e.type !== "start") return { state: s, effects: [] };
    if (e.asking) return { state: { ...OFF, phase: "paused", sawRun: true }, effects: [{ type: "mark" }, { type: "announceAsk" }] };
    // a turn already runs: its answer is read when it lands, then voice mode listens
    if (e.running) return { state: waiting(OFF, e.at, true), effects: [{ type: "mark" }] };
    return listenAgain();
  }
  if (e.type === "start") return { state: s, effects: [] };
  if (e.type === "failed") return { state: { ...OFF, note: e.why }, effects: [{ type: "drop" }, { type: "hush" }] };

  const hearing = s.phase === "starting" || s.phase === "listening" || s.phase === "finishing";
  if (e.type === "chat") {
    if (e.asking && s.phase !== "paused") {
      // an ask is decided with its card, never by voice: stop listening and reading, and say so
      const effects: ModeEffect[] = hearing ? [{ type: "drop" }] : s.phase === "speaking" ? [{ type: "hush" }] : [];
      return { state: { ...s, phase: "paused", heard: "", route: null, sawRun: true, note: null }, effects: [...effects, { type: "announceAsk" }] };
    }
    if (s.phase === "paused") {
      if (e.asking) return { state: s, effects: [] };
      // decided: the agent goes on, and its answer is read when the turn ends
      return { state: waiting(s, e.at, true), effects: [] };
    }
    if (hearing && e.running) {
      // a message went from the box by hand (or a queued one): its answer is read, then voice mode listens again
      return { state: waiting(s, e.at, true), effects: [{ type: "drop" }, { type: "mark" }] };
    }
    if (s.phase === "waiting") {
      if (e.running) return { state: s.sawRun ? s : { ...s, sawRun: true }, effects: [] };
      if (!s.sawRun && e.answer === null) return { state: s, effects: [] };
      const words = e.answer ? speakable(e.answer) : "";
      if (!words) return listenAgain(e.answer === null ? "noAnswer" : null);
      return { state: { ...s, phase: "speaking", note: null }, effects: [{ type: "speak", text: words }] };
    }
    return { state: s, effects: [] };
  }
  if (e.type === "listening") return s.phase === "starting" ? { state: { ...s, phase: "listening", route: e.route }, effects: [] } : { state: s, effects: [] };
  if (e.type === "heard") {
    if (!hearing || e.text === s.heard) return { state: s, effects: [] };
    return { state: { ...s, heard: e.text, wordsAt: e.at, note: null }, effects: [] };
  }
  if (e.type === "tick") {
    if (s.phase === "listening" && s.heard.trim() && e.at - s.wordsAt >= PAUSE_MS) return { state: { ...s, phase: "finishing" }, effects: [{ type: "finish" }] };
    if (s.phase === "waiting" && !s.sawRun && e.at - s.since >= WAIT_START_MS) return listenAgain("noAnswer");
    return { state: s, effects: [] };
  }
  if (e.type === "ended") {
    if (!hearing) return { state: s, effects: [] };
    const text = s.heard.trim();
    // what was said goes as the message; the mark first, so the answer read is the one to this message
    if (text) return { state: waiting(s, e.at, false), effects: [{ type: "mark" }, { type: "send", text }] };
    // nothing said: an error ends voice mode with words for it, a quiet end listens again (the recognizer's own limit)
    if (e.error) return { state: { ...OFF, note: refusalOf(e.error) }, effects: [] };
    return listenAgain();
  }
  if (e.type === "spoken") return s.phase === "speaking" ? listenAgain() : { state: s, effects: [] };
  return { state: s, effects: [] };
}

export interface ModeDeps {
  ears: Ears;
  mouth: Mouth | null;
  lang(): Spoken;
  /** The person's yes to Apple's servers for a language this Mac cannot recognize by itself. */
  apple(): boolean;
  /** The Mac voice for answers (none: the Mac's default). */
  voice(): string | undefined;
  send(text: string): void;
  /** The chat's answers now, oldest first. */
  answers(): { id: string; text: string }[];
  announceAsk(): void;
  onView(s: ModeState): void;
  now?: () => number;
  every?: (fn: () => void, ms: number) => () => void;
}

const everyMs = (fn: () => void, ms: number) => {
  const h = setInterval(fn, ms);
  return () => clearInterval(h);
};

export function createVoiceMode(d: ModeDeps) {
  const now = d.now ?? Date.now;
  const every = d.every ?? everyMs;
  let state = OFF;
  let hearing: Hearing | null = null;
  let session = 0;
  let speech = 0;
  let mark: Set<string> | null = null;
  let clock: (() => void) | null = null;
  let chatNow = { running: false, asking: false };

  const answer = (): string | null => {
    if (!mark) return null;
    const fresh = d.answers().filter((a) => !mark!.has(a.id) && a.text.trim());
    return fresh.length ? fresh.map((a) => a.text).join("\n\n") : null;
  };

  const run = (fx: ModeEffect) => {
    switch (fx.type) {
      case "listen": {
        const mine = ++session;
        d.ears
          .listen(d.lang(), d.apple(), {
            heard: (text) => mine === session && dispatch({ type: "heard", text, at: now() }),
            ended: (error) => {
              if (mine !== session) return;
              hearing = null;
              dispatch({ type: "ended", error, at: now() });
            },
          })
          .then(
            (h) => {
              if (mine !== session) return h.cancel();
              hearing = h;
              dispatch({ type: "listening", route: h.route });
            },
            (e) => mine === session && dispatch({ type: "failed", why: refusalOf(e) }),
          );
        break;
      }
      case "finish":
        hearing?.stop();
        break;
      case "drop":
        session += 1;
        hearing?.cancel();
        hearing = null;
        break;
      case "mark":
        mark = new Set(d.answers().map((a) => a.id));
        break;
      case "send":
        d.send(fx.text);
        break;
      case "speak": {
        const mine = ++speech;
        if (!d.mouth) {
          // no way to read aloud here: the answer stays on screen, and voice mode listens again
          queueMicrotask(() => mine === speech && dispatch({ type: "spoken" }));
          break;
        }
        d.mouth.speak(fx.text, d.lang(), d.voice(), () => mine === speech && dispatch({ type: "spoken" }));
        break;
      }
      case "hush":
        speech += 1;
        d.mouth?.cancel();
        break;
      case "announceAsk":
        speech += 1;
        d.announceAsk();
        break;
    }
  };

  function dispatch(e: ModeEvent) {
    const r = step(state, e);
    state = r.state;
    if (state.phase === "off" && clock) {
      clock();
      clock = null;
    }
    d.onView(state);
    r.effects.forEach(run);
  }

  return {
    get state(): ModeState {
      return state;
    },
    start(): void {
      if (state.phase !== "off") return;
      clock ??= every(() => dispatch({ type: "tick", at: now() }), TICK_MS);
      dispatch({ type: "start", running: chatNow.running, asking: chatNow.asking, at: now() });
    },
    stop(): void {
      dispatch({ type: "stop" });
    },
    /** What the chat shows now; called whenever it changes. */
    chat(running: boolean, asking: boolean): void {
      chatNow = { running, asking };
      if (state.phase !== "off") dispatch({ type: "chat", running, asking, answer: answer(), at: now() });
    },
  };
}

export type VoiceMode = ReturnType<typeof createVoiceMode>;
