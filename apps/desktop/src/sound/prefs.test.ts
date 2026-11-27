import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sound from "./index";
import { PREF_KEYS } from "./prefs";

function memoryStorage(broken = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (broken) throw new Error("denied");
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error("denied");
      m.set(k, v);
    },
    m,
  };
}

beforeEach(() => void vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => void vi.unstubAllGlobals());

describe("the sound switches", () => {
  it("start as GoSpark's do: every sound on, the Default tone", () => {
    expect(sound.finishChimeEnabled()).toBe(true);
    expect(sound.finishTone()).toBe("default");
    expect(sound.settleSoundEnabled()).toBe(true);
    expect(sound.effortSoundEnabled()).toBe(true);
    expect(sound.tooltipSoundEnabled()).toBe(true);
  });

  it("are saved on this computer, each under its own key, and read back", () => {
    sound.setFinishChimeEnabled(false);
    sound.setSettleSoundEnabled(false);
    sound.setEffortSoundEnabled(false);
    sound.setTooltipSoundEnabled(false);
    sound.setFinishTone("kzurbSonar");
    expect(sound.finishChimeEnabled()).toBe(false);
    expect(sound.settleSoundEnabled()).toBe(false);
    expect(sound.effortSoundEnabled()).toBe(false);
    expect(sound.tooltipSoundEnabled()).toBe(false);
    expect(sound.finishTone()).toBe("kzurbSonar");
    expect((localStorage as unknown as ReturnType<typeof memoryStorage>).m.get(PREF_KEYS.tone)).toBe("kzurbSonar");
    sound.setFinishChimeEnabled(true);
    expect(sound.finishChimeEnabled()).toBe(true);
  });

  it("keep every tone the picker offers, and read a value it does not know as Default", () => {
    for (const id of sound.TONES) {
      sound.setFinishTone(id);
      expect(sound.finishTone()).toBe(id);
    }
    localStorage.setItem(PREF_KEYS.tone, "ringtone-9");
    expect(sound.finishTone()).toBe("default");
  });

  it("offers Default and the five tones, each with its own words", () => {
    expect(sound.TONES).toEqual(["default", "heaven", "highwire", "iridium", "krypton", "kzurbSonar"]);
    expect(new Set(Object.values(sound.TONE_LABEL)).size).toBe(6);
  });

  it("fall back to the defaults when storage is missing or refuses", () => {
    vi.stubGlobal("localStorage", memoryStorage(true));
    expect(sound.finishChimeEnabled()).toBe(true);
    expect(sound.finishTone()).toBe("default");
    expect(() => sound.setFinishChimeEnabled(false)).not.toThrow();
    expect(() => sound.setFinishTone("heaven")).not.toThrow();
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", undefined);
    expect(sound.settleSoundEnabled()).toBe(true);
  });
});
