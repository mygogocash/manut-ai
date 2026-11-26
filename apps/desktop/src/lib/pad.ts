// Zero-padding for the clock and date text the app builds by hand (`07:05`, `2026-11-03`), so every place that writes
// a time writes it the same way.
export const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
