// The overlay, drawn with react-dom/server as the other component tests draw theirs.
import { beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { PaletteView, type PaletteViewProps } from "./Palette";
import type { Group } from "./groups";

const noop = () => {};
const row = (id: string, label: string, hint?: string) => ({ id, label, hint, run: noop });
const groups: Group[] = [
  { key: "go", heading: "pal.go", rows: [row("go:a", "Team"), row("go:b", "History")] },
  { key: "do", heading: "pal.do", rows: [row("do:a", "New session")] },
  { key: "chats", heading: "pal.chats", rows: [row("chat:a", "Refund for Khun Mali", "Nam")] },
];

function draw(over: Partial<PaletteViewProps> = {}) {
  return renderToString(<PaletteView query="" onQuery={noop} groups={groups} cursor={0} onPick={noop} onHover={noop} onKeyDown={noop} onBackdrop={noop} {...over} />);
}
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("the palette's overlay", () => {
  beforeEach(() => setLang("en"));

  it("is a modal dialog with a field over a listbox of options", () => {
    const html = draw();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(count(html, 'role="option"')).toBe(4);
  });

  it("heads the groups Go to, Do and Chats, in that order", () => {
    const html = draw();
    const at = ["Go to", "Do", "Chats"].map((h) => html.indexOf(`>${h}<`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("marks exactly the row under the cursor, and names it for the field", () => {
    const html = draw({ cursor: 2 });
    expect(count(html, 'aria-selected="true"')).toBe(1);
    expect(html).toContain('aria-activedescendant="palette-opt-2"');
    expect(html).toMatch(/id="palette-opt-2"[^>]*aria-selected="true"/);
  });

  it("shows a chat's member beside its title, and says so when nothing is found", () => {
    expect(draw()).toContain("Refund for Khun Mali");
    const none = draw({ groups: [] });
    expect(none).toContain('data-testid="palette-none"');
    expect(none).toContain("Nothing found");
    expect(none).not.toContain("aria-activedescendant");
  });

  it("speaks the app's language", () => {
    setLang("ja");
    const html = draw({ groups: [{ key: "go", heading: "pal.go", rows: [row("go:a", "x")] }] });
    expect(html).toContain("移動");
    expect(html).toContain("コマンドパレット");
  });
});
