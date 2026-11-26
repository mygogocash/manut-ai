// Renders a short struck tone to samples: additive synthesis, a few notes each ringing as a set of fading sine partials.
// Lifted from GoSpark's `ToneSynth.swift` (our own, `mygogocash/gospark` at a7537c80) with every constant unchanged, so the
// chimes ship as a few numbers rather than sound files and stay tunable right where `recipes.ts` declares them. Pure: no
// audio context, no globals, so a test can read the samples it makes.

/** A note of a chime: when it starts (seconds) and how strongly it rings, relative to the others. `endFrequency` makes it a
 *  glide that reaches that pitch by the end of the sound. */
export interface Note {
  frequency: number;
  onset: number;
  level: number;
  endFrequency?: number;
}

/** One sine in a note's tone: its frequency as a multiple of the fundamental, how loud it starts, and how quickly it fades
 *  (the seconds it takes to fall by about two thirds). */
export interface Partial {
  multiple: number;
  level: number;
  decay: number;
}

/** A whole sound: what to render, and how loud it plays relative to the system volume (`volume`, 0 to 1). */
export interface Recipe {
  notes: Note[];
  partials: Partial[];
  duration: number;
  volume: number;
}

export const SAMPLE_RATE = 44_100;
/** The loudest sample of a rendered sound: every sound is scaled to this, as GoSpark's are, and `volume` sets the rest. */
export const PEAK = 0.9;
/** A raised-cosine onset: quick enough to feel struck, with no click. */
const ATTACK = 0.006;
/** The tail is inaudible by the end; the fade makes sure it stops without a tick. */
const RELEASE = 0.08;

/** The samples of `notes` rung with `partials` for `duration` seconds, mono at 44.1 kHz, scaled so the loudest is `PEAK`. */
export function renderWave(notes: readonly Note[], partials: readonly Partial[], duration: number): Float32Array {
  const count = Math.trunc(SAMPLE_RATE * duration);
  const samples = new Float64Array(count);
  for (const note of notes) {
    const start = Math.trunc(note.onset * SAMPLE_RATE);
    const sounding = (count - start) / SAMPLE_RATE;
    for (let index = start; index < count; index++) {
      const time = (index - start) / SAMPLE_RATE;
      const onset = time < ATTACK ? 0.5 - 0.5 * Math.cos((Math.PI * time) / ATTACK) : 1;
      const frequency = note.endFrequency !== undefined && sounding > 0 ? note.frequency + (note.endFrequency - note.frequency) * Math.min(1, time / sounding) : note.frequency;
      let tone = 0;
      for (const p of partials) tone += p.level * Math.exp(-time / p.decay) * Math.sin(2 * Math.PI * frequency * p.multiple * time);
      samples[index] += note.level * onset * tone;
    }
  }
  const fade = Math.trunc(RELEASE * SAMPLE_RATE);
  for (let index = count - fade; index < count; index++) samples[index] *= (count - index) / fade;
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0 ? PEAK / peak : 0;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = samples[i] * scale;
  return out;
}

export const renderRecipe = (r: Recipe): Float32Array => renderWave(r.notes, r.partials, r.duration);
