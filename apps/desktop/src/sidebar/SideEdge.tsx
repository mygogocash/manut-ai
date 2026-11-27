// The side menu's edge and its two buttons (the owner, 27 Nov 2026), beside the panel's own handle (app/PanelResizer.tsx):
//
// - `SideResizer`: a handle on the menu's right edge. Dragging it, or ←/→ with it focused, sets the menu's width within
//   [SIDE_MIN, SIDE_MAX]; a double click, or Enter, gives the canvas's width back. While it is dragged the grid follows the
//   pointer at once, with no slide.
// - `SideShow`: once the menu is hidden, the one button at the top left that brings it back, as ChatGPT's does. The menu's own
//   Hide button is in its top row (Sidebar.tsx). ⌘⇧S does either (keys.ts, settable).
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { t } from "../i18n";
import { Icon } from "../ui/icons";
import { clampSide, setSideHidden, setSideWidth, useSide } from "./sideState";

const STEP = 16;
const win = () => document.querySelector<HTMLElement>("[data-testid=window]");

/** Puts the menu's width and whether it shows on the window, where the grid and every rule read them. */
export function useSideOnWindow(drag: number | null): void {
  const { width, hidden } = useSide();
  useEffect(() => {
    const w = win();
    if (!w) return;
    w.style.setProperty("--side-w", hidden ? "0px" : `${drag ?? width}px`);
    w.classList.toggle("side-hidden", hidden);
    w.classList.toggle("side-dragging", drag !== null);
  }, [width, hidden, drag]);
}

export function SideResizer({ drag, onDrag }: { drag: number | null; onDrag: (w: number | null) => void }) {
  const { width, hidden } = useSide();
  const start = useRef<{ x: number; w: number } | null>(null);
  if (hidden) return null;
  const end = () => {
    if (start.current && drag !== null) setSideWidth(drag);
    start.current = null;
    onDrag(null);
  };
  return (
    <div
      className={`side-resizer${drag !== null ? " on" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("side.resize")}
      aria-valuenow={drag ?? width}
      title={t("side.resizeTip")}
      tabIndex={0}
      data-testid="side-resizer"
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start.current = { x: e.clientX, w: width };
        onDrag(width);
      }}
      onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
        const s = start.current;
        if (s) onDrag(clampSide(s.w + (e.clientX - s.x)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => setSideWidth(null)}
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const step = e.shiftKey ? STEP * 4 : STEP;
          setSideWidth(width + (e.key === "ArrowRight" ? step : -step));
        } else if (e.key === "Enter") {
          e.preventDefault();
          setSideWidth(null);
        }
      }}
    />
  );
}

/** The top-left button that shows the hidden menu again. */
export function SideShow() {
  const { hidden } = useSide();
  if (!hidden) return null;
  return (
    <button type="button" className="side-show" aria-label={t("side.show")} title={t("side.show")} onClick={() => setSideHidden(false)} data-testid="side-show">
      <Icon name="panel-left" />
    </button>
  );
}

/** The drag in progress, shared by the handle and the window. */
export function useSideDrag(): [number | null, (w: number | null) => void] {
  return useState<number | null>(null);
}
