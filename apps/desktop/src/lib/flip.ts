// A row that is pinned, settled or removed moves to its place calmly instead of jumping (item 85c, docs/motion.md). The
// driver in firstPaint.ts follows each `data-flip-list` container's `data-flip` children and slides the ones that moved
// from their old place to the new on the plain ease, in the Switch's time. This file is the pure part: which keys moved
// and by how much. No dependency: the Web Animations API does the sliding.

/** Which keys moved, and by how far they must travel back to where they stood (their old top less their new one). */
export function moved(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, top] of after) {
    const was = before.get(k);
    if (was !== undefined && Math.abs(was - top) >= 1) out.set(k, was - top);
  }
  return out;
}
