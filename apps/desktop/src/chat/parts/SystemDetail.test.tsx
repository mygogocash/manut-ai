// The quiet line that opens what the app sent in the chat's name (item 102j), drawn with react-dom/server as the other chat parts'
// tests draw them: the line and its label show, the text stays closed until pressed, and nothing about it reads as the person's
// message. What a press opens is the helper-runs e2e spec's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SystemDetail } from "./SystemDetail";

describe("a quiet line with what was sent", () => {
  it("shows the line and its label, with the text closed until pressed", () => {
    const html = renderToString(createElement(SystemDetail, { text: "Helpers reported to Kit.", detail: { label: "Show what was sent", text: "[Manut AI: your helper lanes reported] …" } }));
    expect(html).toContain("Helpers reported to Kit.");
    expect(html).toContain("Show what was sent");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("your helper lanes reported");
    expect(html).not.toContain("row-user");
  });
});
