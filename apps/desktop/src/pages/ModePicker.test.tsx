// Home's mode at the top left (ModePicker.tsx, the owner's ask of 27 Nov 2026): the button names the brand and the mode in use,
// and its menu offers only the modes it is given, each with what it does and a tick on the one in use. Opening it and picking
// are the browser specs' (chat-keys.spec.ts).
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModeMenu, ModePicker } from "./ModePicker";

describe("Home's mode picker", () => {
  it("names the brand and the mode in use, closed until pressed", () => {
    const html = renderToString(createElement(ModePicker, { mode: "chat", modes: ["chat", "team", "code"], onMode: () => {} }));
    expect(html).toContain("Manut AI");
    expect(html).toMatch(/data-testid="home-mode-now"[^>]*>Chat</);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="menu"');
  });

  it("offers only the modes it is given, with what each does, and ticks the one in use", () => {
    const html = renderToString(createElement(ModeMenu, { mode: "team", modes: ["chat", "team"], onPick: () => {} }));
    expect(html).not.toContain("home-mode-code");
    expect(html).toContain("Give the team a job");
    expect(html).toContain("Ask Buddy something");
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="home-mode-team"/);
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="home-mode-chat"/);
  });
});
