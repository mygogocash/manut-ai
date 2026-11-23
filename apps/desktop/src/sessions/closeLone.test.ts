// ⌘W (the menu's Close Window on macOS, Ctrl+Shift+W elsewhere) on a terminal that is not split closes its session the
// way its row's x does: through the store's `close`, which holds a running terminal for the undo window (the toast
// brings it back, closeGrace.ts) and closes an ended one at once. With the undo window Off a running program is left
// alone, so the key falls through to closing the window instead of ending the program with no way back.
import { describe, expect, it } from "vitest";
import { closeLone } from "./SplitView";
import type { SessionRec } from "./agents";

const rec = (over: Partial<SessionRec> = {}): SessionRec => ({ id: "s1", agent: "shell", cwd: "/w/a", startedAt: 1, status: "running", view: "terminal", ...over });

function stub(list: SessionRec[], undoable: boolean) {
  const closed: string[] = [];
  const ss = { getState: () => ({ list }) as never, closeUndoable: () => undoable, close: (id: string) => void closed.push(id) };
  return { ss, closed };
}

describe("closeLone", () => {
  it("closes a running terminal through the store's close when that close can be undone", () => {
    const { ss, closed } = stub([rec()], true);
    expect(closeLone("s1", ss)).toBe(true);
    expect(closed).toEqual(["s1"]);
  });

  it("leaves a running terminal alone when the close could not be undone (the undo window is Off)", () => {
    for (const status of ["running", "starting"] as const) {
      const { ss, closed } = stub([rec({ status })], false);
      expect(closeLone("s1", ss), status).toBe(false);
      expect(closed, status).toEqual([]);
    }
  });

  it("closes a terminal whose program ended at once, with or without an undo window", () => {
    for (const undoable of [true, false]) {
      const { ss, closed } = stub([rec({ status: "exited" })], undoable);
      expect(closeLone("s1", ss)).toBe(true);
      expect(closed).toEqual(["s1"]);
    }
  });

  it("does nothing for a session that is not listed", () => {
    const { ss, closed } = stub([rec()], true);
    expect(closeLone("nope", ss)).toBe(false);
    expect(closed).toEqual([]);
  });
});
