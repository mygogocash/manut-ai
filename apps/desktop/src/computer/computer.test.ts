// What Settings › Computer reads, and a computer use card's fields as the shell sends them (item 82).
import { afterEach, describe, expect, it, vi } from "vitest";
import { computerAsk, getComputerShell, statusLine, tauriComputer } from "./computer";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

afterEach(() => invoke.mockReset());

describe("computer use on the page", () => {
  it("says ready only when both permissions are on, and otherwise what is missing", () => {
    expect(statusLine({ accessibility: true, screen: true, signed: false })).toBe("computer.ready");
    expect(statusLine({ accessibility: true, screen: false, signed: true })).toBe("computer.needScreen");
    expect(statusLine({ accessibility: false, screen: true, signed: true })).toBe("computer.needAccessibility");
    expect(statusLine({ accessibility: false, screen: false, signed: false })).toBe("computer.needBoth");
  });

  it("reads the status and opens a pane by its name only: the shell holds the addresses", async () => {
    invoke.mockResolvedValueOnce({ mac: true, accessibility: true, screen: false, signed: false });
    const shell = tauriComputer();
    expect(await shell.status()).toEqual({ accessibility: true, screen: false, signed: false });
    expect(invoke).toHaveBeenLastCalledWith("computer_status");
    invoke.mockResolvedValueOnce(null);
    await shell.open("screen");
    expect(invoke).toHaveBeenLastCalledWith("computer_open", { pane: "screen" });
    // no command of the page's asks macOS for a permission: there is none
    expect(invoke.mock.calls.map((c) => c[0])).toEqual(["computer_status", "computer_open"]);
  });

  it("uses the browser stand-in only when a test asks for it", async () => {
    const m = { status: { accessibility: true, screen: true, signed: true }, opened: [] as string[] };
    vi.stubGlobal("window", { __manutComputerMock: true, __manutComputer: m });
    const shell = getComputerShell();
    expect(await shell.status()).toEqual({ accessibility: true, screen: true, signed: true });
    await shell.open("accessibility");
    expect(m.opened).toEqual(["accessibility"]);
    expect(invoke).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("takes a card's fields only when it can draw them whole", () => {
    expect(computerAsk({ act: "click", app: "TextEdit", window: "Untitled", control: "button “Save”" })).toEqual({ act: "click", app: "TextEdit", window: "Untitled", control: "button “Save”" });
    expect(computerAsk({ act: "menu", app: "TextEdit", menu: ["File", "Save…"] })).toEqual({ act: "menu", app: "TextEdit", menu: ["File", "Save…"] });
    // typing that replaces what a field holds is drawn only with how much it holds: the card must say so
    expect(computerAsk({ act: "replace", app: "TextEdit", control: "text area", replaces: 10, text: "Thanks!" })).toEqual({ act: "replace", app: "TextEdit", control: "text area", replaces: 10, text: "Thanks!" });
    for (const replaces of [undefined, 0, -1, 1.5, "10", null]) {
      expect(computerAsk({ act: "replace", app: "TextEdit", control: "text area", replaces, text: "Thanks!" }), String(replaces)).toBeNull();
    }
    // and a count never rides on another act
    expect(computerAsk({ act: "set", app: "TextEdit", control: "text area", replaces: 10, text: "x" })).toBeNull();
    for (const bad of [null, undefined, "click", [], {}, { act: "drag", app: "TextEdit" }, { act: "click" }, { act: "click", app: "" }, { act: "set", app: "X", text: 3 }, { act: "menu", app: "X", menu: ["File", 2] }, { act: "menu", app: "X", menu: "File" }, { act: "look", app: "\u202e" }]) {
      expect(computerAsk(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("never draws an invisible format character, and draws only a small base64 picture", () => {
    // a right-to-left override, an isolate or a zero-width space can make a line read otherwise than it is
    expect(computerAsk({ act: "click", app: "Safari\u200b", window: "Pay \u202e0001\u202c", control: "button “Pay \u2067now\u2069”" })).toEqual({ act: "click", app: "Safari", window: "Pay 0001", control: "button “Pay now”" });
    expect(computerAsk({ act: "menu", app: "TextEdit", menu: ["File\ufeff", "Save…"] })?.menu).toEqual(["File", "Save…"]);
    expect(computerAsk({ act: "click", app: "TextEdit", control: "button “Save”", picture: "iVBORw0KGgo=" })?.picture).toBe("iVBORw0KGgo=");
    for (const picture of ["javascript:alert(1)", "data:image/png;base64,iVBOR", "iVBOR w0K", "x".repeat(350_001), 42]) {
      const c = computerAsk({ act: "click", app: "TextEdit", control: "button “Save”", picture });
      expect(c, String(picture).slice(0, 30)).toEqual({ act: "click", app: "TextEdit", control: "button “Save”" });
    }
  });
});
