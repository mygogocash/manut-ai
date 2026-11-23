/// Text rules the value types and the reducer share. Swift counts a string in characters as a
/// person reads them (grapheme clusters), so the limits GoSpark states in characters are cut
/// the same way here. That matters for Thai, where a consonant and the vowel and tone marks
/// above it are several code points and one character: a cut by code point would leave marks
/// with nothing under them.

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/// The em dash and its longer relatives: the horizontal bar, and the two- and three-em dashes.
/// They are written by code point so no editor or tool can swap one for a look-alike.
const EM_DASHES = new RegExp(`[${String.fromCodePoint(0x2014, 0x2015, 0x2e3a, 0x2e3b)}]`, "g");

/// GoSpark's house rule for model prose (`TextCleanup.withoutEmDashes`): the em dash becomes a
/// plain hyphen with the spacing around it kept, so a dash set off by spaces stays set off and a
/// dash closed up stays closed up. The en dash stays, because it is the correct mark in a range
/// of numbers.
export function withoutEmDashes(text: string): string {
  return text.replace(EM_DASHES, "-");
}

/// Whether the text is empty once whitespace and line breaks are trimmed.
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/// The text trimmed, or `undefined` when nothing is left.
export function trimmedOrUndefined(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/// The length of the text in UTF-8 bytes, which is how GoSpark measures a tool's output.
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      // A surrogate pair is one code point of four bytes.
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/// The first `count` characters, and whether anything was left behind.
export function firstCharacters(text: string, count: number): { readonly text: string; readonly cut: boolean } {
  // A character is at least one code unit, so a text this short cannot hold more than `count`.
  if (text.length <= count) return { text, cut: false };
  let taken = 0;
  let end = 0;
  for (const piece of segmenter.segment(text)) {
    if (taken === count) return { text: text.slice(0, end), cut: true };
    end = piece.index + piece.segment.length;
    taken += 1;
  }
  return { text, cut: false };
}

/// The last `count` characters.
export function lastCharacters(text: string, count: number): string {
  // A character is at least one code unit, so a text this short cannot hold more than `count`.
  if (text.length <= count) return text;
  // Only a tail is segmented, so one enormous output is never walked whole. The tail grows
  // until it holds enough characters, which the first try does for all but the longest clusters.
  for (let span = count * 4; ; span *= 2) {
    const whole = span >= text.length;
    const pieces = Array.from(segmenter.segment(whole ? text : text.slice(-span)), (piece) => piece.segment);
    // A tail may open in the middle of a character, so its first piece is not kept.
    if (!whole) pieces.shift();
    if (whole || pieces.length >= count) return pieces.slice(-count).join("");
  }
}
