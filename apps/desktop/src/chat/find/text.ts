// Find in a chat (item 150), the part with no page in it: which runs of text a query matches, in which order, and how
// Next and Previous move between the matches. The text it is given is whatever the chat shows, read by read.ts, so a
// key the chat shows masked is masked here too: nothing in this file can reach a word the page does not draw.
//
// A query is matched as typed, case-insensitively unless Match case is on. Matching is a regular expression built from
// the query (every character escaped), not a lowercased copy of the text: lowercasing can change a string's length
// ("İ" becomes two letters), and every offset found in a copy would then be off by one for the rest of the run. Thai
// text and any other script go through the same way: there is nothing to fold in Thai, and a match is a run of the same
// characters wherever it sits.
//
// A run of spaces, tabs or line breaks in the query matches any run of them in the text, since a paragraph's source can
// break a line where the page shows one space.

/** The matches stop here, as the terminal's find stops counting at its own limit, and the bar then says "more than". */
export const FIND_LIMIT = 2000;

/** How a query is matched: letter case counts, or not (the default). */
export interface FindOptions {
  caseSensitive: boolean;
}
export const FIND_PLAIN: FindOptions = { caseSensitive: false };

/** One run of text the chat shows: a message's paragraph, a step's command. `key` names it the same way each time it is
 *  read, so a match can be found again after the chat changed. */
export interface Run {
  key: string;
  text: string;
}

/** A match: the run it is in (an index into the runs it was found in) and its characters, `start` to `end`. */
export interface Match {
  block: number;
  start: number;
  end: number;
}

export interface Found {
  matches: Match[];
  /** the limit was reached: there may be more than the matches say */
  capped: boolean;
}

const SYNTAX = /[.*+?^${}()|[\]\\]/g;

/** The pattern a query stands for, or null when there is nothing to look for (empty, or only white space). */
export function patternFor(query: string, options: FindOptions = FIND_PLAIN): RegExp | null {
  if (!query.trim()) return null;
  // split() with a capturing group keeps the white space between the words, at the odd places
  const source = query
    .split(/(\s+)/)
    .map((part, i) => (i % 2 ? "\\s+" : part.replace(SYNTAX, "\\$&")))
    .join("");
  try {
    return new RegExp(source, options.caseSensitive ? "gu" : "giu");
  } catch {
    return null;
  }
}

/** Every match of `query` in `runs`, in the order the runs are read and left to right inside one, up to `limit`. */
export function findAll(runs: readonly Run[], query: string, options: FindOptions = FIND_PLAIN, limit: number = FIND_LIMIT): Found {
  const re = patternFor(query, options);
  const matches: Match[] = [];
  if (!re) return { matches, capped: false };
  for (let block = 0; block < runs.length; block++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(runs[block]!.text))) {
      // the pattern is never empty, but a zero-length match must never stall the loop
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      matches.push({ block, start: m.index, end: m.index + m[0].length });
      if (matches.length >= limit) return { matches, capped: true };
    }
  }
  return { matches, capped: false };
}

/** The match Next (1) or Previous (-1) goes to from match `at` of `count`, wrapping at both ends. With no match current
 *  (-1), Next is the first and Previous the last. -1 when there is nothing to go to. */
export function stepIndex(at: number, step: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (at < 0) return step === 1 ? 0 : count - 1;
  return (at + step + count) % count;
}

/** A place in the runs: a run and a character in it. */
export interface Place {
  block: number;
  start: number;
}

/** The first match at or after `from`, in reading order; -1 when every match is before it (the caller then wraps to the
 *  first, as Next does at the end). Typing keeps the match the person is on while it still matches, since a longer query
 *  starts where the shorter one did. */
export function firstFrom(matches: readonly Match[], from: Place): number {
  return matches.findIndex((m) => m.block > from.block || (m.block === from.block && m.start >= from.start));
}
