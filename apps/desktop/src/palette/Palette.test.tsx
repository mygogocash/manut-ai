// The overlay, drawn with react-dom/server as the other component tests draw theirs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { forgetKeys, KEYS_KEY, setKeys } from "../app/keys";
import { PaletteView, pointerMoved, type PaletteViewProps } from "./Palette";
import type { Group } from "./groups";
import type { KeyAction } from "../app/keys";

const noop = () => {};
const row = (id: string, label: string, hint?: string) => ({ id, label, hint, run: noop });
const groups: Group[] = [
  { key: "go", heading: "pal.go", rows: [{ ...row("go:a", "Team"), icon: "users" }, row("go:b", "History")], icon: "chevron-right" },
  { key: "do", heading: "pal.do", rows: [row("do:a", "New session")], icon: "chevron-right" },
  { key: "chats", heading: "pal.chats", rows: [row("chat:a", "Refund for Khun Mali", "Nam")], icon: "clock" },
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

  it("heads the groups Go to, Actions and Chats, in that order, in sentence case as the Search board writes them", () => {
    const html = draw();
    const at = ["Go to", "Actions", "Chats"].map((h) => html.indexOf(`>${h}<`));
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

  it("draws every row as the canvas's Search board does: an icon of the set before its word (item 85i)", () => {
    const html = draw();
    expect(count(html, 'class="pal-row')).toBe(4);
    for (const m of html.matchAll(/<li[^>]*class="pal-row[^"]*"[^>]*>(.*?)<\/li>/g)) expect(m[1]).toMatch(/^<svg class="ic"[^>]*viewBox="0 0 16 16"/);
    // a row's own icon, else its group's: Team is the menu's users, a chat the clock of Recent
    expect(html).toMatch(/data-row="go:a"><svg[^>]*><circle cx="6" cy="6" r="2.2"/);
    expect(html).toMatch(/data-row="chat:a"><svg[^>]*><circle cx="8" cy="8" r="5.5"/);
    // the field has the magnifier and says Esc closes it
    expect(html).toMatch(/<div class="pal-s"><svg class="ic"[^>]*>.*<input[^>]*data-testid="palette-input"[^>]*\/><span class="pal-kbd" aria-hidden="true">Esc<\/span>/);
  });

  it("speaks the app's language", () => {
    setLang("ja");
    const html = draw({ groups: [{ key: "go", heading: "pal.go", rows: [row("go:a", "x")], icon: "chevron-right" }] });
    expect(html).toContain("移動");
    expect(html).toContain("コマンドパレット");
  });
});

describe("the cursor follows the pointer only when the pointer moves", () => {
  it("takes a move to a new place, and never the first move or one at the same place (the list changing under a resting pointer)", () => {
    expect(pointerMoved(null, 10, 20)).toBe(false);
    expect(pointerMoved({ x: 10, y: 20 }, 10, 20)).toBe(false);
    expect(pointerMoved({ x: 10, y: 20 }, 11, 20)).toBe(true);
    expect(pointerMoved({ x: 10, y: 20 }, 10, 19)).toBe(true);
  });
});

// ---- keys where the actions are (item 167d) -------------------------------------------------------------------------------------

describe("the keys the palette teaches", () => {
  const storage = new Map<string, string>();
  const mac = (on: boolean) => vi.stubGlobal("navigator", { platform: on ? "MacIntel" : "Linux x86_64" });
  beforeEach(() => {
    storage.clear();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
    forgetKeys();
    setLang("en");
    mac(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  const keyed = (id: string, label: string, keyAction: KeyAction) => ({ ...row(id, label), keyAction });
  const withKeys: Group[] = [
    { key: "do", heading: "pal.do", rows: [keyed("do:new-session", "New chat or terminal", "new-session"), row("do:new-chat", "New thread with Buddy")], icon: "chevron-right" },
  ];
  const rowHtml = (html: string, id: string) => new RegExp(`<li[^>]*data-row="${id}"[^>]*>.*?</li>`).exec(html)![0];

  it("shows a row's key at its tail as the Search board draws it, a cap for each key, and names it to assistive technology", () => {
    const html = draw({ groups: withKeys });
    const keyedRow = rowHtml(html, "do:new-session");
    expect(keyedRow).toContain('aria-keyshortcuts="Meta+N"');
    expect(keyedRow).toMatch(/<span class="pal-n">New chat or terminal<\/span><span class="kcaps" aria-hidden="true" data-testid="keycaps"><kbd class="kcap">⌘<\/kbd><kbd class="kcap">N<\/kbd><\/span><\/li>/);
    // a row whose action has no key shows none
    const plain = rowHtml(html, "do:new-chat");
    expect(plain).not.toContain("kcap");
    expect(plain).not.toContain("aria-keyshortcuts");
  });

  it("draws the keys of the keyboard it is on: Ctrl and N off a Mac", () => {
    mac(false);
    forgetKeys();
    const keyedRow = rowHtml(draw({ groups: withKeys }), "do:new-session");
    expect(keyedRow).toContain('aria-keyshortcuts="Control+N"');
    expect(keyedRow).toContain('<kbd class="kcap">Ctrl</kbd><kbd class="kcap">N</kbd>');
  });

  it("shows the key the person set, and follows when they change it", () => {
    setKeys("new-session", [{ meta: true, ctrl: false, alt: true, shift: false, code: "KeyB" }], true);
    const keyedRow = rowHtml(draw({ groups: withKeys }), "do:new-session");
    expect(keyedRow).toContain('<kbd class="kcap">⌥</kbd><kbd class="kcap">⌘</kbd><kbd class="kcap">B</kbd>');
    expect(keyedRow).toContain('aria-keyshortcuts="Alt+Meta+B"');
    expect(keyedRow).not.toContain(">N<");
  });

  it("shows no key for an action the person gave none", () => {
    storage.set(KEYS_KEY, JSON.stringify({ "new-session": [], search: [] }));
    forgetKeys();
    const html = draw({ groups: withKeys });
    expect(rowHtml(html, "do:new-session")).not.toContain("kcap");
    expect(rowHtml(html, "do:new-session")).not.toContain("aria-keyshortcuts");
    expect(html).not.toContain('data-testid="palette-foot-key"');
  });

  it("ends on a foot that says what Return does, what Esc does and which key opens the palette (the person's own)", () => {
    const foot = /<div class="pal-foot" data-testid="palette-foot">(.*?)<\/div><\/div><\/div>$/.exec(draw())![1]!;
    expect(foot).toMatch(/<kbd class="kcap">Return<\/kbd><\/span>opens the marked row/);
    expect(foot).toMatch(/<kbd class="kcap">Esc<\/kbd><\/span>closes/);
    expect(foot).toMatch(/data-testid="palette-foot-key"><span class="kcaps"[^>]*><kbd class="kcap">⌘<\/kbd><kbd class="kcap">K<\/kbd><\/span>opens this menu from any screen/);
    // the first of the three, Return, leads; the palette's own key is last
    expect(foot.indexOf("Return")).toBeLessThan(foot.indexOf("Esc"));
    expect(foot.indexOf("Esc")).toBeLessThan(foot.indexOf("opens this menu"));
    setKeys("search", [{ meta: true, ctrl: false, alt: false, shift: false, code: "KeyP" }], true);
    expect(draw()).toMatch(/data-testid="palette-foot-key">.*<kbd class="kcap">P<\/kbd>.*opens this menu/);
    mac(false);
    forgetKeys();
    expect(draw()).toContain('<kbd class="kcap">Enter</kbd>');
  });
});
