// Settings › Voice, drawn with react-dom/server: the three choices, what works on this Mac for Thai and for English as
// the Mac reported it, what does not work yet, the permissions, and what is never kept, in every language.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { DEFAULT_PREFS, type HearStatus } from "../voice/voice";
import { voicesFor, VoiceView, worksLine, type VoiceViewProps } from "./VoicePage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const thai: HearStatus = { lang: "th-TH", supported: true, available: true, onDevice: false, speech: "notAsked", mic: "notAsked" };
const english: HearStatus = { ...thai, lang: "en-US", onDevice: true };

function draw(over: Partial<VoiceViewProps> = {}) {
  return renderToString(
    <VoiceView offered prefs={DEFAULT_PREFS} statuses={{ "th-TH": thai, "en-US": english }} voices={[]} onLang={noop} onWhere={noop} onVoice={noop} {...over} />,
  );
}

afterEach(() => setLang("en"));

describe("Settings › Voice", () => {
  it("offers Thai and English, this Mac only or Apple, and the voice for answers, with Thai and this Mac at first", () => {
    setLang("en");
    const html = draw();
    expect(html).toMatch(/aria-checked="true"[^>]*>Thai \(ไทย\)</);
    expect(html).toMatch(/aria-checked="true"[^>]*>This Mac only</);
    expect(html).toContain('data-testid="voice-voice"');
    expect(words(html)).toContain("The Mac's default");
    // the yes to Apple shows as on once given, and can be taken back here
    expect(draw({ prefs: { ...DEFAULT_PREFS, where: "apple" } })).toMatch(/aria-checked="true"[^>]*>Apple when needed</);
  });

  it("says what works on this Mac for each language, as the Mac reported it", () => {
    setLang("en");
    const text = words(draw());
    expect(text).toContain("Thai (ไทย): this Mac cannot recognize it by itself, so it works only through Apple's servers, after your yes.");
    expect(text).toContain("English: recognized on this Mac. Nothing is sent.");
    // and what does not work yet, plainly
    expect(text).toContain("Thai on this Mac alone is not here yet.");
    expect(draw({ statuses: { "th-TH": { ...thai, onDevice: true }, "en-US": english } })).not.toContain("voice-thai-later");
    expect(worksLine(undefined, "th-TH")).toBe("Thai (ไทย): this Mac cannot turn it into text.");
    expect(words(draw({ statuses: null }))).toContain("Checking what this Mac can do");
  });

  it("shows the two permissions as macOS keeps them, and what is never kept", () => {
    setLang("en");
    const text = words(draw({ statuses: { "th-TH": { ...thai, mic: "denied", speech: "allowed" }, "en-US": english } }));
    expect(text).toContain("Microphone Turned off. Turn it on in System Settings › Privacy & Security.");
    expect(text).toContain("Speech recognition Allowed");
    expect(text).toContain("Nothing is recorded. No audio is written to a file, and neither the audio nor the words heard go to a log.");
    expect(text).toContain("Voice mode never answers an ask.");
  });

  it("lists the Mac's voices for the language spoken only", () => {
    const all = [
      { id: "kanya", name: "Kanya", lang: "th-TH" },
      { id: "samantha", name: "Samantha", lang: "en-US" },
      { id: "daniel", name: "Daniel", lang: "en_GB" },
    ];
    expect(voicesFor(all, "th-TH").map((v) => v.id)).toEqual(["kanya"]);
    expect(voicesFor(all, "en-US").map((v) => v.id)).toEqual(["samantha", "daniel"]);
    const html = draw({ voices: voicesFor(all, "th-TH"), prefs: { ...DEFAULT_PREFS, voices: { "th-TH": "kanya" } } });
    expect(html).toMatch(/<option value="kanya" selected="">Kanya<\/option>/);
  });

  it("says voice is for the Mac app where it is not offered", () => {
    setLang("en");
    const html = draw({ offered: false });
    expect(words(html)).toContain("Voice works in the Mac app only.");
    expect(html).not.toContain("voice-lang");
  });

  it("has its words in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      const html = draw();
      expect(words(html), l).toContain(t("voice.set.where"));
      expect(html, l).not.toMatch(/\{\w+\}/);
    }
  });
});
