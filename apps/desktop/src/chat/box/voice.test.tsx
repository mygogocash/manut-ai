// The chat box's voice parts (Voice.tsx), drawn with react-dom/server from props as box.test.tsx draws the others: the two
// buttons before Send, the card that asks before a language goes to Apple's servers, the line that says plainly while
// the microphone or voice mode listens, waits, reads aloud or waits for an ask, and their words in every language.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LANGS, setLang, t } from "../../i18n";
import { OFF, type ModeState } from "../../voice/mode";
import type { MicView } from "../../voice/mic";
import { answersOf, VoiceAbove, VoiceButtons } from "./Voice";
import { voiceOffered } from "../../voice/engine";

afterEach(() => setLang("en"));

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const off: MicView = { kind: "off" };
const buttons = (mic: MicView, mode: ModeState, disabled = false) =>
  renderToString(createElement(VoiceButtons, { mic, mode, lang: "th-TH", disabled, onMic: vi.fn(), onMode: vi.fn() }));
const above = (p: Partial<Parameters<typeof VoiceAbove>[0]>) =>
  renderToString(createElement(VoiceAbove, { consent: null, mic: off, mode: OFF, lang: "th-TH", note: null, onYes: vi.fn(), onNo: vi.fn(), onStop: vi.fn(), ...p }));

describe("the microphone and voice mode buttons", () => {
  it("name the language spoken at rest and how to stop while on, and one is off while the other works", () => {
    const rest = buttons(off, OFF);
    expect(rest).toContain('data-testid="voice-mic"');
    expect(rest).toContain('data-testid="voice-mode"');
    expect(rest).toContain('aria-label="Speak your message (Thai (ไทย))"');
    expect(rest).toMatch(/aria-pressed="false"/);
    expect(rest).not.toContain("disabled");

    const listening = buttons({ kind: "listening", route: "onDevice" }, OFF);
    expect(listening).toContain('aria-label="Stop listening (Esc)"');
    expect(listening).toMatch(/class="bx-voice on" aria-pressed="true"/);
    expect(listening).toMatch(/disabled=""[^>]*data-testid="voice-mode"/);

    const talking = buttons(off, { ...OFF, phase: "speaking" });
    expect(talking).toContain('aria-label="Stop voice mode (Esc)"');
    expect(talking).toMatch(/disabled=""[^>]*data-testid="voice-mic"/);
    // offline: neither can start
    expect(buttons(off, OFF, true).match(/disabled=""/g)).toHaveLength(2);
  });
});

describe("what voice says over the box", () => {
  it("asks before a language goes to Apple's servers, in plain words, with a yes and a no", () => {
    const html = above({ consent: "th-TH" });
    const text = words(html);
    expect(html).toContain('data-testid="voice-consent"');
    expect(text).toContain("Thai (ไทย) is turned into text by Apple's servers");
    expect(text).toContain("what you say is sent to Apple's servers while you speak");
    expect(text).toContain("Manut AI keeps no recording");
    expect(text).toContain("Settings › Voice");
    expect(html).toContain('data-testid="voice-consent-yes"');
    expect(html).toContain('data-testid="voice-consent-no"');
  });

  it("says plainly while the microphone listens, where the words are made, and that nothing is sent", () => {
    expect(words(above({ mic: { kind: "starting" } }))).toContain("Starting the microphone");
    const device = words(above({ mic: { kind: "listening", route: "onDevice" } }));
    expect(device).toContain("Listening in Thai (ไทย), on this Mac.");
    expect(device).toContain("nothing is sent until you press Send");
    expect(words(above({ mic: { kind: "listening", route: "apple" }, lang: "th-TH" }))).toContain("through Apple's servers");
    expect(above({ mic: off })).not.toContain("voice-mic-line");
  });

  it("says what voice mode does in each phase, with the words heard while it listens, and a Stop", () => {
    const line = (m: Partial<ModeState>) => above({ mode: { ...OFF, ...m } });
    const listening = line({ phase: "listening", route: "onDevice", heard: "มีออเดอร์กี่รายการ" });
    expect(listening).toContain('data-phase="listening"');
    expect(words(listening)).toContain("Voice mode is listening in Thai (ไทย), on this Mac. Pause, and it sends what you said.");
    expect(words(listening)).toContain("มีออเดอร์กี่รายการ");
    expect(listening).toContain('data-testid="voice-stop"');
    expect(words(line({ phase: "waiting" }))).toContain("Waiting for the answer");
    expect(words(line({ phase: "speaking" }))).toContain("Reading the answer aloud");
    const paused = words(line({ phase: "paused" }));
    expect(paused).toContain("There is something to approve above. Voice mode waits: decide with the card, as always.");
    // the words heard are shown only while it listens, never once it waits or is paused
    expect(line({ phase: "paused", heard: "approve it" })).not.toContain("approve it");
    expect(above({ mode: OFF })).not.toContain("voice-strip");
  });

  it("shows why it stopped, or a note while it goes on", () => {
    expect(words(above({ mode: { ...OFF, note: "mic-denied" } }))).toContain("System Settings › Privacy & Security › Microphone");
    expect(words(above({ mode: { ...OFF, phase: "starting", note: "noAnswer" } }))).toContain("No answer came to read aloud. Listening again.");
    expect(words(above({ note: "Nothing was heard." }))).toContain("Nothing was heard.");
  });

  it("has every word in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      const html = above({ consent: "en-US", mic: { kind: "listening", route: "apple" }, mode: { ...OFF, phase: "paused" }, note: t("voice.err.nothing") });
      expect(words(html), l).toContain(t("voice.consentYes"));
      expect(words(html), l).toContain(t("voice.mode.paused"));
      expect(html, l).not.toMatch(/\{\w+\}/);
      expect(buttons(off, OFF), l).not.toMatch(/\{\w+\}/);
    }
  });
});

describe("what voice mode reads and where voice is offered", () => {
  it("reads the chat's answers only, in order", () => {
    expect(
      answersOf([
        { kind: "user", id: "u1", text: "hi" },
        { kind: "assistant", id: "a1", text: "hello" },
        { kind: "activity", id: "t1" },
        { kind: "assistant", id: "a2" },
      ]),
    ).toEqual([
      { id: "a1", text: "hello" },
      { id: "a2", text: "" },
    ]);
    expect(answersOf(undefined)).toEqual([]);
  });

  it("is not offered outside the Mac app unless a test asks for the stand-in", () => {
    expect(voiceOffered()).toBe(false);
  });
});
