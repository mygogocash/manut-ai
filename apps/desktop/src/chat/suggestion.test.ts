// The suggested next message of a coding chat (item 76): kept apart from the timeline, shown only while the setting is on, and dropped
// by a new turn or a send.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSuggestOn } from "../lib/suggest";
import { clearSuggestion, noteSuggestion, resetSuggestions, suggestionFor } from "./suggestion";

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  resetSuggestions();
  setSuggestOn(true);
});
afterEach(() => {
  setSuggestOn(false);
  vi.unstubAllGlobals();
});

describe("a chat's suggestion", () => {
  it("is kept for the chat it came to, trimmed, and replaced by the next one", () => {
    noteSuggestion("agent:s1", "  Now add a test  ");
    expect(suggestionFor("agent:s1")).toBe("Now add a test");
    expect(suggestionFor("agent:s2")).toBeNull();
    noteSuggestion("agent:s1", "Run the tests");
    expect(suggestionFor("agent:s1")).toBe("Run the tests");
  });

  it("keeps nothing for blank text, and cuts a very long one", () => {
    noteSuggestion("agent:s1", "   ");
    expect(suggestionFor("agent:s1")).toBeNull();
    noteSuggestion("agent:s1", "a".repeat(2000));
    expect(suggestionFor("agent:s1")?.length).toBe(500);
  });

  it("is dropped when asked, and not shown at once when the setting is turned off", () => {
    noteSuggestion("agent:s1", "Now add a test");
    setSuggestOn(false);
    expect(suggestionFor("agent:s1")).toBeNull();
    setSuggestOn(true);
    expect(suggestionFor("agent:s1")).toBe("Now add a test");
    clearSuggestion("agent:s1");
    expect(suggestionFor("agent:s1")).toBeNull();
  });

  it("is never kept while the setting is off, so one that arrives late is dropped", () => {
    setSuggestOn(false);
    noteSuggestion("agent:s1", "Now add a test");
    setSuggestOn(true);
    expect(suggestionFor("agent:s1")).toBeNull();
  });
});
