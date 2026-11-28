// How a file's diff lines are laid out beside a lane (item 146): each line with the numbers git's hunk headers give it, the same
// lines paired for a side by side view, and the line range a run of selected lines covers. Nothing here draws or reads the
// page: DiffView (Work.tsx) draws what these give, and the note on selected lines (chat/box/SelectionNote.tsx) asks the range.
//
// A file's `lines` (lib/protocol.ts `DiffFile`) are git's unified diff: `@@ -a,b +c,d @@` opens a hunk, then each line starts
// with ` `, `+` or `-`. The numbers are only as good as those headers: lines before the first header, or after one that cannot
// be read (an agent's own, shorter diff), have none, and everything below says so by leaving a number out, never by guessing one.

/** Unified: each line under the one before it. Split: the file before the change on the left and after it on the right, a change's
 *  removed and added lines side by side (`pairRows`). */
export type DiffLayout = "unified" | "split";

export type RowKind = "hunk" | "add" | "del" | "ctx";

/** One line of a file's diff. `index` is its place in the file's `lines`, `text` the line without its `+`, `-` or space (a hunk's
 *  is its whole header). `old` and `new` are its line numbers in the file before and after the change: an added line has no `old`,
 *  a removed line no `new`, and a line no hunk header placed has neither. */
export interface DiffRow {
  index: number;
  kind: RowKind;
  text: string;
  old?: number;
  new?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The lines of a file's diff as rows, numbered from each hunk's header. */
export function rowsOf(lines: readonly string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let old: number | null = null;
  let now: number | null = null;
  lines.forEach((l, index) => {
    if (l.startsWith("@@")) {
      const m = HUNK.exec(l);
      old = m ? Number(m[1]) : null;
      now = m ? Number(m[2]) : null;
      rows.push({ index, kind: "hunk", text: l });
      return;
    }
    const kind: RowKind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx";
    const row: DiffRow = { index, kind, text: l.slice(1) };
    // a removed line is in the old file only, an added line in the new file only, a line of context in both
    if (kind !== "add" && old !== null) {
      row.old = old;
      old += 1;
    }
    if (kind !== "del" && now !== null) {
      row.new = now;
      now += 1;
    }
    rows.push(row);
  });
  return rows;
}

/** One row of the side by side view: a hunk's rule across both sides, or a left cell (the file before) and a right cell (the
 *  file after). A line of context is both cells; a removed line is a left cell alone and an added line a right cell alone. A
 *  run of removed lines followed at once by a run of added lines is one change, and its lines are paired one against one, the
 *  lines left over when the runs differ in length standing opposite an empty cell. */
export type SplitRow = { hunk: DiffRow } | { left?: DiffRow; right?: DiffRow };

export function pairRows(rows: readonly DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i];
    if (r.kind === "hunk") {
      out.push({ hunk: r });
      i += 1;
    } else if (r.kind === "ctx") {
      out.push({ left: r, right: r });
      i += 1;
    } else {
      // the run of removed lines, then the run of added lines right after it
      const dels: DiffRow[] = [];
      const adds: DiffRow[] = [];
      while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++]);
      while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k], right: adds[k] });
    }
  }
  return out;
}

/** Which file's numbers a range is in: `new` (the file after the change, where lines of context and added lines are), `old` (the
 *  file before it, when every line picked was removed) or `mixed` (removed lines among lines of the new file; the numbers are
 *  the new file's, and the removed lines are in the quote). */
export type RangeSide = "new" | "old" | "mixed";

export interface DiffRange {
  from: number;
  to: number;
  side: RangeSide;
}

/** The line numbers a run of picked rows covers, or null when they carry none (a hunk's rule only, or lines no header placed).
 *  By default they are the new file's where any picked line is in it, else the old file's; `prefer: "old"` is for rows picked on
 *  the left of the split layout, which is the file before the change: every line there has an old number, a line of context
 *  included, and they are the old file's. */
export function rangeOf(picked: readonly DiffRow[], prefer: "new" | "old" = "new"): DiffRange | null {
  const rows = picked.filter((r) => r.kind !== "hunk");
  if (prefer === "old") {
    const olds = rows.flatMap((r) => (r.old !== undefined ? [r.old] : []));
    return olds.length ? { from: Math.min(...olds), to: Math.max(...olds), side: "old" } : null;
  }
  const news = rows.flatMap((r) => (r.new !== undefined ? [r.new] : []));
  const olds = rows.flatMap((r) => (r.kind === "del" && r.old !== undefined ? [r.old] : []));
  if (news.length) return { from: Math.min(...news), to: Math.max(...news), side: rows.some((r) => r.kind === "del") ? "mixed" : "new" };
  if (olds.length) return { from: Math.min(...olds), to: Math.max(...olds), side: "old" };
  return null;
}

/** The picked rows as lines of a patch: each with its `+`, `-` or space, a hunk's rule left out. What a note quotes, so the
 *  person's agent sees which of the lines were added and which removed, which the page draws as a tint, never as text. */
export const quoteOf = (picked: readonly DiffRow[]): string =>
  picked
    .filter((r) => r.kind !== "hunk")
    .map((r) => `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`)
    .join("\n");
