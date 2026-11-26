// "A chime and its notification never play twice for the same finish" (item 131). A finish is a bot's answer (the `message`
// that raises the notification) and the `turn.end` that follows it. The notification for it is news, which notify-rules makes
// with no sound of its own, so the one sound of a finish is the chime; and the chime is named by its chat and turn, so a turn
// that ends twice chimes once. Both go quiet in quiet hours, from the same setting.
import { describe, expect, it } from "vitest";
import { noteFor } from "../lib/notify";
import { presentOutside, type PresentContext } from "../lib/outside";
import { SoundBoard, soundFor, type AudioLike } from "../lib/sounds";
import type { BridgeEvent } from "../lib/protocol";

const ctx = (over: Partial<PresentContext> = {}): PresentContext => ({ hideDetails: false, quiet: { start: "22:00", end: "07:00" }, now: new Date(2026, 10, 26, 5, 0).getTime(), waiting: 1, ...over });
const message: BridgeEvent = { event: "message", bot: "kami", id: "m1", text: "Your report is ready." };
const done: BridgeEvent = { event: "turn.end", bot: "kami", outcome: "done" };
const names = { name: () => "Kami", watching: () => false };

describe("a finish's notification and its chime", () => {
  it("the notification for a finished answer carries no sound, whatever the settings", () => {
    const note = noteFor(message, names)!;
    expect(note).toBeTruthy();
    for (const hideDetails of [false, true]) {
      const shown = presentOutside({ kind: "notice", title: note.title, body: note.body }, ctx({ hideDetails, now: new Date(2026, 10, 26, 12, 0).getTime(), quiet: { start: "22:00", end: "07:00" } }));
      expect(shown, `hideDetails ${hideDetails}`).not.toBeNull();
      expect(shown!.sound).toBe(false);
    }
  });

  it("in quiet hours the notification waits in the app, and the chime is held by the same hours", () => {
    const note = noteFor(message, names)!;
    expect(presentOutside({ kind: "notice", title: note.title, body: note.body }, ctx())).toBeNull();
    const finishes: (string | undefined)[] = [];
    let quiet = true;
    const audio = { state: "running", currentTime: 0, destination: {}, createOscillator: () => ({}), createGain: () => ({}), resume: () => Promise.resolve() } as unknown as AudioLike;
    let now = 1_000_000;
    const board = new SoundBoard({ now: () => now, enabled: () => true, quiet: () => quiet, audio: () => audio, finish: (k) => finishes.push(k), onGesture: () => undefined });
    board.settle();
    // the board waits a second after it settles
    now = 1_002_000;
    expect(board.offer("finish", { chat: "kami", id: "turn:1" })).toBe(false);
    quiet = false;
    // the same finish was used up in quiet hours: it does not ring when they end
    expect(board.offer("finish", { chat: "kami", id: "turn:1" })).toBe(false);
    expect(finishes).toEqual([]);
    // the next finish, after quiet hours, chimes once under its own name
    now += 2000;
    expect(board.offer("finish", { chat: "kami", id: "turn:2" })).toBe(true);
    expect(finishes).toEqual(["kami\nturn:2"]);
  });

  it("a finish out of sight is the chime's moment, and one in view is not", () => {
    expect(soundFor(done, { watching: () => false, open: () => false })).toEqual({ sound: "finish" });
    expect(soundFor(done, { watching: () => true, open: () => false })).toBeNull();
    expect(soundFor({ event: "turn.end", bot: "kami", outcome: "interrupted" }, { watching: () => false, open: () => false })).toBeNull();
  });

  it("a request's notification keeps its own sound: that is an ask, not a finish", () => {
    const shown = presentOutside({ kind: "request", approval: "", member: "Kami", summary: "Run ls", canApprove: false }, ctx({ now: new Date(2026, 10, 26, 12, 0).getTime() }));
    expect(shown!.sound).toBe(true);
  });
});
