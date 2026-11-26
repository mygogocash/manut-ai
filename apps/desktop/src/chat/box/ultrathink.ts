// The effort card's one-click "Ultrathink this message" (item 132), a port of GoSpark's
// `GoGoCode/Views/Composer/UltrathinkDraft.swift`: a visible line it puts into the draft, and the rules for when it may
// add or take that line away.
//
// The row writes Claude Code's keyword into the text rather than keeping a hidden flag, so what is sent is exactly what
// the person sees, and nothing about it is remembered for the model or the chat: the draft already keeps itself
// (app/drafts.ts). Claude Code reads the keyword with `/\bultrathink\b/gi` wherever it stands in a message, except in
// one that starts with "/", which it runs as a command; it then adds a reminder to reason thoroughly on that turn and
// changes no effort level. Only a Claude Code chat offers the row.
//
// Manut AI's box has no quoted reply inside the text (a reply is a chip above it), so where GoSpark puts the line under
// a quote, this puts it at the very top.

/** The line the row adds. A line of its own above the message, where the person can see and delete it, asks for
 *  ultrathink as surely as the word typed into a sentence would. */
export const ULTRATHINK_LINE = "Ultrathink:";

/** Claude Code's own matcher: ASCII word edges and ASCII case only, as JavaScript reads it without the `u` flag, so
 *  "ultrathinkครับ" counts and the Kelvin sign is not a "k". */
const KEYWORD = /\bultrathink\b/gi;

/** Where the draft stands. `inserted`: it asks only through the row's own line, which the row may take away again.
 *  `typed`: the person wrote the word themselves, so only they can take it out. */
export type UltrathinkState = "off" | "inserted" | "typed";

/** What the card's row shows: none (not a Claude Code chat, or a model with no levels to deepen); a switch; on and
 *  locked by a word the person typed; or off and locked, because a slash command never reads the word and a line in
 *  front of it would stop it being a command at all. */
export type UltrathinkRow = { kind: "hidden" } | { kind: "toggle"; on: boolean } | { kind: "typed" } | { kind: "slash" };

/** Whether Claude Code would run the draft as a slash command, where it reads no keyword. Leading spaces and blank
 *  lines do not count: the box trims a message before it sends it. */
export const takesSlashPath = (text: string): boolean => /^\s*\//.test(text);

/** Every place Claude Code would act on the keyword, as start offsets. None in a slash command. */
export function keywordAt(text: string): number[] {
  if (takesSlashPath(text)) return [];
  return [...text.matchAll(KEYWORD)].map((m) => m.index ?? 0);
}

/** The row's own line where it stands, with the line break after it: the draft's first line, exactly as the row writes
 *  it. Null when the draft does not start that way. */
function ownLine(text: string): { start: number; end: number } | null {
  if (!text.startsWith(ULTRATHINK_LINE)) return null;
  const end = ULTRATHINK_LINE.length;
  if (end === text.length) return { start: 0, end };
  return text[end] === "\n" ? { start: 0, end: end + 1 } : null;
}

/** Where `text` stands on ultrathink. The row's line counts as inserted only while Claude Code would read the keyword
 *  in it; any other match, anywhere in the draft, is the person's own and locks the row on. */
export function ultrathinkState(text: string): UltrathinkState {
  const found = keywordAt(text);
  const own = ownLine(text);
  const mine = own && found.includes(own.start) ? own : null;
  if (found.some((at) => at !== mine?.start)) return "typed";
  return mine ? "inserted" : "off";
}

/** The row for `text`. `offered`: the chat's agent is Claude Code. `hasLevels`: the model shows thinking levels; one
 *  with a single fixed level gets no row, as in other Claude Code clients. */
export function ultrathinkRow(text: string, offered: boolean, hasLevels: boolean): UltrathinkRow {
  if (!offered || !hasLevels) return { kind: "hidden" };
  const state = ultrathinkState(text);
  if (state === "typed") return { kind: "typed" };
  if (state === "inserted") return { kind: "toggle", on: true };
  return takesSlashPath(text) ? { kind: "slash" } : { kind: "toggle", on: false };
}

/** The draft with the row switched to `on`. Only the row's own line is ever added or removed, and nothing changes where
 *  the row is locked: a word the person typed stays, and a slash command is never given a line in front of it. */
export function settingUltrathink(on: boolean, text: string): string {
  const state = ultrathinkState(text);
  if (state === "off" && on) return takesSlashPath(text) ? text : `${ULTRATHINK_LINE}\n${text}`;
  if (state === "inserted" && !on) {
    const own = ownLine(text);
    return own ? text.slice(own.end) : text;
  }
  return text;
}
