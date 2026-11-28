// The reclaimer's xterm side (engine-reclaim.ts) on a real xterm 6: what a program that dies with its input modes on
// leaves, and that it is given back once, only for an agent, and not when the program turned them off itself.
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { attachReclaim, takeBackModes } from "./engine-reclaim";
import { programEnded } from "./engine";
import { KITTY_KEYBOARD_DISARM_SEQUENCE } from "./leaked-input-modes";
import { kittyKeysOn } from "./park";

const make = () => new Terminal({ cols: 40, rows: 10, allowProposedApi: true, vtExtensions: { kittyKeyboard: true } });
/** Resolves once everything written before it has been read (xterm reads in order). */
const flush = (t: Terminal, d = "") => new Promise<void>((r) => t.write(d, r));
const el = () => ({}) as HTMLElement;
const on = (t: Terminal) => ({ kitty: kittyKeysOn(t), mouse: t.modes.mouseTrackingMode !== "none", focus: t.modes.sendFocusMode, paste: t.modes.bracketedPasteMode, keys: t.modes.applicationCursorKeysMode });

const ARMED = "\x1b[>1u\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1h";

describe("what a killed agent leaves, and what is given back", () => {
  it("the Kitty keyboard protocol, mouse and focus reporting, bracketed paste and application keys go off", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, ARMED);
    expect(on(t)).toEqual({ kitty: true, mouse: true, focus: true, paste: true, keys: true });
    const wrote = takeBackModes(t, e);
    await flush(t);
    expect(on(t)).toEqual({ kitty: false, mouse: false, focus: false, paste: false, keys: false });
    // Paradev's three first, in its order, then the two xterm shows on
    expect(wrote).toBe(`${KITTY_KEYBOARD_DISARM_SEQUENCE}\x1b[?1003l\x1b[?1004l\x1b[?2004l\x1b[?1l`);
  });

  it("writes nothing when the program turned its modes off itself (a clean exit)", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, ARMED);
    await flush(t, "\x1b[<u\x1b[?1003l\x1b[?1004l\x1b[?2004l\x1b[?1l");
    expect(takeBackModes(t, e)).toBe("");
  });

  it("writes nothing for a terminal that never had a program turn a mode on", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, "hello\r\n$ ");
    expect(takeBackModes(t, e)).toBe("");
  });

  it("is once: after the first write has been read a second end writes nothing", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, ARMED);
    expect(takeBackModes(t, e)).not.toBe("");
    await flush(t);
    expect(takeBackModes(t, e)).toBe("");
  });

  it("a program's modes are read while it runs and not from a terminal the engine never attached", async () => {
    const t = make();
    await flush(t, ARMED);
    expect(takeBackModes(t, el())).toBe(""); // no record for this element: nothing is guessed
    expect(on(t).mouse).toBe(true);
  });

  it("the alternate screen it entered with ?1049h is left, and the cursor goes back where it was in the main screen", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, "$ codex");
    await flush(t, "\x1b[?1049h\x1b[2J\x1b[5;7Hframe");
    expect(t.buffer.active.type).toBe("alternate");
    expect(takeBackModes(t, e)).toBe(`\x1b[?1049l${KITTY_KEYBOARD_DISARM_SEQUENCE}`);
    await flush(t);
    expect(t.buffer.active.type).toBe("normal");
    expect([t.buffer.active.cursorX, t.buffer.active.cursorY]).toEqual([7, 0]);
    expect(takeBackModes(t, e)).toBe("");
  });

  it("the Kitty protocol keeps its flags for each screen: those of the main screen and of the alternate one both go", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, "\x1b[>1u\x1b[?1049h\x1b[>3u"); // flags pushed on the main screen, then on the alternate one
    expect(kittyKeysOn(t)).toBe(true);
    expect(takeBackModes(t, e)).toBe(`${KITTY_KEYBOARD_DISARM_SEQUENCE}\x1b[?1049l${KITTY_KEYBOARD_DISARM_SEQUENCE}`);
    await flush(t);
    expect(t.buffer.active.type).toBe("normal");
    expect(kittyKeysOn(t)).toBe(false); // the main screen's flags
    await flush(t, "\x1b[?1049h");
    expect(kittyKeysOn(t)).toBe(false); // and the alternate screen's, when a program goes there again
  });

  it("an alternate screen entered with ?1047h or ?47h is left as it is: ?1049l would restore a cursor nothing saved", async () => {
    for (const enter of ["\x1b[?1047h", "\x1b[?47h"]) {
      const t = make();
      const e = el();
      attachReclaim(t, e);
      await flush(t, `$ x${enter}frame`);
      expect(takeBackModes(t, e)).toBe("");
      expect(t.buffer.active.type).toBe("alternate");
    }
  });

  it("a mouse mode set at any level is taken (9, 1000, 1002, 1003), split from other modes in one escape too", async () => {
    for (const set of ["\x1b[?9h", "\x1b[?1000h", "\x1b[?1002h", "\x1b[?1003h", "\x1b[?25;1002h"]) {
      const t = make();
      const e = el();
      attachReclaim(t, e);
      await flush(t, set);
      expect(takeBackModes(t, e), set).toBe("\x1b[?1003l");
      await flush(t);
      expect(on(t).mouse, set).toBe(false);
    }
  });

  it("a mode set with CSI = flags u counts, and one set to 0 does not", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, "\x1b[=0;1u");
    expect(takeBackModes(t, e)).toBe("");
    await flush(t, "\x1b[=5;1u");
    expect(kittyKeysOn(t)).toBe(true);
    expect(takeBackModes(t, e)).toBe(KITTY_KEYBOARD_DISARM_SEQUENCE);
    await flush(t);
    expect(kittyKeysOn(t)).toBe(false);
  });

  it("an escape split between two writes still counts", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, "\x1b[?10");
    await flush(t, "03h");
    expect(takeBackModes(t, e)).toBe("\x1b[?1003l");
  });

  it("a terminal made again from a snapshot (a new xterm on the same element) still knows what the program turned on", async () => {
    const e = el();
    const a = make();
    const stop = attachReclaim(a, e);
    await flush(a, "\x1b[?1004h");
    stop();
    a.dispose();
    const b = make();
    attachReclaim(b, e);
    expect(takeBackModes(b, e)).toBe("\x1b[?1004l");
  });

  it("stops watching when it is undone: arms after that are not seen", async () => {
    const t = make();
    const e = el();
    const stop = attachReclaim(t, e);
    stop();
    await flush(t, "\x1b[?1003h");
    expect(takeBackModes(t, e)).toBe("");
  });
});

