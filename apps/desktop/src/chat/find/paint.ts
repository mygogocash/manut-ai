// Find in a chat (item 150): drawing the matches without touching the messages.
//
// Two ways, and the page says which at run time (never by the web view's version):
//
// 1. The CSS Custom Highlight API, where the web view has `CSS.highlights` (Safari 17.2 and later). Each match is a
//    Range, handed to the browser to paint behind its text: the message's text and markup are not touched, and
//    neither is its layout. `::highlight(chat-find)` and `::highlight(chat-find-current)` in find.css say how.
// 2. Where it is missing (the macOS 11 web view): a layer of boxes laid over the timeline, one for each line of each match,
//    taken from the match's own client rects. The layer is a sibling of the timeline's scroll column, not a part of it:
//    nothing is added between the messages (a node there would break the rows' spacing rules, which read a row's
//    neighbour), nothing is wrapped around a word, and the boxes never take a click (`pointer-events: none`). They are
//    drawn again when the column scrolls or resizes. A box is a pale tint, since it lies over the text and not under it
//    (find.css keeps every text colour readable through it); the current match has a ring as well.
import type { Block } from "./read";
import type { Match } from "./text";

export const PLAIN = "chat-find";
export const CURRENT = "chat-find-current";

interface Registry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}
type HighlightCtor = new (...r: Range[]) => { priority: number };

/** The browser's highlight registry when it has one. */
export function highlights(): { reg: Registry; Highlight: HighlightCtor } | null {
  const g = globalThis as { CSS?: { highlights?: Registry }; Highlight?: HighlightCtor };
  return g.CSS?.highlights && typeof g.Highlight === "function" ? { reg: g.CSS.highlights, Highlight: g.Highlight } : null;
}

/** A match as a Range over the text nodes it was read from, or null when the page moved under it since. */
export function rangeOf(b: Block, start: number, end: number): Range | null {
  let first: Block["segs"][number] | undefined;
  let lastSeg: Block["segs"][number] | undefined;
  for (const s of b.segs) {
    if (!first && s.end > start) first = s;
    if (s.start < end) lastSeg = s;
    else break;
  }
  if (!first || !lastSeg) return null;
  try {
    const a = first.node as unknown as Text;
    const z = lastSeg.node as unknown as Text;
    if (!a.isConnected || !z.isConnected) return null;
    const r = document.createRange();
    r.setStart(a, start - first.start);
    r.setEnd(z, end - lastSeg.start);
    return r;
  } catch {
    // a text node that changed since it was read, and is shorter now
    return null;
  }
}

export interface Painter {
  readonly kind: "highlight" | "boxes";
  paint(blocks: readonly Block[], matches: readonly Match[], current: number): void;
  clear(): void;
}

/** A painter for the timeline column `scroller`, with `layer` (the box layer beside it) for a web view with no highlights. */
export function makePainter(scroller: HTMLElement, layer: HTMLElement | null): Painter {
  const api = highlights();
  if (api) {
    const clear = () => {
      api.reg.delete(PLAIN);
      api.reg.delete(CURRENT);
    };
    return {
      kind: "highlight",
      clear,
      paint(blocks, matches, current) {
        const rest: Range[] = [];
        let now: Range | null = null;
        matches.forEach((m, i) => {
          const r = rangeOf(blocks[m.block]!, m.start, m.end);
          if (!r) return;
          if (i === current) now = r;
          else rest.push(r);
        });
        if (!rest.length && !now) return clear();
        api.reg.set(PLAIN, new api.Highlight(...rest));
        // the current match paints above the rest where they meet
        const h = new api.Highlight(...(now ? [now] : []));
        h.priority = 1;
        api.reg.set(CURRENT, h);
      },
    };
  }
  // what the layer holds now, so a repaint of a page that did not move (the page asks for one whenever a group opens or shuts)
  // leaves the boxes where they are instead of replacing each of them
  let drawn = "";
  const clear = () => {
    drawn = "";
    layer?.replaceChildren();
  };
  return {
    kind: "boxes",
    clear,
    paint(blocks, matches, current) {
      if (!layer) return;
      const view = scroller.getBoundingClientRect();
      // the layer lies exactly over the column's visible box, and clips what lies outside it
      layer.style.left = `${scroller.offsetLeft}px`;
      layer.style.top = `${scroller.offsetTop}px`;
      layer.style.width = `${scroller.clientWidth}px`;
      layer.style.height = `${scroller.clientHeight}px`;
      const boxes: HTMLElement[] = [];
      matches.forEach((m, i) => {
        const r = rangeOf(blocks[m.block]!, m.start, m.end);
        if (!r) return;
        // only what is near the view is drawn: a long chat with a common word has thousands of matches
        const whole = r.getBoundingClientRect();
        if (whole.bottom < view.top - 200 || whole.top > view.bottom + 200) return;
        for (const q of Array.from(r.getClientRects())) {
          if (q.width < 1 || q.height < 1) continue;
          const box = document.createElement("div");
          box.className = i === current ? "cf-box cf-cur" : "cf-box";
          box.style.cssText = `left:${q.left - view.left}px;top:${q.top - view.top}px;width:${q.width}px;height:${q.height}px`;
          boxes.push(box);
        }
      });
      const now = `${layer.style.cssText}|${boxes.map((b) => `${b.className}:${b.style.cssText}`).join("|")}`;
      if (now === drawn) return;
      drawn = now;
      layer.replaceChildren(...boxes);
    },
  };
}

/** The first run that is not wholly above the top of the column: where a new search starts. */
export function topBlock(scroller: HTMLElement, blocks: readonly Block[]): number {
  const edge = scroller.getBoundingClientRect().top + 8;
  for (let i = 0; i < blocks.length; i++) {
    const el = (blocks[i]!.segs[0]?.node as unknown as Text | undefined)?.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    // a run with no box (a folded group, hidden) cannot be the one in view
    if (r.height > 0 && r.bottom > edge) return i;
  }
  return 0;
}

/** Scroll the column so the match is in view, in the middle when it was not: clear of the pinned message at the top and the
 *  bar's own corner. A match already in the open part of the view stays where it is. True when the column moved. */
export function bringIntoView(scroller: HTMLElement, r: Range): boolean {
  const box = r.getBoundingClientRect();
  if (!box.width && !box.height) return false;
  const view = scroller.getBoundingClientRect();
  if (box.top >= view.top + 56 && box.bottom <= view.bottom - 24) return false;
  scroller.scrollTop += box.top + box.height / 2 - (view.top + view.height / 2);
  return true;
}
