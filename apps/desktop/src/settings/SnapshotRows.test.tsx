// Settings › Computer › Snapshot of any app (item 104), drawn with react-dom/server: off until the person turns it on,
// the suggested keys shown, one line for where the key stands (off, on, taken, or why those keys cannot be used), the
// picture switch off too, the line for a Mac without Accessibility, and what it reads; and the page's own rows on the
// Computer page, which the App Store edition does not draw.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import type { SnapState } from "../computer/snapshot";
import { SnapshotRowsView, statusText, type SnapshotRowsProps } from "./SnapshotRows";
import { ComputerView } from "./ComputerPage";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const OFF: SnapState = { on: false, keys: "Control+Option+Command+M", shown: "⌃⌥⌘M", picture: false, status: "off", suggested: "Control+Option+Command+M", suggestedShown: "⌃⌥⌘M" };

function draw(over: Partial<SnapshotRowsProps> = {}) {
  return renderToString(<SnapshotRowsView state={OFF} accessibility onOn={noop} onKeys={noop} onPicture={noop} {...over} />);
}

afterEach(() => setLang("en"));

describe("Settings › Computer › Snapshot of any app", () => {
  it("is off until the person turns it on, with the suggested keys shown and nothing registered", () => {
    const html = draw();
    expect(html).toMatch(/data-testid="snap-onoff"[\s\S]*?aria-checked="false"[^>]*>On<[\s\S]*?aria-checked="true"[^>]*>Off</);
    expect(html).toMatch(/data-testid="snap-picture"[\s\S]*?aria-checked="true"[^>]*>Off</);
    expect(html).toMatch(/value="⌃⌥⌘M"[^>]*data-testid="snap-keys"|data-testid="snap-keys"[^>]*value="⌃⌥⌘M"/);
    expect(html).toContain('data-status="off"');
    expect(words(html)).toContain("Off. No key is set with macOS, so ⌃⌥⌘M does nothing.");
    expect(words(html)).toContain("Nothing is sent until you press Send.");
    // the suggestion is the keys already: no button to take it
    expect(html).not.toContain('data-testid="snap-suggest"');
  });

  it("says where the key stands: on, taken by another app, or why the keys cannot be used", () => {
    expect(statusText({ ...OFF, on: true, status: "on" })).toBe("On. Press ⌃⌥⌘M in any app.");
    expect(statusText({ ...OFF, on: true, status: "taken" })).toBe("Another app or macOS already uses ⌃⌥⌘M. Choose other keys.");
    expect(statusText({ ...OFF, on: true, keys: "Command+M", shown: "⌘M", status: "invalid", why: "modifiers" })).toBe("Use two of Control, Option and Command, so no app loses its own shortcut.");
    expect(statusText({ ...OFF, on: true, keys: "Control+Command+Q", shown: "⌃⌘Q", status: "invalid", why: "macos" })).toBe("macOS or every app's menus use ⌃⌘Q. Choose other keys.");
    const taken = draw({ state: { ...OFF, on: true, keys: "Control+Option+Command+J", shown: "⌃⌥⌘J", status: "taken" } });
    expect(taken).toContain('data-status="taken"');
    // other keys than the suggestion: one press takes the suggestion back
    expect(words(taken)).toContain("Use ⌃⌥⌘M");
  });

  it("says the key needs Accessibility when macOS has not given it, and what is never read", () => {
    expect(draw({ accessibility: false })).toContain('data-testid="snap-needs"');
    expect(draw({ accessibility: true })).not.toContain('data-testid="snap-needs"');
    const text = words(draw());
    expect(text).toContain("never Manut AI's own windows and pages, System Settings, Keychain Access, Passwords");
    expect(text).toContain("A picture is not masked");
  });

  it("is drawn on the Computer page, and not in the App Store edition", () => {
    const page = (appStore: boolean) =>
      renderToString(<ComputerView offered status={{ accessibility: true, screen: true, signed: true }} onOpen={noop} onRecheck={noop} appStore={appStore} snapshot={<SnapshotRowsView state={OFF} accessibility onOn={noop} onKeys={noop} onPicture={noop} />} />);
    expect(page(false)).toContain('data-testid="snap-rows"');
    expect(page(true)).not.toContain('data-testid="snap-rows"');
  });

  it("reads in every language", () => {
    for (const [lang, title] of [["ja", "どのアプリからでもスナップショット"], ["ko", "어느 앱에서나 스냅샷"], ["zh", "任意应用的快照"]] as const) {
      setLang(lang);
      expect(words(draw())).toContain(title);
    }
  });
});
