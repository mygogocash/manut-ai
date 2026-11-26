// The finish sound's choices: Default (the synthesized chime in recipes.ts) and five tones from the Android Open Source
// Project, bundled as WAV files (src/assets/sounds/, AndroidSoundSources.json says where each came from).
import type { Key } from "../i18n";

export const TONES = ["default", "heaven", "highwire", "iridium", "krypton", "kzurbSonar"] as const;
export type ToneId = (typeof TONES)[number];

/** The words each choice shows. */
export const TONE_LABEL: Record<ToneId, Key> = {
  default: "sounds.tone.default",
  heaven: "sounds.tone.heaven",
  highwire: "sounds.tone.highwire",
  iridium: "sounds.tone.iridium",
  krypton: "sounds.tone.krypton",
  kzurbSonar: "sounds.tone.kzurbSonar",
};

/** Where each tone's file is served from (Vite gives each a hashed address in the build). Default has none. */
export const TONE_URL: Record<Exclude<ToneId, "default">, string> = {
  heaven: new URL("../assets/sounds/Tone-Heaven.wav", import.meta.url).href,
  highwire: new URL("../assets/sounds/Tone-Highwire.wav", import.meta.url).href,
  iridium: new URL("../assets/sounds/Tone-Iridium.wav", import.meta.url).href,
  krypton: new URL("../assets/sounds/Tone-Krypton.wav", import.meta.url).href,
  kzurbSonar: new URL("../assets/sounds/Tone-KzurbSonar.wav", import.meta.url).href,
};
