// The chat box's keys (item 95): what Enter and Cmd+Enter do on Home and in an open chat with an answer running, the two
// choices in Settings that swap them, and the line under the box. The boxes only ask these, so every key in every state
// is pinned here; e2e/chat-keys.spec.ts presses them in the app.
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import {
  AFTER_SEND_KEY,
  FOLLOW_UP_KEY,
  afterSend,
  followUp,
  keysCaption,
  reloadBoxKeys,
  sendKey,
  setAfterSend,
  setFollowUp,
  stashKey,
  staysHome,
  whileRunning,
  type KeyLike,
} from "./keys";

const key = (k: string, over: Partial<KeyLike> = {}): KeyLike => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });

/** A page's storage for the saved choices. */
function withStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  reloadBoxKeys();
  setLang("en");
});

describe("which send key", () => {
  it("Enter, and Command+Enter on a Mac; Shift+Enter is a new line, and an input method's Enter only commits", () => {
    expect(sendKey(key("Enter"), true)).toBe("enter");
    expect(sendKey(key("Enter", { metaKey: true }), true)).toBe("cmd");
    expect(sendKey(key("Enter", { shiftKey: true }), true)).toBeNull();
    expect(sendKey(key("Enter", { altKey: true }), true)).toBeNull();
    expect(sendKey(key("Enter", { metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(sendKey(key("Enter", { ctrlKey: true }), true)).toBeNull();
    expect(sendKey(key("Enter", { isComposing: true }), true)).toBeNull();
    expect(sendKey(key("Enter", { keyCode: 229 }), true)).toBeNull();
    expect(sendKey(key("a"), true)).toBeNull();
  });

  it("Ctrl+Enter is the Cmd key off a Mac, where Command (the Windows key) is not", () => {
    expect(sendKey(key("Enter", { ctrlKey: true }), false)).toBe("cmd");
    expect(sendKey(key("Enter", { metaKey: true }), false)).toBeNull();
  });

  it("Cmd+S stashes, on any layout, and not while an input method composes", () => {
    expect(stashKey(key("s", { metaKey: true }), true)).toBe(true);
    expect(stashKey(key("S", { metaKey: true }), true)).toBe(true);
    expect(stashKey(key("ㄴ", { metaKey: true, code: "KeyS" }), true)).toBe(true);
    expect(stashKey(key("s", { ctrlKey: true }), false)).toBe(true);
    expect(stashKey(key("s"), true)).toBe(false);
    expect(stashKey(key("s", { metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(stashKey(key("s", { metaKey: true, isComposing: true }), true)).toBe(false);
  });
});

describe("Home's box: send and open, or send and stay", () => {
  it("by default Enter opens what it started and Cmd+Enter stays on Home", () => {
    expect(afterSend()).toBe("open");
    expect(staysHome("enter")).toBe(false);
    expect(staysHome("cmd")).toBe(true);
  });

  it("the setting swaps the two", () => {
    expect(staysHome("enter", "stay")).toBe(true);
    expect(staysHome("cmd", "stay")).toBe(false);
  });

  it("is saved on this computer, and only a choice that differs from the default is written", () => {
    const m = withStorage();
    setAfterSend("stay");
    expect(m.get(AFTER_SEND_KEY)).toBe("stay");
    reloadBoxKeys();
    expect(afterSend()).toBe("stay");
    setAfterSend("open");
    expect(m.has(AFTER_SEND_KEY)).toBe(false);
    // anything else saved there reads as the default
    m.set(AFTER_SEND_KEY, "teleport");
    reloadBoxKeys();
    expect(afterSend()).toBe("open");
  });
});

describe("an open chat while its answer runs: wait for it, or add it now", () => {
  it("by default Enter waits and Cmd+Enter adds it now, for an agent that can take it", () => {
    expect(followUp()).toBe("queue");
    expect(whileRunning("enter", true)).toBe("queue");
    expect(whileRunning("cmd", true)).toBe("steer");
  });

  it("the setting swaps the two", () => {
    expect(whileRunning("enter", true, "steer")).toBe("steer");
    expect(whileRunning("cmd", true, "steer")).toBe("queue");
  });

  it("an agent that cannot take a message mid-answer waits with either key, whatever the setting", () => {
    for (const pref of ["queue", "steer"] as const) {
      expect(whileRunning("enter", false, pref)).toBe("queue");
      expect(whileRunning("cmd", false, pref)).toBe("queue");
    }
  });

  it("is saved on this computer", () => {
    const m = withStorage();
    setFollowUp("steer");
    expect(m.get(FOLLOW_UP_KEY)).toBe("steer");
    reloadBoxKeys();
    expect(followUp()).toBe("steer");
    setFollowUp("queue");
    expect(m.has(FOLLOW_UP_KEY)).toBe(false);
  });

  it("the line under the box says what Enter does now, and what Cmd+Enter does instead", () => {
    expect(keysCaption(true, "Kami", "queue", true)).toBe("Enter sends it when this answer is done · ⌘Enter adds it now");
    expect(keysCaption(true, "Kami", "steer", true)).toBe("Enter adds it to this answer now · ⌘Enter waits until it is done");
    expect(keysCaption(false, "Buddy", "steer", true)).toBe("Buddy takes it when this answer is done, with Enter or ⌘Enter");
    expect(keysCaption(true, "Kami", "queue", false)).toBe("Enter sends it when this answer is done · Ctrl+Enter adds it now");
    setLang("ja");
    expect(keysCaption(true, "Kami", "queue", true)).toContain("⌘Enter");
  });
});
