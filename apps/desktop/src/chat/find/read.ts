// Find in a chat (item 150): what the chat shows, read from the page, run by run.
//
// Find reads the page and nothing else. A message's words are the ones the bubble drew (markdown already turned into
// text, a key the chat shows masked still masked, the link chip's label and not its address), and a step's words are the
// ones its row draws. It never goes back to the store for the text: that would find words the page does not show.
//
// The one thing the page does not show is a folded group's steps. While a find bar is open the activity line draws them
// anyway, with the `hidden` attribute, marked `data-find-folded` and named by `data-fold` (Activity.slot.tsx), so this
// reads them through the very same rows the person sees once the group opens. A run read from one carries that fold's
// name, and the finder opens the group while the match in it is the current one.
//
// The walk works on a few members of the DOM only (`ElLike`), so a test can hand it a small tree of plain objects. In
// the page it is given `look`, which asks the browser how an element is drawn: hidden things are skipped, and an
// element that is not drawn inline (a flex item, a block) ends the run of text it follows, as it does in the browser's own
// find, so "Ran" and the command beside it are two runs, not one word.

/** What the walk uses of a text node. */
export interface TextLike {
  readonly nodeType: number;
  readonly data: string;
}
/** What the walk uses of an element. */
export interface ElLike {
  readonly nodeType: number;
  readonly tagName: string;
  readonly childNodes: ArrayLike<TextLike | ElLike>;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}

/** Where a piece of a run's text lives: the text node, and the run's characters `start` to `end` that it holds. */
export interface Seg {
  node: TextLike;
  start: number;
  end: number;
}

/** One run of text the chat shows, with where each piece of it is in the page. */
export interface Block {
  /** Names the run the same way each time the chat is read: its row, then its place in the row. */
  key: string;
  text: string;
  segs: readonly Seg[];
  /** The folded group it is in (`data-fold`), or null for text that is drawn in the open. */
  fold: string | null;
}

/** How the browser draws an element (`getComputedStyle`), for what decides whether it is read and where its text ends. */
export interface Look {
  display: string;
  visibility: string;
}
export interface ReadEnv {
  look?(el: ElLike): Look | null;
}

/** Never read: their content is not text a person reads in the chat. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "CANVAS", "IFRAME", "VIDEO", "AUDIO", "OBJECT", "EMBED", "IMG"]);

/** End a run of text on either side, whatever the stylesheet says (with `look`, the stylesheet also decides). */
const BREAKS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT",
  "TH", "THEAD", "TR", "UL",
]);

const isEl = (n: TextLike | ElLike): n is ElLike => n.nodeType === 1;
const isText = (n: TextLike | ElLike): n is TextLike => n.nodeType === 3;

/** Every run of text under `root` (the timeline), in the order the page draws them. Each child of `root` is a row: it is
 *  named by its `data-row` (the item's id), else its `data-kind`, else by the row before it, so a run keeps its key while
 *  other rows come and go. */
export function readBlocks(root: ElLike, env: ReadEnv = {}): Block[] {
  const out: Block[] = [];
  let anchor = "top";
  let loose = 0;
  let row = anchor;
  let nth = 0;
  let cur: { text: string; segs: Seg[] } | null = null;
  let fold: string | null = null;

  const flush = () => {
    // a run of white space only is the gap between two blocks, not a word to find
    if (cur && cur.text.trim()) out.push({ key: `${row}:${nth++}`, text: cur.text, segs: cur.segs, fold });
    cur = null;
  };
  const add = (n: TextLike) => {
    if (!n.data) return;
    cur ??= { text: "", segs: [] };
    cur.segs.push({ node: n, start: cur.text.length, end: cur.text.length + n.data.length });
    cur.text += n.data;
  };

  const walk = (n: TextLike | ElLike): void => {
    if (isText(n)) return add(n);
    if (!isEl(n)) return;
    const tag = n.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) || n.hasAttribute("data-find-skip")) return;
    const folded = n.hasAttribute("data-find-folded");
    // a folded group is drawn hidden on purpose, to be read; any other hidden thing is not shown, so it is not read
    if (!folded && (n.hasAttribute("hidden") || n.getAttribute("aria-hidden") === "true")) return;
    const look = env.look?.(n) ?? null;
    // (not opacity: a row that has just arrived rises from opacity 0, and a read that skipped it would miss the whole message)
    if (look && !folded && (look.display === "none" || look.visibility === "hidden" || look.visibility === "collapse")) return;
    const inline = !!look && (look.display.startsWith("inline") || look.display === "contents");
    const breaks = folded || BREAKS.has(tag) || n.hasAttribute("data-find-block") || (!!look && !inline);
    // a closed <details> shows its <summary> and nothing else
    const closed = tag === "DETAILS" && !n.hasAttribute("open");
    if (breaks) flush();
    const outer = fold;
    if (folded) fold = n.getAttribute("data-fold");
    for (let i = 0; i < n.childNodes.length; i++) {
      const c = n.childNodes[i]!;
      if (closed && !(isEl(c) && c.tagName.toUpperCase() === "SUMMARY")) continue;
      walk(c);
    }
    if (breaks) flush();
    fold = outer;
  };

  for (let i = 0; i < root.childNodes.length; i++) {
    const c = root.childNodes[i]!;
    flush();
    if (isEl(c)) {
      const own = c.getAttribute("data-row") ?? c.getAttribute("data-kind");
      if (own) {
        anchor = own;
        loose = 0;
        row = own;
      } else row = `${anchor}+${++loose}`;
    } else row = `${anchor}+${++loose}`;
    nth = 0;
    walk(c);
    flush();
  }
  return out;
}

/** Is `next` the same runs, in the same nodes, as `prev`? Then nothing needs finding again. */
export function sameBlocks(prev: readonly Block[], next: readonly Block[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.key !== b.key || a.text !== b.text || a.fold !== b.fold || a.segs.length !== b.segs.length) return false;
    for (let j = 0; j < a.segs.length; j++) if (a.segs[j]!.node !== b.segs[j]!.node) return false;
  }
  return true;
}
