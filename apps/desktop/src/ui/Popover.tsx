import { useEffect, useRef, type ReactNode } from "react";
import { useLeaving } from "./leave";

/**
 * Anchored popover: render it inside a `position: relative` wrapper next to its trigger.
 * Closes on outside click and on Escape; `onClose` gets which one, so a trigger can take focus back on Escape.
 * It arrives with a short Rise and, once closed, fades out where it stands (inert, showing what it showed last)
 * before it leaves the page (ui.css, leave.ts).
 */
export function Popover({
  open,
  onClose,
  children,
  align = "right",
  side = "bottom",
  width = 248,
  className,
  label,
}: {
  open: boolean;
  onClose: (why: "escape" | "outside") => void;
  children: ReactNode;
  align?: "left" | "right";
  side?: "top" | "bottom";
  /** px, or any CSS width (e.g. a `min()` that keeps a menu inside the sidebar) */
  width?: number | string;
  className?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { drawn, leaving } = useLeaving(open);
  // what it showed while open, so a parent that draws nothing once closed does not empty a popover that is fading
  const shown = useRef(children);
  if (open) shown.current = children;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      const anchor = el?.parentElement;
      if (el && anchor && !anchor.contains(e.target as Node)) onClose("outside");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose("escape");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!drawn) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`ui-pop ui-pop-${side} ui-pop-${align}${className ? ` ${className}` : ""}`}
      style={{ width }}
      {...(leaving ? { "data-leaving": "", inert: true, "aria-hidden": true } : {})}
    >
      {leaving ? shown.current : children}
    </div>
  );
}
