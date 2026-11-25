// The palette's two small rules, kept apart from the overlay so they can be tested without a page: what a typed word
// finds, and what each key does.

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/** Whether `label` holds every word of `query`, in any case. Plain matching on the words the row shows, in whatever
 *  language they are shown in: no fuzzy scoring, so what is found is what a person can read. An empty query finds all. */
export function matches(label: string, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fold(label);
  return words.every((w) => text.includes(w));
}

export interface KeyState {
  cursor: number;
  count: number;
  /** an input method is composing: its keys are its own */
  composing: boolean;
}

export type KeyResult = { cursor: number; do: "none" | "pick" | "close" };

/** What a key does in the open palette: arrows move (wrapping), Enter picks the row under the cursor, Esc closes. A key
 *  pressed while an input method composes does nothing here, so committing a word never picks a row. */
export function keyResult(key: string, s: KeyState): KeyResult {
  if (s.composing) return { cursor: s.cursor, do: "none" };
  if (key === "Escape") return { cursor: s.cursor, do: "close" };
  if (s.count <= 0) return { cursor: 0, do: "none" };
  if (key === "ArrowDown") return { cursor: (s.cursor + 1) % s.count, do: "none" };
  if (key === "ArrowUp") return { cursor: (s.cursor - 1 + s.count) % s.count, do: "none" };
  if (key === "Enter") return { cursor: s.cursor, do: "pick" };
  return { cursor: s.cursor, do: "none" };
}
