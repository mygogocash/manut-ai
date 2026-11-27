// Puts the picked theme on the page (item 99b): one <style id="manut-theme"> at the end of <head>, holding themes.ts's
// `themeCss` for the picked theme and nothing for the brand's look, which is tokens.css as it is. <html data-palette>
// names the look in force ("manut", or the theme's id), so a theme picked and since deleted reads as the brand's. The
// terminal is told which colours the theme brings for it (sessions/term/appColors.ts).
import { useLayoutEffect } from "react";
import { setAppTermColors } from "../sessions/term/appColors";
import { parseLook } from "../state/prefs";
import { themeById, useThemes } from "./library";
import { BRAND_ID, kindsOf, themeCss, type UserTheme } from "./themes";

export const THEME_STYLE_ID = "manut-theme";

export function applyTheme(theme: UserTheme | null, doc: Document = document): void {
  let el = doc.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  const css = themeCss(theme);
  if (!css) el?.remove();
  else {
    if (!el) {
      el = doc.createElement("style");
      el.id = THEME_STYLE_ID;
    }
    if (el.textContent !== css) el.textContent = css;
    // last in <head>, after every stylesheet the app has loaded so far (specificity carries it past later ones)
    if (el.parentNode !== doc.head || el !== doc.head.lastElementChild) doc.head.append(el);
  }
  doc.documentElement.dataset.palette = theme?.id ?? BRAND_ID;
  setAppTermColors(theme?.term ? { name: theme.name, kinds: kindsOf(theme), colors: theme.term } : null);
}

/** The look `palette` names, drawn: its theme while the person keeps one by that id, else the brand's. Before paint, so a
 *  change never shows a frame of the old colours. */
export function useThemeSheet(palette: string): void {
  const themes = useThemes();
  useLayoutEffect(() => {
    applyTheme(themes.find((t) => t.id === palette) ?? null);
  }, [palette, themes]);
}

/** At start, before the app draws: the saved look's theme, so the first paint is already in it. */
export function bootTheme(): void {
  try {
    const palette = parseLook(typeof localStorage === "undefined" ? null : localStorage.getItem("manut.look")).palette;
    applyTheme(palette === BRAND_ID ? null : themeById(palette));
  } catch {
    /* no storage: the brand's look */
  }
}
