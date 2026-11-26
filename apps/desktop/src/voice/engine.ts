// The two halves voice needs, behind interfaces the tests drive with stand-ins (mic.test.ts, mode.test.ts):
// - Ears: the shell's listening (src-tauri/src/voice.rs): `voice_status`, `voice_listen`, `voice_stop`, and the words as
//   `voice-heard` events until `voice-ended`. The page never touches the audio; it hears only the words.
// - Mouth: reading aloud with the web view's own speechSynthesis, which speaks with the Mac's own voices, on the Mac.
// In a plain browser (dev, e2e) with `window.__manutVoiceMock` set, a stand-in pair records every call in
// `window.__manutVoice` and lets a test say words and finish speaking; without it the box offers no voice there.
import { isMacPlatform } from "../lib/power";
import { chunks, type HearStatus, type Route, type Spoken } from "./voice";
import { inTauri } from "../lib/tauri";

/** What the page hears from one recognition. Neither callback comes after `cancel`. */
export interface HearCallbacks {
  /** The words heard so far (each replaces the last); `final` on the last. */
  heard(text: string, final: boolean): void;
  /** It ended: by `stop`, by the recognizer itself, or with an error code (never what was heard). */
  ended(error?: string): void;
}

/** One recognition that started. */
export interface Hearing {
  route: Route;
  /** Finish: the last words come, then `ended`. */
  stop(): void;
  /** Drop it at once: nothing more comes. */
  cancel(): void;
}

export interface Ears {
  status(lang: Spoken): Promise<HearStatus>;
  /** Rejects with a refusal code (voice.ts `Refusal`) when it cannot start. */
  listen(lang: Spoken, apple: boolean, on: HearCallbacks): Promise<Hearing>;
}

/** A voice the Mac offers for reading aloud. */
export interface MacVoice {
  id: string;
  name: string;
  lang: string;
}

export interface Mouth {
  voices(): MacVoice[];
  /** Read `text` aloud in `lang`, with voice `voice` when the Mac has it; `done` once it has all been read, or failed. */
  speak(text: string, lang: string, voice: string | undefined, done: () => void): void;
  /** Stop reading at once: `done` does not come. */
  cancel(): void;
}

type MockGlobals = { __manutVoiceMock?: boolean; __manutVoice?: VoiceMock };
const mockOn = () => typeof window !== "undefined" && !!(window as unknown as MockGlobals).__manutVoiceMock;

/** Voice is offered in the Mac app (the shell listens with macOS's speech recognition), and in a browser test that asks
 *  for the stand-in. */
export const voiceOffered = (): boolean => (inTauri() && isMacPlatform()) || mockOn();

/** How long the page waits for the end after `stop` before it calls the recognition over itself. */
export const STOP_GRACE_MS = 4_000;

interface HeardPayload {
  id: number;
  text: string;
  final: boolean;
}
interface EndedPayload {
  id: number;
  error: string | null;
}

/** The shell's listening. Events are taken from before the start, so none is missed between the shell's answer and the
 *  page reading it, and each is matched to the recognition's id. */
export function tauriEars(): Ears {
  return {
    async status(lang) {
      const { invoke } = await import("@tauri-apps/api/core");
      return invoke<HearStatus>("voice_status", { lang });
    },
    async listen(lang, apple, on) {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      let id: number | null = null;
      let over = false;
      let grace: ReturnType<typeof setTimeout> | null = null;
      const early: (["heard", HeardPayload] | ["ended", EndedPayload])[] = [];
      const offs: (() => void)[] = [];
      const finish = () => {
        over = true;
        if (grace) clearTimeout(grace);
        offs.forEach((off) => off());
      };
      const take = (kind: "heard" | "ended", p: HeardPayload | EndedPayload) => {
        if (over || p.id !== id) return;
        if (kind === "heard") on.heard((p as HeardPayload).text, (p as HeardPayload).final);
        else {
          finish();
          on.ended((p as EndedPayload).error ?? undefined);
        }
      };
      offs.push(await listen<HeardPayload>("voice-heard", (e) => (id === null ? early.push(["heard", e.payload]) : take("heard", e.payload))));
      offs.push(await listen<EndedPayload>("voice-ended", (e) => (id === null ? early.push(["ended", e.payload]) : take("ended", e.payload))));
      let started: { id: number; route: Route };
      try {
        started = await invoke<{ id: number; route: Route }>("voice_listen", { lang, apple });
      } catch (e) {
        finish();
        throw e;
      }
      id = started.id;
      for (const [kind, p] of early) take(kind, p);
      return {
        route: started.route,
        stop() {
          if (over) return;
          void invoke("voice_stop", { id, keep: true }).catch(() => undefined);
          grace ??= setTimeout(() => {
            if (over) return;
            finish();
            on.ended();
          }, STOP_GRACE_MS);
        },
        cancel() {
          if (over) return;
          finish();
          void invoke("voice_stop", { id, keep: false }).catch(() => undefined);
        },
      };
    },
  };
}

