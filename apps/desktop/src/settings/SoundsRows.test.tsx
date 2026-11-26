// Settings › General › Sounds and chimes, drawn with react-dom/server: each row, the tone picker with Default and the five tones
// and its Preview, the switches as given, and every word in all four languages.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import { TONES } from "../sound";
import { SoundsRowsView, type SoundsRowsProps } from "./SoundsRows";

const noop = () => {};
const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const draw = (over: Partial<SoundsRowsProps> = {}) =>
  renderToString(<SoundsRowsView finish tone="default" settle effort onFinish={noop} onTone={noop} onSettle={noop} onEffort={noop} onPreview={noop} {...over} />);

afterEach(() => setLang("en"));

describe("Settings › Sounds and chimes", () => {
  it("has the finish chime, the finish sound with Preview, the settle sound and the effort slider's sound, each on at first", () => {
    setLang("en");
    const html = draw();
    for (const id of ["sound-finish-seg", "sound-preview", "sound-tone", "sound-settle-seg", "sound-effort-seg"]) expect(html, id).toContain(`data-testid="${id}"`);
    expect(html.match(/aria-checked="true"[^>]*>On</g)).toHaveLength(3);
    const text = words(html);
    for (const w of ["Finish chime", "Finish sound", "Preview", "Done for now sound", "Effort slider sound"]) expect(text, w).toContain(w);
  });

  it("has no tooltip row: the app has no tooltip component of its own", () => {
    expect(words(draw()).toLowerCase()).not.toContain("tooltip");
  });

  it("offers Default and the five tones, and shows the one chosen", () => {
    setLang("en");
    const html = draw({ tone: "krypton" });
    expect(html.match(/<option/g)).toHaveLength(TONES.length);
    for (const w of ["Default", "Heaven", "Highwire", "Iridium", "Krypton", "Kzurb Sonar"]) expect(words(html)).toContain(w);
    expect(html).toMatch(/<option value="krypton" selected/);
  });

  it("shows a switch that is off as off", () => {
    setLang("en");
    const html = draw({ finish: false, settle: false, effort: false });
    expect(html.match(/aria-checked="true"[^>]*>Off</g)).toHaveLength(3);
  });

  it("reads in every language, with no key left bare", () => {
    for (const lang of LANGS) {
      setLang(lang);
      const text = words(draw());
      for (const k of ["sounds.finish", "sounds.tone", "sounds.preview", "sounds.settle", "sounds.effort", "sounds.tone.default"] as const) {
        expect(t(k), `${lang} ${k}`).not.toBe(k);
        expect(text, `${lang} ${k}`).toContain(t(k));
      }
    }
  });
});
