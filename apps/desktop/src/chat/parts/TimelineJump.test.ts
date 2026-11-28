// What the "Jump to bottom" pill counts as new (item 102l-6): messages that came in since the person let go of the bottom. Older messages
// that Show older put above everything they had are not new, however many.
import { describe, expect, it } from "vitest";
import type { TimelineItem } from "../../state/store";
import { freshSince } from "./TimelineJump";

const user = (id: string): TimelineItem => ({ kind: "user", id, ts: 1, text: id });
const bot = (id: string): TimelineItem => ({ kind: "assistant", id, ts: 1, text: id });
const note = (id: string): TimelineItem => ({ kind: "system", id, ts: 1, text: id });

describe("messages that came in since the person let go of the bottom", () => {
  const had = new Set(["m5", "m6"]);

  it("counts what is below the messages they had, and nothing when none came", () => {
    expect(freshSince([user("m5"), bot("m6")], had)).toBe(0);
    expect(freshSince([user("m5"), bot("m6"), user("m7"), bot("m8")], had)).toBe(2);
  });

  it("does not count older messages put above everything they had", () => {
    const older = [user("m1"), bot("m2"), user("m3"), bot("m4")];
    expect(freshSince([...older, user("m5"), bot("m6")], had)).toBe(0);
    // and still counts what came in at the bottom meanwhile
    expect(freshSince([...older, user("m5"), bot("m6"), user("m7")], had)).toBe(1);
  });

  it("counts an answer slotted above a message sent while it was being written, which is below the first they had", () => {
    expect(freshSince([user("m5"), bot("m6"), bot("m8"), user("m7")], new Set(["m5", "m6", "m7"]))).toBe(1);
  });

  it("counts every message when none they had is shown any more, and no row that is not a message", () => {
    expect(freshSince([user("a"), note("n"), bot("b")], had)).toBe(2);
  });
});
