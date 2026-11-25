// Settings › Computer (item 82), drawn with react-dom/server: the status line, the two permissions with their Open
// buttons and Re-check, what the agent may look at and do, the note for a copy macOS forgets permissions for, and the
// page in a browser or on Windows and Linux, in every language.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang } from "../i18n";
import { ComputerView, type ComputerViewProps } from "./ComputerPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};

function draw(over: Partial<ComputerViewProps> = {}) {
  return renderToString(<ComputerView offered status={{ accessibility: false, screen: false, signed: false }} onOpen={noop} onRecheck={noop} {...over} />);
}

afterEach(() => setLang("en"));

describe("Settings › Computer", () => {
  it("says what is missing, and ready only when both are on", () => {
    setLang("en");
    expect(words(draw())).toContain("Not ready: turn on Accessibility and Screen capture.");
    expect(draw()).toContain('data-ready="false"');
    expect(words(draw({ status: { accessibility: true, screen: false, signed: true } }))).toContain("Almost ready: your agent can read app windows.");
    const ready = draw({ status: { accessibility: true, screen: true, signed: true } });
    expect(ready).toContain('data-ready="true"');
    expect(words(ready)).toContain("Computer use is ready");
    expect(words(draw({ status: null }))).toContain("Checking…");
    expect(words(draw({ status: null, failed: true }))).toContain("Could not read what macOS allows.");
  });

  it("shows each permission as macOS keeps it, with a line on what it is for and a button to its pane", () => {
    setLang("en");
    const html = draw({ status: { accessibility: true, screen: false, signed: true } });
    expect(html).toMatch(/data-testid="computer-accessibility" data-granted="true"[^>]*>Allowed</);
    expect(html).toMatch(/data-testid="computer-screen" data-granted="false"[^>]*>Off</);
    expect(words(html)).toContain("Read app windows' text and controls, and click and type in them after your yes.");
    expect(words(html)).toContain("Take pictures of app windows so your agent can see what they show.");
    expect(html).toContain('data-testid="computer-open-accessibility"');
    expect(html).toContain('data-testid="computer-open-screen"');
    expect(html).toContain('data-testid="computer-recheck"');
    expect(words(html)).toContain("Nothing is turned on from here.");
  });

  it("says what is looked at, what asks first and what never happens", () => {
    setLang("en");
    const text = words(draw());
    expect(text).toContain("Look: only at the apps you allow, chat by chat.");
    expect(text).toContain("Never several under one yes, and nothing while the screen is locked.");
    expect(text).toContain("Never: Manut AI's own windows, System Settings, Keychain Access and Passwords");
  });

  it("says a copy not signed with a Developer ID loses both permissions at each update", () => {
    setLang("en");
    expect(words(draw())).toContain("not signed with a Developer ID, so macOS forgets both permissions after each update");
    expect(draw({ status: { accessibility: true, screen: true, signed: true } })).not.toContain("computer-unsigned");
  });

  it("in a browser, or on Windows and Linux, says computer use is on the Mac only", () => {
    setLang("en");
    const html = draw({ offered: false });
    expect(words(html)).toBe("Computer Computer use is on the Mac only for now.");
    expect(html).not.toContain("computer-open");
  });

  it("reads in every language", () => {
    for (const l of LANGS) {
      setLang(l);
      const text = words(draw({ status: { accessibility: true, screen: false, signed: false } }));
      expect(text, l).toContain("Manut AI");
      expect(text, l).toContain("Developer ID");
      expect(text, l).not.toContain("Computer use is ready");
    }
  });
});
