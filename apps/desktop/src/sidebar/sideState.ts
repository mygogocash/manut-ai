// The side menu's width and whether it shows (the owner, 27 Nov 2026: "make it slide and adjustable and add a button to hide
// or show the full sidebar"), kept on this Mac. The window grid reads the width from `--side-w`, so dragging the menu's edge,
// hiding it and showing it again all move the same column, and its slide is the grid's own (app.css).
import { useSyncExternalStore } from "react";
import { changes } from "../lib/changes";

/** The canvas's width, and how narrow and how wide the menu may be dragged. */
export const SIDE_DEFAULT = 196;
export const SIDE_MIN = 176;
export const SIDE_MAX = 360;

const WIDTH_KEY = "manut.side.width";
const HIDDEN_KEY = "manut.side.hidden";

export const clampSide = (w: number) => Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)));

export interface SideState {
  readonly width: number;
  readonly hidden: boolean;
}

function read(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* no storage: it holds until the app closes */
  }
}

/** What was kept, each part checked: a width that is not a number goes back to the canvas's. */
export function parseSide(width: string | null, hidden: string | null): SideState {
  const w = Number(width);
  return { width: width !== null && Number.isFinite(w) ? clampSide(w) : SIDE_DEFAULT, hidden: hidden === "1" };
}

const listeners = changes();
let state: SideState | null = null;
const current = (): SideState => (state ??= parseSide(read(WIDTH_KEY), read(HIDDEN_KEY)));

function put(next: SideState): void {
  state = next;
  write(WIDTH_KEY, next.width === SIDE_DEFAULT ? null : String(next.width));
  write(HIDDEN_KEY, next.hidden ? "1" : null);
  listeners.emitSnapshot();
}

export const sideState = current;
/** The menu's width: a drag's end, or null for the canvas's width again. */
export const setSideWidth = (w: number | null) => put({ ...current(), width: w === null ? SIDE_DEFAULT : clampSide(w) });
export const setSideHidden = (hidden: boolean) => put({ ...current(), hidden });
export const toggleSide = () => setSideHidden(!current().hidden);
export const onSideChange = (fn: () => void) => listeners.subscribe(fn);
export const useSide = (): SideState => useSyncExternalStore(onSideChange, current, current);
/** For tests: read from storage again. */
export function forgetSide(): void {
  state = null;
}
