// Input modes a program left on in a terminal (item 148). Lifted from Paradev (MIT, Copyright (c) 2025-2026 Superset Inc.,
// `paradevai/paradev` at 2db3bbaf37ffbe24b78c8cdb974bf34632e6fb20): `packages/shared/src/leaked-input-mode-reclaim.ts`,
// the decision logic as it is, with its tests ported to vitest (leaked-input-modes.test.ts).
//
// A TUI (Claude Code, Codex) turns on the Kitty keyboard protocol, mouse reporting and focus reporting, and turns them
// off again when it exits cleanly. Killed or crashed it never writes the escapes that restore them, so the terminal
// keeps them: every key reaches the next program CSI-u encoded (Ctrl+C as `^[[99;5u`), mouse moves print reports, and
// it stays so until `reset`.
//
// This file only decides. It is told when a mode is turned on or off (`noteArm`) and when the shell owns the terminal
// again (`noteShellReady`), and says which escapes turn off the modes the program left (`collectDisarm`). Two rules
// keep it from taking what is not the program's: a mode that was on before the first `noteShellReady` belongs to
// whatever ran first (a shell's own start-up) and is never taken back, and a mode turned on again before the escapes
// are collected stays on (a program that is still running owns it).
//
// What differs from Paradev: its own shell wrappers print a marker (`OSC 777`) before every prompt, and that marker is
// its "the shell owns the terminal again". Manut AI puts no hook into the person's shell, so its sign is the end of the
// agent program the shell of this app started for the terminal (engine-reclaim.ts); the marker's constants are not here.

const ESC = "\x1b";

/** Kitty keyboard protocol off: a stack unwind (`CSI < 255 u` pops more than the stack holds, emptying it) and an
 *  explicit set to 0 (`CSI = 0 ; 1 u`) that covers flags turned on without a push. */
export const KITTY_KEYBOARD_DISARM_SEQUENCE = `${ESC}[<255u${ESC}[=0;1u`;

/** Modes only a program turns on and a shell never does, so taking them back once a shell owns the terminal is safe. */
export type LeakableInputMode = "kitty" | "mouse" | "focus";

/** The escapes that turn each mode off. Mouse tracking is one xterm group: any level's reset (`?1003l`) clears the
 *  whole protocol, so one escape covers 9, 1000, 1002 and 1003. */
export const LEAKED_MODE_DISARM: Record<LeakableInputMode, string> = {
  kitty: KITTY_KEYBOARD_DISARM_SEQUENCE,
  mouse: `${ESC}[?1003l`,
  focus: `${ESC}[?1004l`,
};

export interface LeakedInputModeReclaimerSnapshot {
  sawMarker: boolean;
  modes: [LeakableInputMode, { armed: boolean; shellOwned: boolean; pending: boolean }][];
}

export interface LeakedInputModeReclaimer {
  snapshot(): LeakedInputModeReclaimerSnapshot;
  /** A mode was turned on (true) or off (false) in the stream. */
  noteArm(mode: LeakableInputMode, armed: boolean): void;
  /** The shell owns the terminal again: modes still on that did not belong to the shell are marked as leaked and their
   *  shadow is cleared (in stream order). Call `collectDisarm` once what was already written has been read. */
  noteShellReady(): void;
  /** The escapes for the modes marked leaked and not turned on again since, so a program that still owns the terminal
   *  keeps its modes. Consumes the marks; "" when nothing leaked. */
  collectDisarm(): string;
}

/** A decision core that knows nothing of where its events come from. */
export function createLeakedInputModeReclaimer(snapshot?: LeakedInputModeReclaimerSnapshot): LeakedInputModeReclaimer {
  const modeNames: LeakableInputMode[] = ["kitty", "mouse", "focus"];
  const state = new Map<LeakableInputMode, { armed: boolean; shellOwned: boolean; pending: boolean }>(
    snapshot ? structuredClone(snapshot.modes) : modeNames.map((m) => [m, { armed: false, shellOwned: false, pending: false }]),
  );
  let sawMarker = snapshot?.sawMarker ?? false;

  return {
    snapshot() {
      return { sawMarker, modes: structuredClone([...state]) };
    },
    noteArm(mode, armed) {
      const s = state.get(mode);
      if (!s) return;
      s.armed = armed;
      if (armed) {
        // turned on again: a reclaim waiting for it is off, the mode is live again
        s.pending = false;
        // on before the first marker: the shell's own start-up turned it on
        if (!sawMarker) s.shellOwned = true;
      } else {
        s.shellOwned = false;
      }
    },
    noteShellReady() {
      sawMarker = true;
      for (const s of state.values()) {
        if (s.armed && !s.shellOwned) {
          s.pending = true;
          s.armed = false;
        }
      }
    },
    collectDisarm() {
      let disarm = "";
      for (const mode of modeNames) {
        const s = state.get(mode);
        if (!s) continue;
        if (s.pending && !s.armed) disarm += LEAKED_MODE_DISARM[mode];
        s.pending = false;
      }
      return disarm;
    },
  };
}
