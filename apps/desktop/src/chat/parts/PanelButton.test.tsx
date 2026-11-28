// The header's panel button names Details' key as the person set it (item 167d), where it used to say a ⌘. written into its words.
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n";
import { forgetKeys, KEYS_KEY, setKeys } from "../../app/keys";
import { PanelToggle } from "./PanelButton";

const storage = new Map<string, string>();
beforeEach(() => {
  storage.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  forgetKeys();
  setLang("en");
  vi.stubGlobal("navigator", { platform: "MacIntel" });
});
afterEach(() => vi.unstubAllGlobals());

const button = (working = 0) => {
  const tag = /<button[^>]*data-testid="panel-button"[^>]*>/.exec(renderToString(<PanelToggle working={working} />))![0];
  return { label: /aria-label="([^"]*)"/.exec(tag)?.[1], title: /title="([^"]*)"/.exec(tag)?.[1], keys: /aria-keyshortcuts="([^"]*)"/.exec(tag)?.[1] };
};

describe("the panel button's tooltip", () => {
  it("names Details' key: ⌘. to begin with, and Ctrl+. on a keyboard that is not a Mac's", () => {
    expect(button()).toEqual({ label: "Panel (⌘.)", title: "Panel (⌘.)", keys: "Meta+." });
    vi.stubGlobal("navigator", { platform: "Win32" });
    forgetKeys();
    expect(button()).toEqual({ label: "Panel (Ctrl+.)", title: "Panel (Ctrl+.)", keys: "Control+." });
  });

  it("says how many subagents work, with the key after it", () => {
    expect(button(1).label).toBe("Plans · 1 subagent working (⌘.)");
    expect(button(3).label).toBe("Plans · 3 subagents working (⌘.)");
  });

  it("names the key the person set, and only its words when they gave none", () => {
    setKeys("details", [{ meta: true, ctrl: false, alt: false, shift: false, code: "KeyB" }], true);
    expect(button()).toEqual({ label: "Panel (⌘B)", title: "Panel (⌘B)", keys: "Meta+B" });
    storage.set(KEYS_KEY, JSON.stringify({ details: [] }));
    forgetKeys();
    expect(button()).toEqual({ label: "Panel", title: "Panel", keys: undefined });
    expect(button(2).label).toBe("Plans · 2 subagents working");
  });
});
