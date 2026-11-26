// Whether the person asked the system for less motion. Moves that run from script (a scroll, a hand-off, a reveal)
// ask this first and settle at once when it is true; the stylesheets do the same through the media query itself.
export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
