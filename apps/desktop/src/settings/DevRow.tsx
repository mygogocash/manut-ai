// One row as Settings draws it (Settings.slot.tsx `Row`): what it is on the left, what to do on the right. Settings ›
// Developer and its sign-in by email both draw rows, so the markup is here once.
import type { ReactNode } from "react";

export function Row({ title, hint, children }: { title?: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-k">
        {title && <b>{title}</b>}
        {hint && <span>{hint}</span>}
      </div>
      {children !== undefined && <div className="st-v">{children}</div>}
    </div>
  );
}
