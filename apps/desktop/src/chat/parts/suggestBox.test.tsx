// The suggested next message in the chat box (item 76), drawn with react-dom/server: it shows greyed in an empty, quiet box and nowhere
// else. Tab takes it and typing replaces it (Composer.tsx's key handler, read in the browser by e2e).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import type { Bot } from "../../lib/protocol";
import { Composer } from "./Composer";

const bot: Bot = { name: "agent:s1", display_name: "Claude Code", is_default: false, model: "", provider: "", description: "", status: "online", running: false };
const draw = (over: Partial<Parameters<typeof Composer>[0]> = {}) => {
  setLang("en");
  return renderToString(createElement(Composer, { bot, running: false, offline: false, onSend: () => undefined, onStop: () => undefined, ...over }));
};
const placeholder = (html: string) => /<textarea[^>]*placeholder="([^"]*)"/.exec(html)?.[1];

afterEach(() => setLang("en"));

describe("the suggestion in the box", () => {
  it("is the greyed placeholder of an empty box, with a quiet line that says Tab uses it", () => {
    const html = draw({ suggestion: "Now add a test for the empty cart" });
    expect(placeholder(html)).toBe("Now add a test for the empty cart");
    expect(html).toContain('data-testid="suggest-hint"');
    expect(html).toContain("Tab uses it");
  });

  it("shows nothing without one, and the box keeps its own placeholder", () => {
    for (const none of [undefined, null, ""]) {
      const html = draw({ suggestion: none });
      expect(placeholder(html), String(none)).toBe("Message Claude Code");
      expect(html).not.toContain("suggest-hint");
    }
  });

  it("is not shown while a turn runs, while the agent is offline or while a reply chip waits", () => {
    expect(draw({ suggestion: "x", running: true })).not.toContain("suggest-hint");
    const off = draw({ suggestion: "x", offline: true });
    expect(off).not.toContain("suggest-hint");
    expect(placeholder(off)).not.toBe("x");
    expect(draw({ suggestion: "x", reply: { session_id: "r", source: "line", place: "Mali", kind: "thread" } })).not.toContain("suggest-hint");
  });

  it("is never sent by itself: the box with only a suggestion has Send disabled", () => {
    expect(draw({ suggestion: "Now add a test" })).toMatch(/data-testid="send"[^>]*disabled|disabled[^>]*data-testid="send"/);
  });
});
