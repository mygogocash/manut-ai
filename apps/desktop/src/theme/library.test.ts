// The person's own themes, kept on this Mac (item 99b): saved and read back, changed in place, removed, at most 40, each
// checked as it is read so one changed by hand that breaks the text rule or holds anything but colours is left out; and
// the stylesheet that puts the picked one on the page, with the terminal told which colours it brings.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allThemes, freeName, MAX_THEMES, newThemeId, parseThemes, putTheme, reloadThemes, removeTheme, themeById, THEMES_KEY } from "./library";
import { applyTheme, THEME_STYLE_ID } from "./apply";
import { appTermColors, setAppTermColors } from "../sessions/term/appColors";
import { copyOf, type UserTheme } from "./themes";

let disk: Map<string, string>;
beforeEach(() => {
  disk = new Map();
  vi.stubGlobal("localStorage", { getItem: (k: string) => disk.get(k) ?? null, setItem: (k: string, v: string) => void disk.set(k, v), removeItem: (k: string) => void disk.delete(k) });
  reloadThemes();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setAppTermColors(null);
});

const night: UserTheme = { id: "mine-night001", name: "Night", from: "vscode", dark: { "--main": "#101820", "--aui-ink": "#e8edf2" }, term: { background: "#000000", red: "#ff5555" } };

describe("the themes kept on this Mac", () => {
  it("starts with none, and keeps nothing on disk while there are none", () => {
    expect(allThemes()).toEqual([]);
    expect(disk.has(THEMES_KEY)).toBe(false);
  });

  it("saves a theme and reads it back after a restart", () => {
    expect(putTheme(night)).toEqual({ ok: true });
    expect(JSON.parse(disk.get(THEMES_KEY)!)).toEqual({ v: 1, themes: [night] });
    reloadThemes();
    expect(themeById(night.id)).toEqual(night);
  });

  it("changes a theme in place by its id, and removes it", () => {
    putTheme(night);
    putTheme(copyOf(null, "mine-second01", "Second"));
    putTheme({ ...night, name: "Night 2" });
    expect(allThemes().map((t) => t.name)).toEqual(["Night 2", "Second"]);
    removeTheme(night.id);
    expect(allThemes().map((t) => t.id)).toEqual(["mine-second01"]);
    removeTheme("mine-second01");
    expect(disk.has(THEMES_KEY)).toBe(false);
  });

  it("refuses a theme that would not be read back, and a new one past the most it keeps", () => {
    expect(putTheme({ ...night, dark: { "--main": "#101820", "--aui-ink": "#18202a" } })).toEqual({ ok: false, why: "invalid" });
    for (let i = 0; i < MAX_THEMES; i++) expect(putTheme({ ...night, id: `mine-t${String(i).padStart(4, "0")}` }).ok).toBe(true);
    expect(putTheme({ ...night, id: "mine-onemore1" })).toEqual({ ok: false, why: "many" });
    // changing one already kept is still fine
    expect(putTheme({ ...night, id: "mine-t0003", name: "Changed" })).toEqual({ ok: true });
  });

  it("reads tolerantly: junk, a wrong shape, a theme changed by hand to break the rule, twice the same id", () => {
    for (const raw of [null, "", "{not json", "[]", '{"themes": 3}', '"x"']) expect(parseThemes(raw), String(raw)).toEqual([]);
    const broken = { ...night, id: "mine-broken01", dark: { "--main": "#101820", "--aui-ink": "#141c24" } };
    expect(parseThemes(JSON.stringify({ v: 1, themes: [night, broken, { ...night, name: "Again" }, 7] }))).toEqual([night]);
  });

  it("gives a new theme an id of the right shape that is not taken, and a name not taken", () => {
    putTheme(night);
    const seq = [0.1, 0.1, 0.5];
    const first = newThemeId(() => 0.1);
    putTheme({ ...night, id: first });
    expect(newThemeId(() => seq.shift()!)).not.toBe(first);
    expect(first).toMatch(/^mine-[a-z0-9]{8}$/);
    expect(freeName("Night")).toBe("Night 2");
    expect(freeName("Other")).toBe("Other");
  });
});

/** A page with a <head> and an <html> enough for applyTheme. */
function fakeDoc() {
  const head: { children: unknown[]; append(el: unknown): void; lastElementChild: unknown } = {
    children: [],
    append(el) {
      this.children = this.children.filter((c) => c !== el).concat(el);
      (el as { parentNode: unknown }).parentNode = head;
    },
    get lastElementChild() {
      return this.children[this.children.length - 1] ?? null;
    },
  };
  const els = new Map<string, { id: string; textContent: string; parentNode: unknown; remove(): void }>();
  const doc = {
    head,
    documentElement: { dataset: {} as Record<string, string> },
    getElementById: (id: string) => [...els.values()].find((e) => e.id === id && head.children.includes(e)) ?? null,
    createElement: () => {
      const el = {
        id: "",
        textContent: "",
        parentNode: null as unknown,
        remove() {
          head.children = head.children.filter((c) => c !== el);
        },
      };
      els.set(String(els.size), el);
      return el;
    },
  };
  return doc;
}

describe("the picked theme on the page", () => {
  it("puts one stylesheet last in <head>, names the look on <html>, and tells the terminal its colours", () => {
    const doc = fakeDoc();
    applyTheme(night, doc as unknown as Document);
    const el = doc.getElementById(THEME_STYLE_ID)!;
    expect(el.textContent).toContain(':root[data-theme="dark"]');
    expect(el.textContent).toContain("--main: #101820;");
    expect(doc.head.lastElementChild).toBe(el);
    expect(doc.documentElement.dataset.palette).toBe(night.id);
    expect(appTermColors()).toEqual({ name: "Night", kinds: ["dark"], colors: night.term });
  });

  it("takes it all away again for the brand's look", () => {
    const doc = fakeDoc();
    applyTheme(night, doc as unknown as Document);
    applyTheme(null, doc as unknown as Document);
    expect(doc.getElementById(THEME_STYLE_ID)).toBeNull();
    expect(doc.documentElement.dataset.palette).toBe("manut");
    expect(appTermColors()).toBeNull();
  });
});
