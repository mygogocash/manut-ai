// Plays the sounds: one AudioContext for the page, each sound rendered once and kept (rendering during a slider drag would
// stutter the gesture; GoSpark caches the same way), and every player asks the gate first.
//
// The players are the finish chime (`finish`), the settle tick (`settle`), the effort slider's ladder (`effort`) and the
// tooltip tick (`tooltip`); `previewTone` plays any choice for Settings. A player that is switched off in Settings plays
// nothing, and a preview ignores the switches (the person pressed it to hear the sound) but never the gate.
import { allowsSound } from "./gate";
import { effortRecipe, FINISH, SETTLE, TOOLTIP, type TooltipCue } from "./recipes";
import { effortSoundEnabled, finishChimeEnabled, finishTone, settleSoundEnabled, tooltipSoundEnabled } from "./prefs";
import { renderRecipe, SAMPLE_RATE, type Recipe } from "./synth";
import { TONE_URL, type ToneId } from "./tones";

/** What the player needs of the browser: a context, and the bytes of a tone's file. A test gives stand-ins. */
export interface PlayerDeps {
  audio: () => AudioContext | null;
  loadTone: (url: string) => Promise<ArrayBuffer>;
  allows?: () => boolean;
}

/** One group is one voice: a new sound of the group cuts the one still ringing, so dragging back and forth across one stop
 *  ticks every time instead of swallowing the second crossing. */
type Group = "finish" | "settle" | "effort" | "tooltip";

export interface Player {
  /** The finish chime, or the chosen tone. Resolves to whether it started. `key` makes it once-only: a finish that already
   *  made its sound (same key) makes none. */
  finish(opts?: { tone?: ToneId; preview?: boolean; key?: string }): Promise<boolean>;
  settle(opts?: { preview?: boolean }): Promise<boolean>;
  /** Level `index` of `count` on the effort slider. */
  effort(index: number, count: number, opts?: { preview?: boolean }): Promise<boolean>;
  tooltip(cue: TooltipCue, opts?: { preview?: boolean }): Promise<boolean>;
  /** Fetch and decode a tone ahead of its first play, so a finish never waits on a file. */
  warm(tone: ToneId): Promise<void>;
}

/** How many finish keys are remembered: far more than a session's turns in flight, so the set cannot grow without end. */
const KEEP_KEYS = 500;

export function createPlayer(deps: PlayerDeps): Player {
  const allows = deps.allows ?? allowsSound;
  const buffers = new Map<string, AudioBuffer>();
  const loading = new Map<string, Promise<AudioBuffer | null>>();
  const voices = new Map<Group, AudioBufferSourceNode>();
  const rung = new Set<string>();

  const context = (): AudioContext | null => {
    const ctx = deps.audio();
    // A context the browser holds until a gesture is resumed by the next sound; this one is dropped, never queued.
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  };

  const rendered = (ctx: AudioContext, key: string, recipe: Recipe): AudioBuffer => {
    let buf = buffers.get(key);
    if (!buf) {
      const data = renderRecipe(recipe);
      buf = ctx.createBuffer(1, data.length, SAMPLE_RATE);
      buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
      buffers.set(key, buf);
    }
    return buf;
  };

  const fromFile = (ctx: AudioContext, tone: Exclude<ToneId, "default">): Promise<AudioBuffer | null> => {
    const have = buffers.get(tone);
    if (have) return Promise.resolve(have);
    let p = loading.get(tone);
    if (!p) {
      p = deps
        .loadTone(TONE_URL[tone])
        .then((bytes) => ctx.decodeAudioData(bytes))
        .then((buf) => {
          buffers.set(tone, buf);
          return buf;
        })
        .catch(() => null)
        .finally(() => loading.delete(tone));
      loading.set(tone, p);
    }
    return p;
  };

  const start = (ctx: AudioContext, group: Group, buffer: AudioBuffer, volume: number): void => {
    voices.get(group)?.stop();
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.onended = () => {
      if (voices.get(group) === source) voices.delete(group);
    };
    voices.set(group, source);
    source.start();
  };

  /** The one path of a rendered sound: gate first (before the context is even made), then the switch. */
  const playRecipe = async (group: Group, key: string, recipe: Recipe | null, on: () => boolean, preview?: boolean): Promise<boolean> => {
    if (!allows()) return false;
    if (!recipe || (!preview && !on())) return false;
    const ctx = context();
    if (!ctx) return false;
    start(ctx, group, rendered(ctx, key, recipe), recipe.volume);
    return true;
  };

  return {
    async finish(opts = {}) {
      if (!allows()) return false;
      if (!opts.preview && !finishChimeEnabled()) return false;
      if (opts.key !== undefined && !opts.preview) {
        if (rung.has(opts.key)) return false;
        rung.add(opts.key);
        if (rung.size > KEEP_KEYS) rung.delete(rung.values().next().value as string);
      }
      const ctx = context();
      if (!ctx) return false;
      const tone = opts.tone ?? finishTone();
      // A finish already ringing is not restarted by another; a preview is, so pressing it twice plays twice.
      if (voices.has("finish") && !opts.preview) return false;
      if (tone !== "default") {
        const buf = await fromFile(ctx, tone);
        // A file that cannot be read falls back to the chime, as GoSpark falls back to its default sound.
        if (buf) {
          start(ctx, "finish", buf, FINISH.volume);
          return true;
        }
      }
      start(ctx, "finish", rendered(ctx, "finish", FINISH), FINISH.volume);
      return true;
    },
    settle: (opts = {}) => playRecipe("settle", "settle", SETTLE, settleSoundEnabled, opts.preview),
    effort(index, count, opts = {}) {
      const recipe = effortRecipe(index, count);
      const top = recipe !== null && count > 1 && index === count - 1;
      return playRecipe("effort", top ? "effort-top" : `effort-${count}-${index}`, recipe, effortSoundEnabled, opts.preview);
    },
    tooltip: (cue, opts = {}) => playRecipe("tooltip", `tooltip-${cue}`, TOOLTIP[cue], tooltipSoundEnabled, opts.preview),
    async warm(tone) {
      if (tone === "default" || !allows()) return;
      const ctx = deps.audio();
      if (ctx) await fromFile(ctx, tone);
    },
  };
}

// ---- the page's player ---------------------------------------------------------------------------------------------------

let shared: AudioContext | null | undefined;

/** The page's one AudioContext, made on the first sound that plays (never while the gate is shut or a switch is off). */
export function sharedAudio(): AudioContext | null {
  if (shared !== undefined) return shared;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  try {
    shared = Ctor ? new Ctor() : null;
  } catch {
    shared = null;
  }
  return shared;
}

let page: Player | null = null;
/** The page's player. */
export const sounds = (): Player =>
  (page ??= createPlayer({
    audio: sharedAudio,
    loadTone: async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`tone ${r.status}`);
      return r.arrayBuffer();
    },
  }));
