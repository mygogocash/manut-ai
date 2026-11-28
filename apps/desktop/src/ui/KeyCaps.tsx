// An action's key as the canvas's Search board draws it at a row's tail: one cap for each key (`⌘` and `N` side by side),
// quiet and muted, never read out (the control carries its key as `aria-keyshortcuts`, and its tooltip names it). Used by the
// palette's rows and foot, and beside what an empty state opens (item 167d).
import type { KeyShown } from "../app/keyHints";

export function KeyCaps({ shown, className }: { shown: Pick<KeyShown, "caps">; className?: string }) {
  return (
    <span className={`kcaps${className ? ` ${className}` : ""}`} aria-hidden="true" data-testid="keycaps">
      {shown.caps.map((c, i) => (
        <kbd key={`${i}-${c}`} className="kcap">
          {c}
        </kbd>
      ))}
    </span>
  );
}
