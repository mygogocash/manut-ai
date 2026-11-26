// A page that loads shows the shape of what is coming, as the design canvas's system states board draws it (StatesSystem,
// "Loading"): a wide strip, then rows each with a round mark and two lines, all in the Motion board's Loading shimmer.
// Not a spinner in the middle and not a blank page. The words stay for a screen reader, and for the status role.
import type { CSSProperties } from "react";

const LINES: ReadonlyArray<readonly [number, number]> = [
  [72, 44],
  [58, 36],
  [66, 40],
];

export function Loading({ label, testId, strip = true, rows = 3 }: { label: string; testId: string; strip?: boolean; rows?: number }) {
  return (
    <div className="skels" role="status" data-testid={testId}>
      <span className="vh">{label}</span>
      {strip && <div className="skel mo-loading wide" aria-hidden="true" />}
      {Array.from({ length: rows }, (_, i) => {
        const [a, b] = LINES[i % LINES.length]!;
        return (
          <div className="skel-row" key={i} aria-hidden="true">
            <div className="skel mo-loading dot" />
            <div className="skel-lines">
              <div className="skel mo-loading" style={{ "--w": `${a}%` } as CSSProperties} />
              <div className="skel mo-loading" style={{ "--w": `${b}%` } as CSSProperties} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
