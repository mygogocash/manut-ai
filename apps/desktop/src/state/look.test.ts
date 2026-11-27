// The saved look (Settings > Appearance), read back at start. Item 85f made the Chat board's look the default: an answer
// on the page ("open") at the board's sizes ("medium"). A look saved before held the old defaults whenever the person
// changed anything else, so those read as today's defaults; a choice saved since is kept. Item 99b added the chat column's
// width (medium, the board's 696px, by default) and the person's own themes, picked by their id.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCss } from "../theme/cssRules";
import { CHAT_WIDTHS, DEFAULT_LOOK, LOOK_VERSION, parseLook, savedLook } from "./store";

describe("the saved look", () => {
  it("defaults to the board: open bubbles, medium text, the brand's colours and the board's column", () => {
    expect(DEFAULT_LOOK).toEqual({ palette: "manut", bubbles: "open", text: "medium", width: "medium" });
    expect(parseLook(null)).toEqual(DEFAULT_LOOK);
  });

  it("reads a look saved before 85f: its old defaults become today's, a real choice stays", () => {
    // the person only picked a colour set: soft and small were just what the app drew then
    expect(parseLook(JSON.stringify({ palette: "forest", bubbles: "soft", text: "small" }))).toEqual(DEFAULT_LOOK);
    // solid and large were picked on purpose
    expect(parseLook(JSON.stringify({ palette: "manut", bubbles: "solid", text: "large" }))).toEqual({ ...DEFAULT_LOOK, bubbles: "solid", text: "large" });
    expect(parseLook(JSON.stringify({ palette: "manut", bubbles: "open", text: "medium" }))).toEqual(DEFAULT_LOOK);
  });

  it("keeps soft bubbles, small text, a chat width and a theme of the person's own chosen since", () => {
    const look = { palette: "mine-ab12cd34", bubbles: "soft", text: "small", width: "wide" } as const;
    const saved = savedLook(look);
    expect(JSON.parse(saved)).toEqual({ ...look, v: LOOK_VERSION });
    expect(parseLook(saved)).toEqual(look);
  });

  it("falls back to the defaults for what it cannot read", () => {
    expect(parseLook('{"palette":"neon","bubbles":"round","text":9,"width":"huge"}')).toEqual(DEFAULT_LOOK);
    expect(parseLook('{"palette":"mine-../x","width":7}')).toEqual(DEFAULT_LOOK);
    expect(parseLook("{not json")).toEqual(DEFAULT_LOOK);
  });
});

describe("the chat width", () => {
  const css = parseCss(readFileSync(join(__dirname, "..", "theme", "tokens.css"), "utf8"));
  const width = (sel: string) => css.rules.find((r) => r.selector === sel)?.decls.find((d) => d.prop === "--thread-w")?.value;

  it("is narrow, medium or wide; medium is the Chat board's 696px column", () => {
    expect(CHAT_WIDTHS).toEqual(["narrow", "medium", "wide"]);
    expect(width(":root")).toBe("696px");
  });

  it("moves the one column every chat reads: 600px narrow, 880px wide", () => {
    expect(width('[data-chat-width="narrow"]')).toBe("600px");
    expect(width('[data-chat-width="wide"]')).toBe("880px");
    // medium needs no rule of its own: it is the default
    expect(width('[data-chat-width="medium"]')).toBeUndefined();
  });
});