/** Reading aloud with the web view's speechSynthesis: each answer as short utterances, one after another. */
export function webMouth(): Mouth | null {
  const ss = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!ss || typeof SpeechSynthesisUtterance === "undefined") return null;
  let run = 0;
  return {
    voices: () => ss.getVoices().map((v) => ({ id: v.voiceURI, name: v.name, lang: v.lang })),
    speak(text, lang, voice, done) {
      const mine = ++run;
      ss.cancel();
      const parts = chunks(text);
      const chosen = voice ? ss.getVoices().find((v) => v.voiceURI === voice) : undefined;
      let i = 0;
      const next = () => {
        if (mine !== run) return;
        if (i >= parts.length) {
          run += 1;
          done();
          return;
        }
        const u = new SpeechSynthesisUtterance(parts[i++]);
        u.lang = lang;
        if (chosen) u.voice = chosen;
        u.onend = next;
        u.onerror = () => {
          if (mine !== run) return;
          run += 1;
          done();
        };
        ss.speak(u);
      };
      next();
    },
    cancel() {
      run += 1;
      ss.cancel();
    },
  };
}

/** The browser stand-in's record and controls (e2e). */
export interface VoiceMock {
  calls: string[];
  spoken: string[];
  status: HearStatus | null;
  /** Say words to the recognition that listens now. */
  hear(text: string, final?: boolean): void;
  /** End the recognition that listens now (with an error code, or none). */
  end(error?: string): void;
  /** Finish reading aloud. */
  doneSpeaking(): void;
}

function mockPair(): { ears: Ears; mouth: Mouth } {
  const g = window as unknown as MockGlobals;
  let live: HearCallbacks | null = null;
  let speaking: (() => void) | null = null;
  const m: VoiceMock = (g.__manutVoice ??= { calls: [], spoken: [], status: null, hear: () => {}, end: () => {}, doneSpeaking: () => {} });
  m.hear = (text, final = false) => live?.heard(text, final);
  m.end = (error) => {
    const l = live;
    live = null;
    l?.ended(error);
  };
  m.doneSpeaking = () => {
    const d = speaking;
    speaking = null;
    d?.();
  };
  return {
    ears: {
      async status(lang) {
        m.calls.push(`status ${lang}`);
        return m.status ?? { lang, supported: true, available: true, onDevice: true, speech: "allowed", mic: "allowed" };
      },
      async listen(lang, apple, on) {
        m.calls.push(`listen ${lang}${apple ? " apple" : ""}`);
        live = on;
        return {
          route: apple ? "apple" : "onDevice",
          stop: () => {
            m.calls.push("stop");
            m.end();
          },
          cancel: () => {
            m.calls.push("cancel");
            live = null;
          },
        };
      },
    },
    mouth: {
      voices: () => [],
      speak(text, lang, _voice, done) {
        m.spoken.push(`${lang}: ${text}`);
        speaking = done;
      },
      cancel() {
        m.calls.push("hush");
        speaking = null;
      },
    },
  };
}

let engines: { ears: Ears; mouth: Mouth | null } | null = null;
/** The pair this page uses, made once. */
export function getVoiceEngines(): { ears: Ears; mouth: Mouth | null } {
  if (engines) return engines;
  engines = mockOn() && !inTauri() ? mockPair() : { ears: tauriEars(), mouth: webMouth() };
  return engines;
}
