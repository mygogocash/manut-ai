// Find in a chat (item 150): the controller the bar drives, as engine-find.ts is the terminal's. It holds the query, the
// matches and which one is current, and it asks the page for four things through `FindDeps` (read the chat, open a
// folded group, paint, scroll), so a test drives all of it with plain stand-ins and no page.
//
// Folded groups. A match in a folded step opens that group while it is the current match and the group goes shut again
// when the person moves on: `fold` is told the one group to hold open (or none), and whatever it held before is let
// go. Only a move of the person's (typing, Next, Previous) opens a group. A re-read after the chat changed never does:
// the person who clicked an open group shut must not see the find open it again behind that click.
import type { FindResults } from "../../sessions/term/engine-find";
import { sameBlocks, type Block } from "./read";
import { FIND_PLAIN, findAll, firstFrom, stepIndex, type FindOptions, type Match, type Place } from "./text";

export interface FindDeps {
  /** What the chat shows now, run by run (read.ts). */
  read(): Block[];
  /** The first run that is not wholly above the top of the view: where a new search starts. */
  top(blocks: readonly Block[]): number;
  /** Hold exactly these folded groups open, and let go of any other the find opened. The page has settled when it returns. */
  fold(ids: readonly string[]): void;
  /** Draw the matches, the one at `current` as the one in focus (-1: none). */
  paint(blocks: readonly Block[], matches: readonly Match[], current: number): void;
  /** Bring a match into view. */
  show(block: Block, match: Match): void;
}

export interface ChatFinder {
  /** Look for `text` (the person typed): from the match they are on while it still matches, else from the top of the view. */
  search(text: string, options?: FindOptions): void;
  /** Next (1) or Previous (-1), wrapping at the ends. */
  step(dir: 1 | -1): void;
  /** The chat changed (a message came, an answer grew): read it again and keep the current match where it still is. */
  refresh(): void;
  /** The page moved (it scrolled, it was resized): draw the matches again where they are now, without reading anything. */
  repaint(): void;
  /** The query went: no highlight, no folded group held open. */
  clear(): void;
  onResults(fn: (r: FindResults) => void): () => void;
  dispose(): void;
}

export function makeChatFinder(deps: FindDeps): ChatFinder {
  let blocks: Block[] = [];
  let matches: Match[] = [];
  let capped = false;
  let index = -1;
  let query = "";
  let how: FindOptions = FIND_PLAIN;
  /** The current match as a place that can be found again after the chat changed. */
  let at: { key: string; start: number } | null = null;
  let last: FindResults = { index: -1, count: 0, capped: false };
  const listeners = new Set<(r: FindResults) => void>();
  const emit = () => {
    last = { index, count: matches.length, capped };
    for (const fn of listeners) fn(last);
  };
  const place = (i: number) => {
    const m = matches[i];
    const b = m ? blocks[m.block] : undefined;
    at = m && b ? { key: b.key, start: m.start } : null;
    return b;
  };

  /** Match `i` is now the current one: its folded group held open, the matches drawn, and the match brought into view. */
  const settle = (i: number, show: boolean) => {
    index = i;
    const b = place(i);
    deps.fold(b?.fold ? [b.fold] : []);
    deps.paint(blocks, matches, i);
    const m = matches[i];
    if (show && m && b) deps.show(b, m);
    emit();
  };

  /** Where a search begins: on the match the person is on, if its run is still there, else under the top of the view. */
  const begin = (): Place => {
    const b = at ? blocks.findIndex((x) => x.key === at!.key) : -1;
    if (at && b >= 0) return { block: b, start: at.start };
    return { block: Math.max(0, deps.top(blocks)), start: 0 };
  };

  /** The current match after the chat was read again: the same place, else the nearest in the same run, else the same number. */
  const locate = (): number => {
    if (at) {
      const key = at.key;
      const here = matches.map((m, i) => ({ m, i })).filter(({ m }) => blocks[m.block]!.key === key);
      const exact = here.find(({ m }) => m.start === at!.start);
      if (exact) return exact.i;
      let best: { m: Match; i: number } | undefined;
      for (const h of here) if (!best || Math.abs(h.m.start - at.start) < Math.abs(best.m.start - at.start)) best = h;
      if (best) return best.i;
    }
    return Math.min(Math.max(index, 0), matches.length - 1);
  };

  const none = () => {
    matches = [];
    capped = false;
    index = -1;
    at = null;
  };

  return {
    search(text, options) {
      query = text;
      if (options) how = options;
      const found = findAll(blocks, query, how);
      matches = found.matches;
      capped = found.capped;
      if (!matches.length) {
        index = -1;
        at = null;
        deps.fold([]);
        deps.paint(blocks, [], -1);
        emit();
        return;
      }
      const i = firstFrom(matches, begin());
      // every match is before the place it starts from: Next wraps round to the first
      settle(i < 0 ? 0 : i, true);
    },
    step(dir) {
      if (!matches.length) return;
      settle(stepIndex(index, dir, matches.length), true);
    },
    refresh() {
      const next = deps.read();
      // the same runs in the same nodes: only where they sit may have moved, so the matches are drawn again as they are
      if (sameBlocks(blocks, next)) {
        deps.paint(blocks, matches, index);
        return;
      }
      blocks = next;
      if (!query) {
        deps.paint(blocks, [], -1);
        return;
      }
      const found = findAll(blocks, query, how);
      const had = index >= 0;
      matches = found.matches;
      capped = found.capped;
      // a match the person never moved to stays unmarked: a message that arrives does not take the view or the focus
      index = matches.length && had ? locate() : -1;
      place(index);
      deps.paint(blocks, matches, index);
      emit();
    },
    repaint() {
      deps.paint(blocks, matches, index);
    },
    clear() {
      query = "";
      none();
      deps.fold([]);
      deps.paint(blocks, [], -1);
      emit();
    },
    onResults(fn) {
      listeners.add(fn);
      fn(last);
      return () => void listeners.delete(fn);
    },
    dispose() {
      query = "";
      none();
      deps.fold([]);
      deps.paint(blocks, [], -1);
      listeners.clear();
    },
  };
}