describe("programEnded: only an agent's end gives modes back", () => {
  it("an agent CLI that ended gives its modes back, once what it printed has been read", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, ARMED);
    // the program's last bytes were still waiting to be read when it ended: its own escapes count
    t.write("\x1b[?1000h\x1b[?1049h");
    programEnded(t, e, { agent: true });
    await flush(t);
    await flush(t);
    expect(on(t)).toEqual({ kitty: false, mouse: false, focus: false, paste: false, keys: false });
    expect(t.buffer.active.type).toBe("normal");
  });

  it("the line its owner writes next goes on the screen the terminal returns to, not on the alternate one it leaves", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, "$ codex\r\n");
    await flush(t, "\x1b[?1049h\x1b[2Jframe");
    programEnded(t, e, { agent: true });
    t.write("\r\n[Codex ended]\r\n"); // written at once, as terminals.ts does
    await flush(t);
    await flush(t);
    const b = t.buffer.active;
    expect(b.type).toBe("normal");
    const lines = Array.from({ length: 4 }, (_, y) => b.getLine(y)?.translateToString(true) ?? "");
    expect(lines.join("|")).toContain("[Codex ended]");
    expect(lines.join("|")).toContain("$ codex");
  });

  it("a Shell row's end, or any program that is not an agent, gives nothing back", async () => {
    const t = make();
    const e = el();
    attachReclaim(t, e);
    await flush(t, ARMED);
    programEnded(t, e, { agent: false });
    await flush(t);
    await flush(t);
    expect(on(t)).toEqual({ kitty: true, mouse: true, focus: true, paste: true, keys: true });
  });
});
