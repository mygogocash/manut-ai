// The decision core, ported from Paradev's `terminalInputModeReclaimer.test.ts` (MIT, Superset Inc.,
// `paradevai/paradev` at 2db3bbaf37ffbe24b78c8cdb974bf34632e6fb20; bun:test to vitest, its seven core cases as they were).
// Its xterm adapter tests used a fake terminal and the OSC 777 marker; engine-reclaim.test.ts tests this app's adapter on a
// real xterm instead.
import { describe, expect, it } from "vitest";
import { createLeakedInputModeReclaimer, KITTY_KEYBOARD_DISARM_SEQUENCE, LEAKED_MODE_DISARM } from "./leaked-input-modes";

describe("createLeakedInputModeReclaimer", () => {
  it("disarms kitty leaked by a dead TUI at the next prompt", () => {
    const r = createLeakedInputModeReclaimer();
    r.noteShellReady(); // session's first prompt
    r.noteArm("kitty", true); // TUI arms kitty after the prompt
    r.noteShellReady(); // shell reprompts after the kill
    expect(r.collectDisarm()).toContain(KITTY_KEYBOARD_DISARM_SEQUENCE);
  });

  it("does not disarm kitty a TUI popped itself on clean exit", () => {
    const r = createLeakedInputModeReclaimer();
    r.noteShellReady();
    r.noteArm("kitty", true);
    r.noteArm("kitty", false); // clean pop
    r.noteShellReady();
    expect(r.collectDisarm()).toBe("");
  });

  it("leaves modes armed by shell init alone (shell-owned)", () => {
    const r = createLeakedInputModeReclaimer();
    r.noteArm("kitty", true); // armed before the first marker: the shell owns it
    r.noteShellReady();
    expect(r.collectDisarm()).toBe("");
  });

  it("suppresses the disarm when a TUI re-arms before collection", () => {
    const r = createLeakedInputModeReclaimer();
    r.noteShellReady();
    r.noteArm("kitty", true);
    r.noteShellReady(); // marks kitty leaked
    r.noteArm("kitty", true); // a new TUI grabs it before the flush
    expect(r.collectDisarm()).toBe("");
  });

  it("reclaims leaked mouse and focus reporting", () => {
    const r = createLeakedInputModeReclaimer();
    r.noteShellReady();
    r.noteArm("mouse", true);
    r.noteArm("focus", true);
    r.noteShellReady();
    const out = r.collectDisarm();
    expect(out).toContain("\x1b[?1003l"); // mouse protocol cleared
    expect(out).toContain("\x1b[?1004l"); // focus reporting off
  });

  it("consumes the pending set: a second collect is empty", () => {
    const r = createLeakedInputModeReclaimer();
    r.noteShellReady();
    r.noteArm("kitty", true);
    r.noteShellReady();
    expect(r.collectDisarm()).not.toBe("");
    expect(r.collectDisarm()).toBe("");
  });

  it("writes nothing when no TUI mode leaked", () => {
    const r = createLeakedInputModeReclaimer();
    r.noteShellReady();
    r.noteShellReady();
    expect(r.collectDisarm()).toBe("");
  });

  // added here: what the adapter relies on
  it("the escapes are Paradev's: a kitty stack unwind and set to 0, the mouse group's reset, focus reporting off", () => {
    expect(KITTY_KEYBOARD_DISARM_SEQUENCE).toBe("\x1b[<255u\x1b[=0;1u");
    expect(LEAKED_MODE_DISARM).toEqual({ kitty: "\x1b[<255u\x1b[=0;1u", mouse: "\x1b[?1003l", focus: "\x1b[?1004l" });
  });

  it("a snapshot keeps the epoch and the marks, so a reclaimer can be carried on", () => {
    const a = createLeakedInputModeReclaimer();
    a.noteShellReady();
    a.noteArm("mouse", true);
    const b = createLeakedInputModeReclaimer(a.snapshot());
    b.noteShellReady();
    expect(b.collectDisarm()).toBe("\x1b[?1003l");
    // an arm from before the first marker is the shell's, and stays so through a snapshot
    const c = createLeakedInputModeReclaimer();
    c.noteArm("focus", true);
    const d = createLeakedInputModeReclaimer(c.snapshot());
    d.noteShellReady();
    expect(d.collectDisarm()).toBe("");
  });
});
