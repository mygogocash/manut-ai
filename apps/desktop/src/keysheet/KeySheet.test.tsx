// The key sheet (item 167d), drawn from a given list with react-dom/server: a modal box with a search field over every key by
// group, read only, each key the person can set offering Change and each fixed key only naming itself.
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { defaultKeys, forgetKeys, KEY_ACTIONS } from "../app/keys";
import { sheetGroups } from "../app/keyList";
import { KeySheetView, type KeySheetViewProps } from "./KeySheet";

const noop = () => {};
const draw = (over: Partial<KeySheetViewProps> = {}, query = "") =>
  renderToString(<KeySheetView query={query} onQuery={noop} groups={sheetGroups(defaultKeys(true), true, query)} onChange={noop} onSettings={noop} onBackdrop={noop} onKeyDown={noop} {...over} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  setLang("en");
  forgetKeys();
});

describe("the key sheet", () => {
  it("is a modal dialog named Keyboard shortcuts, with a search field first and Esc to close", () => {
    const html = draw();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Keyboard shortcuts"');
    expect(html).toMatch(/<input[^>]*role="searchbox"[^>]*placeholder="Search shortcuts"[^>]*data-testid="keysheet-input"/);
    expect(html).toMatch(/<span class="pal-kbd" aria-hidden="true">Esc<\/span>/);
  });

  it("lists every key under a heading for each group, in the groups' order", () => {
    const html = draw();
    const at = ["Go to", "Chat", "Panels", "Terminals", "Help"].map((h) => html.indexOf(`>${h}</div>`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const g of ["go", "chat", "panels", "terminals", "help"]) expect(html).toContain(`data-testid="keysheet-group-${g}"`);
    // every action the app registers, by its words and its keys
    expect(html).toContain("Command palette: go anywhere, do anything");
    expect(html).toContain("<kbd class=\"kcap ks-k\">⌘K</kbd>");
    expect(html).toContain("<kbd class=\"kcap ks-k\">⌘N</kbd><kbd class=\"kcap ks-k\">⌘T</kbd>");
    expect(html).toContain("Show every shortcut");
    expect(html).toContain("<kbd class=\"kcap ks-k\">⌘/</kbd>");
  });

  it("offers Change on a key the person can set, naming the action, and on no fixed key", () => {
    const html = draw();
    const rows = html.split('data-testid="keysheet-row"').slice(1);
    const withChange = rows.filter((r) => r.includes('data-testid="keysheet-change"'));
    expect(withChange).toHaveLength(count(html, 'data-testid="keysheet-change"'));
    // one for each action keys.ts registers (the lane keys of item 167a and the sheet's own among them)
    expect(withChange.length).toBe(KEY_ACTIONS.length);
    expect(html).toContain('aria-label="Change the keys for “Show or hide Details”"');
    // a fixed key: listed, with nothing to press
    const card = rows.find((r) => r.includes("1 · 2 · 3"))!;
    expect(card).toContain("Deny · Allow once · Allow for session (focused card)");
    expect(card).not.toContain("keysheet-change");
    const esc = rows.find((r) => r.includes("Stop the running answer"))!;
    expect(esc).not.toContain("keysheet-change");
  });

  it("says None for an action with no key, and still offers Change on it", () => {
    const keys = { ...defaultKeys(true), find: [] };
    const html = renderToString(<KeySheetView query="" onQuery={noop} groups={sheetGroups(keys, true)} onChange={noop} onSettings={noop} onBackdrop={noop} onKeyDown={noop} />);
    const row = html.split('data-testid="keysheet-row"').slice(1).find((r) => r.includes("Find in a chat"))!;
    expect(row).toContain('<span class="ks-none">None</span>');
    expect(row).toContain("keysheet-change");
  });

  it("shows only what the search finds, and says so when nothing is found", () => {
    const html = draw({}, "bottom terminal panel");
    expect(count(html, 'data-testid="keysheet-row"')).toBe(1);
    expect(html).toContain("Show or hide the bottom terminal panel");
    expect(html).not.toContain('data-testid="keysheet-group-chat"');
    const none = draw({}, "zzzz");
    expect(none).toContain('data-testid="keysheet-none"');
    expect(none).toContain("No shortcut matches “zzzz”");
    expect(count(none, 'data-testid="keysheet-row"')).toBe(0);
  });

  it("ends on the link to the Keyboard list where a key is set, and Esc", () => {
    const html = draw();
    expect(html).toMatch(/<button[^>]*data-testid="keysheet-settings"[^>]*>Change shortcuts in Settings › General › Keyboard<\/button>/);
    expect(html).toMatch(/<span class="pal-fh pal-fe">.*Esc.*closes<\/span><\/div>/);
  });

  it("is drawn inert while it fades out, so nothing in it takes a key or a press", () => {
    const html = draw({ leaving: true });
    expect(html).toContain("data-leaving");
    expect(html).toContain("inert");
    expect(draw()).not.toContain("data-leaving");
  });

  it("speaks the app's language", () => {
    setLang("zh");
    const html = renderToString(<KeySheetView query="" onQuery={noop} groups={sheetGroups(defaultKeys(true), true)} onChange={noop} onSettings={noop} onBackdrop={noop} onKeyDown={noop} />);
    expect(html).toContain("设置");
    expect(html).toContain("显示所有快捷键");
  });
});
