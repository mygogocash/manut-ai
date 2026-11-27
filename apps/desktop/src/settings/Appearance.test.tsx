// Settings › General › Appearance (item 99b), drawn with react-dom/server: the brand's look with its rows (theme, bubbles,
// text size, chat width, colours) and the two ways to a theme of one's own; a theme of the person's own picked, with its
// name, its six colours as they are drawn and Delete; the words of each refusal; and every word in all four languages.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { LANGS, setLang } from "../i18n";
import { reloadThemes } from "../theme/library";
import { fullColors, ROLE_TOKEN, ROLES, type UserTheme } from "../theme/themes";
import type { Store } from "../state/store";

const words = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const harbor: UserTheme = { id: "mine-harbor01", name: "Harbor Night", from: "vscode", dark: { "--main": "#1b2330", "--aui-ink": "#d8dee9", "--side": "#161d28" } };

function disk(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
}

let Appearance: () => ReactElement;
let mod: typeof import("./Appearance");
let store: Store;
beforeAll(async () => {
  mod = await import("./Appearance");
  Appearance = mod.Appearance;
  store = (await import("../state/store")).getStore();
}, 30_000);
beforeEach(() => {
  setLang("en");
  disk();
  reloadThemes();
  store.actions.setLook({ palette: "manut", width: "medium" });
  store.actions.setTheme("dark");
});
afterEach(() => {
  vi.unstubAllGlobals();
  reloadThemes();
});

describe("Settings › General › Appearance", () => {
  it("has the theme, bubbles, text size, chat width and colours rows, the brand's look picked and no editor", () => {
    const html = renderToString(<Appearance />);
    for (const id of ["appearance-preview", "theme-seg", "bubbles-seg", "text-seg", "width-seg", "theme-pick", "theme-make", "theme-import", "theme-file"]) expect(html, id).toContain(`data-testid="${id}"`);
    expect(html).toMatch(/<option value="manut" selected="">Manut AI<\/option>/);
    expect(html).not.toContain('data-testid="theme-editor"');
    const text = words(html);
    for (const w of ["Chat width", "Narrow", "Medium", "Wide", "Colours", "The brand's look, or a theme of your own", "Make my own", "Import VS Code theme…"]) expect(text, w).toContain(w);
    // the file picker takes a theme's JSON only
    expect(html).toMatch(/type="file" accept="\.json,\.jsonc,application\/json" hidden=""/);
  });

  it("marks the chat width in force", () => {
    store.actions.setLook({ width: "wide" });
    expect(renderToString(<Appearance />)).toMatch(/data-testid="width-seg"[^]*?aria-checked="true" class="ui-mode"[^>]*>Wide</);
  });

  it("with a theme of the person's own picked: its name, its six colours as drawn, Delete, and that it is dark only", () => {
    disk({ "manut.themes": JSON.stringify({ v: 1, themes: [harbor] }) });
    reloadThemes();
    store.actions.setLook({ palette: harbor.id });
    const html = renderToString(<Appearance />);
    expect(html).toMatch(/<option value="mine-harbor01" selected="">Harbor Night<\/option>/);
    expect(html).toContain('data-testid="theme-editor"');
    expect(html).toContain(`data-testid="theme-name" value="Harbor Night"`);
    const full = fullColors("dark", harbor.dark!);
    for (const role of ROLES) expect(html, role).toMatch(new RegExp(`type="color" class="ap-colour"[^>]*data-testid="theme-colour-${role}" value="${full[ROLE_TOKEN[role]]}"`));
    expect(html).toContain('data-testid="theme-delete"');
    expect(words(html)).toContain("A dark theme: while the app is light, the brand's light look shows");
    for (const w of ["Background", "Side menu", "Text", "Second-line text", "Accent", "Lines", "Delete theme"]) expect(words(html), w).toContain(w);
  });

  it("says why a theme was refused, with the ratio and the background", () => {
    expect(mod.shortfallWords({ what: "muted", band: "--hov", ratio: 4.46 })).toBe("second-line text would read at 4.4 to 1 on a highlighted row, and text needs 4.5 to 1.");
    expect(mod.shortfallWords({ what: "text", band: "--side", ratio: 3.02 })).toBe("text would read at 3.0 to 1 on the side menu, and text needs 4.5 to 1.");
    expect(mod.refusalWords({ kind: "big" })).toBe("the file is over 1 MB, and a VS Code theme is far smaller.");
    expect(mod.refusalWords({ kind: "parse" })).toBe("it is not a theme file Manut AI can read (JSON, comments allowed).");
    expect(mod.refusalWords({ kind: "noColors" })).toBe('it has no colours (a VS Code theme keeps them under "colors").');
    expect(mod.refusalWords({ kind: "noBackground" })).toBe("it has no background colour (editor.background).");
    expect(mod.refusalWords({ kind: "many" })).toBe("you have 40 themes, the most Manut AI keeps. Delete one first.");
  });

  it("reads in every language, with no English left on General's rows outside names", () => {
    disk({ "manut.themes": JSON.stringify({ v: 1, themes: [harbor] }) });
    reloadThemes();
    store.actions.setLook({ palette: harbor.id });
    for (const lang of LANGS.filter((l) => l !== "en")) {
      setLang(lang);
      const text = words(renderToString(<Appearance />))
        // what stays as written: the product, a theme's own name, the preview's sample code and the editor's name
        .replace(/Manut AI|Harbor Night|VS Code|\/v1\/responses|\/plan|keep-alive|MB|Mac/g, "");
      expect(text, lang).not.toMatch(/[A-Za-z]{3,}/);
    }
  });
});
