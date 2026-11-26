// The saved look (Settings > Appearance), read back at start. Item 85f made the Chat board's look the default: an answer
// on the page ("open") at the board's sizes ("medium"). A look saved before held the old defaults whenever the person
// changed anything else, so those read as today's defaults; a choice saved since is kept.
import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK, LOOK_VERSION, parseLook, savedLook } from "./store";

describe("the saved look", () => {
  it("defaults to the board: open bubbles and medium text", () => {
    expect(DEFAULT_LOOK).toEqual({ palette: "manut", bubbles: "open", text: "medium" });
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
  });

  it("reads a look saved before 85f: its old defaults become today's, a real choice stays", () => {
    // the person only picked a colour set: soft and small were just what the app drew then
    expect(parseLook(JSON.stringify({ palette: "forest", bubbles: "soft", text: "small" }))).toEqual({ palette: "manut", bubbles: "open", text: "medium" });
    // solid and large were picked on purpose
    expect(parseLook(JSON.stringify({ palette: "manut", bubbles: "solid", text: "large" }))).toEqual({ palette: "manut", bubbles: "solid", text: "large" });
    expect(parseLook(JSON.stringify({ palette: "manut", bubbles: "open", text: "medium" }))).toEqual(DEFAULT_LOOK);
  });

  it("keeps soft bubbles and small text chosen since", () => {
    const saved = savedLook({ palette: "manut", bubbles: "soft", text: "small" });
    expect(JSON.parse(saved)).toEqual({ palette: "manut", bubbles: "soft", text: "small", v: LOOK_VERSION });
    expect(parseLook(saved)).toEqual({ palette: "manut", bubbles: "soft", text: "small" });
  });

  it("falls back to the defaults for what it cannot read", () => {
    expect(parseLook('{"palette":"neon","bubbles":"round","text":9}')).toEqual(DEFAULT_LOOK);
    expect(parseLook("{not json")).toEqual(DEFAULT_LOOK);
  });
});
