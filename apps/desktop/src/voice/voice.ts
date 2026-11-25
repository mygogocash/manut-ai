// Voice in the chat box (item 81): what the microphone and voice mode share, as pure helpers so they are tested without a
// microphone. The languages a person may speak, the person's choices (kept in this computer's storage), whether a
// language may be listened to now or needs the person's yes to Apple first, where heard words go in the box, and how an
// answer is made fit to read aloud. The listening itself is the shell's (src-tauri/src/voice.rs), the reading aloud the
// web view's own speechSynthesis (engine.ts); docs/voice.md says what runs where.
import { t, type Key } from "../i18n";

/** The languages a person may speak, as the Mac's speech recognition names them. Thai and English are the two the owner
 *  asked for; US English is the English this Mac recognizes by itself. The shell takes no other. */
export const SPOKEN = ["th-TH", "en-US"] as const;
export type Spoken = (typeof SPOKEN)[number];
/** Each spoken language's name in the app's language. */
export const SPOKEN_NAME: Record<Spoken, Key> = { "th-TH": "voice.lang.th", "en-US": "voice.lang.en" };
export const spokenName = (lang: Spoken): string => t(SPOKEN_NAME[lang]);

/** Whether the person let this app use the microphone or speech recognition, as macOS keeps it (src-tauri `Access`). */
export type Access = "notAsked" | "allowed" | "denied" | "restricted";

/** What this Mac can do for one language (src-tauri `Status`), read without asking the person anything. */
export interface HearStatus {
  lang: string;
  supported: boolean;
  available: boolean;
  onDevice: boolean;
  speech: Access;
  mic: Access;
}

/** Where one recognition runs: on this Mac, or on Apple's servers. */
export type Route = "onDevice" | "apple";

/** The person's choice in Settings › Voice: words are made on this Mac only, or a language this Mac cannot recognize by
 *  itself may go to Apple's servers. Only "apple" lets audio leave the Mac, and only the person's yes sets it. */
export type Where = "device" | "apple";

export interface VoicePrefs {
  lang: Spoken;
  where: Where;
  /** The Mac voice that reads answers aloud, per spoken language (its voiceURI); none: the Mac's default for it. */
  voices: Partial<Record<Spoken, string>>;
}

/** Thai first: the shops this app is for speak Thai. Nothing leaves the Mac until the person says yes. */
export const DEFAULT_PREFS: VoicePrefs = { lang: "th-TH", where: "device", voices: {} };

const LANG_KEY = "manut.voice.lang";
const WHERE_KEY = "manut.voice.where";
const VOICES_KEY = "manut.voice.voices";

