// What a key does in the Customize page's forms. The page serves Japanese, Korean and Chinese, whose input methods use Enter to
// commit what is being composed and Escape to cancel it. Neither is for the form: a half-written fact must not be saved, nor a
// half-written routine added, nor a question closed, by the key that only finishes a character. The app's own rule for this is
// lib/ime.ts (every form puts `holdImeEnter` on its keydown); this adds the Escape that closes an open question to it.
import { composing, holdImeEnter } from "../lib/ime";

/** The part of a key event the page reads, which React's `KeyboardEvent` has. */
export interface FormKey {
  key: string;
  preventDefault(): void;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  keyCode?: number;
}

/** The `onKeyDown` of a form, or of a row that holds one. An Enter that only commits a composition does not submit it. With
 *  `close`, an Escape that is not cancelling a composition calls it. */
export const formKeys =
  (close?: () => void) =>
  (e: FormKey): void => {
    holdImeEnter(e);
    if (close && e.key === "Escape" && !composing(e)) close();
  };
