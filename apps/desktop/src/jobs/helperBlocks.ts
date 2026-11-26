// The helper blocks a lead lane's agent ends an answer with to ask for helper lanes (item 102e; `docs/several-agents.md`, "4. Helper
// lanes a lane asks for", rules R3 and R4). Pure functions over the answer's text: nothing here starts an agent, opens a card or
// reads the app. The lane's chat reads an answer with them once its turn ends (`helperOutcome`), hides the blocks while the answer
// streams (`hideHelperBlocks`), and says how many helper lanes are being asked for while a block is still being written
// (`streamingHelpers`).
//
// Ported from GoSpark's delegation block parser (ours, `mygogocash/gospark` at a7537c80, `GoGoCode/Models/Buddy.swift`:
// `delegationOutcome`, `streamingOutcome`, `partialDelegations`, `delegatingReply`, `displayText`, `firstDelegationBlock`), with the
// fork's top-level fence walk (`hideSplitBlocks` in `src/threads/types.ts`, the bridge's `split_blocks`): only a fence that opens its
// own line at the top level counts, never one inside a `>` quote or inside another fence that quotes it as an example. Where this
// differs from GoSpark, the comment at that place says how and why. The biggest difference: GoSpark keeps the readable blocks of a
// reply and starts their heads; here one block that cannot be read, or that names a key outside its five, refuses the whole
// request, because a card that shows fewer helper lanes than were asked for would not show what the agent asked.

/** The words that open a helper block: the design's `manut-helpers`, and the plain `helpers` an agent may shorten it to. */
export const HELPER_FENCES = ["manut-helpers", "helpers"] as const;

/** The only keys a helper takes. A block can name an agent, a model and an effort, never a mode or a permission (R3): any
 *  other key refuses the whole request, as a workflow file's unknown field does. */
export const HELPER_KEYS = ["title", "brief", "agent", "model", "effort"] as const;

/** The longest brief a helper takes, in characters. The card shows every brief whole, so one far past any real task (about 5,000
 *  words) is refused rather than drawn. */
export const BRIEF_MAX = 30_000;

/** The longest title a card row shows, in characters: a longer one is cut with "…". */
export const TITLE_MAX = 80;

/** The longest agent, model or effort a helper names. They are one line of text each: an agent id, a model id, a level. */
export const NAME_MAX = 100;

/** One helper lane as its block asked for it. `title` is never empty: with none, the brief's first words stand in, as GoSpark's
 *  `task` falls back to its prompt. Agent, model and effort are absent when the block left them out. */