type Store = Pick<Storage, "getItem" | "setItem">;
const browserStore = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The person's voice choices; anything missing or unreadable is the default. */
export function readPrefs(store: Store | undefined = browserStore()): VoicePrefs {
  try {
    const lang = store?.getItem(LANG_KEY);
    const where = store?.getItem(WHERE_KEY);
    let voices: VoicePrefs["voices"] = {};
    const raw = store?.getItem(VOICES_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const l of SPOKEN) {
          const v = (parsed as Record<string, unknown>)[l];
          if (typeof v === "string" && v) voices = { ...voices, [l]: v };
        }
      }
    }
    return {
      lang: SPOKEN.includes(lang as Spoken) ? (lang as Spoken) : DEFAULT_PREFS.lang,
      where: where === "apple" ? "apple" : "device",
      voices,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

const listeners = new Set<() => void>();
/** Settings › Voice and the box follow each other's changes in the same window. */
export function onPrefs(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Keep a change of the person's (a language, the yes to Apple or taking it back, a voice). */
export function savePrefs(change: Partial<VoicePrefs>, store: Store | undefined = browserStore()): VoicePrefs {
  const next = { ...readPrefs(store), ...change };
  try {
    store?.setItem(LANG_KEY, next.lang);
    store?.setItem(WHERE_KEY, next.where);
    store?.setItem(VOICES_KEY, JSON.stringify(next.voices));
  } catch {
    /* no storage: the choice holds until the window closes */
  }
  listeners.forEach((fn) => fn());
  return next;
}

/** Why listening cannot start, as the shell and this page name it. */
export type Refusal =
  | "unsupported"
  | "mic-denied"
  | "speech-denied"
  | "apple-not-allowed"
  | "unavailable"
  | "input"
  | "busy"
  | "not-here"
  | "failed"
  | "nothing";

/** What the box does when the microphone or voice mode is pressed: listen (on this Mac, or through Apple's servers with
 *  the person's yes), ask the person first, or say why it cannot. The shell checks the same again (`may_listen`); a
 *  permission never asked is not a refusal, since listening is what shows macOS's own prompt. */
export type Plan = { kind: "listen"; apple: boolean } | { kind: "ask" } | { kind: "refuse"; why: Refusal };

export function decide(s: HearStatus, where: Where): Plan {
  if (!s.supported) return { kind: "refuse", why: "unsupported" };
  if (s.mic === "denied" || s.mic === "restricted") return { kind: "refuse", why: "mic-denied" };
  if (s.speech === "denied" || s.speech === "restricted") return { kind: "refuse", why: "speech-denied" };
  // A language this Mac recognizes by itself always stays on it, whatever the person allowed.
  if (!s.onDevice && where !== "apple") return { kind: "ask" };
  if (!s.available) return { kind: "refuse", why: "unavailable" };
  return { kind: "listen", apple: !s.onDevice };
}

/** A refusal from the shell (a code, or `failed:<domain>:<code>` for the recognizer's own error) as one of ours. */
export function refusalOf(e: unknown): Refusal {
  const code = String(e instanceof Error ? e.message : e).trim();
  const known: Refusal[] = ["unsupported", "mic-denied", "speech-denied", "apple-not-allowed", "unavailable", "input", "busy", "not-here", "nothing"];
  return (known as string[]).includes(code) ? (code as Refusal) : "failed";
}

const REFUSAL: Record<Refusal, Key> = {
  unsupported: "voice.err.unsupported",
  "mic-denied": "voice.err.micDenied",
  "speech-denied": "voice.err.speechDenied",
  "apple-not-allowed": "voice.err.appleNotAllowed",
  unavailable: "voice.err.unavailable",
  input: "voice.err.input",
  busy: "voice.err.busy",
  "not-here": "voice.err.notHere",
  failed: "voice.err.failed",
  nothing: "voice.err.nothing",
};

/** The refusal in plain words, naming the language where it matters. */
export const refusalText = (why: Refusal, lang: Spoken): string => t(REFUSAL[why], { lang: spokenName(lang) });

/** Where a recognition runs, in words for the line over the box. */
export const routeText = (route: Route): string => t(route === "apple" ? "voice.whereApple" : "voice.whereDevice");

/** The box while the microphone listens: what was typed before it was pressed, then the words heard so far (which the
 *  recognizer revises as it goes, so each update replaces the last), after a space. */
export function withHeard(base: string, heard: string): string {
  const words = heard.trim();
  if (!words) return base;
  if (!base.trim()) return words;
  return /\s$/.test(base) ? base + words : `${base} ${words}`;
}

/** An answer as words to read aloud: the markdown's marks go, a link reads as its text, and code and addresses are left
 *  out (read aloud they are noise; they stay on screen). Lines stay lines, so the voice pauses between them. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, "\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]+>?/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/\|/g, " ")
        .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, "$2")
        .replace(/^[-=:\s]{3,}$/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

/** Text cut into pieces of at most `max` characters, at a line or a sentence's end where it can, else at a space, so a
 *  long answer is read as several short utterances (one long one can stop half way in a web view). */
export function chunks(text: string, max = 220): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let rest = line.trim();
    while (rest.length > max) {
      const head = rest.slice(0, max);
      const stop = Math.max(...[". ", "! ", "? ", "。", "！", "？"].map((p) => head.lastIndexOf(p)));
      const space = head.lastIndexOf(" ");
      const at = stop > max / 3 ? stop + 1 : space > max / 3 ? space : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}
