import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sound from "./index";
import { allowsSound, gateOpen, setGateForTests, silencedCount } from "./gate";
import { createPlayer, type PlayerDeps } from "./player";
import { FINISH, SETTLE } from "./recipes";
import { PREF_KEYS } from "./prefs";
import { TONE_URL } from "./tones";

// ---- stand-ins: no AudioContext is ever made, so nothing can make a sound ------------------------------------------------

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
}

function fakeAudio(state: AudioContextState = "running") {
  const log = { buffers: [] as number[], sources: [] as { buffer: unknown; started: number; stopped: number; volume: number; end: () => void }[], resumed: 0, decoded: 0 };
  const ctx = {
    state,
    destination: {},
    resume: () => ((log.resumed += 1), Promise.resolve()),
    createBuffer: (_c: number, length: number) => {
      log.buffers.push(length);
      return { length, copyToChannel() {} };
    },
    decodeAudioData: async (bytes: ArrayBuffer) => ((log.decoded += 1), { length: bytes.byteLength, decoded: true }),
    createGain: () => {
      const g = { gain: { value: 1 }, connect() {} };
      return g;
    },
    createBufferSource: () => {
      const rec = { buffer: null as unknown, started: 0, stopped: 0, volume: 0, end: () => undefined as void };
      log.sources.push(rec);
      const src = {
        set buffer(b: unknown) {
          rec.buffer = b;
        },
        onended: null as null | (() => void),
        connect() {},
        start() {
          rec.started += 1;
        },
        stop() {
          rec.stopped += 1;
        },
      };
      rec.end = () => src.onended?.();
      return src;
    },
  };
  // record the volume each gain node was given, in the order sources were made
  const make = ctx.createGain;
  ctx.createGain = () => {
    const g = make();
    const idx = log.sources.length; // the gain is made after the source
    Object.defineProperty(g.gain, "value", {
      set(v: number) {
        log.sources[idx - 1].volume = v;
      },
      get: () => 1,
    });
    return g;
  };
  return { ctx: ctx as unknown as AudioContext, log };
}

function player(over: Partial<PlayerDeps> = {}, state: AudioContextState = "running") {
  const audio = fakeAudio(state);
  const audioCalls = { n: 0 };
  const tones = { urls: [] as string[], fail: false };
  const deps: PlayerDeps = {
    audio: () => (audioCalls.n++, audio.ctx),
    loadTone: async (url) => {
      tones.urls.push(url);
      if (tones.fail) throw new Error("no file");
      return new ArrayBuffer(8);
    },
    allows: () => true,
    ...over,
  };
  return { p: createPlayer(deps), audio, audioCalls, tones };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  setGateForTests(null);
});

// ---- the gate ------------------------------------------------------------------------------------------------------------

describe("the gate", () => {
  it("is shut in a test run, so a test that reaches a sound makes none", () => {
    setGateForTests(null);
    expect(allowsSound()).toBe(false);
    expect(silencedCount()).toBe(1);
  });

  it("opens only outside tests and drivers, where an AudioContext exists", () => {
    const real = { mode: "production", webdriver: false, fakeAudio: false, hasAudio: true };
    expect(gateOpen(real)).toBe(true);
    expect(gateOpen({ ...real, mode: "test" })).toBe(false);
    expect(gateOpen({ ...real, webdriver: true })).toBe(false);
    // a Playwright spec whose AudioContext is a counting stand-in may let the player run, since it cannot make a sound
    expect(gateOpen({ ...real, webdriver: true, fakeAudio: true })).toBe(true);
    expect(gateOpen({ ...real, hasAudio: false })).toBe(false);
    expect(gateOpen({ ...real, mode: "development" })).toBe(true);
  });

  it("every player asks it first: each is refused at the gate before an AudioContext is made, a file fetched or a switch read", async () => {
    setGateForTests(false);
    const audioCalls = { n: 0 };
    const loads = { n: 0 };
    // the page's own gate, as the exported functions use it
    expect(await sound.playFinish("k")).toBe(false);
    expect(silencedCount()).toBe(1);
    expect(await sound.previewTone("heaven")).toBe(false);
    expect(await sound.playSettle()).toBe(false);
    expect(await sound.previewSettle()).toBe(false);
    expect(await sound.effortTick(0, 4)).toBe(false);
    expect(await sound.effortTick(3, 4)).toBe(false);
    expect(await sound.previewEffort(1, 4)).toBe(false);
    expect(await sound.tooltipTick("open")).toBe(false);
    await sound.warmTone("krypton");
    expect(silencedCount()).toBe(9);
    // and the same through a player of our own: it asks, and nothing else is touched
    const p = createPlayer({ audio: () => (audioCalls.n++, null), loadTone: async () => (loads.n++, new ArrayBuffer(0)) });
    await p.finish({ tone: "iridium" });
    await p.settle();
    await p.effort(0, 3);
    await p.tooltip("close");
    await p.warm("kzurbSonar");
    expect(silencedCount()).toBe(14);
    expect(audioCalls.n).toBe(0);
    expect(loads.n).toBe(0);
  });

  it("asks before the switch: a player that is switched off still reaches the gate", async () => {
    localStorage.setItem(PREF_KEYS.settle, "off");
    const asked = { n: 0 };
    const { p, audioCalls } = player({ allows: () => (asked.n++, true) });
    expect(await p.settle()).toBe(false);
    expect(asked.n).toBe(1);
    expect(audioCalls.n).toBe(0);
  });
});

// ---- playing -------------------------------------------------------------------------------------------------------------

