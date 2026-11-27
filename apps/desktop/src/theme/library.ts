// The person's own themes (item 99b), kept on this Mac in localStorage (`manut.themes`) and nowhere else. Which look is
// picked is the look's `palette` (state/prefs.ts, `manut.look`): "manut" for the brand's, or one of these ids. Each theme
// is checked when it is read back (themes.ts `cleanTheme`), so one changed by hand that breaks the text rule, or holds
// anything but colours, is left out rather than drawn.
import { useSyncExternalStore } from "react";
import { changes } from "../lib/changes";
import { cleanTheme, type ThemeId, type UserTheme } from "./themes";

export const THEMES_KEY = "manut.themes";
/** Enough for anyone's collection; a list that keeps growing is a mistake somewhere, and each theme is drawn in a menu. */
export const MAX_THEMES = 40;

/** Stored text -> the themes it holds that pass every check, at most `MAX_THEMES`, each id once. */
export function parseThemes(raw: string | null): UserTheme[] {
  let v: unknown;
  try {
    v = raw ? JSON.parse(raw) : null;
  } catch {
    return [];
  }
  const list = v && typeof v === "object" && Array.isArray((v as { themes?: unknown }).themes) ? (v as { themes: unknown[] }).themes : [];
  const out: UserTheme[] = [];
  for (const item of list) {
    const t = cleanTheme(item);
    if (t && !out.some((o) => o.id === t.id)) out.push(t);
    if (out.length >= MAX_THEMES) break;
  }
  return out;
}

function load(): UserTheme[] {
  try {
    return parseThemes(typeof localStorage === "undefined" ? null : localStorage.getItem(THEMES_KEY));
  } catch {
    return [];
  }
}

let themes: readonly UserTheme[] = load();
const listeners = changes();

function save(next: readonly UserTheme[]): void {
  themes = next;
  try {
    if (typeof localStorage !== "undefined") {
      if (next.length) localStorage.setItem(THEMES_KEY, JSON.stringify({ v: 1, themes: next }));
      else localStorage.removeItem(THEMES_KEY);
    }
  } catch {
    /* no storage, or full: the themes hold for this run */
  }
  listeners.emit();
}

export const allThemes = (): readonly UserTheme[] => themes;
export const themeById = (id: string): UserTheme | null => themes.find((t) => t.id === id) ?? null;
export const useThemes = (): readonly UserTheme[] => useSyncExternalStore(listeners.subscribe, allThemes, allThemes);

/** Add a theme, or change the one with its id. Refused when the list is full and the theme is new, or when the theme does
 *  not pass the checks it would be read back with. */
export function putTheme(t: UserTheme): { ok: true } | { ok: false; why: "many" | "invalid" } {
  const clean = cleanTheme(t);
  if (!clean) return { ok: false, why: "invalid" };
  const at = themes.findIndex((o) => o.id === t.id);
  if (at < 0 && themes.length >= MAX_THEMES) return { ok: false, why: "many" };
  save(at < 0 ? [...themes, clean] : themes.map((o, i) => (i === at ? clean : o)));
  return { ok: true };
}

export function removeTheme(id: string): void {
  if (themes.some((t) => t.id === id)) save(themes.filter((t) => t.id !== id));
}

/** A new theme's id, never one in use. */
export function newThemeId(rand: () => number = Math.random): ThemeId {
  for (;;) {
    const id: ThemeId = `mine-${Math.floor(rand() * 36 ** 8)
      .toString(36)
      .padStart(8, "0")}`;
    if (!themes.some((t) => t.id === id)) return id;
  }
}

/** A name not taken yet: `base`, else `base 2`, `base 3`… */
export function freeName(base: string): string {
  const taken = new Set(themes.map((t) => t.name));
  if (!taken.has(base)) return base;
  // room for the number inside a name's 60 characters
  const stem = base.slice(0, 54).trim();
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
}

/** Tests: read the themes again from storage. */
export function reloadThemes(): void {
  themes = load();
  listeners.emit();
}
