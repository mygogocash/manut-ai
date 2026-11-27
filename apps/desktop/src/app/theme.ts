import { useEffect, useState } from "react";
import type { Look, Theme } from "../state/store";

const query = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null);

export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme !== "system") return theme;
  return query()?.matches ? "light" : "dark";
}

/** The theme in force, live: under "system" it changes when the OS goes light or dark, so what is drawn from it
 *  (a session terminal's colours) follows the page instead of keeping the theme the app started in. */
export function useResolvedTheme(theme: Theme): "dark" | "light" {
  const [, bump] = useState(0);
  useEffect(() => {
    if (theme !== "system") return;
    const mq = query();
    const on = () => bump((n) => n + 1);
    mq?.addEventListener("change", on);
    return () => mq?.removeEventListener("change", on);
  }, [theme]);
  return resolveTheme(theme);
}

/** Writes the look (bubble style, text size, chat width) to <html data-bubbles|data-text|data-chat-width>. The colours
 *  are src/theme/apply.ts's: it writes data-palette with the theme it draws, which is the brand's when the one saved is
 *  gone. */
export function useLookAttributes(look: Look) {
  useEffect(() => {
    const d = document.documentElement.dataset;
    d.bubbles = look.bubbles;
    d.text = look.text;
    d.chatWidth = look.width;
  }, [look.bubbles, look.text, look.width]);
}

/** Writes the resolved theme to <html data-theme>; "system" follows the OS live. */
export function useThemeAttribute(theme: Theme) {
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    if (theme !== "system") return;
    const mq = query();
    mq?.addEventListener("change", apply);
    return () => mq?.removeEventListener("change", apply);
  }, [theme]);
}
