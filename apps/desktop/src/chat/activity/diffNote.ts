// A note on selected lines of a diff (item 146): which file and lines a selection in the pane beside a lane covers, and the lines
// as a patch fragment for the note to quote. The person selects text in the Diff and presses Add a note (chat/box/SelectionNote.tsx,
// item 97); where the selection lies inside one file's lines the chip carries the file and the line range as well, and nothing is
// sent until the person sends.
//
// `pickedLines` is the rule, over cells it is handed, and tested without a page. `pickedFromRange` only reads the attributes
// DiffView draws on each line (Work.tsx: `data-path` on a file, `data-row`, `data-kind`, `data-old`, `data-new` and `data-side` on a
// line) back into those cells, so what is quoted is what the page drew, a key already hidden, never the shell's text again.
import { quoteOf, rangeOf, type DiffRange, type DiffRow, type RowKind } from "./diffLayout";

/** Where a note's quote is: the file, and the lines when git's hunk headers numbered them. */
export interface NoteAt {
  file: string;
  range?: DiffRange;
}

/** A line of a diff as the page drew it. In the split layout `side` is the side the cell is on, and a line of context is a cell on
 *  both. */
export interface Cell extends DiffRow {
  side?: "old" | "new";
}

/** The lines a selection of one file's cells covers: as a patch fragment, and where they are. In the split layout both sides' cells
 *  may be among them (the keyboard can extend a selection over both), and only the side of the first one counts: its lines are
 *  that file's, and the old side's numbers are the file before the change. null when no line was picked. */
export function pickedLines(file: string, cells: readonly Cell[]): { quote: string; at: NoteAt } | null {
  const first = cells.find((c) => c.kind !== "hunk");
  if (!first) return null;
  const side = first.side;
  const seen = new Set<number>();
  const rows: DiffRow[] = [];
  for (const c of cells) {
    if (c.kind === "hunk" || (side !== undefined && c.side !== side) || seen.has(c.index)) continue;
    seen.add(c.index);
    rows.push(c);
  }
  const range = rangeOf(rows, side === "old" ? "old" : "new");
  return { quote: quoteOf(rows), at: range ? { file, range } : { file } };
}

const KINDS: readonly RowKind[] = ["add", "del", "ctx"];

/** Whether `range` takes in some of what `node` holds, not only its edge: a drag that ends at the start of the next line, or
 *  begins at the end of one, does not pick that line. */
function takesIn(range: Range, node: Node): boolean {
  const inside = document.createRange();
  inside.selectNodeContents(node);
  // this range's start is before the node's end, and its end after the node's start
  return range.compareBoundaryPoints(Range.END_TO_START, inside) < 0 && range.compareBoundaryPoints(Range.START_TO_END, inside) > 0;
}

function cellOf(line: HTMLElement, text: Element): Cell | null {
  const kind = line.dataset.kind as RowKind;
  const index = Number(line.dataset.row);
  if (!KINDS.includes(kind) || !Number.isInteger(index)) return null;
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  const cell: Cell = { index, kind, text: text.textContent ?? "" };
  const old = num(line.dataset.old);
  const now = num(line.dataset.new);
  if (old !== undefined) cell.old = old;
  if (now !== undefined) cell.new = now;
  if (line.dataset.side === "old" || line.dataset.side === "new") cell.side = line.dataset.side;
  return cell;
}

/** The lines a selection covers, when it lies inside one file's lines in the Diff. A selection that begins in one file and ends in
 *  another is of no one file, and picks nothing here (the note then quotes what was selected, as a note on any text does). */
export function pickedFromRange(range: Range): { quote: string; at: NoteAt } | null {
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const file = el?.closest<HTMLElement>(".dv-file[data-path]");
  const path = file?.dataset.path;
  if (!file || !path) return null;
  const cells: Cell[] = [];
  for (const line of file.querySelectorAll<HTMLElement>(".dv-l[data-row]")) {
    const text = line.querySelector(".dv-t");
    if (!text || !takesIn(range, text)) continue;
    const cell = cellOf(line, text);
    if (cell) cells.push(cell);
  }
  return pickedLines(path, cells);
}
