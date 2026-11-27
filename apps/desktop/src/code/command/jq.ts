// jq's operands: which words of a jq line are its filter or its files and which are values of its options.
// Its own file because it is one program's reading, used only by `classify`.

/** jq's operands (and yq's, which takes jq's options): `--arg`, `--argjson`, `--slurpfile` and `--rawfile` each take a name and
 *  then a value, where its other options with a value take one. Read as one-value options, `--arg x 1 '<filter>'` made `1` the
 *  filter and left the real filter unread. */
export const JQ_TWO_VALUES = new Set(["--arg", "--argjson", "--slurpfile", "--rawfile"]);

export const JQ_ONE_VALUE = new Set(["--indent", "-L", "--library-path", "--seq-prefix", "--stream-errors-to"]);

export function jqOperands(words: string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === "--") {
      for (let j = i + 1; j < words.length; j++) out.push(j);
      break;
    }
    if (w.startsWith("-") && w !== "-") {
      if (JQ_TWO_VALUES.has(w)) i += 2;
      else if (JQ_ONE_VALUE.has(w)) i++;
      continue;
    }
    out.push(i);
  }
  return out;
}