describe("playing", () => {
  it("renders the finish chime once and reuses it, at 0.35", async () => {
    const { p, audio } = player();
    expect(await p.finish({ preview: true })).toBe(true);
    expect(await p.finish({ preview: true })).toBe(true);
    expect(audio.log.buffers).toEqual([30_869]);
    expect(audio.log.sources).toHaveLength(2);
    expect(audio.log.sources[0].volume).toBe(FINISH.volume);
    // a preview pressed again cuts the one still ringing and plays from the top
    expect(audio.log.sources[0].stopped).toBe(1);
  });

  it("a finish does not restart one still ringing, and plays again once it has ended", async () => {
    const { p, audio } = player();
    expect(await p.finish()).toBe(true);
    expect(await p.finish()).toBe(false);
    expect(audio.log.sources).toHaveLength(1);
    audio.log.sources[0].end();
    expect(await p.finish()).toBe(true);
    expect(audio.log.sources).toHaveLength(2);
  });

  it("the settle tick plays at 0.18, the effort ladder at its own volumes and the tooltip tick at 0.12", async () => {
    const { p, audio } = player();
    await p.settle();
    await p.effort(0, 5);
    await p.effort(4, 5);
    await p.tooltip("open");
    expect(audio.log.sources.map((s) => s.volume)).toEqual([SETTLE.volume, 0.16, 0.36, 0.12]);
    expect(audio.log.buffers).toEqual([14_112, 5_733, 10_584, 7_056]);
  });

  it("dragging back and forth across one stop ticks every time: the new tick cuts the old and reuses its buffer", async () => {
    const { p, audio } = player();
    await p.effort(2, 5);
    await p.effort(2, 5);
    await p.effort(2, 5);
    expect(audio.log.sources).toHaveLength(3);
    expect(audio.log.buffers).toHaveLength(1);
    expect(audio.log.sources.map((s) => s.stopped)).toEqual([1, 1, 0]);
  });

  it("is silent for a level that is not on the slider", async () => {
    const { p, audio } = player();
    expect(await p.effort(5, 5)).toBe(false);
    expect(audio.log.sources).toHaveLength(0);
  });

  it("makes no sound when there is no AudioContext", async () => {
    const { p } = player({ audio: () => null });
    expect(await p.finish()).toBe(false);
    expect(await p.settle()).toBe(false);
  });

  it("resumes a context the browser holds", async () => {
    const { p, audio } = player({}, "suspended");
    await p.settle();
    expect(audio.log.resumed).toBe(1);
  });
});

describe("the tones", () => {
  it("a chosen tone is fetched from its bundled file once, decoded and played at 0.35", async () => {
    const { p, audio, tones } = player();
    sound.setFinishTone("heaven");
    expect(await p.finish({ preview: true })).toBe(true);
    expect(await p.finish({ preview: true })).toBe(true);
    expect(tones.urls).toEqual([TONE_URL.heaven]);
    expect(audio.log.decoded).toBe(1);
    expect(audio.log.buffers).toEqual([]);
    expect(audio.log.sources[0].volume).toBe(0.35);
    expect((audio.log.sources[0].buffer as { decoded: boolean }).decoded).toBe(true);
  });

  it("falls back to the chime when a file cannot be read", async () => {
    const { p, audio, tones } = player();
    tones.fail = true;
    expect(await p.finish({ tone: "krypton", preview: true })).toBe(true);
    expect(audio.log.buffers).toEqual([30_869]);
  });

  it("warm reads a tone ahead, and Default has nothing to read", async () => {
    const { p, tones } = player();
    await p.warm("default");
    await p.warm("iridium");
    expect(tones.urls).toEqual([TONE_URL.iridium]);
  });

  it("each of the five has a file address", () => {
    expect(Object.keys(TONE_URL).sort()).toEqual(["heaven", "highwire", "iridium", "krypton", "kzurbSonar"]);
    for (const url of Object.values(TONE_URL)) expect(url).toMatch(/Tone-[A-Za-z]+\.wav$/);
  });
});

describe("the switches", () => {
  it("a switched-off sound plays nothing, but its Preview still plays", async () => {
    sound.setFinishChimeEnabled(false);
    sound.setSettleSoundEnabled(false);
    sound.setEffortSoundEnabled(false);
    sound.setTooltipSoundEnabled(false);
    const { p, audio } = player();
    expect(await p.finish()).toBe(false);
    expect(await p.settle()).toBe(false);
    expect(await p.effort(1, 4)).toBe(false);
    expect(await p.tooltip("open")).toBe(false);
    expect(audio.log.sources).toHaveLength(0);
    expect(await p.finish({ preview: true })).toBe(true);
    expect(await p.settle({ preview: true })).toBe(true);
    expect(await p.effort(1, 4, { preview: true })).toBe(true);
  });
});

describe("one finish, one sound", () => {
  it("a finish that already sounded (same key) makes no second sound, even after the first one ended", async () => {
    const { p, audio } = player();
    expect(await p.finish({ key: "kami\nturn:1" })).toBe(true);
    // the first ended: the voice is free again, yet the same finish is still the same finish
    audio.log.sources[0].end();
    expect(await p.finish({ key: "kami\nturn:1" })).toBe(false);
    expect(audio.log.sources).toHaveLength(1);
  });

  it("another finish has its own key, and a preview needs none", async () => {
    const { p, audio } = player();
    expect(await p.finish({ key: "a" })).toBe(true);
    expect(await p.finish({ key: "b", preview: true })).toBe(true);
    expect(audio.log.sources).toHaveLength(2);
  });

  it("a finish held back by the switch does not use its key up", async () => {
    sound.setFinishChimeEnabled(false);
    const { p } = player();
    expect(await p.finish({ key: "a" })).toBe(false);
    sound.setFinishChimeEnabled(true);
    expect(await p.finish({ key: "a" })).toBe(true);
  });
});
