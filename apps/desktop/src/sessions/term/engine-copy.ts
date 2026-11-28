// What copying a selection in a terminal puts on the clipboard (item 148). Lifted from Paradev (MIT, Copyright (c) 2025-2026
// Superset Inc., `paradevai/paradev` at 2db3bbaf37ffbe24b78c8cdb974bf34632e6fb20): `apps/desktop/src/renderer/lib/terminal/
// terminal-copy.ts`, with its tests ported to vitest (engine-copy.test.ts, engine-copy.ghostty.test.ts). It follows
// Ghostty's whitespace rules: the spaces a row is padded with are not copied (trailing spaces of each line go, and the
// blank cells between words stay), blank lines at the end go, rows that were wrapped by the terminal's width are joined
// into the line they were, a wide character is copied once, and a rectangular selection is copied cell by cell.
//
// xterm's own text keeps the padding. Its `getSelection()` is the fallback whenever the selection's shape cannot be read
// (the selection mode is a private field of xterm, absent in another version: engine-copy.test.ts and the browser spec
// term-copy.spec.ts fail when a bump of xterm takes it away).
//
// What differs from Paradev: its fallback for a clipboard the page cannot write is its desktop's native copy; this app
// writes through `navigator.clipboard`, as every other copy in the terminal does.
import type { IBufferLine, Terminal } from "@xterm/xterm";

type SelectionTerminal = Pick<Terminal, "getSelection" | "getSelectionPosition" | "buffer">;

function isWideWrapSpacer(line: IBufferLine | undefined, nextLine: IBufferLine | undefined, x: number): boolean {
  // xterm represents Ghostty's spacer_head as an empty cell before a wide glyph
  return !!(line && x === line.length - 1 && !line.getCell(x)?.getChars() && nextLine?.isWrapped && nextLine.getCell(0)?.getWidth() === 2);
}

/** `selection` (xterm's own text) without the spaces each line ends in and without blank lines at its end. */
export function trimTerminalSelection(selection: string): string {
  return selection.replace(/ +(?=\r?\n|$)/g, "").replace(/(?:\r?\n)+$/, "");
}

/** The text to copy for the terminal's selection, by Ghostty's rules (read from the buffer's cells), or the trimmed text
 *  xterm gives when the selection's shape is unknown. */
export function getTerminalSelectionForCopy(terminal: SelectionTerminal): string {
  const selection = terminal.getSelection();
  const position = terminal.getSelectionPosition?.();
  if (!position) return trimTerminalSelection(selection);

  // xterm only exposes rectangular selection mode through this private field
  const internal = terminal as SelectionTerminal & { _core?: { _selectionService?: { _activeSelectionMode?: number } } };
  const mode = internal._core?._selectionService?._activeSelectionMode;
  if (mode === undefined || mode < 0 || mode > 3) return trimTerminalSelection(selection);
  const rectangle = mode === 3;
  const { start } = position;
  let { end } = position;
  const buffer = terminal.buffer.active;
  if (!rectangle && isWideWrapSpacer(buffer.getLine(end.y), buffer.getLine(end.y + 1), end.x - 1)) end = { x: 1, y: end.y + 1 };
  let result = "";
  let blankRows = 0;
  let blankCells = 0;
  for (let y = start.y; y <= end.y; y++) {
    const line = buffer.getLine(y);
    if (!line?.getCell) return trimTerminalSelection(selection);
    let startX = rectangle ? Math.min(start.x, end.x) : y === start.y ? start.x : 0;
    const endX = rectangle ? Math.max(start.x, end.x) : y === end.y ? end.x : line.length;
    if (startX >= endX) continue;
    if (startX > 0 && line.getCell(startX)?.getWidth() === 0) startX--;
    const cells: string[] = [];
    for (let x = startX; x < endX; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      if (isWideWrapSpacer(line, buffer.getLine(y + 1), x)) continue;
      cells.push(cell.getChars());
    }
    if (cells.length === 0) continue;
    if (!cells.some((cell) => cell !== "")) {
      blankRows++;
      continue;
    }
    result += "\n".repeat(blankRows);
    blankRows = !buffer.getLine(y + 1)?.isWrapped ? 1 : 0;
    if (!line.isWrapped) blankCells = 0;
    for (const cell of cells) {
      if (cell === "" || cell === " ") {
        blankCells++;
      } else {
        result += " ".repeat(blankCells) + cell;
        blankCells = 0;
      }
    }
  }
  return result;
}

const writeClipboard = (text: string): Promise<void> => (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("no clipboard")));

/** Copy through the page: the terminal's own `copy` event (the Edit menu's Copy on macOS, which xterm answers with its raw
 *  text) is answered again with the text by these rules, which replaces what xterm put there. Returns what undoes it. */
export function installTerminalCopyHandler(terminal: Terminal, writeText: (text: string) => Promise<void> = writeClipboard): () => void {
  const element = terminal.element;
  if (!element) return () => {};
  const handleCopy = (event: ClipboardEvent) => {
    const text = getTerminalSelectionForCopy(terminal);
    if (!text && !(terminal.hasSelection?.() ?? !!terminal.getSelection())) return;
    event.preventDefault();
    if (event.clipboardData) {
      try {
        event.clipboardData.setData("text/plain", text);
        return;
      } catch {
        /* the page may not set it: written below */
      }
    }
    void writeText(text).catch(() => undefined);
  };
  element.addEventListener("copy", handleCopy);
  return () => element.removeEventListener("copy", handleCopy);
}