export interface HelperBrief {
  readonly title: string;
  readonly brief: string;
  readonly agent?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** Why a request could not be read. Each refuses the whole request (R3): nothing starts and no card offers Start helpers. */
export type HelperRefusal =
  /** a block is not JSON */
  | { readonly why: "json" }
  /** a block is neither one object nor a list of objects */
  | { readonly why: "shape" }
  /** a block is an empty list */
  | { readonly why: "empty" }
  /** a helper has a key outside `HELPER_KEYS`, such as `mode` or `approve` */
  | { readonly why: "key"; readonly key: string }
  /** a value is not one line of text (a number, true, null, a list, a line break in an agent's name) */
  | { readonly why: "value"; readonly key: string }
  /** a helper has no brief, or only spaces */
  | { readonly why: "brief" }
  /** a brief is longer than `BRIEF_MAX` */
  | { readonly why: "long" }
  /** a block was never closed: the answer was cut short */
  | { readonly why: "unclosed" };

/** What reading an answer for helper blocks found (GoSpark's `DelegationOutcome`). No block is told apart from a block that cannot
 *  be read: an agent that asked and was refused hears about it, and the person sees a line, where a missing block says nothing. */
export type HelperOutcome =
  /** no helper block: the lead answered by itself */
  | { readonly kind: "none" }
  /** a block was there and the request cannot be used */
  | { readonly kind: "refused"; readonly refusal: HelperRefusal }
  /** every block closed and read */
  | { readonly kind: "helpers"; readonly helpers: readonly HelperBrief[] }
  /** while the answer streams: the whole helpers so far, a block still open (`streamingHelpers` only) */
  | { readonly kind: "partial"; readonly helpers: readonly HelperBrief[] };

// ---------------------------------------------------------------------------------------------------------------------------
// The top-level fence walk
// ---------------------------------------------------------------------------------------------------------------------------

// The fork's patterns (`src/threads/types.ts`): an opening fence of three or more backticks or tildes with up to three spaces in
// front, its info word, and the rest of its line; a closing fence of the same character, at least as long, with nothing after it.
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*(.*?)\s*$/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A whole block on one line: ```` ```manut-helpers {...}``` ````, as the fork reads its own blocks. One pattern for each set of
 *  words that open a block, made once: the helper blocks' and item 102k's reach blocks (`reachBlocks.ts`) share this walk. */
const inlines = new Map<string, RegExp>();
const inlineFor = (words: readonly string[]): RegExp => {
  const k = words.join("\n");
  let re = inlines.get(k);
  if (!re) {
    const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    re = new RegExp(`^ {0,3}(\`{3,})(${alt})[ \\t]+([{[].*[}\\]])[ \\t]*\\1[ \\t]*$`);
    inlines.set(k, re);
  }
  return re;
};
const strip = (line: string): string => line.replace(/\r$/, "");
const closes = (line: string | undefined, fence: string): boolean => {
  const c = line === undefined ? null : CLOSE.exec(strip(line));
  return !!c && c[1][0] === fence[0] && c[1].length >= fence.length;
};

/** One block of the app's own: the word that opened it, the lines it covers, `[from, to)`, its JSON, and whether its closing
 *  fence came. */
export interface FencedBlock {
  readonly word: string;
  readonly from: number;
  readonly to: number;
  readonly body: string;
  readonly closed: boolean;
}

/** The end of a helper block opened at line `open` with `fence`: the line of its closing fence, or `lines.length` when it is still
 *  open. GoSpark's nesting (`firstDelegationBlock`): a brief often holds a fenced code sample, so a fence with an info word inside
 *  the block opens one level deeper and the next bare fence closes that level, not the block. A bare fence closes the block only
 *  at the top of it and only when it is at least as long as the block's own (the fork's `closes`). */
function blockEnd(lines: readonly string[], open: number, fence: string): number {
  let depth = 0;
  for (let j = open + 1; j < lines.length; j++) {
    const line = strip(lines[j]);
    const c = CLOSE.exec(line);
    if (c && c[1][0] === fence[0]) {
      if (depth === 0 && c[1].length >= fence.length) return j;
      if (depth > 0) depth -= 1;
      continue;
    }
    const m = FENCE.exec(line);
    if (m && m[2][0] === fence[0] && m[3]) depth += 1;
  }
  return lines.length;
}

/** Every top-level block of `text` opened by one of `words`, in written order. A fence inside a `>` quote, inside another fence (a
 *  ```` or ~~~ fence quoting a block as an example), or that does not start its line is the answer's text, not a block (the fork's
 *  walk). A backtick fence line with more backticks after its info word is an inline code span, as Markdown reads it, unless it is
 *  a whole one-line block. A block's word with words after it (```` ```helpers are how you ask ````) opens an ordinary code block,
 *  not a request. The helper blocks walk with `HELPER_FENCES`; item 102k's reach blocks (`reachBlocks.ts`) with their own words. */
export function fencedBlocks(text: string, words: readonly string[]): { lines: string[]; blocks: FencedBlock[] } {
  const lines = text.split("\n");
  const blocks: FencedBlock[] = [];
  if (!words.some((w) => text.includes(w))) return { lines, blocks };
  const isWord = (info: string): boolean => words.includes(info);
  const inlineRe = inlineFor(words);
  for (let i = 0; i < lines.length; ) {
    const line = strip(lines[i]);
    const inline = inlineRe.exec(line);
    if (inline) {
      blocks.push({ word: inline[2], from: i, to: i + 1, body: inline[3], closed: true });
      i += 1;
      continue;
    }
    const m = FENCE.exec(line);
    if (!m || line.trimStart().startsWith(">")) {
      i += 1;
      continue;
    }
    const [, , fence, info, rest] = m;
    // a block's fence with nothing after its word, or with the JSON starting there (whose strings may hold backticks)
    const helper = isWord(info) && (!rest || /^[{[]/.test(rest));
    if (!helper && fence[0] === "`" && rest.includes("`")) {
      i += 1; // an inline code span, not a fence
      continue;
    }
    if (helper) {
      // the JSON may start on the opening line, as the fork's blocks allow; the rest of the block follows it
      const end = blockEnd(lines, i, fence);
      const body = [rest, ...lines.slice(i + 1, end).map(strip)].filter((l, k) => k > 0 || l).join("\n");
      blocks.push({ word: info, from: i, to: Math.min(end + 1, lines.length), body, closed: end < lines.length });
      i = end + 1;
      continue;
    }
    // another fence: everything up to its close is its own, examples of blocks included
    let j = i + 1;
    while (j < lines.length && !closes(lines[j], fence)) j += 1;
    i = j + 1;
  }
  return { lines, blocks };
}

/** The helper blocks of `text`. */
const scan = (text: string) => fencedBlocks(text, HELPER_FENCES);

// ---------------------------------------------------------------------------------------------------------------------------
// Reading one block
// ---------------------------------------------------------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** One helper from one JSON object, or why it cannot be one. Strict where GoSpark is lenient: GoSpark skips an entry with no prompt
 *  and ignores keys it does not know; here either refuses the request (R3). */
export function helperFrom(entry: unknown): HelperBrief | HelperRefusal {
  if (!isPlainObject(entry)) return { why: "shape" };
  for (const key of Object.keys(entry)) if (!(HELPER_KEYS as readonly string[]).includes(key)) return { why: "key", key: cut(oneLine(key), 40) };
  for (const key of HELPER_KEYS) if (key in entry && typeof entry[key] !== "string") return { why: "value", key };
  const text = (key: (typeof HELPER_KEYS)[number]): string => (typeof entry[key] === "string" ? (entry[key] as string) : "");
  const brief = text("brief").trim();
  if (!brief) return { why: "brief" };
  if (brief.length > BRIEF_MAX) return { why: "long" };
  const names: Partial<Record<"agent" | "model" | "effort", string>> = {};
  for (const key of ["agent", "model", "effort"] as const) {
    const v = text(key).trim();
    if (/[\r\n]/.test(v) || v.length > NAME_MAX) return { why: "value", key };
    if (v) names[key] = v;
  }
  // no title: the brief's first words, as GoSpark's `TextCleanup.singleLine(prompt, limit: 60)`
  const title = cut(oneLine(text("title")) || cut(oneLine(brief), 60), TITLE_MAX);
  return { title, brief, ...names };
}

export const isRefusal = (v: HelperBrief | HelperRefusal): v is HelperRefusal => "why" in v;

/** One block's JSON: a list of helpers or one helper object (GoSpark's `parse`). Either every helper in it is read, or the block
 *  is refused with the first reason found. */
function readBody(body: string): { helpers: HelperBrief[] } | { refusal: HelperRefusal } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { refusal: { why: "json" } };
  }
  const entries = Array.isArray(json) ? json : isPlainObject(json) ? [json] : null;
  if (!entries) return { refusal: { why: "shape" } };
  if (!entries.length) return { refusal: { why: "empty" } };
  const helpers: HelperBrief[] = [];
  for (const entry of entries) {
    const h = helperFrom(entry);
    if (isRefusal(h)) return { refusal: h };
    helpers.push(h);
  }
  return { helpers };
}

// ---------------------------------------------------------------------------------------------------------------------------
// What an answer asks for
// ---------------------------------------------------------------------------------------------------------------------------

/** What an answer asks for once its turn is over (GoSpark's `delegationOutcome`). Every top-level helper block counts, one helper
 *  each or a list in one, in written order. Unlike GoSpark, a block that cannot be read refuses the whole request even when others
 *  can, and so does a block left open at the end (a stopped or truncated answer), where GoSpark still starts the closed ones. */
export function helperOutcome(text: string): HelperOutcome {
  const { blocks } = scan(text);
  if (!blocks.length) return { kind: "none" };
  const helpers: HelperBrief[] = [];
  for (const block of blocks) {
    if (!block.closed) return { kind: "refused", refusal: { why: "unclosed" } };
    const read = readBody(block.body);
    if ("refusal" in read) return { kind: "refused", refusal: read.refusal };
    helpers.push(...read.helpers);
  }
  return { kind: "helpers", helpers };
}

/** The whole helper objects at the top level of a block still being written: `[{…}, {…}, {…` gives the first two (GoSpark's
 *  `partialDelegations`). Strings and escapes are skipped, so a brace inside a brief never ends an object early. An object that
 *  cannot be read is left out here; the turn's end reads the answer again and says so. */
export function partialHelpers(openBody: string): HelperBrief[] {
  const found: HelperBrief[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < openBody.length; i++) {
    const ch = openBody[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "{") {
      // a helper object sits in the top-level list, or is the whole body
      if (depth === 1 || (depth === 0 && start < 0)) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (start >= 0 && (depth === 1 || depth === 0)) {
        try {
          const h = helperFrom(JSON.parse(openBody.slice(start, i + 1)));
          if (!isRefusal(h)) found.push(h);
        } catch {
          /* not whole JSON after all: left for the turn's end */
        }
        start = -1;
      }
    } else if (ch === "]") depth -= 1;
    else if (ch === "`" && depth === 0) return found; // the fence closed after all; the closed-block path reads it
  }
  return found;
}

/** What an answer still being written asks for so far (GoSpark's `streamingOutcome`): every closed block's helpers and every whole
 *  helper inside a block still open. `partial` while a block is open, `helpers` once every block is closed, `none` while nothing is
 *  whole yet. A block that cannot be read is not reported here: the turn's end reads the answer again and refuses it. Nothing
 *  starts from this (GoSpark starts heads as each brief closes; here helper lanes start only from the card after the turn): the
 *  chat only says how many are being asked for while the blocks are hidden. */
export function streamingHelpers(text: string): HelperOutcome {
  const { blocks } = scan(text);
  const helpers: HelperBrief[] = [];
  let open = false;
  for (const block of blocks) {
    if (!block.closed) {
      open = true;
      helpers.push(...partialHelpers(block.body));
      continue;
    }
    const read = readBody(block.body);
    if ("helpers" in read) helpers.push(...read.helpers);
  }
  if (open) return helpers.length ? { kind: "partial", helpers } : { kind: "none" };
  return helpers.length ? { kind: "helpers", helpers } : { kind: "none" };
}

/** Whether `text` has a helper block at its top level, closed or still being written. */
export const hasHelperBlock = (text: string): boolean => scan(text).blocks.length > 0;

/** Whether `text` ends in a helper block, closed or still being written, with nothing but blank lines after it. What is written
 *  before such a block is whole lines, though `hideHelperBlocks` trims the line end that said so. */
export const endsInHelperBlock = (text: string): boolean => endsInFenced(text, HELPER_FENCES);

/** Whether `text` ends in a top-level block opened by one of `words`, closed or still being written, with nothing but blank lines
 *  after it. */
export function endsInFenced(text: string, words: readonly string[]): boolean {
  const { lines, blocks } = fencedBlocks(text, words);
  const last = blocks[blocks.length - 1];
  return !!last && lines.slice(last.to).every((l) => !l.trim());
}

/** The answer as the person reads it in a lead lane's chat: every top-level helper block taken out, and a block still open cut
 *  from its fence to the end (GoSpark's `displayText` and `withoutDelegationBlock`, with the fork's walk). The same while the
 *  answer streams and once it is over: only a fence that opens its own line at the top level is a block, so a sentence that names
 *  the fence keeps every word after it. Blank lines left three deep are made two, and the ends trimmed, as `hideSplitBlocks` does. */
export const hideHelperBlocks = (text: string): string => hideFenced(text, HELPER_FENCES);

/** `text` with every top-level block opened by one of `words` taken out, and one still open cut from its fence to the end, as
 *  `hideHelperBlocks` does for the helper blocks. */
export function hideFenced(text: string, words: readonly string[]): string {
  const { lines, blocks } = fencedBlocks(text, words);
  if (!blocks.length) return text;
  const keep: string[] = [];
  let b = 0;
  for (let i = 0; i < lines.length; i++) {
    while (b < blocks.length && blocks[b].to <= i) b += 1;
    if (b < blocks.length && i >= blocks[b].from && i < blocks[b].to) continue;
    keep.push(lines[i]);
  }
  return keep.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Which of a turn's answers, oldest first, carries the request to act on (GoSpark's `delegatingReply`): the newest one with a
 *  helper block, readable or not, since it is the lead's latest word on what to ask for. Null when none has one. */
export function helperReply(texts: readonly string[]): number | null {
  for (let i = texts.length - 1; i >= 0; i--) if (helperOutcome(texts[i]).kind !== "none") return i;
  return null;
}
