import type { ReactNode } from "react";
import { routinesWords as W } from "./words";

/// The pieces of the Routines page that more than one part of it draws: what was done, what was not, and the question that is asked before
/// a change. The page itself is RoutinesView.tsx and the form that makes a routine is MakeRoutineForm.tsx.

/// Why a change was not made, in words, and whether the API refused the operator key, which is the one refusal with a way out.
export type Problem = { text: string; refused: boolean };

/// What was done, said once where it was done.
export function Said({ text }: { text: string }) {
  return (
    <div className="banner ok" role="status">
      <span className="grow">{text}</span>
    </div>
  );
}

/// A change that was not made. A key the API refused comes with the way to enter another.
export function Failed({ problem, onForget }: { problem: Problem; onForget: () => void }) {
  return (
    <div className="banner err" role="alert">
      <span className="grow">{problem.text}</span>
      {problem.refused && (
        <button type="button" className="btn" style={{ color: "var(--ink)" }} onClick={onForget}>
          {W.anotherKey}
        </button>
      )}
    </div>
  );
}

/// A question: what will happen, in words that name it exactly, and two buttons, the one that does it first. Nothing is sent until the
/// first is pressed, and the second sends nothing. While a change is on its way every button waits.
export function Question({ id, title, yes, no, busyLabel, busy, locked, danger = false, onYes, onNo, children }: {
  id: string;
  title: string;
  yes: string;
  no: string;
  busyLabel: string;
  busy: boolean;
  locked: boolean;
  danger?: boolean;
  onYes: () => void;
  onNo: () => void;
  children: ReactNode;
}) {
  return (
    <div className="dialog" role="dialog" aria-labelledby={id} style={{ flexBasis: "100%", maxWidth: 560 }}>
      <h3 id={id}>{title}</h3>
      {children}
      <div className="chips">
        <button type="button" className={danger ? "btn danger solid" : "btn dark"} disabled={locked}
          aria-busy={busy ? true : undefined} onClick={onYes}>
          {busy ? busyLabel : yes}
        </button>
        <button type="button" className="btn" disabled={locked} onClick={onNo}>
          {no}
        </button>
      </div>
    </div>
  );
}
