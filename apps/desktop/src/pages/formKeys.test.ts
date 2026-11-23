// What a key does in the Customize page's forms. The page serves Japanese, Korean and Chinese, whose input methods use Enter to
// commit what is being composed, and Escape to cancel it. Neither may reach the form: a half-written fact must not be saved,
// nor a half-written routine added, nor a question closed, by the key that only finishes a character.
import { describe, expect, it, vi } from "vitest";
import { formKeys } from "./formKeys";

/** A key event as React hands it over: the key, `preventDefault`, and the native event it wraps. */
function key(k: string, over: { composing?: boolean; native?: boolean; keyCode?: number } = {}) {
  const preventDefault = vi.fn();
  return {
    event: {
      key: k,
      preventDefault,
      keyCode: over.keyCode,
      isComposing: over.native ? undefined : over.composing,
      nativeEvent: over.native ? { isComposing: over.composing } : undefined,
    },
    preventDefault,
  };
}

describe("Enter in a form", () => {
  it("is left alone when it is a plain Enter, so the form submits as it should", () => {
    const { event, preventDefault } = key("Enter");
    formKeys()(event);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("is held back while an input method is composing, so the form does not submit", () => {
    const { event, preventDefault } = key("Enter", { composing: true });
    formKeys()(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("is held back when React hands over the browser's own composing flag", () => {
    const { event, preventDefault } = key("Enter", { composing: true, native: true });
    formKeys()(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("is held back for the Enter Safari sends as key code 229 after the composition has ended, which the macOS webview does", () => {
    const { event, preventDefault } = key("Enter", { keyCode: 229 });
    formKeys()(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("holds back only Enter: a letter typed while composing is not touched", () => {
    const { event, preventDefault } = key("a", { composing: true });
    formKeys()(event);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("Escape in a form that can be closed", () => {
  it("closes it, as the owner asked", () => {
    const close = vi.fn();
    formKeys(close)(key("Escape").event);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not close it when it only cancels what an input method is composing", () => {
    const close = vi.fn();
    formKeys(close)(key("Escape", { composing: true }).event);
    formKeys(close)(key("Escape", { composing: true, native: true }).event);
    formKeys(close)(key("Escape", { keyCode: 229 }).event);
    expect(close).not.toHaveBeenCalled();
  });

  it("ignores every other key, and ignores Escape when there is nothing to close", () => {
    const close = vi.fn();
    formKeys(close)(key("Tab").event);
    formKeys(close)(key("Enter").event);
    expect(close).not.toHaveBeenCalled();
    expect(() => formKeys()(key("Escape").event)).not.toThrow();
  });

  it("still holds back a composing Enter on the way, as the form without a way to close does", () => {
    const close = vi.fn();
    const { event, preventDefault } = key("Enter", { composing: true });
    formKeys(close)(event);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });
});
