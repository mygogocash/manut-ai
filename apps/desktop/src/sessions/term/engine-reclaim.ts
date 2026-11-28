// Giving the keyboard and mouse back when an agent dies uncleanly (item 148). Paradev's reclaimer (leaked-input-modes.ts)
// decides which of the Kitty keyboard protocol, mouse reporting and focus reporting a dead program left on; this file
// is its xterm side, as Paradev's `terminalInputModeReclaimer.ts` is, with one difference: what says "the shell owns the
// terminal again".
//
// Paradev's shell wrappers print a marker before each prompt. Manut AI puts no hook into the person's shell and never
// edits its configuration, so the sign is the end of the agent program the shell of this app started for the terminal
// (`terminals.ts`, the program's exit; engine.ts `programEnded`). A Shell row, or any program that is not an agent, never
// gets here: its modes are its own. An agent the person starts by hand inside a shell is not read either: the app only
// sees which program is in front, and cannot tell an agent that ended from one that was put in the background with
// Ctrl+Z, which would lose the modes it still needs.
//
// Besides those three, three more are given back when the program that ended had them on, read from xterm itself:
// bracketed paste and application cursor keys (Paradev turns both off for a brand-new shell over stale content,
// `FRESH_SHELL_INPUT_MODE_RESET`), and the alternate screen when the program entered it with `?1049h`. The shell that
// takes over the terminal then draws on the screen it had before, with its scrollback; the last frame of the dead
// program goes, as it would after a clean exit. Paradev does not leave the alternate screen.
import type { IDisposable, Terminal } from "@xterm/xterm";
import { createLeakedInputModeReclaimer, KITTY_KEYBOARD_DISARM_SEQUENCE, type LeakableInputMode, type LeakedInputModeReclaimer } from "./leaked-input-modes";

interface Shared {
  reclaimer: LeakedInputModeReclaimer;
  /** the alternate screen was entered with `?1049h`, which saved the cursor, so `?1049l` puts it back where it was; a
   *  program that entered with `?47h` or `?1047h` saved none, and `?1049l` would send the cursor to the first row */
  alt1049: boolean;
}

/** One record for each terminal element. A terminal that is parked and made again is a new xterm on the same element,
 *  so what the program turned on while it ran is still known. */
const shared = new WeakMap<object, Shared>();

function sharedFor(el: object): Shared {
  let s = shared.get(el);
  if (!s) {
    const reclaimer = createLeakedInputModeReclaimer();
    // Paradev's reclaimer calls whatever is on before the first prompt marker the shell's own. Here the program is the
    // agent from its first byte and no shell ran before it, so nothing is anyone's but the agent's: the first epoch
    // begins at once, and a mode restored from an earlier session's kept text is never taken for the shell's.
    reclaimer.noteShellReady();
    s = { reclaimer, alt1049: false };
    shared.set(el, s);
  }
  return s;
}

/** The DEC private modes that count: mouse reporting at any level (9, 1000, 1002, 1003) and focus reporting (1004). */
const MOUSE_MODES = [9, 1000, 1002, 1003];

/** Watch which of the modes the program turns on and off in terminal `term` (an xterm parser handler for each escape,
 *  chunk-safe and exact; each returns false so xterm still applies it). Returns what stops watching. */
export function attachReclaim(term: Terminal, el: HTMLElement): () => void {
  const s = sharedFor(el);
  const note = (mode: LeakableInputMode, armed: boolean) => s.reclaimer.noteArm(mode, armed);
  const handlers: IDisposable[] = [];
  const parser = term.parser;
  // Kitty keyboard protocol: `CSI > flags u` pushes, `CSI = flags ; mode u` sets (0 turns it off), `CSI < n u` pops
  handlers.push(
    parser.registerCsiHandler({ prefix: ">", final: "u" }, () => {
      note("kitty", true);
      return false;
    }),
    parser.registerCsiHandler({ prefix: "=", final: "u" }, (params) => {
      const raw = params[0];
      const flags = typeof raw === "number" ? raw : (raw?.[0] ?? 0);
      note("kitty", flags !== 0);
      return false;
    }),
    parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
      note("kitty", false);
      return false;
    }),
  );
  const dec = (params: (number | number[])[], armed: boolean) => {
    for (const p of params) {
      const mode = typeof p === "number" ? p : p[0];
      if (MOUSE_MODES.includes(mode)) note("mouse", armed);
      else if (mode === 1004) note("focus", armed);
      else if (mode === 1049) s.alt1049 = armed;
    }
  };
  handlers.push(
    parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      dec(params, true);
      return false;
    }),
    parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      dec(params, false);
      return false;
    }),
  );
  return () => {
    for (const h of handlers) h.dispose();
  };
}

/** The escapes for the two modes of the three that xterm itself shows on and that a shell turns on again by itself. */
function keysOff(term: Terminal): string {
  let out = "";
  if (term.modes.bracketedPasteMode) out += "\x1b[?2004l";
  if (term.modes.applicationCursorKeysMode) out += "\x1b[?1l";
  return out;
}

/** The program that was in terminal `term` has ended: write the escapes that turn off what it left on. Nothing is
 *  written when it left nothing (a clean exit turned its modes off itself), and once the first write has been read a
 *  second call writes nothing, since the first one turned them off. Call it once everything the program printed has
 *  been read (engine.ts `programEnded`), so its own last escapes count. Returns what it wrote, for a test. */
export function takeBackModes(term: Terminal, el: HTMLElement): string {
  const s = shared.get(el);
  if (!s) return "";
  s.reclaimer.noteShellReady();
  const input = s.reclaimer.collectDisarm();
  let out = input + keysOff(term);
  // The Kitty protocol keeps its flags for each screen, and leaving the alternate screen shows the main screen's again, so
  // the escapes that turned them off on the alternate one go once more on the main one. They do nothing there when the
  // program never turned the protocol on, and the program that did is gone.
  if (term.buffer.active.type === "alternate" && s.alt1049) out += "\x1b[?1049l" + KITTY_KEYBOARD_DISARM_SEQUENCE;
  if (out) term.write(out);
  return out;
}
