// The text being typed in a chat box, for the controls in the box's own row (item 132). The box (chat/parts/Composer.tsx)
// keeps its draft to itself; the effort card's Ultrathink row is the one control that writes into it, and it does so
// here rather than through a prop on every caller, since the controls are handed to the box from three places (a coding
// chat, Buddy's chat and its threads). Outside a box there is no draft, and a control that needs one shows nothing.
import { createContext, useContext } from "react";

export interface BoxDraft {
  /** The text as it stands. */
  text: string;
  /** Puts `next` in its place, as a person's own edit (the box's prompt history walk ends there). */
  set(next: string): void;
}

export const BoxDraftContext = createContext<BoxDraft | null>(null);

/** The draft of the box this control sits in, or null outside one. */
export const useBoxDraft = (): BoxDraft | null => useContext(BoxDraftContext);
