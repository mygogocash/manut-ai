// The limits an artifact link's page keeps, said once beside the protocol (artifacts.ts) and checked before anything is asked or sent:
// which files can be one, the title a file's name gives, and the sizes the API and the shell's request command take.
import { describe, expect, it } from "vitest";
import { kindOfFile, MAX_ARTIFACT_BYTES, MAX_REQUEST_BYTES, MAX_TITLE, shareBody, shareRefusal, titleOfFile, titleOk, utf8Bytes } from "./artifacts";

describe("a file as a page", () => {
  it("is HTML or Markdown by its extension, whatever its case, and nothing else", () => {
    expect(["menu.html", "MENU.HTM", "a.b.html"].map(kindOfFile)).toEqual(["html", "html", "html"]);
    expect(["notes.md", "Notes.Markdown"].map(kindOfFile)).toEqual(["markdown", "markdown"]);
    expect(["photo.png", "page.html.txt", "html", "README", "script.js"].map(kindOfFile)).toEqual([null, null, null, null, null]);
  });

  it("is titled by its name without the extension, on one line and at most MAX_TITLE long", () => {
    expect(titleOfFile("Opening hours.md")).toBe("Opening hours");
    expect(titleOfFile("/Users/fon/Desktop/menu.html")).toBe("menu");
    expect(titleOfFile("two\nlines.md")).toBe("two lines");
    expect(titleOfFile(`${"x".repeat(200)}.md`)).toHaveLength(MAX_TITLE);
    expect(titleOfFile(".md")).toBe("");
  });

  it("refuses what the API would refuse, before anything is asked", () => {
    const page = { title: "Menu", kind: "html" as const, text: "<h1>Menu</h1>" };
    expect(shareRefusal(page)).toBeNull();
    expect(shareRefusal({ ...page, title: " " })).toBe("invalid_title");
    expect(titleOk("a\u2028b")).toBe(false);
    expect(shareRefusal({ ...page, kind: "pdf" as never })).toBe("invalid_kind");
    expect(shareRefusal({ ...page, text: "" })).toBe("invalid_text");
    // Thai counts three bytes to a letter, as the API stores it
    expect(shareRefusal({ ...page, text: "ก".repeat(Math.floor(MAX_ARTIFACT_BYTES / 3) + 1) })).toBe("too_large");
    expect(shareRefusal({ ...page, text: "a".repeat(MAX_ARTIFACT_BYTES) })).toBeNull();
    // a page of control characters escapes to six bytes each, past what the shell sends, so it is refused here too
    const control = "\u0001".repeat(MAX_ARTIFACT_BYTES / 2);
    expect(utf8Bytes(JSON.stringify(shareBody({ ...page, text: control }))) > MAX_REQUEST_BYTES).toBe(true);
    expect(shareRefusal({ ...page, text: control })).toBe("too_large");
  });

  it("sends exactly the fields the API reads, the title trimmed", () => {
    expect(shareBody({ title: "  Menu ", kind: "markdown", text: "# Menu" })).toEqual({ title: "Menu", kind: "markdown", text: "# Menu" });
  });
});
