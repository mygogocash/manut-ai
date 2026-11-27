// Settings › General › Keyboard's settable rows (item 99), drawn from props with react-dom/server: each action with its keys
// and Change, Reset only on a changed one, Reset all once any is changed, the wait for new keys, and why keys were refused.
// What a press does is keys.test.ts's.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultKeys, type Keys } from "../app/keys";
import { KeysRowsView, refusalWords } from "./KeysRows";

const base = { defaults: defaultKeys(true), mac: true, recording: null, refused: null, onChange: () => {}, onReset: () => {}, onResetAll: () => {} };
const draw = (over: Partial<Parameters<typeof KeysRowsView>[0]> & { keys?: Keys }) => renderToString(createElement(KeysRowsView, { ...base, keys: defaultKeys(true), ...over }));

describe("the keyboard rows", () => {
  it("show each action's keys with Change, and no Reset while every one is as it came", () => {
    const html = draw({});
    expect(html).toContain("Command palette: go anywhere, do anything");
    expect(html).toContain("⌘K");
    expect(html).toContain("⌘N · ⌘T");
    expect(html).toContain("Show or hide the bottom terminal panel");
    expect(html).not.toContain("keys-reset");
  });

  it("offer Reset on a changed one and Reset all, wait for new keys, and say why keys were refused", () => {
    const keys = { ...defaultKeys(true), search: [{ meta: true, ctrl: false, alt: false, shift: false, code: "KeyP" }] };
    const html = draw({ keys, recording: "details", refused: "⌘Q belongs to macOS or the window." });
    expect(html).toContain("⌘P");
    expect(html).toContain("keys-reset");
    expect(html).toContain("Reset all shortcuts");
    expect(html).toContain("Press the new keys. Esc cancels.");
    expect(html).toContain("⌘Q belongs to macOS or the window.");
  });

  it("word a refusal by its reason, naming the action that has the keys", () => {
    const k = { meta: true, ctrl: false, alt: false, shift: false, code: "KeyK" };
    expect(refusalWords({ ok: false, why: "taken", by: "search" }, k, true)).toBe("⌘K is already used for Command palette: go anywhere, do anything.");
    expect(refusalWords({ ok: false, why: "editing" }, { ...k, code: "KeyC" }, true)).toBe("⌘C is for editing text.");
    expect(refusalWords({ ok: true }, k, true)).toBeNull();
  });
});
